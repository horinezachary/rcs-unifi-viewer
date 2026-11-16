// UniFi Viewer: network health, switch ports, device adoption and Wi-Fi from a UniFi Network
// controller.
//
// The controller is the source of truth. Health, devices, ports, networks and Wi-Fi are read from it
// on every poll and kept only in memory. State holds what the panel is looking at (switch, port,
// Wi-Fi network); config holds the controller's address, site, pinned certificate and the Allow changes switch;
// the API key or login lives in the module's data folder, so it is never in a save. Starting,
// restoring and reconnecting only read. A VLAN change or an adoption goes out only when the operator
// asks, and only with Allow changes on in Setup.
//
// Stream Deck:
//   keys 1-5    Overview, Switches, Trunks, Adopt, Wi-Fi (in every view but Switches)
//   Overview    keys 6-10 WAN status, down, up, clients, devices
//   Switches    keys 1-10 VLANs for the selected port (key 10 pages with more than 10 networks),
//               11/12 previous/next port, 13 Overview, 14 revert, 15 hold to save
//   Adopt       keys 6-14 waiting devices: hold to adopt
//   Wi-Fi       keys 6-14 networks
//   Trunks      keys 6-15 links between switches, coloured by speed; press one to see its port

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { UnifiClient, type Credentials } from './client.js';
import { emptyView, trunkTree, wifiQrText, type Device, type NetworkView, type SpeedTier, type Trunk } from './model.js';
import { qrRows } from './qr.js';

export interface State {
  /** MAC of the switch the panel shows. */
  sw: string;
  /** Port number on that switch. */
  selPort: number;
  /** Wi-Fi network the panel shows. */
  ssid: string;
}

export interface Config {
  address: string;
  port: number;
  site: string;
  /** SHA-256 of the controller's certificate, pinned on first connect. */
  fingerprint: string;
  /** Lets the operator set port VLANs and adopt devices. Off: the module only reads. */
  allowChanges: boolean;
}

type C = Ctx<State, Config>;
export type View = 'overview' | 'switches' | 'adopt' | 'wifi' | 'setup' | 'trunks';
const VIEWS: View[] = ['overview', 'switches', 'adopt', 'wifi', 'setup', 'trunks'];
const STRIP_VIEWS: View[] = ['overview', 'switches', 'trunks', 'adopt', 'wifi'];

export const KEY = { OVERVIEW: 0, SWITCHES: 1, TRUNKS: 2, ADOPT: 3, WIFI: 4, MORE: 9, PREV: 10, NEXT: 11, BACK: 12, REVERT: 13, SAVE: 14 } as const;
const HOLD_MS = 700;
const MAX_DEVICES = 150;

// Key colours, since keys have no CSS: the accent is the manifest theme's UniFi blue.
const ACCENT = '#006FFF';
const ON_ACCENT = '#FFFFFF';
const SELECTED = '#13284A';
/** Link speed colours, the same as the panel's and web view's. */
export const TIER_COLORS: Record<Exclude<SpeedTier, ''>, string> = { '100M': '#E5B53A', '1G': '#3DD68C', '2.5G': '#7DD3FC', '10G': '#2F6BFF', '25G': '#A970FF' };
const TIER_TEXT: Record<Exclude<SpeedTier, ''>, string> = { '100M': '#16181C', '1G': '#16181C', '2.5G': '#16181C', '10G': '#FFFFFF', '25G': '#FFFFFF' };
const ALERT = '#D7263D';
const DANGER = '#3A1E1C';
const GOOD = '#173A2A';
const BLANK: Omit<KeySetParams, 'index'> = {};

interface Runtime {
  client: UnifiClient | null;
  view: View;
  /** Unsaved VLAN picks on the panel's switch: port number to network id. */
  pending: Map<number, string>;
  vlanPage: number;
  creds: Credentials;
  /** The controller took a fifth strip icon, for Trunks. */
  trunksIcon: boolean;
  ctx: C;
}
let rt: Runtime | null = null;

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
const SITE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validAddress(a: unknown): a is string {
  return typeof a === 'string' && (a === '' || ADDRESS_RE.test(a));
}

function cfg(ctx: C): Config {
  const c = (ctx.config ?? {}) as Partial<Config>;
  return {
    address: c.address ?? '',
    port: c.port ?? 443,
    site: c.site || 'default',
    fingerprint: c.fingerprint ?? '',
    allowChanges: c.allowChanges ?? false
  };
}

const view = (): NetworkView => rt?.client?.view ?? emptyView();
const ready = (): boolean => !!rt?.client?.ready;
const short = (s: string | undefined, n: number): string => [...(s ?? '')].slice(0, n).join('');
const hasCreds = (c: Credentials): boolean => !!c.apiKey || (!!c.username && !!c.password);

function switches(): Device[] {
  return view().devices.filter((d) => d.adopted && d.ports.length > 0);
}

function currentSwitch(ctx: C): Device | undefined {
  const list = switches();
  return list.find((d) => d.mac === ctx.state.value.sw) ?? list.find((d) => d.kind === 'switch') ?? list[0];
}

function mbps(bits: number): string {
  const m = bits / 1e6;
  return m >= 1000 ? (m / 1000).toFixed(2) + 'G' : m >= 100 ? m.toFixed(0) : m.toFixed(1);
}

// ---- credentials: in the data folder, never in state, config or a save --------------------------

function credsFile(ctx: C): string {
  return path.join(ctx.dataDir, 'credentials.json');
}

async function loadCreds(ctx: C): Promise<Credentials> {
  try {
    const j = JSON.parse(await readFile(credsFile(ctx), 'utf8'));
    return { apiKey: j.apiKey || undefined, username: j.username || undefined, password: j.password || undefined };
  } catch {
    return {};
  }
}

async function saveCreds(ctx: C, c: Credentials): Promise<void> {
  const file = credsFile(ctx);
  await mkdir(ctx.dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(c), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

/** For calls made from client events, which can land after the module stopped. */
function quiet(p: Promise<unknown>): void {
  p.catch(() => {});
}

// ---- connection --------------------------------------------------------------------------------

/** (Re)connects to the configured controller. Only reads. */
function connect(ctx: C, force = false): void {
  if (!rt) return;
  const c = cfg(ctx);
  const old = rt.client;
  if (old && !force && old.host === c.address && old.port === c.port && old.site === c.site && old.fingerprint === c.fingerprint) return;
  old?.removeAllListeners();
  old?.stop();
  rt.client = null;
  rt.pending.clear();
  if (!c.address || !hasCreds(rt.creds)) {
    quiet(ctx.status('disconnected', !c.address ? 'Set the controller address in Setup' : 'Add an API key in the web view Setup page'));
    quiet(draw(ctx));
    return;
  }
  const client = new UnifiClient({ host: c.address, port: c.port, site: c.site, fingerprint: c.fingerprint, credentials: rt.creds });
  rt.client = client;
  client.on('status', (connection, text) => {
    if (rt?.client !== client) return;
    quiet(ctx.status(connection, text));
    quiet(draw(ctx));
  });
  client.on('change', () => {
    if (rt?.client !== client) return;
    quiet(draw(ctx));
  });
  client.on('fingerprint', (fp) => {
    if (rt?.client !== client) return;
    // Trust on first use: the module's own setting, not device state.
    quiet(ctx.setConfig({ ...cfg(ctx), fingerprint: fp }).then(() => ctx.log('info', `Trusted the controller certificate ${fp}`)));
  });
  client.start();
}

// ---- drawing -----------------------------------------------------------------------------------

function switchView(d: Device | undefined) {
  return d ? { id: d.id, mac: d.mac, name: d.name, model: d.model, ports: d.ports } : null;
}

export function snapshot(ctx: C) {
  const v = view();
  const c = cfg(ctx);
  const sw = currentSwitch(ctx);
  const client = rt?.client;
  return {
    type: 'snapshot',
    connection: client?.connection ?? 'disconnected',
    statusText: client?.statusText ?? (!c.address ? 'Set the controller address in Setup' : hasCreds(rt?.creds ?? {}) ? '' : 'Add an API key in the web view Setup page'),
    ready: ready(),
    kind: client?.kind ?? null,
    certificateSeen: client?.certificateSeen ?? '',
    sites: client?.sites ?? [],
    credentials: { apiKey: !!rt?.creds.apiKey, username: rt?.creds.apiKey ? '' : rt?.creds.username ?? '' },
    config: c,
    view: rt?.view ?? 'overview',
    health: v.health,
    history: v.history,
    devices: v.devices.slice(0, MAX_DEVICES).map(({ ports, ...d }) => ({ ...d, portCount: ports.length })),
    networks: v.networks,
    wlans: v.wlans,
    switch: switchView(sw),
    trunks: v.trunks,
    trunkTree: trunkTree(v.trunks),
    trunksIcon: rt?.trunksIcon ?? false,
    selPort: ctx.state.value.selPort,
    pending: [...(rt?.pending ?? [])],
    ssid: ctx.state.value.ssid || v.wlans[0]?.id || ''
  };
}

function navFaces(ctx: C): KeySetParams[] {
  const cur = rt?.view ?? 'overview';
  const waiting = view().devices.filter((d) => !d.adopted).length;
  const nav = (index: number, label: string, v: View, sub = 'VIEW'): KeySetParams =>
    cur === v ? { index, label, sublabel: sub, background: ACCENT, color: ON_ACCENT } : { index, label, sublabel: sub };
  return [
    nav(KEY.OVERVIEW, 'STATS', 'overview'),
    nav(KEY.SWITCHES, 'PORTS', 'switches'),
    nav(KEY.TRUNKS, 'TRUNKS', 'trunks', trunkSummary()),
    nav(KEY.ADOPT, 'ADOPT', 'adopt', waiting ? `${waiting} WAITING` : 'VIEW'),
    nav(KEY.WIFI, 'WI-FI', 'wifi')
  ];
}

function trunkSummary(): string {
  const hot = view().trunks.filter((t) => t.warn).length;
  return hot ? `⚠ ${hot} BUSY` : 'VIEW';
}

function speedLabel(mbps: number): string {
  return !mbps ? '?' : mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`;
}

function trunkFace(index: number, t: Trunk): KeySetParams {
  const pct = `${Math.round(t.load * 100)}%`;
  const where = short(`${t.down.device} ${t.down.port || ''}`.trim(), 12);
  if (t.warn) return { index, label: `⚠ ${speedLabel(t.speed)} ${pct}`, sublabel: where, background: ALERT, color: '#FFFFFF' };
  if (!t.tier) return { index, label: `${speedLabel(t.speed)} ${pct}`, sublabel: where };
  return { index, label: `${speedLabel(t.speed)} ${pct}`, sublabel: where, background: TIER_COLORS[t.tier], color: TIER_TEXT[t.tier] };
}

function vlanPaging(n: number): { perPage: number; pages: number } {
  const perPage = n > 10 ? 9 : 10;
  return { perPage, pages: Math.max(1, Math.ceil(n / perPage)) };
}

function keyFaces(ctx: C): KeySetParams[] {
  const v = view();
  const c = cfg(ctx);
  const cur = rt?.view ?? 'overview';
  const live = ready();
  const blanks = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ index: from + i }));

  if (!live) {
    return [...navFaces(ctx), ...blanks(5, 7), { index: 7, label: 'OFFLINE', sublabel: short(c.address || 'no address', 12), background: DANGER }, ...blanks(8, 15)];
  }

  if (cur === 'switches') {
    const sw = currentSwitch(ctx);
    const port = sw?.ports.find((p) => p.idx === ctx.state.value.selPort) ?? sw?.ports[0];
    const target = port ? rt!.pending.get(port.idx) ?? port.networkId : '';
    const { perPage, pages } = vlanPaging(v.networks.length);
    const page = Math.min(rt!.vlanPage, pages - 1);
    const faces: KeySetParams[] = [];
    for (let k = 0; k < 10; k++) {
      const net = v.networks[page * perPage + k];
      if (k === KEY.MORE && pages > 1) faces.push({ index: k, label: 'MORE ▶', sublabel: `page ${page + 1}/${pages}` });
      else if (k < perPage && net && port) {
        const on = net.id === target;
        faces.push({ index: k, label: short(net.name.toUpperCase(), 10), sublabel: `VLAN ${net.vlan}`, ...(on ? { background: ACCENT, color: ON_ACCENT } : {}) });
      } else faces.push({ index: k });
    }
    const n = rt!.pending.size;
    faces.push({ index: KEY.PREV, label: '◀ PORT', sublabel: port ? `port ${port.idx}` : '' });
    faces.push({ index: KEY.NEXT, label: 'PORT ▶', sublabel: short(sw?.name, 12) });
    faces.push({ index: KEY.BACK, label: 'STATS', sublabel: 'back' });
    faces.push(n ? { index: KEY.REVERT, label: 'REVERT', sublabel: `${n} UNSAVED` } : { index: KEY.REVERT });
    faces.push(
      !c.allowChanges
        ? { index: KEY.SAVE, label: 'VIEW ONLY', sublabel: 'see Setup' }
        : n
          ? { index: KEY.SAVE, label: 'SAVE', sublabel: `${n} · hold`, background: ACCENT, color: ON_ACCENT }
          : { index: KEY.SAVE, label: 'SAVE', sublabel: 'nothing' }
    );
    return faces;
  }

  const faces = navFaces(ctx);
  if (cur === 'overview' || cur === 'setup') {
    const h = v.health;
    const offline = v.devices.filter((d) => d.adopted && d.state === 'offline').length;
    const adopted = v.devices.filter((d) => d.adopted).length;
    faces.push(
      { index: 5, label: h?.wanStatus === 'online' ? 'ONLINE' : h?.wanStatus === 'offline' ? 'DOWN' : '—', sublabel: 'WAN', background: h?.wanStatus === 'online' ? GOOD : h?.wanStatus === 'offline' ? DANGER : undefined },
      { index: 6, label: h ? '↓ ' + mbps(h.down) : '—', sublabel: 'Mb/s down' },
      { index: 7, label: h ? '↑ ' + mbps(h.up) : '—', sublabel: 'Mb/s up' },
      { index: 8, label: h ? String(h.wired + h.wireless) : '—', sublabel: 'clients' },
      { index: 9, label: `${adopted - offline}/${adopted}`, sublabel: offline ? `${offline} offline` : 'devices', ...(offline ? { background: DANGER } : {}) },
      ...blanks(10, 15)
    );
  } else if (cur === 'adopt') {
    const waiting = v.devices.filter((d) => !d.adopted).slice(0, 9);
    waiting.forEach((d, i) => faces.push({ index: 5 + i, label: short(d.model || 'DEVICE', 10), sublabel: c.allowChanges ? 'hold: adopt' : short(d.ip, 12) }));
    faces.push(...blanks(5 + waiting.length, 15));
  } else if (cur === 'trunks') {
    const list = v.trunks.slice(0, 10);
    list.forEach((t, i) => faces.push(trunkFace(5 + i, t)));
    faces.push(...blanks(5 + list.length, 15));
  } else if (cur === 'wifi') {
    const sel = snapshot(ctx).ssid;
    const list = v.wlans.slice(0, 9);
    list.forEach((w, i) => faces.push({ index: 5 + i, label: short(w.name, 10), sublabel: `${w.clients} clients`, ...(w.id === sel ? { background: SELECTED } : {}) }));
    faces.push(...blanks(5 + list.length, 15));
  }
  return faces;
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  if (!clientId) await ctx.keys.setMany(keyFaces(ctx));
  await ctx.ui.send(snapshot(ctx), clientId);
}

// ---- selection: the module's own state ---------------------------------------------------------

async function setView(ctx: C, v: unknown): Promise<void> {
  if (!rt || !VIEWS.includes(v as View)) return;
  rt.view = v as View;
  // Keys and buttons change page too, so the strip highlight follows. Setup has no strip icon.
  // strip.select is newer than some SDKs and hosts this runs on: without it the highlight stays put.
  // On a controller whose strip holds only four icons, Trunks sits under Switches.
  const icon = rt.view === 'trunks' && !rt.trunksIcon ? 'switches' : rt.view;
  if (STRIP_VIEWS.includes(icon)) {
    const strip = ctx.strip as typeof ctx.strip & { select?(id: string): Promise<void> };
    void strip.select?.(icon).catch(() => {});
  }
  await draw(ctx);
}

/** Opens a trunk's port: the downstream switch's uplink, or for an access point the switch port it is on. */
async function showTrunk(ctx: C, id: unknown): Promise<void> {
  const t = view().trunks.find((x) => x.id === id);
  if (!rt || !t) return;
  const down = switches().find((d) => d.mac === t.down.mac);
  const sw = down ?? switches().find((d) => d.mac === t.up.mac);
  if (!sw) return;
  const port = down ? t.down.port : t.up.port;
  if (sw.mac !== currentSwitch(ctx)?.mac) rt.pending.clear();
  await ctx.state.patch({ sw: sw.mac, selPort: port || sw.ports[0]?.idx || 1 });
  await setView(ctx, 'switches');
}

async function selectSwitch(ctx: C, mac: unknown): Promise<void> {
  const sw = switches().find((d) => d.mac === mac);
  if (!rt || !sw) return;
  if (sw.mac !== currentSwitch(ctx)?.mac) rt.pending.clear(); // unsaved picks belong to one switch
  await ctx.state.patch({ sw: sw.mac, selPort: sw.ports[0]?.idx ?? 1 });
  await draw(ctx);
}

async function stepPort(ctx: C, by: number): Promise<void> {
  const sw = currentSwitch(ctx);
  if (!sw?.ports.length) return;
  const i = Math.max(0, sw.ports.findIndex((p) => p.idx === ctx.state.value.selPort));
  const next = sw.ports[(i + by + sw.ports.length) % sw.ports.length]!;
  await ctx.state.patch({ sw: sw.mac, selPort: next.idx });
  await draw(ctx);
}

async function selectPort(ctx: C, idx: unknown): Promise<void> {
  const sw = currentSwitch(ctx);
  if (!sw?.ports.some((p) => p.idx === idx)) return;
  await ctx.state.patch({ sw: sw.mac, selPort: idx as number });
  await draw(ctx);
}

// ---- operator actions: the only things that change the network ---------------------------------

function changesAllowed(ctx: C): boolean {
  if (cfg(ctx).allowChanges) return true;
  void ctx.notify('This module only reads. Turn on Allow changes in Setup to change the network.', 'warning');
  return false;
}

/** Stages a VLAN for the panel's selected port. Nothing is sent until SAVE. */
async function pickVlan(ctx: C, networkId: string): Promise<void> {
  if (!rt || !ready() || !changesAllowed(ctx)) return;
  const sw = currentSwitch(ctx);
  const port = sw?.ports.find((p) => p.idx === ctx.state.value.selPort) ?? sw?.ports[0];
  if (!sw || !port || !view().networks.some((n) => n.id === networkId)) return;
  if (port.networkId === networkId) rt.pending.delete(port.idx);
  else rt.pending.set(port.idx, networkId);
  await draw(ctx);
}

async function applyPorts(ctx: C, sw: Device, changes: { idx: number; networkId: string }[]): Promise<boolean> {
  if (!rt?.client || !ready()) {
    await ctx.notify('Not connected to the controller', 'warning');
    return false;
  }
  if (!changesAllowed(ctx)) return false;
  const nets = view().networks;
  const valid = changes.filter((ch) => sw.ports.some((p) => p.idx === ch.idx && p.networkId !== ch.networkId) && nets.some((n) => n.id === ch.networkId));
  if (!valid.length) {
    await ctx.notify('No port changes to save');
    return false;
  }
  try {
    await rt.client.setPortNetworks(sw.id, valid);
    const list = valid.map((ch) => `${ch.idx} → ${nets.find((n) => n.id === ch.networkId)?.name}`).join(', ');
    await ctx.log('info', `Set VLANs on ${sw.name}: port ${list}`);
    await ctx.notify(`Applied ${valid.length} port change${valid.length > 1 ? 's' : ''} to ${sw.name}`);
    return true;
  } catch (e) {
    await ctx.notify(`Ports not changed: ${(e as Error).message}`, 'error');
    return false;
  }
}

async function savePending(ctx: C): Promise<void> {
  const sw = currentSwitch(ctx);
  if (!rt || !sw || !rt.pending.size) return;
  const changes = [...rt.pending].map(([idx, networkId]) => ({ idx, networkId }));
  if (await applyPorts(ctx, sw, changes)) rt.pending.clear();
  await draw(ctx);
}

async function adopt(ctx: C, mac: unknown): Promise<void> {
  const d = view().devices.find((x) => x.mac === mac && !x.adopted);
  if (!rt?.client || !d || !changesAllowed(ctx)) return;
  try {
    await rt.client.adopt(d.mac);
    await ctx.log('info', `Adopting ${d.model} ${d.mac}`);
    await ctx.notify(`Adopting ${d.model || d.mac}`);
  } catch (e) {
    await ctx.notify(`Not adopted: ${(e as Error).message}`, 'error');
  }
  await draw(ctx);
}

/**
 * Sends one Wi-Fi password and its join QR code to the client that asked, and nowhere else, once
 * the system PIN is entered at the panel (a web browser signed in with the PIN has already done so).
 */
async function reveal(ctx: C, id: unknown, clientId: string): Promise<void> {
  const w = view().wlans.find((x) => x.id === id);
  if (!w || !rt?.client) return;
  if (!w.qrType) return ctx.notify(`${w.name} uses enterprise sign-in: there is no shared password`, 'warning');
  const password = w.qrType === 'WPA' ? rt.client.passphrase(w.id) ?? '' : '';
  if (w.qrType === 'WPA' && !password) return ctx.notify('The controller did not send this password. The API key may need admin rights.', 'warning');
  if (w.qrType === 'WPA' && !(await ctx.verifyPin(`Show the password for ${w.name}`, clientId))) {
    return ctx.notify('Password not shown: the PIN was not entered', 'warning');
  }
  await ctx.ui.send({ type: 'reveal', id: w.id, name: w.name, password, qr: qrRows(wifiQrText(w.name, w.qrType, password, w.hidden)) }, clientId);
}

async function setConfig(ctx: C, changes: Partial<Config>): Promise<void> {
  const next = { ...cfg(ctx) };
  if (changes.address !== undefined) {
    const a = String(changes.address).trim();
    if (!validAddress(a)) {
      await ctx.notify('That is not an IP address or host name', 'warning');
      return draw(ctx);
    }
    if (a !== next.address) next.fingerprint = ''; // a different controller: trust its certificate afresh
    next.address = a;
  }
  if (changes.port !== undefined) {
    const p = Number(changes.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      await ctx.notify('Port must be 1 to 65535', 'warning');
      return draw(ctx);
    }
    next.port = p;
  }
  if (changes.site !== undefined) {
    const s = String(changes.site).trim();
    if (!SITE_RE.test(s)) {
      await ctx.notify('A site name is the short name from the controller, such as default', 'warning');
      return draw(ctx);
    }
    next.site = s;
  }
  if (changes.allowChanges !== undefined) next.allowChanges = !!changes.allowChanges;
  await ctx.setConfig(next);
  if (rt && !next.allowChanges) rt.pending.clear();
  connect(ctx);
  await draw(ctx);
}

async function setCredentials(ctx: C, m: any): Promise<void> {
  if (!rt) return;
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  let c: Credentials;
  if (m.clear) c = {};
  else if (clean(m.apiKey, 256)) c = { apiKey: clean(m.apiKey, 256) };
  else if (clean(m.username, 128) && typeof m.password === 'string' && m.password) c = { username: clean(m.username, 128), password: m.password.slice(0, 256) };
  else return ctx.notify('Enter an API key, or a username and password', 'warning');
  rt.creds = c;
  await saveCreds(ctx, c);
  await ctx.log('info', m.clear ? 'Removed the controller credentials' : c.apiKey ? 'Set a new API key' : `Set the login for ${c.username}`);
  connect(ctx, true);
  await draw(ctx);
}

export default defineModule<State, Config>({
  holdMs: HOLD_MS,

  async start(ctx) {
    rt?.client?.stop();
    const none: Credentials = {};
    const r: Runtime = (rt = { client: null, view: 'overview', pending: new Map(), vlanPage: 0, creds: none, trunksIcon: false, ctx });
    const saved = await loadCreds(ctx);
    if (r.creds === none) r.creds = saved; // unless a new sign-in came in meanwhile
    await ctx.state.init({ sw: '', selPort: 1, ssid: '' });
    const icons = [
      { id: 'overview', label: 'Overview', icon: 'assets/overview.svg' },
      { id: 'switches', label: 'Switches', icon: 'assets/switches.svg' },
      { id: 'trunks', label: 'Trunks', icon: 'assets/trunks.svg' },
      { id: 'adopt', label: 'Adopt', icon: 'assets/adopt.svg' },
      { id: 'wifi', label: 'Wi-Fi', icon: 'assets/wifi.svg' }
    ];
    // Controllers before v0.10 take four icons: there Trunks opens from the Switches header and key 3.
    r.trunksIcon = await ctx.strip.set(icons).then(
      () => true,
      () => ctx.strip.set(icons.filter((i) => i.id !== 'trunks')).then(() => false)
    );
    connect(ctx); // reads only: no changes on start, whatever the reason
    await draw(ctx);
  },

  stop() {
    rt?.client?.removeAllListeners();
    rt?.client?.stop();
    rt = null;
  },

  async key(ctx, { index, action }) {
    if (action !== 'down' || !rt) return;
    const cur = rt.view;
    if (cur === 'switches') {
      const nets = view().networks;
      const { perPage, pages } = vlanPaging(nets.length);
      if (index === KEY.MORE && pages > 1) {
        rt.vlanPage = (rt.vlanPage + 1) % pages;
        return draw(ctx);
      }
      if (index < perPage) {
        const net = nets[Math.min(rt.vlanPage, pages - 1) * perPage + index];
        if (net) await pickVlan(ctx, net.id);
        return;
      }
      if (index === KEY.PREV) return stepPort(ctx, -1);
      if (index === KEY.NEXT) return stepPort(ctx, 1);
      if (index === KEY.BACK) return setView(ctx, 'overview');
      if (index === KEY.REVERT) {
        rt.pending.clear();
        return draw(ctx);
      }
      if (index === KEY.SAVE && rt.pending.size && cfg(ctx).allowChanges) return ctx.notify('Hold SAVE to apply the port changes');
      return;
    }
    if (index <= KEY.WIFI) return setView(ctx, (['overview', 'switches', 'trunks', 'adopt', 'wifi'] as View[])[index]);
    if (cur === 'trunks' && index >= 5) {
      const t = view().trunks[index - 5];
      if (t) await showTrunk(ctx, t.id);
      return;
    }
    if (cur === 'wifi' && index >= 5) {
      const w = view().wlans[index - 5];
      if (w) {
        await ctx.state.patch({ ssid: w.id });
        await draw(ctx);
      }
    }
    if (cur === 'adopt' && index >= 5 && view().devices.some((d) => !d.adopted) && cfg(ctx).allowChanges) {
      await ctx.notify('Hold the key to adopt');
    }
  },

  async hold(ctx, index) {
    if (!rt) return;
    if (rt.view === 'switches' && index === KEY.SAVE) return savePending(ctx);
    if (rt.view === 'adopt' && index >= 5) {
      const d = view().devices.filter((x) => !x.adopted)[index - 5];
      if (d) await adopt(ctx, d.mac);
    }
  },

  async strip(ctx, id) {
    await setView(ctx, id);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'view':
        return setView(ctx, m.view);
      case 'select-switch':
        return selectSwitch(ctx, m.mac);
      case 'show-trunk':
        return showTrunk(ctx, m.id);
      case 'select-port':
        return selectPort(ctx, m.idx);
      case 'pick-vlan':
        return pickVlan(ctx, String(m.networkId));
      case 'revert':
        rt.pending.clear();
        return draw(ctx);
      case 'save':
        return savePending(ctx);
      case 'get-switch': {
        // The web view keeps its own switch, so browsing there never moves the panel.
        const sw = switches().find((d) => d.mac === m.mac);
        return ctx.ui.send({ type: 'switch', switch: switchView(sw) }, clientId);
      }
      case 'apply-ports': {
        // From the web view, which keeps its own unsaved picks: an explicit switch and port list.
        const sw = switches().find((d) => d.mac === m.mac);
        const changes = Array.isArray(m.changes)
          ? m.changes.filter((ch: any) => Number.isInteger(ch?.idx) && typeof ch?.networkId === 'string').map((ch: any) => ({ idx: ch.idx, networkId: ch.networkId }))
          : [];
        if (sw) await applyPorts(ctx, sw, changes);
        await draw(ctx);
        return ctx.ui.send({ type: 'applied', mac: m.mac }, clientId);
      }
      case 'adopt':
        return adopt(ctx, m.mac);
      case 'select-ssid':
        if (view().wlans.some((w) => w.id === m.id)) await ctx.state.patch({ ssid: String(m.id) });
        return draw(ctx);
      case 'reveal':
        return reveal(ctx, m.id, clientId);
      case 'config':
        return setConfig(ctx, m.config ?? {});
      case 'credentials':
        return setCredentials(ctx, m);
      case 'trust': {
        const seen = rt.client?.certificateSeen;
        if (!seen) return;
        await ctx.setConfig({ ...cfg(ctx), fingerprint: seen });
        await ctx.log('warning', `Trusted a new controller certificate ${seen}`);
        connect(ctx, true);
        return draw(ctx);
      }
      case 'reconnect':
        connect(ctx, true);
        return draw(ctx);
    }
  }
});

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiClient } from '../src/client.js';
import mod, { KEY, type Config, type State } from '../src/index.js';
import { MockUnifi, type MockOptions } from '../src/mock.js';
import { findTrunks, trunkTree, nativeNetwork, parseDevices, parseHealth, parseNetworks, speedTier, wifiQrText } from '../src/model.js';
import { qrRows } from '../src/qr.js';

let mock: MockUnifi | null = null;
let sim: TestModule<State, Config> | null = null;
let client: UnifiClient | null = null;

afterEach(async () => {
  await sim?.close();
  client?.stop();
  await mock?.close();
  sim = null;
  mock = null;
  client = null;
});

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) {
      const snap = sim ? last() : null;
      throw new Error(`timed out (${snap ? `connection ${snap.connection}, ready ${snap.ready}, "${snap.statusText}", errors ${sim!.errors.map(String)}` : 'no module'})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startMock(opts: MockOptions = {}): Promise<number> {
  mock = new MockUnifi({ apiKey: 'k3y', username: 'admin', password: 'pw', ...opts });
  return mock.listen(0);
}

const BASE: Config = { address: '127.0.0.1', port: 0, site: 'default', fingerprint: '', allowChanges: false };

async function startModule(
  port: number,
  extra: { config?: Partial<Config>; state?: State; creds?: object; reason?: 'boot' | 'restore' | 'user'; verifyPin?: (reason: string, clientId?: string) => boolean } = {},
) {
  sim = await startTestModule(mod, { config: { ...BASE, port, ...extra.config }, state: extra.state, reason: extra.reason, verifyPin: extra.verifyPin });
  await sim.settle();
    await until(() => sim!.strip.length > 0);
  // The test controller starts with no secrets: give it credentials as the web view would.
  await sim.sendUi({ type: 'credentials', ...(extra.creds ?? { apiKey: 'k3y' }) });
  await until(() => last()?.ready === true);
  await sim.settle();
    await until(() => sim!.strip.length > 0);
  return sim;
}

const last = () => [...sim!.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message;
const changes = () => mock!.changes.filter((c) => !c.path.endsWith('/login'));

describe('model', () => {
  it('reads networks, with the untagged one as VLAN 1, and skips WAN and VPN', () => {
    const nets = parseNetworks([
      { _id: 'a', name: 'Video', purpose: 'corporate', vlan_enabled: true, vlan: 20 },
      { _id: 'b', name: 'Default', purpose: 'corporate' },
      { _id: 'c', name: 'Internet', purpose: 'wan' }
    ]);
    expect(nets).toEqual([
      { id: 'b', name: 'Default', vlan: 1 },
      { id: 'a', name: 'Video', vlan: 20 }
    ]);
  });

  it('finds a port native network from its override, the switch, or its profile', () => {
    const pcs = new Map([['pc1', { name: 'Cameras', native_networkconf_id: 'net-video' }]]);
    expect(nativeNetwork({ native_networkconf_id: 'x' }, { native_networkconf_id: 'y' }, pcs, 'def')).toEqual({ networkId: 'y', profile: '' });
    expect(nativeNetwork({ portconf_id: 'pc1' }, undefined, pcs, 'def')).toEqual({ networkId: 'net-video', profile: 'Cameras' });
    expect(nativeNetwork({}, undefined, pcs, 'def')).toEqual({ networkId: 'def', profile: '' });
  });

  it('reads WAN rates in bits per second', () => {
    const h = parseHealth([
      { subsystem: 'wan', status: 'ok', 'rx_bytes-r': 125_000, 'tx_bytes-r': 250_000 },
      { subsystem: 'wlan', num_user: 3 },
      { subsystem: 'lan', num_user: 2 }
    ]);
    expect(h).toMatchObject({ wanStatus: 'online', down: 1e6, up: 2e6, wireless: 3, wired: 2 });
  });

  it('bands link speeds for colour', () => {
    expect([0, 10, 100, 1000, 2500, 5000, 10000, 25000, 40000].map(speedTier)).toEqual(['', '100M', '100M', '1G', '2.5G', '10G', '10G', '25G', '25G']);
  });

  it('finds trunks from switch and access point uplinks, with traffic and a warning at 90%', () => {
    const sw = (mac: string, name: string, uplink: object | undefined, ports: object[]) => ({ _id: name, mac, name, type: 'usw', state: 1, adopted: true, uplink, port_table: ports });
    const port = (idx: number, speed: number, rxMb = 0, txMb = 0, extra = {}) => ({ port_idx: idx, up: true, speed, 'rx_bytes-r': rxMb * 125_000, 'tx_bytes-r': txMb * 125_000, ...extra });
    const raw = [
      { _id: 'gw', mac: 'aa:00', name: 'Gateway', type: 'udm', state: 1, adopted: true, port_table: [port(1, 2500)] },
      sw('aa:01', 'Core', { uplink_mac: 'aa:00', uplink_remote_port: 1, port_idx: 24, type: 'wire' }, [port(3, 2500, 30, 200), port(23, 10000), port(24, 2500, 400, 100, { is_uplink: true })]),
      sw('aa:02', 'Stage', { uplink_mac: 'AA:01', uplink_remote_port: 23, port_idx: 24, type: 'wire' }, [port(24, 1000, 950, 20)]),
      sw('aa:03', 'Mini', { uplink_mac: 'aa:02', uplink_remote_port: 5, speed: 100, 'rx_bytes-r': 1_000_000, 'tx_bytes-r': 0, type: 'wire' }, []),
      { _id: 'ap', mac: 'aa:10', name: 'AP', type: 'uap', state: 1, adopted: true, uplink: { uplink_mac: 'aa:01', uplink_remote_port: 3, type: 'wire' } },
      sw('aa:04', 'Mesh', { uplink_mac: 'aa:01', type: 'wireless' }, [])
    ];
    const trunks = findTrunks(parseDevices(raw, [], [], []));
    expect(trunks.map((t) => `${t.up.device}:${t.up.port}>${t.down.device}:${t.down.port} ${t.tier} ${t.warn}`)).toEqual([
      'Core:3>AP:0 2.5G false',
      'Core:23>Stage:24 1G true',
      'Gateway:1>Core:24 2.5G false',
      'Stage:5>Mini:0 100M false'
    ]);
    const core = trunks.find((t) => t.down.device === 'Core')!;
    expect(core).toMatchObject({ speed: 2500, toDown: 400e6, toUp: 100e6 });
    expect(core.load).toBeCloseTo(0.16);
    // An access point reports no ports: its traffic is the switch port's, turned around.
    expect(trunks.find((t) => t.down.device === 'AP')).toMatchObject({ speed: 2500, toDown: 200e6, toUp: 30e6, down: { kind: 'ap' } });
    expect(trunks.find((t) => t.down.device === 'Stage')!.load).toBeCloseTo(0.95);
    expect(trunks.find((t) => t.down.device === 'Mini')).toMatchObject({ speed: 100, toDown: 8e6 });
  });

  it('lays trunks out as a tree, children by port under their uplink', () => {
    const t = (up: string, upPort: number, down: string) => ({ up: { mac: up, device: up.toUpperCase(), port: upPort }, down: { mac: down, device: down.toUpperCase(), port: 24 } }) as any;
    const tree = trunkTree([t('core', 23, 'stage'), t('gw', 1, 'core'), t('core', 22, 'foh'), t('stage', 5, 'mini')]);
    const at = Object.fromEntries(tree.nodes.map((n) => [n.mac, [n.depth, n.x]]));
    expect(at).toEqual({ gw: [0, 0.5], core: [1, 0.5], foh: [2, 0], stage: [2, 1], mini: [3, 1] });
    expect(tree).toMatchObject({ width: 2, depth: 4 });
    expect(trunkTree([t('a', 1, 'b'), t('b', 2, 'a')]).nodes).toHaveLength(2); // a loop still shows both
  });

  it('escapes Wi-Fi QR text and makes a QR code', () => {
    expect(wifiQrText('Comms', 'WPA', 'talk;back', false)).toBe('WIFI:T:WPA;S:Comms;P:talk\\;back;;');
    expect(wifiQrText('Open', 'nopass', '', true)).toBe('WIFI:T:nopass;S:Open;H:true;;');
    const rows = qrRows('WIFI:T:WPA;S:Crew;P:loadin-2026-rig;;');
    expect(rows.length).toBeGreaterThanOrEqual(21);
    expect(rows.every((r) => r.length === rows.length && /^[01]+$/.test(r))).toBe(true);
    expect(rows[0]!.slice(0, 7)).toBe('1111111'); // finder pattern
  });
});

describe('client', () => {
  it('reads a UniFi OS console with an API key, pins its certificate, and sends nothing but GETs', async () => {
    const port = await startMock();
    client = new UnifiClient({ host: '127.0.0.1', port, site: 'default', fingerprint: '', credentials: { apiKey: 'k3y' } });
    let pinned = '';
    client.on('fingerprint', (fp) => (pinned = fp));
    client.start();
    await until(() => client!.ready && !!client!.view.health);
    expect(pinned).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(client.kind).toBe('unifi-os');
    expect(client.sites.map((s) => s.name)).toContain('default');
    const v = client.view;
    expect(v.devices[0]!.kind).toBe('gateway');
    expect(v.devices.find((d) => d.name === 'AP Lobby')!.state).toBe('offline');
    expect(v.devices.filter((d) => !d.adopted)).toHaveLength(2);
    const stage = v.devices.find((d) => d.name === 'SW-Stage')!;
    expect(stage.ports).toHaveLength(24);
    expect(stage.ports[0]).toMatchObject({ idx: 1, client: 'Camera 1', networkId: 'net-video', up: true });
    expect(v.wlans.find((w) => w.name === 'Crew')).toMatchObject({ security: 'WPA3', vlan: 10, clients: 38 });
    expect(v.wlans.find((w) => w.name === 'Ops 802.1X')!.qrType).toBe('');
    expect(mock!.changes).toEqual([]);
  });

  it('logs in to a self-hosted controller with a username and password', async () => {
    const port = await startMock({ kind: 'classic', apiKey: undefined });
    client = new UnifiClient({ host: '127.0.0.1', port, site: 'default', fingerprint: '', credentials: { username: 'admin', password: 'pw' } });
    client.start();
    await until(() => client!.ready);
    expect(client.kind).toBe('classic');
    expect(mock!.changes.map((c) => c.path)).toEqual(['/api/login']);
  });

  it('says so when the login is wrong, without retrying fast', async () => {
    const port = await startMock();
    client = new UnifiClient({ host: '127.0.0.1', port, site: 'default', fingerprint: '', credentials: { apiKey: 'wrong' } });
    client.start();
    await until(() => client!.connection === 'disconnected' && !!client!.statusText);
    expect(client.statusText).toMatch(/refused the API key/);
  });

  it('refuses a controller whose certificate is not the pinned one, before sending the key', async () => {
    const port = await startMock({ otherCertificate: true });
    client = new UnifiClient({ host: '127.0.0.1', port, site: 'default', fingerprint: 'AA:BB', credentials: { apiKey: 'k3y' } });
    client.start();
    await until(() => !!client!.certificateSeen);
    expect(client.statusText).toMatch(/certificate changed/);
    expect(mock!.requests).toEqual([]);
  });

  it('says when the site does not exist', async () => {
    const port = await startMock();
    client = new UnifiClient({ host: '127.0.0.1', port, site: 'nope', fingerprint: '', credentials: { apiKey: 'k3y' } });
    client.start();
    await until(() => client!.connection === 'disconnected' && /site/.test(client!.statusText));
  });
});

describe('module', () => {
  it('starts, restores and resumes by only reading', async () => {
    const port = await startMock();
    for (const reason of ['boot', 'restore', 'user'] as const) {
      await startModule(port, { reason, state: { sw: '70:a7:41:00:00:03', selPort: 5, ssid: 'w-crew' }, config: { allowChanges: true } });
      await sim!.close();
      sim = null;
    }
    expect(changes()).toEqual([]);
  });

  it('keeps the credentials out of state and config, and pins the certificate in config', async () => {
    const port = await startMock();
    await startModule(port);
    await until(() => !!sim!.config.fingerprint);
    expect(JSON.stringify(sim!.state)).not.toContain('k3y');
    expect(JSON.stringify(sim!.config)).not.toContain('k3y');
    expect(JSON.stringify(sim!.uiMessages)).not.toContain('k3y');
    expect(last().credentials).toEqual({ apiKey: true, username: '' });
  });

  it('asks for credentials before connecting, and keeps them as module secrets', async () => {
    const port = await startMock();
    sim = await startTestModule(mod, { config: { ...BASE, port } });
    await sim.settle();
    await until(() => sim!.strip.length > 0);
    expect(sim.status?.text).toMatch(/API key/);
    expect(mock!.requests).toEqual([]);
    await sim.sendUi({ type: 'credentials', apiKey: 'k3y' });
    await until(() => last()?.credentials.apiKey === true); // drawn after the file is written
    expect(sim.secrets).toEqual({ apiKey: 'k3y' });
    expect(JSON.stringify(sim.state) + JSON.stringify(sim.config)).not.toContain('k3y');
  });

  it('connects with the secrets it starts with, as after a restore', async () => {
    const port = await startMock();
    sim = await startTestModule(mod, { config: { ...BASE, port }, secrets: { apiKey: 'k3y' }, reason: 'restore' });
    await until(() => last()?.ready === true);
    expect(last()?.credentials).toMatchObject({ apiKey: true });
  });

  it('keeps credentials.json on a controller without secrets', async () => {
    const port = await startMock();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'unifi-old-host-'));
    await writeFile(path.join(dataDir, 'credentials.json'), JSON.stringify({ apiKey: 'k3y' }));
    sim = await startTestModule(mod, { config: { ...BASE, port }, dataDir, noSecrets: true });
    await until(() => last()?.ready === true);
    await sim.sendUi({ type: 'credentials', apiKey: 'n3w' });
    await until(() => sim!.logs.some((l) => l.text === 'Set a new API key')); // after the file is written
    expect(JSON.parse(await readFile(path.join(dataDir, 'credentials.json'), 'utf8'))).toEqual({ apiKey: 'n3w' });
    expect(sim.errors).toEqual([]);
  });

  it('moves credentials.json from an older version into the secrets', async () => {
    const port = await startMock();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'unifi-legacy-'));
    await writeFile(path.join(dataDir, 'credentials.json'), JSON.stringify({ apiKey: 'k3y' }));
    sim = await startTestModule(mod, { config: { ...BASE, port }, dataDir });
    await until(() => last()?.ready === true);
    expect(sim.secrets).toEqual({ apiKey: 'k3y' });
    await expect(readFile(path.join(dataDir, 'credentials.json'))).rejects.toThrow();
  });

  it('shows the overview on the keys', async () => {
    const port = await startMock();
    await startModule(port);
    await until(() => sim!.keys[6]?.label?.startsWith('↓') === true);
    expect(sim!.keys[KEY.OVERVIEW]?.background).toBeTruthy();
    expect(sim!.keys[5]?.label).toBe('ONLINE');
    expect(sim!.keys[8]?.label).toBe('214');
    expect(sim!.keys[9]).toMatchObject({ label: '5/6', sublabel: '1 offline' });
    expect(sim!.keys[KEY.ADOPT]?.sublabel).toBe('2 WAITING');
  });

  it('shows trunks on the keys, coloured by speed and red when busy, and opens one on a press', async () => {
    const port = await startMock();
    await startModule(port);
    await until(() => last()?.trunks?.length === 4); // AP Lobby is offline, so not listed
    expect(sim!.keys[KEY.TRUNKS]).toMatchObject({ label: 'TRUNKS', sublabel: '⚠ 1 BUSY' });
    // Five strip icons where the controller takes them; four (no Trunks) on older ones.
    const ids = sim!.strip.map((i) => i.id);
    expect(ids).toEqual(last()?.trunksIcon ? ['overview', 'switches', 'trunks', 'adopt', 'wifi'] : ['overview', 'switches', 'adopt', 'wifi']);
    await sim!.press(KEY.TRUNKS);
    await until(() => last()?.view === 'trunks');
    const faces = [5, 6, 7, 8].map((i) => sim!.keys[i]!);
    expect(faces.map((f) => f.sublabel)).toEqual(['SW-Core 24', 'AP Stage', 'SW-FOH 24', 'SW-Stage 24']);
    expect(faces[1]).toMatchObject({ background: '#3DD68C' });
    expect(faces[0]).toMatchObject({ label: '2.5G 17%', background: '#7DD3FC' });
    expect(faces[2]).toMatchObject({ background: '#D7263D' });
    expect(faces[2]!.label).toMatch(/^⚠ 1G 9\d%$/);
    expect(faces[3]).toMatchObject({ background: '#2F6BFF' });
    await sim!.press(6); // AP Stage: opens the core switch at the AP's port
    await until(() => last()?.view === 'switches');
    expect(last()?.switch?.name).toBe('SW-Core');
    expect(last()?.selPort).toBe(5);
    await sim!.press(KEY.BACK); // STATS, back out of Switches
    await sim!.press(KEY.TRUNKS);
    await until(() => last()?.view === 'trunks');
    await sim!.press(8);
    await until(() => last()?.view === 'switches');
    expect(last()?.switch?.name).toBe('SW-Stage');
    expect(last()?.selPort).toBe(24);
    expect(changes()).toEqual([]);
  });

  it('will not change ports or adopt with Allow changes off', async () => {
    const port = await startMock();
    await startModule(port);
    await sim!.tapStrip('switches');
    await sim!.press(2);
    await sim!.press(KEY.SAVE, { holdMs: 750 });
    await sim!.sendUi({ type: 'apply-ports', mac: '70:a7:41:00:00:03', changes: [{ idx: 1, networkId: 'net-audio' }] });
    await sim!.sendUi({ type: 'adopt', mac: 'f4:e2:c6:1a:09:3b' });
    expect(changes()).toEqual([]);
    expect(sim!.notifications.at(-1)?.text).toMatch(/Allow changes/);
    expect(sim!.keys[KEY.SAVE]?.label).toBe('VIEW ONLY');
  });

  it('stages VLANs on the keys and applies them only on a held SAVE', async () => {
    const port = await startMock();
    await startModule(port, { config: { allowChanges: true }, state: { sw: '70:a7:41:00:00:03', selPort: 1, ssid: '' } });
    await sim!.tapStrip('switches');
    // Networks sorted by VLAN: Default 1, Mgmt 10, Video 20, Audio 30, Lighting 40, LED 50, Guest 60, Comms 70.
    expect(sim!.keys[2]).toMatchObject({ label: 'VIDEO', sublabel: 'VLAN 20', background: '#006FFF' });
    await sim!.press(3); // Audio for port 1
    await sim!.press(KEY.NEXT);
    await sim!.press(5); // LED for port 2
    expect(last().pending).toEqual([
      [1, 'net-audio'],
      [2, 'net-led']
    ]);
    expect(sim!.keys[KEY.SAVE]?.sublabel).toBe('2 · hold');
    await sim!.press(KEY.SAVE); // a tap does nothing
    expect(changes()).toEqual([]);
    await sim!.press(KEY.SAVE, { holdMs: 750 });
    await until(() => changes().length === 1);
    expect(changes()[0]).toMatchObject({ method: 'PUT', path: '/proxy/network/api/s/default/rest/device/stage' });
    expect(changes()[0]!.body.port_overrides).toEqual([
      { port_idx: 1, native_networkconf_id: 'net-audio' },
      { port_idx: 2, native_networkconf_id: 'net-led' }
    ]);
    await until(() => last().pending.length === 0 && last().switch.ports[0].networkId === 'net-audio');
    expect(sim!.notifications.at(-1)?.text).toBe('Applied 2 port changes to SW-Stage');
  });

  it('reverts staged VLANs without sending anything', async () => {
    const port = await startMock();
    await startModule(port, { config: { allowChanges: true } });
    await sim!.tapStrip('switches');
    await sim!.press(0);
    await sim!.press(KEY.REVERT);
    expect(last().pending).toEqual([]);
    expect(changes()).toEqual([]);
  });

  it('applies the web view port picks for any switch, keeping other overrides', async () => {
    const port = await startMock();
    mock!.devices.find((d) => d._id === 'foh')!.port_overrides = [{ port_idx: 3, name: 'Desk', poe_mode: 'off' }];
    await startModule(port, { config: { allowChanges: true } });
    await sim!.sendUi({ type: 'apply-ports', mac: '70:a7:41:00:00:04', changes: [{ idx: 3, networkId: 'net-video' }] }, 'web1');
    await until(() => changes().length === 1);
    expect(changes()[0]!.body.port_overrides).toEqual([{ port_idx: 3, name: 'Desk', poe_mode: 'off', native_networkconf_id: 'net-video' }]);
  });

  it('adopts a waiting device on a held key', async () => {
    const port = await startMock();
    await startModule(port, { config: { allowChanges: true } });
    await sim!.press(KEY.ADOPT);
    expect(sim!.keys[5]).toMatchObject({ label: 'Switch Fle', sublabel: 'hold: adopt' });
    await sim!.press(5);
    expect(changes()).toEqual([]);
    await sim!.press(5, { holdMs: 750 });
    await until(() => changes().length === 1);
    expect(changes()[0]).toMatchObject({ method: 'POST', body: { cmd: 'adopt', mac: 'f4:e2:c6:1a:09:3b' } });
  });

  it('shows a Wi-Fi password only after the PIN, and only to the client that asked', async () => {
    const port = await startMock();
    let answer = false;
    const asked: (string | undefined)[] = [];
    await startModule(port, { verifyPin: (_reason, clientId) => (asked.push(clientId), answer) });
    await sim!.sendUi({ type: 'reveal', id: 'w-comms' }, 'panel');
    expect(sim!.pinRequests).toEqual(['Show the password for Comms']);
    expect(asked).toEqual(['panel']);
    expect(sim!.uiMessages.some((m) => m.message.type === 'reveal')).toBe(false);
    expect(JSON.stringify(sim!.uiMessages)).not.toContain('talkback');
    expect(sim!.notifications.at(-1)?.text).toMatch(/PIN/);
    answer = true;
    await sim!.sendUi({ type: 'reveal', id: 'w-comms' }, 'panel');
    const r = sim!.uiMessages.find((m) => m.message.type === 'reveal')!;
    expect(r.clientId).toBe('panel');
    expect(r.message).toMatchObject({ name: 'Comms', password: 'talkback;only' });
    expect(r.message.qr.length).toBeGreaterThan(20);
    await sim!.sendUi({ type: 'reveal', id: 'w-ops' }, 'panel');
    expect(sim!.notifications.at(-1)?.text).toMatch(/enterprise/);
    expect(sim!.pinRequests).toHaveLength(2);
  });

  it('stops at a changed certificate until the operator trusts it', async () => {
    const port = await startMock({ otherCertificate: true });
    sim = await startTestModule(mod, { config: { ...BASE, port, fingerprint: 'AA:BB' } });
    await sim.settle();
    await until(() => sim!.strip.length > 0);
    await sim.sendUi({ type: 'credentials', apiKey: 'k3y' });
    await until(() => !!last()?.certificateSeen);
    expect(mock!.requests).toEqual([]);
    await sim.sendUi({ type: 'trust' });
    await until(() => last()?.ready === true);
    expect(sim.config.fingerprint).toBe(last().certificateSeen || sim.config.fingerprint);
    expect(sim.config.fingerprint).not.toBe('AA:BB');
  });

  it('forgets the pinned certificate when the address changes, and checks inputs', async () => {
    const port = await startMock();
    await startModule(port);
    await until(() => !!sim!.config.fingerprint);
    await sim!.sendUi({ type: 'config', config: { address: 'bad address!' } });
    expect(sim!.notifications.at(-1)?.text).toMatch(/not an IP address/);
    await sim!.sendUi({ type: 'config', config: { site: '../x' } });
    expect(sim!.config.site).toBe('default');
    await sim!.sendUi({ type: 'config', config: { address: 'localhost' } });
    expect(sim!.config.address).toBe('localhost');
  });
});

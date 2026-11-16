// What the module shows, made from the UniFi Network API's raw records. Everything here is read
// from the controller on every poll and kept only in memory: none of it is saved.

export type DeviceState = 'online' | 'offline' | 'pending' | 'adopting' | 'provisioning' | 'upgrading' | 'unknown';
export type DeviceKind = 'gateway' | 'switch' | 'ap' | 'other';

export interface Port {
  idx: number;
  name: string;
  up: boolean;
  /** Link speed in Mb/s, 0 when down. */
  speed: number;
  poe: boolean;
  poeWatts: number;
  /** The port's native network (untagged VLAN), or '' when it cannot be told. */
  networkId: string;
  /** A port profile assigned on the controller; changing the VLAN here replaces it. */
  profile: string;
  uplink: boolean;
  /** The wired client the controller sees on this port, if any. */
  client: string;
  /** Traffic in bits per second, as the switch reports it: received and sent on this port. */
  rx: number;
  tx: number;
}

export interface Device {
  id: string;
  mac: string;
  name: string;
  model: string;
  kind: DeviceKind;
  state: DeviceState;
  adopted: boolean;
  ip: string;
  clients: number;
  /** Seconds. */
  uptime: number;
  version: string;
  ports: Port[];
  /** The wired link up to another device, as the controller reports it. */
  uplink: Uplink | null;
}

export interface Uplink {
  /** MAC of the device this one plugs into. */
  mac: string;
  /** That device's port, or 0 when it is not known. */
  remotePort: number;
  /** This device's own port, or 0 when it is not known. */
  localPort: number;
  /** Mb/s. */
  speed: number;
  /** Bits per second, received and sent by this device on the link. */
  rx: number;
  tx: number;
}

/** Link speed bands, coloured the same on the panel, the web view and the keys. */
export type SpeedTier = '100M' | '1G' | '2.5G' | '10G' | '25G' | '';

export interface TrunkEnd {
  mac: string;
  device: string;
  kind: DeviceKind;
  /** 0 when the controller does not say. */
  port: number;
}

/** A wired link between two network devices: switches, gateways and access points. */
export interface Trunk {
  id: string;
  /** The upstream end, closer to the gateway. */
  up: TrunkEnd;
  /** The downstream end: the device whose uplink this is. */
  down: TrunkEnd;
  /** Link speed in Mb/s, 0 when not known. */
  speed: number;
  tier: SpeedTier;
  /** Bits per second flowing towards the downstream device, and back up. */
  toDown: number;
  toUp: number;
  /** The busier direction as a share of the link speed, 0 to 1 (or more, if the counters overshoot). */
  load: number;
  /** Within 90% of the link speed. */
  warn: boolean;
}

export interface Network {
  id: string;
  name: string;
  /** 1 for the untagged default network. */
  vlan: number;
}

export interface Wlan {
  id: string;
  name: string;
  security: string;
  /** 'WPA' or 'nopass' for a join QR code, '' when it cannot have one (enterprise). */
  qrType: 'WPA' | 'nopass' | '';
  bands: string;
  vlan: number;
  clients: number;
  enabled: boolean;
  hidden: boolean;
}

export interface Health {
  wanStatus: 'online' | 'offline' | 'unknown';
  wanIp: string;
  isp: string;
  /** Milliseconds, or null. */
  latency: number | null;
  /** Bits per second. */
  down: number;
  up: number;
  wired: number;
  wireless: number;
}

export interface NetworkView {
  health: Health | null;
  devices: Device[];
  networks: Network[];
  wlans: Wlan[];
  /** WAN bits per second, oldest first: [down, up]. */
  history: [number, number][];
  trunks: Trunk[];
}

export const emptyView = (): NetworkView => ({ health: null, devices: [], networks: [], wlans: [], history: [], trunks: [] });

type Raw = Record<string, any>;

const str = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function deviceState(code: unknown): DeviceState {
  switch (code) {
    case 1:
      return 'online';
    case 0:
    case 6:
    case 9:
    case 10:
    case 11:
      return 'offline';
    case 2:
      return 'pending';
    case 4:
      return 'upgrading';
    case 5:
      return 'provisioning';
    case 7:
      return 'adopting';
    default:
      return 'unknown';
  }
}

function deviceKind(type: unknown): DeviceKind {
  if (type === 'usw') return 'switch';
  if (type === 'uap') return 'ap';
  if (type === 'ugw' || type === 'udm' || type === 'uxg') return 'gateway';
  return 'other';
}

const KIND_ORDER: Record<DeviceKind, number> = { gateway: 0, switch: 1, ap: 2, other: 3 };

/** The native network of a port: an override first, then what the switch reports, then its profile. */
export function nativeNetwork(port: Raw, override: Raw | undefined, portconfs: Map<string, Raw>, defaultNet: string): { networkId: string; profile: string } {
  for (const src of [override, port]) {
    if (!src) continue;
    if (typeof src.native_networkconf_id === 'string' && src.native_networkconf_id) return { networkId: src.native_networkconf_id, profile: '' };
    if (typeof src.portconf_id === 'string' && src.portconf_id) {
      const pc = portconfs.get(src.portconf_id);
      return { networkId: str(pc?.native_networkconf_id) || defaultNet, profile: str(pc?.name, 32) || 'profile' };
    }
  }
  return { networkId: defaultNet, profile: '' };
}

export function parseNetworks(raw: Raw[]): Network[] {
  return raw
    .filter((n) => n && typeof n._id === 'string' && !['wan', 'remote-user-vpn', 'site-vpn', 'vpn-client', 'vpn-server'].includes(n.purpose))
    .map((n) => ({ id: n._id, name: str(n.name, 32) || 'Network', vlan: n.vlan_enabled === false || !n.vlan ? 1 : Number(n.vlan) || 1 }))
    .sort((a, b) => a.vlan - b.vlan || a.name.localeCompare(b.name));
}

/** The untagged network: the one without a VLAN (the LAN called Default on a new site). */
export function defaultNetwork(nets: Network[]): string {
  return nets.find((n) => n.vlan === 1)?.id ?? '';
}

export function parseDevices(raw: Raw[], portconfRaw: Raw[], nets: Network[], clientsRaw: Raw[]): Device[] {
  const portconfs = new Map(portconfRaw.filter((p) => typeof p?._id === 'string').map((p) => [p._id as string, p]));
  const def = defaultNetwork(nets);
  const onPort = new Map<string, string>();
  for (const c of clientsRaw) {
    if (c?.is_wired && typeof c.sw_mac === 'string' && Number.isInteger(c.sw_port)) {
      onPort.set(`${c.sw_mac}:${c.sw_port}`, str(c.name || c.hostname || c.mac, 32));
    }
  }
  return raw
    .filter((d) => d && typeof d.mac === 'string')
    .map((d): Device => {
      const overrides = new Map<number, Raw>((Array.isArray(d.port_overrides) ? d.port_overrides : []).map((o: Raw) => [o.port_idx, o]));
      const ports = (Array.isArray(d.port_table) ? d.port_table : [])
        .filter((p: Raw) => Number.isInteger(p?.port_idx))
        .map((p: Raw): Port => {
          const n = nativeNetwork(p, overrides.get(p.port_idx), portconfs, def);
          return {
            idx: p.port_idx,
            name: str(overrides.get(p.port_idx)?.name ?? p.name, 32) || `Port ${p.port_idx}`,
            up: !!p.up,
            speed: p.up ? num(p.speed) : 0,
            poe: !!p.poe_enable || (typeof p.poe_mode === 'string' && p.poe_mode !== 'off' && !!p.port_poe),
            poeWatts: Number(p.poe_power) || 0,
            networkId: n.networkId,
            profile: n.profile,
            uplink: !!p.is_uplink,
            client: onPort.get(`${d.mac}:${p.port_idx}`) ?? '',
            rx: num(p['rx_bytes-r']) * 8,
            tx: num(p['tx_bytes-r']) * 8
          };
        })
        .sort((a: Port, b: Port) => a.idx - b.idx);
      const kind = deviceKind(d.type);
      const adopted = d.adopted !== false;
      return {
        id: str(d._id),
        mac: d.mac,
        name: str(d.name, 32) || str(d.model_name || d.model, 32) || d.mac,
        model: str(d.model_name || d.model, 32),
        kind,
        state: adopted ? deviceState(d.state) : 'pending',
        adopted,
        ip: str(d.ip, 45),
        clients: num(d.num_sta ?? d['user-num_sta']),
        uptime: num(d.uptime),
        version: str(d.version, 32),
        ports: kind === 'switch' || kind === 'gateway' ? ports : [],
        uplink: parseUplink(d.uplink, ports)
      };
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

function parseUplink(u: Raw | undefined, ports: Port[]): Uplink | null {
  if (!u || typeof u !== 'object' || typeof u.uplink_mac !== 'string' || !u.uplink_mac || (u.type && u.type !== 'wire')) return null;
  const localPort = Number.isInteger(u.port_idx) ? u.port_idx : ports.find((p) => p.uplink)?.idx ?? 0;
  return {
    mac: u.uplink_mac,
    remotePort: Number.isInteger(u.uplink_remote_port) ? u.uplink_remote_port : 0,
    localPort,
    speed: num(u.speed),
    rx: num(u['rx_bytes-r']) * 8,
    tx: num(u['tx_bytes-r']) * 8
  };
}

/** 100 Mb/s and below, up to 1G, up to 2.5G, up to 10G, and above. */
export function speedTier(mbps: number): SpeedTier {
  if (!(mbps > 0)) return '';
  if (mbps <= 100) return '100M';
  if (mbps <= 1000) return '1G';
  if (mbps <= 2500) return '2.5G';
  if (mbps <= 10000) return '10G';
  return '25G';
}

export const TRUNK_WARN = 0.9;

/**
 * The wired links between switches, gateways and access points, from each one's uplink. Clients
 * and wireless (mesh) uplinks are not trunks here. The traffic is what the downstream device counts
 * on its uplink port, or for an access point (which reports no ports), on the switch port it uses.
 */
export function findTrunks(devices: Device[]): Trunk[] {
  const net = devices.filter((d) => d.adopted && d.kind !== 'other');
  const byMac = new Map(net.map((d) => [d.mac.toLowerCase(), d]));
  const out: Trunk[] = [];
  for (const d of net) {
    const u = d.uplink;
    if (!u || d.state === 'offline') continue;
    const parent = byMac.get(u.mac.toLowerCase());
    const local = d.ports.find((p) => p.idx === u.localPort);
    const remote = parent?.ports.find((p) => p.idx === u.remotePort);
    const speed = local?.speed || u.speed || remote?.speed || 0;
    // Downstream's port: receives what flows down, sends what flows up.
    const toDown = local ? local.rx : remote ? remote.tx : u.rx;
    const toUp = local ? local.tx : remote ? remote.rx : u.tx;
    const load = speed ? Math.max(toDown, toUp) / (speed * 1e6) : 0;
    out.push({
      id: `${d.mac}:${u.localPort}`,
      up: { mac: u.mac, device: parent?.name ?? u.mac, kind: parent?.kind ?? 'other', port: u.remotePort },
      down: { mac: d.mac, device: d.name, kind: d.kind, port: u.localPort },
      speed,
      tier: speedTier(speed),
      toDown,
      toUp,
      load,
      warn: load >= TRUNK_WARN
    });
  }
  return out.sort((a, b) => a.up.device.localeCompare(b.up.device) || a.up.port - b.up.port || a.down.device.localeCompare(b.down.device));
}

export interface TreeNode {
  mac: string;
  name: string;
  /** 0 for the top (the gateway, or a switch whose uplink is not a known device). */
  depth: number;
  /** Horizontal position in leaf slots: 0 for the first leaf, fractional for parents. */
  x: number;
}

export interface TrunkTree {
  nodes: TreeNode[];
  /** Leaf slots across, and levels down. */
  width: number;
  depth: number;
}

/** Lays the trunks out as a tree: each device under the one its uplink plugs into, by port. */
export function trunkTree(trunks: Trunk[]): TrunkTree {
  const names = new Map<string, string>();
  const kids = new Map<string, Trunk[]>();
  const isChild = new Set<string>();
  for (const t of trunks) {
    names.set(t.up.mac, t.up.device);
    names.set(t.down.mac, t.down.device);
    isChild.add(t.down.mac);
    kids.set(t.up.mac, [...(kids.get(t.up.mac) ?? []), t]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.up.port - b.up.port || a.down.device.localeCompare(b.down.device));
  const roots = [...names.keys()].filter((m) => !isChild.has(m)).sort((a, b) => names.get(a)!.localeCompare(names.get(b)!));
  const nodes: TreeNode[] = [];
  const seen = new Set<string>();
  let leaf = 0;
  let maxDepth = 0;
  const place = (mac: string, depth: number): number => {
    seen.add(mac);
    maxDepth = Math.max(maxDepth, depth);
    const xs = (kids.get(mac) ?? []).filter((t) => !seen.has(t.down.mac)).map((t) => place(t.down.mac, depth + 1));
    const x = xs.length ? (xs[0]! + xs.at(-1)!) / 2 : leaf++;
    nodes.push({ mac, name: names.get(mac) ?? mac, depth, x });
    return x;
  };
  for (const r of roots) if (!seen.has(r)) place(r, 0);
  for (const m of names.keys()) if (!seen.has(m)) place(m, 0); // a loop of uplinks has no root
  return { nodes, width: Math.max(leaf, 1), depth: maxDepth + 1 };
}

function bands(w: Raw): string {
  const list: string[] = Array.isArray(w.wlan_bands) ? w.wlan_bands : w.wlan_band === 'both' || !w.wlan_band ? ['2g', '5g'] : [w.wlan_band];
  const names: Record<string, string> = { '2g': '2.4', '5g': '5', '6g': '6' };
  return list.map((b) => names[b] ?? b).join(' + ') + ' GHz';
}

function security(w: Raw): { label: string; qr: Wlan['qrType'] } {
  if (w.security === 'open') return { label: 'Open', qr: 'nopass' };
  if (w.security === 'wpaeap') return { label: 'Enterprise', qr: '' };
  const label = w.wpa3_support ? (w.wpa3_transition ? 'WPA2/WPA3' : 'WPA3') : 'WPA2';
  return { label, qr: 'WPA' };
}

export function parseWlans(raw: Raw[], nets: Network[], clientsRaw: Raw[]): Wlan[] {
  const count = new Map<string, number>();
  for (const c of clientsRaw) if (!c?.is_wired && typeof c?.essid === 'string') count.set(c.essid, (count.get(c.essid) ?? 0) + 1);
  return raw
    .filter((w) => w && typeof w._id === 'string')
    .map((w) => {
      const s = security(w);
      const net = nets.find((n) => n.id === w.networkconf_id);
      return {
        id: w._id,
        name: str(w.name, 32),
        security: s.label,
        qrType: s.qr,
        bands: bands(w),
        vlan: net?.vlan ?? (w.vlan_enabled && w.vlan ? Number(w.vlan) : 1),
        clients: count.get(w.name) ?? 0,
        enabled: w.enabled !== false,
        hidden: !!w.hide_ssid
      };
    });
}

export function parseHealth(raw: Raw[]): Health {
  const sub = (name: string) => raw.find((s) => s?.subsystem === name) ?? {};
  const wan = sub('wan');
  const www = sub('www');
  const rate = (k: string) => num(wan[k] ?? www[k]) * 8;
  const st = wan.status ?? www.status;
  return {
    wanStatus: st === 'ok' ? 'online' : st === 'error' || st === 'warning' ? 'offline' : 'unknown',
    wanIp: str(wan.wan_ip, 45),
    isp: str(wan.isp_name || wan.isp_organization, 40),
    latency: typeof www.latency === 'number' ? www.latency : null,
    down: rate('rx_bytes-r'),
    up: rate('tx_bytes-r'),
    wired: num(sub('lan').num_user),
    wireless: num(sub('wlan').num_user)
  };
}

/** The text a phone camera reads to join a Wi-Fi network. */
export function wifiQrText(ssid: string, type: 'WPA' | 'nopass', password: string, hidden: boolean): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');
  return `WIFI:T:${type};S:${esc(ssid)};${type === 'WPA' ? `P:${esc(password)};` : ''}${hidden ? 'H:true;' : ''};`;
}

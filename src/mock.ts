// A pretend UniFi Network controller for development and tests, over HTTPS with a self-signed
// certificate like the real thing. It answers the read endpoints the module polls, accepts adopt and
// port-override changes, and records every request that is not a GET so tests can check that
// nothing was changed without an operator.

import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

type Raw = Record<string, any>;

export interface MockOptions {
  /** 'unifi-os' serves under /proxy/network and logs in at /api/auth/login. */
  kind?: 'unifi-os' | 'classic';
  site?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  /** Use the second test certificate, as if the controller had been replaced. */
  otherCertificate?: boolean;
}

const certDir = new URL('../test/fixtures/', import.meta.url);

const NETS = [
  { id: 'net-default', name: 'Default', vlan: 0 },
  { id: 'net-mgmt', name: 'Mgmt', vlan: 10 },
  { id: 'net-video', name: 'Video', vlan: 20 },
  { id: 'net-audio', name: 'Audio', vlan: 30 },
  { id: 'net-light', name: 'Lighting', vlan: 40 },
  { id: 'net-led', name: 'LED', vlan: 50 },
  { id: 'net-guest', name: 'Guest', vlan: 60 },
  { id: 'net-comms', name: 'Comms', vlan: 70 }
];

const SEED: Record<string, number[]> = {
  core: [10, 10, 10, 10, 0, 0, 20, 20, 30, 30, 40, 50, 50, 60, 60, 70, 70, 0, 0, 0, 10, 10, 10, 10],
  stage: [20, 20, 20, 20, 30, 30, 30, 30, 40, 40, 40, 50, 50, 50, 70, 70, 70, 70, 0, 0, 0, 10, 10, 10],
  foh: [30, 30, 30, 30, 30, 30, 70, 70, 70, 40, 40, 40, 20, 20, 0, 0, 0, 0, 0, 0, 0, 10, 10, 10]
};
const STAGE_CLIENTS = ['Camera 1', 'Camera 2', 'Camera 3', 'PTZ 1', 'Stagebox A', 'Stagebox B', 'Mon mix', 'Wireless RX', 'Light node 1', 'Light node 2', 'Fixture rail', 'LED proc A', 'LED proc B', 'LED proc C', 'Intercom 1', 'Intercom 2'];

const netByVlan = (v: number) => NETS.find((n) => n.vlan === v)!.id;

function switchDevice(id: string, name: string, mac: string, ip: string, uptime: number): Raw {
  return {
    _id: id,
    mac,
    name,
    model: 'USW24P',
    model_name: 'Switch 24 PoE',
    type: 'usw',
    state: 1,
    adopted: true,
    ip,
    num_sta: 20,
    uptime,
    version: '7.1.26',
    port_overrides: [] as Raw[],
    port_table: SEED[id]!.map((vlan, i) => ({
      port_idx: i + 1,
      name: `Port ${i + 1}`,
      up: !(id === 'stage' && i >= 18 && i <= 20) && i % 11 !== 5,
      speed: i >= 22 ? 10000 : 1000,
      poe_enable: i < 16,
      poe_power: i < 16 ? '4.20' : '0.00',
      is_uplink: i === 23,
      native_networkconf_id: netByVlan(vlan)
    }))
  };
}

export class MockUnifi {
  readonly kind: 'unifi-os' | 'classic';
  readonly site: string;
  /** Every request other than a GET, in order. */
  readonly changes: { method: string; path: string; body: any }[] = [];
  /** Every request path, in order. */
  readonly requests: string[] = [];
  devices: Raw[];
  wlans: Raw[];
  online = true;
  private server: https.Server;
  private sessions = new Set<string>();
  private t = 0;

  constructor(private opts: MockOptions = {}) {
    this.kind = opts.kind ?? 'unifi-os';
    this.site = opts.site ?? 'default';
    const day = 86400;
    this.devices = [
      { _id: 'gw', mac: '70:a7:41:00:00:01', name: 'Gateway', model_name: 'Cloud Gateway Ultra', type: 'udm', state: 1, adopted: true, ip: '10.0.1.1', num_sta: 214, uptime: 41 * day, version: '4.1.13', port_table: [] },
      switchDevice('core', 'SW-Core', '70:a7:41:00:00:02', '10.0.10.2', 41 * day),
      switchDevice('stage', 'SW-Stage', '70:a7:41:00:00:03', '10.0.10.3', 3 * day),
      switchDevice('foh', 'SW-FOH', '70:a7:41:00:00:04', '10.0.10.4', 3 * day),
      { _id: 'ap1', mac: '70:a7:41:00:00:21', name: 'AP Stage', model_name: 'U7 Pro', type: 'uap', state: 1, adopted: true, ip: '10.0.10.20', num_sta: 96, uptime: 3 * day, version: '8.0.17' },
      { _id: 'ap2', mac: '70:a7:41:00:00:22', name: 'AP Lobby', model_name: 'U7 Pro', type: 'uap', state: 0, adopted: true, ip: '10.0.10.21', num_sta: 0, uptime: 0, version: '8.0.17' },
      { _id: 'p1', mac: 'f4:e2:c6:1a:09:3b', model_name: 'Switch Flex Mini', type: 'usw', state: 1, adopted: false, ip: '10.0.10.61', version: '7.1.26', port_table: [] },
      { _id: 'p2', mac: 'f4:e2:c6:7d:41:e0', model_name: 'U7 Lite', type: 'uap', state: 1, adopted: false, ip: '10.0.10.62', version: '8.0.17' }
    ];
    this.wlans = [
      { _id: 'w-crew', name: 'Crew', security: 'wpapsk', wpa3_support: true, wpa3_transition: false, x_passphrase: 'loadin-2026-rig', networkconf_id: 'net-mgmt', wlan_bands: ['2g', '5g'], enabled: true },
      { _id: 'w-guest', name: 'Guest', security: 'wpapsk', wpa3_support: false, x_passphrase: 'welcome-show', networkconf_id: 'net-guest', wlan_band: 'both', enabled: true },
      { _id: 'w-comms', name: 'Comms', security: 'wpapsk', wpa3_support: true, wpa3_transition: true, x_passphrase: 'talkback;only', networkconf_id: 'net-comms', wlan_bands: ['5g'], enabled: true },
      { _id: 'w-ops', name: 'Ops 802.1X', security: 'wpaeap', networkconf_id: 'net-mgmt', wlan_bands: ['5g', '6g'], enabled: true }
    ];
    const name = opts.otherCertificate ? 'other' : 'mock';
    this.server = https.createServer(
      { key: readFileSync(new URL(`${name}-key.pem`, certDir)), cert: readFileSync(new URL(`${name}-cert.pem`, certDir)) },
      (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => this.handle(req.method ?? 'GET', req.url ?? '/', req.headers, body, res));
      }
    );
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve((this.server.address() as AddressInfo).port)));
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private authed(headers: Raw): boolean {
    if (this.opts.apiKey && headers['x-api-key'] === this.opts.apiKey) return true;
    const sid = /(?:^|; )(?:TOKEN|unifises)=([^;]+)/.exec(headers.cookie ?? '')?.[1];
    return !!sid && this.sessions.has(sid);
  }

  private handle(method: string, url: string, headers: Raw, body: string, res: import('node:http').ServerResponse): void {
    this.requests.push(`${method} ${url}`);
    const send = (status: number, data: unknown, extra: Raw = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(data));
    };
    const ok = (data: unknown[]) => send(200, { meta: { rc: 'ok' }, data });
    let json: any;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      return send(400, { meta: { rc: 'error', msg: 'api.err.Invalid' } });
    }
    if (method !== 'GET') this.changes.push({ method, path: url, body: json });

    if (url === '/' && method === 'GET') {
      if (this.kind === 'classic') {
        res.writeHead(302, { location: '/manage' });
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<!doctype html><title>UniFi OS</title>');
    }
    const loginPath = this.kind === 'unifi-os' ? '/api/auth/login' : '/api/login';
    if (url === loginPath && method === 'POST') {
      if (!this.opts.username || json?.username !== this.opts.username || json?.password !== this.opts.password) return send(401, { meta: { rc: 'error', msg: 'api.err.Invalid' } });
      const sid = Math.random().toString(36).slice(2);
      this.sessions.add(sid);
      const cookie = this.kind === 'unifi-os' ? `TOKEN=${sid}; path=/; secure; httponly` : `unifises=${sid}; path=/; secure; httponly`;
      return send(200, { meta: { rc: 'ok' }, data: [] }, { 'set-cookie': [cookie], ...(this.kind === 'unifi-os' ? { 'x-csrf-token': 'csrf-' + sid } : {}) });
    }
    const prefix = this.kind === 'unifi-os' ? '/proxy/network' : '';
    if (!url.startsWith(prefix + '/api/')) return send(404, { error: 'not found' });
    if (!this.authed(headers)) return send(401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' } });
    if (this.kind === 'unifi-os' && method !== 'GET' && !headers['x-api-key'] && !String(headers['x-csrf-token'] ?? '').startsWith('csrf-')) {
      return send(403, { meta: { rc: 'error', msg: 'api.err.InvalidCSRF' } });
    }
    const path = url.slice(prefix.length);
    if (path === '/api/self/sites') return ok([{ name: this.site, desc: 'Stage' }, { name: 'tour2', desc: 'Tour B' }]);
    const m = /^\/api\/s\/([^/]+)\/(.+)$/.exec(path);
    if (!m) return send(404, { meta: { rc: 'error', msg: 'api.err.NotFound' } });
    if (decodeURIComponent(m[1]!) !== this.site) return send(400, { meta: { rc: 'error', msg: 'api.err.NoSiteContext' } });
    const rest = m[2]!;

    if (method === 'GET') {
      switch (rest) {
        case 'stat/health':
          return ok(this.health());
        case 'stat/device':
          return ok(this.devices);
        case 'stat/sta':
          return ok(this.clients());
        case 'rest/networkconf':
          return ok([
            ...NETS.map((n) => ({ _id: n.id, name: n.name, purpose: n.vlan === 60 ? 'guest' : 'corporate', vlan_enabled: n.vlan > 0, ...(n.vlan ? { vlan: n.vlan } : {}) })),
            { _id: 'net-wan', name: 'Internet 1', purpose: 'wan' }
          ]);
        case 'rest/wlanconf':
          return ok(this.wlans);
        case 'rest/portconf':
          return ok([]);
      }
      return send(404, { meta: { rc: 'error', msg: 'api.err.NotFound' } });
    }
    if (method === 'POST' && rest === 'cmd/devmgr' && json?.cmd === 'adopt') {
      const d = this.devices.find((x) => x.mac === json.mac && x.adopted === false);
      if (!d) return send(400, { meta: { rc: 'error', msg: 'api.err.UnknownDevice' } });
      d.adopted = true;
      d.state = 7;
      d.name = d.model_name;
      setTimeout(() => (d.state = 1), 1500);
      return ok([]);
    }
    const put = /^rest\/device\/([^/]+)$/.exec(rest);
    if (method === 'PUT' && put) {
      const d = this.devices.find((x) => x._id === decodeURIComponent(put[1]!));
      if (!d || !Array.isArray(json?.port_overrides)) return send(400, { meta: { rc: 'error', msg: 'api.err.Invalid' } });
      d.port_overrides = json.port_overrides;
      for (const o of d.port_overrides) {
        const p = d.port_table?.find((x: Raw) => x.port_idx === o.port_idx);
        if (p && o.native_networkconf_id) p.native_networkconf_id = o.native_networkconf_id;
      }
      return ok([d]);
    }
    return send(404, { meta: { rc: 'error', msg: 'api.err.NotFound' } });
  }

  private health(): Raw[] {
    this.t++;
    const wave = (base: number, amp: number, period: number) => Math.max(0, base + amp * Math.sin(this.t / period) + (Math.random() - 0.5) * amp * 0.6);
    const down = wave(410, 180, 4) * 125_000; // Mb/s to bytes/s
    const up = wave(185, 70, 5) * 125_000;
    return [
      { subsystem: 'wan', status: this.online ? 'ok' : 'error', wan_ip: '203.0.113.24', isp_name: 'Venue Fiber', 'rx_bytes-r': this.online ? down : 0, 'tx_bytes-r': this.online ? up : 0, num_adopted: 6, num_disconnected: 1, num_pending: 2 },
      { subsystem: 'www', status: this.online ? 'ok' : 'error', latency: this.online ? 4 : undefined },
      { subsystem: 'wlan', status: 'ok', num_user: 167, num_ap: 2 },
      { subsystem: 'lan', status: 'ok', num_user: 47, num_sw: 3 }
    ];
  }

  private clients(): Raw[] {
    const stage = this.devices.find((d) => d._id === 'stage')!;
    const wired = STAGE_CLIENTS.map((name, i) => ({ mac: `02:00:00:00:01:${i.toString(16).padStart(2, '0')}`, name, is_wired: true, sw_mac: stage.mac, sw_port: i + 1 }));
    const wireless = [
      ...Array.from({ length: 38 }, (_, i) => ({ mac: `02:00:00:00:02:${i.toString(16).padStart(2, '0')}`, hostname: `crew-${i}`, is_wired: false, essid: 'Crew' })),
      ...Array.from({ length: 112 }, (_, i) => ({ mac: `02:00:00:00:03:${i.toString(16).padStart(2, '0')}`, is_wired: false, essid: 'Guest' })),
      ...Array.from({ length: 14 }, (_, i) => ({ mac: `02:00:00:00:04:${i.toString(16).padStart(2, '0')}`, is_wired: false, essid: 'Comms' }))
    ];
    return [...wired, ...wireless];
  }
}

// A connection to one UniFi Network controller: a UniFi OS console (Dream Machine, Cloud Gateway,
// Cloud Key, UniFi OS Server) or a self-hosted Network application.
//
// Connecting only reads. The client polls with GETs (health every few seconds, devices, clients,
// networks and Wi-Fi more slowly) and mirrors what the controller reports. The two things that
// change the network, adopting a device and setting port VLANs, are separate methods the module
// calls only when the operator asks, and afterwards the client shows what the controller reports,
// never a guess at what the change did.

import { EventEmitter } from 'node:events';
import { CertificateChanged, request, type Response, type Target } from './http.js';
import { emptyView, findTrunks, parseDevices, parseHealth, parseNetworks, parseWlans, type NetworkView } from './model.js';

export type Connection = 'connected' | 'connecting' | 'disconnected';

export interface Credentials {
  /** A UniFi OS API key (Settings › Control Plane › Integrations). Preferred. */
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface ClientOptions {
  host: string;
  port: number;
  site: string;
  fingerprint: string;
  credentials: Credentials;
  /** Health (WAN rates) poll. */
  fastMs?: number;
  /** Devices, clients, networks and Wi-Fi poll. */
  slowMs?: number;
  retryMs?: number;
  retryMaxMs?: number;
  /** Samples of WAN history kept. */
  historyLength?: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export interface Site {
  name: string;
  desc: string;
}

export interface UnifiClient {
  on(event: 'status', fn: (connection: Connection, text: string) => void): this;
  on(event: 'change', fn: (view: NetworkView) => void): this;
  /** First connection to a controller whose certificate was not pinned yet. */
  on(event: 'fingerprint', fn: (fingerprint: string) => void): this;
}

type Raw = Record<string, any>;

export class UnifiClient extends EventEmitter {
  view: NetworkView = emptyView();
  connection: Connection = 'disconnected';
  statusText = '';
  /** True once a full read has come in. */
  ready = false;
  kind: 'unifi-os' | 'classic' | null = null;
  sites: Site[] = [];
  /** Set when the controller's certificate is not the pinned one. Cleared by trusting it. */
  certificateSeen = '';

  private cookie = '';
  private csrf = '';
  private fastTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private stopped = true;
  private generation = 0;
  private passphrases = new Map<string, string>();
  private rawDevices = new Map<string, Raw>();
  private readonly o: Required<Omit<ClientOptions, 'credentials'>> & { credentials: Credentials };

  constructor(opts: ClientOptions) {
    super();
    this.o = { fastMs: 5000, slowMs: 15_000, retryMs: 2000, retryMaxMs: 30_000, historyLength: 60, ...opts };
    this.retryDelay = this.o.retryMs;
  }

  get host(): string {
    return this.o.host;
  }
  get port(): number {
    return this.o.port;
  }
  get site(): string {
    return this.o.site;
  }
  get fingerprint(): string {
    return this.o.fingerprint;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    for (const t of [this.fastTimer, this.slowTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.fastTimer = this.slowTimer = this.retryTimer = null;
    this.ready = false;
    this.setStatus('disconnected', '');
  }

  /** The Wi-Fi password, read from the controller with the rest of the Wi-Fi settings. */
  passphrase(wlanId: string): string | undefined {
    return this.passphrases.get(wlanId);
  }

  // ---- reading ---------------------------------------------------------------------------------

  private setStatus(connection: Connection, text: string): void {
    if (connection === this.connection && text === this.statusText) return;
    this.connection = connection;
    this.statusText = text;
    this.emit('status', connection, text);
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    this.setStatus('connecting', `Connecting to ${this.o.host}`);
    try {
      await this.detect();
      await this.login();
      await this.readSites();
      await this.pollSlow(gen);
      await this.pollFast(gen);
      if (gen !== this.generation) return;
      this.retryDelay = this.o.retryMs;
    } catch (e) {
      this.fail(gen, e);
    }
  }

  private fail(gen: number, e: unknown): void {
    if (gen !== this.generation || this.stopped) return;
    this.generation++;
    for (const t of [this.fastTimer, this.slowTimer]) if (t) clearTimeout(t);
    this.ready = false;
    this.cookie = '';
    if (e instanceof CertificateChanged) {
      this.certificateSeen = e.seen;
      this.setStatus('disconnected', 'The controller certificate changed. Check it, then trust it in Setup.');
      this.emit('change', this.view);
      return; // no retry until the operator trusts the new certificate
    }
    const msg = e instanceof Error ? e.message : String(e);
    this.setStatus('disconnected', msg);
    this.emit('change', this.view);
    const wait = e instanceof ApiError && (e.status === 401 || e.status === 403) ? this.o.retryMaxMs : this.retryDelay;
    this.retryTimer = setTimeout(() => void this.connect(), wait);
    this.retryDelay = Math.min(this.retryDelay * 2, this.o.retryMaxMs);
  }

  private async pollFast(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    try {
      const health = parseHealth(await this.get('stat/health'));
      if (gen !== this.generation) return;
      const h = this.view.history.concat([[health.down, health.up]]);
      this.view = { ...this.view, health, history: h.slice(-this.o.historyLength) };
      this.emit('change', this.view);
      this.fastTimer = setTimeout(() => void this.pollFast(gen), this.o.fastMs);
    } catch (e) {
      this.fail(gen, e);
    }
  }

  private async pollSlow(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    try {
      const [devices, clients, networks, wlans, portconfs] = await Promise.all([
        this.get('stat/device'),
        this.get('stat/sta'),
        this.get('rest/networkconf'),
        this.get('rest/wlanconf'),
        this.get('rest/portconf').catch(() => [])
      ]);
      if (gen !== this.generation) return;
      const nets = parseNetworks(networks);
      this.rawDevices = new Map(devices.filter((d) => typeof d?._id === 'string').map((d) => [d._id, d]));
      this.passphrases = new Map(wlans.filter((w) => typeof w?._id === 'string' && typeof w.x_passphrase === 'string').map((w) => [w._id, w.x_passphrase]));
      const parsed = parseDevices(devices, portconfs, nets, clients);
      this.view = {
        ...this.view,
        devices: parsed,
        trunks: findTrunks(parsed),
        networks: nets,
        wlans: parseWlans(wlans, nets, clients)
      };
      this.ready = true;
      this.setStatus('connected', '');
      this.emit('change', this.view);
      if (this.slowTimer) clearTimeout(this.slowTimer); // a refresh and the timer can overlap
      this.slowTimer = setTimeout(() => void this.pollSlow(gen), this.o.slowMs);
    } catch (e) {
      this.fail(gen, e);
    }
  }

  /** Reads devices, clients and networks again now, after a change. */
  refresh(): Promise<void> {
    return this.ready ? this.pollSlow(this.generation) : Promise.resolve();
  }

  // ---- the HTTP API ----------------------------------------------------------------------------

  private target(): Target {
    return { host: this.o.host, port: this.o.port, fingerprint: this.o.fingerprint };
  }

  private async raw(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { ...extra };
    const c = this.o.credentials;
    if (c.apiKey) headers['x-api-key'] = c.apiKey;
    else if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const res = await request(this.target(), method, path, headers, body);
    if (!this.o.fingerprint) {
      this.o.fingerprint = res.fingerprint;
      this.emit('fingerprint', res.fingerprint);
    }
    const updated = res.headers['x-updated-csrf-token'] ?? res.headers['x-csrf-token'];
    if (typeof updated === 'string' && updated) this.csrf = updated;
    return res;
  }

  /** UniFi OS answers / itself; the self-hosted application redirects to /manage. */
  private async detect(): Promise<void> {
    if (this.o.credentials.apiKey) {
      this.kind = 'unifi-os';
      return;
    }
    const res = await this.raw('GET', '/');
    this.kind = res.status === 200 ? 'unifi-os' : 'classic';
  }

  private async login(): Promise<void> {
    const c = this.o.credentials;
    if (c.apiKey) return;
    if (!c.username || !c.password) throw new ApiError('Add an API key or a username and password in the web view Setup page');
    this.cookie = '';
    this.csrf = '';
    const path = this.kind === 'unifi-os' ? '/api/auth/login' : '/api/login';
    const res = await this.raw('POST', path, { username: c.username, password: c.password, remember: false });
    if (res.status === 401 || res.status === 403 || res.status === 400) throw new ApiError('The controller refused the username or password', res.status);
    if (res.status !== 200) throw new ApiError(`Login failed (HTTP ${res.status})`, res.status);
    const set = res.headers['set-cookie'] ?? [];
    this.cookie = set.map((s) => s.split(';')[0]).join('; ');
    const csrfCookie = set.map((s) => s.split(';')[0]!).find((s) => s.startsWith('csrf_token='));
    if (!this.csrf && csrfCookie) this.csrf = csrfCookie.slice('csrf_token='.length);
  }

  private apiPath(p: string): string {
    return (this.kind === 'unifi-os' ? '/proxy/network' : '') + p;
  }

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<Raw[]> {
    const res = await this.raw(method, this.apiPath(path), body);
    if (res.status === 401 && !retried && !this.o.credentials.apiKey) {
      await this.login(); // the session expired
      return this.call(method, path, body, true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(this.o.credentials.apiKey ? 'The controller refused the API key' : 'The controller refused the login', res.status);
    }
    let json: Raw;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new ApiError(res.status === 404 ? 'Not a UniFi Network controller, or the site does not exist' : `Unexpected answer (HTTP ${res.status})`, res.status);
    }
    if (res.status >= 400 || json?.meta?.rc === 'error') {
      const why = json?.meta?.msg ?? `HTTP ${res.status}`;
      throw new ApiError(why === 'api.err.NoSiteContext' ? `There is no site "${this.o.site}" on this controller` : `The controller said ${why}`, res.status);
    }
    return Array.isArray(json?.data) ? json.data : [];
  }

  private get(p: string): Promise<Raw[]> {
    return this.call('GET', `/api/s/${encodeURIComponent(this.o.site)}/${p}`);
  }

  private async readSites(): Promise<void> {
    try {
      const raw = await this.call('GET', '/api/self/sites');
      this.sites = raw.filter((s) => typeof s?.name === 'string').map((s) => ({ name: s.name, desc: String(s.desc ?? s.name).slice(0, 40) }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw e;
      this.sites = [];
    }
  }

  // ---- changes: only on operator action --------------------------------------------------------

  /** Adopts a device that is waiting on this site. */
  async adopt(mac: string): Promise<void> {
    if (!this.ready) throw new ApiError('Not connected');
    await this.call('POST', `/api/s/${encodeURIComponent(this.o.site)}/cmd/devmgr`, { cmd: 'adopt', mac: mac.toLowerCase() });
    void this.refresh();
  }

  /**
   * Sets the native (untagged) network of some ports on one switch, in one change. Keeps each
   * port's other override settings; a port profile on a changed port is replaced, since a profile
   * carries its own native network.
   */
  async setPortNetworks(deviceId: string, changes: { idx: number; networkId: string }[]): Promise<void> {
    if (!this.ready) throw new ApiError('Not connected');
    const dev = this.rawDevices.get(deviceId);
    if (!dev) throw new ApiError('That switch is no longer on the controller');
    const overrides: Raw[] = (Array.isArray(dev.port_overrides) ? dev.port_overrides : []).map((o: Raw) => ({ ...o }));
    for (const { idx, networkId } of changes) {
      let o = overrides.find((x) => x.port_idx === idx);
      if (!o) overrides.push((o = { port_idx: idx }));
      delete o.portconf_id;
      o.native_networkconf_id = networkId;
    }
    overrides.sort((a, b) => a.port_idx - b.port_idx);
    await this.call('PUT', `/api/s/${encodeURIComponent(this.o.site)}/rest/device/${encodeURIComponent(deviceId)}`, { port_overrides: overrides });
    await this.refresh();
  }
}

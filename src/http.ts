// HTTPS to a UniFi controller, with the certificate pinned on first use.
//
// UniFi consoles and self-hosted controllers use self-signed certificates, so normal verification
// would always fail. Instead each request opens its own TLS connection, checks the certificate's
// SHA-256 fingerprint against the one in config and only then sends the request, so a credential
// never goes to a server that is not the trusted controller. An empty fingerprint trusts whatever
// answers first; the module then stores it.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export class CertificateChanged extends Error {
  constructor(readonly seen: string, readonly expected: string) {
    super('The controller presented a different certificate');
  }
}

export interface Target {
  host: string;
  port: number;
  /** SHA-256 fingerprint as Node prints it (AA:BB:…), or '' to accept any. */
  fingerprint: string;
  timeoutMs?: number;
}

export interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The certificate this response came over. */
  fingerprint: string;
}

const MAX_BODY = 16 * 1024 * 1024;

function connectPinned(t: Target): Promise<{ socket: tls.TLSSocket; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: t.host,
      port: t.port,
      servername: net.isIP(t.host) ? undefined : t.host,
      rejectUnauthorized: false // self-signed: trust comes from the pinned fingerprint below
    });
    const timer = setTimeout(() => socket.destroy(new Error('Timed out connecting')), t.timeoutMs ?? 8000);
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const fingerprint = socket.getPeerCertificate()?.fingerprint256 ?? '';
      if (!fingerprint || (t.fingerprint && fingerprint !== t.fingerprint)) {
        socket.destroy();
        return reject(new CertificateChanged(fingerprint, t.fingerprint));
      }
      socket.removeAllListeners('error');
      resolve({ socket, fingerprint });
    });
  });
}

export async function request(t: Target, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Response> {
  const { socket, fingerprint } = await connectPinned(t);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        path,
        createConnection: () => socket,
        headers: {
          host: t.port === 443 ? t.host : `${t.host}:${t.port}`,
          accept: 'application/json',
          connection: 'close',
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error('Response too large'));
          else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), fingerprint }));
        res.on('error', reject);
      }
    );
    req.setTimeout(t.timeoutMs ?? 8000, () => req.destroy(new Error('Timed out waiting for the controller')));
    req.on('error', reject);
    req.end(payload);
  });
}

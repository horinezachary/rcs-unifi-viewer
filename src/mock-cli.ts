#!/usr/bin/env node
// npm run mock -- [--port 8443] [--classic] [--api-key KEY] [--username U --password P] [--other-cert]
// Starts a pretend UniFi controller with a show-style site. Point the module at 127.0.0.1 and the
// port, and give it the API key (default "mock-api-key") in the web view's Setup page.

import { parseArgs } from 'node:util';
import { MockUnifi } from './mock.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8443' },
    host: { type: 'string', default: '127.0.0.1' },
    classic: { type: 'boolean', default: false },
    'api-key': { type: 'string', default: 'mock-api-key' },
    username: { type: 'string', default: 'admin' },
    password: { type: 'string', default: 'admin' },
    'other-cert': { type: 'boolean', default: false }
  }
});

const mock = new MockUnifi({
  kind: values.classic ? 'classic' : 'unifi-os',
  apiKey: values.classic ? undefined : values['api-key'],
  username: values.username,
  password: values.password,
  otherCertificate: values['other-cert']
});
const port = await mock.listen(Number(values.port), values.host);
console.log(`Mock UniFi ${mock.kind} controller on https://${values.host}:${port}, site "${mock.site}".`);
console.log(values.classic ? `Log in as ${values.username} / ${values.password}.` : `API key "${values['api-key']}", or ${values.username} / ${values.password}.`);
let last = 0;
setInterval(() => {
  const n = mock.changes.length;
  if (n !== last) console.log(`${n} change(s) received; last: ${JSON.stringify(mock.changes.at(-1))}`);
  last = n;
}, 500);

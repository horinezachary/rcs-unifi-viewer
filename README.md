# UniFi Viewer

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module that shows a UniFi
Network site at a glance: WAN health and bandwidth, devices, switch ports and their VLANs, devices
waiting for adoption, and Wi-Fi networks with join QR codes. It talks to a UniFi OS console (Dream
Machine, Cloud Gateway, Cloud Key, UniFi OS Server) or a self-hosted UniFi Network application.

- **Overview**: WAN status, ISP and latency, client counts, devices online, a bandwidth graph of the
  last five minutes and the device list. The Stream Deck shows WAN, down, up, clients and devices.
- **Switches**: every port of a switch, coloured by its native VLAN, with link speed, PoE and the
  device on it. Tap a port, pick a VLAN on keys 1 to 10, then hold SAVE (key 15). The web view has
  a VLAN menu per port and an Apply button.
- **Trunks**: every wired link between switches, access points and the gateway, from each device's uplink, with both
  ends' ports, the link speed and the traffic each way. Links are coloured by speed: up to 100 Mb/s
  gold, 1G green, 2.5G light blue, 10G blue, above that purple. A link whose busier direction is at 90%
  of its speed or more is outlined in red with a warning triangle. On the panel it has its own strip icon
  (on controllers from v0.10; before that, the Trunks button in Switches) and key 3; tap a link's key
  to open its port. List / Tree at the top switches to a tree of the switches, each under the one
  it plugs into, with the links in their speed colours. Traffic refreshes with the device list,
  every 15 s.
- **Adopt**: devices waiting to be adopted. Hold the device's key, or tap Adopt and confirm.
- **Wi-Fi**: each network's bands, security, VLAN and clients. Tap Show for
  the password and a QR code a phone can scan to join. The panel asks for the system PIN first when
  one is set (a web browser signed in with the PIN is not asked again). It hides itself after a minute.
- **Larger Stream Decks** (XL 8×4, Stream Deck + XL 9×4, on controllers from 0.21.0): the five view
  keys stay on the top row and every other key lists devices, trunks or networks; in Switches the rows
  above the bottom one are VLANs, and the bottom row ends with REVERT and SAVE.
- **Setup**: controller address, port and site on the panel; the sign-in (an API key, or a local
  admin's username and password) in the web view.

## The controller is the source of truth

Everything shown is read from the controller every few seconds and kept only in memory: nothing about
the network is saved. State holds which switch, port and Wi-Fi network the panel shows; config holds
the address, port, site, the pinned certificate and the Allow changes switch. Starting, restoring a save, resuming
after a power cut and reconnecting only read (GET requests). The module changes the network only when
someone sets port VLANs or adopts a device, and only with **Allow changes** on in Setup (it is off by
default). After a change it shows what the controller then reports, never a guess.

The API key or password is a module secret: the controller keeps it apart from state and config and
never sends it to a UI. Named saves include it, so restoring a save or loading it on another unit
brings the login back. A downloaded save carries it only sealed with a passphrase you pick, or not at
all. Module Reset or a factory reset removes it. Earlier versions kept it in `credentials.json` in the
data folder; the first start on controller 0.15.0 or later moves it into the secrets. An older
controller has no secrets, so there the module keeps using that file and saves leave the login out.

## Certificates

UniFi controllers use self-signed certificates. The module trusts the certificate it sees on the first
connection and stores its SHA-256 fingerprint in config. Each request checks the fingerprint before
sending anything, so the API key never goes to a different server. If the certificate changes (a new
console, a new certificate), the module stops and Setup shows **Trust new certificate**. Changing the
address forgets the old fingerprint.

## Develop

Node.js 22 or later, and a checkout of the main `rack-control-surface` repo, which holds the SDK
until it is published to npm.

```sh
# next to this folder: git clone …/rack-control-surface && cd rack-control-surface && npm install && npm run build
npm install            # links the SDK from ../rack-control-surface when it is there
npm run link-sdk -- C:\src\rack-control-surface    # or point at a checkout somewhere else (or set RCS_REPO)
npm test               # unit tests against a mock controller and the SDK's fake controller
npm run mock           # a pretend UniFi OS console on https://127.0.0.1:8443 (--classic, --api-key, --other-cert)
npm run dev            # the simulator at http://127.0.0.1:5173/sim with this module
```

In the simulator's web view (http://127.0.0.1:5174), open UniFi Viewer › Setup, set the address
`127.0.0.1`, port `8443`, and the API key `mock-api-key`. `npm ci` clears `node_modules`, so run
`npm run link-sdk` again after it.

Anything that changes live show equipment is developed against the mock first. Check with the owner
before pointing a development build at a production network with Allow changes on.

### What it reads and writes

All under `/proxy/network` on UniFi OS, or at the root on the self-hosted application:

| Request | When |
| --- | --- |
| `GET /api/s/<site>/stat/health` | every 5 s |
| `GET …/stat/device`, `stat/sta`, `rest/networkconf`, `rest/wlanconf`, `rest/portconf` | every 15 s |
| `GET /api/self/sites` | on connect |
| `PUT …/rest/device/<id>` with `port_overrides` | operator saves port VLANs |
| `POST …/cmd/devmgr` `{"cmd":"adopt"}` | operator adopts a device |

A changed port gets `native_networkconf_id` in its override; its other override settings stay, and a
port profile on it is replaced. This is the Network 8 and later model, and it has only been tested
against the mock so far.

## Releasing

Every merge to `main` is a release (`.github/workflows/release.yml`), versioned from the PR title:
`feat:` is a minor bump, `!:` or `BREAKING CHANGE` a major one, anything else a patch; `[skip release]`
skips it. The workflow tests, stamps the version into `module.json`, packs, signs and publishes
`unifi-viewer-<version>.zip` and its `.sig` as a GitHub release here, where units find it through
the module index in [horinezachary/rcs-releases](https://github.com/horinezachary/rcs-releases).

It needs two Actions secrets:

- `RCS_SIGNING_KEY`: the module's private signing key. Make one with
  `node node_modules/@rcs/module-sdk/dist/pack-cli.js keygen`, keep `rcs-signing.key` safe (it is
  git-ignored), and add the printed public key to this module's entry in `index.json` in rcs-releases.
- `RCS_SOURCE_TOKEN`: a fine-grained token with Contents read-only on `rack-control-surface`, so the
  workflows can link the SDK from it. CI uses the tag in `package.json` `rcs.sdkRef`.

## Icon

`assets/icon.svg` is the Ubiquiti "U" mark, taken from [Simple Icons](https://simpleicons.org) 15.0.0
(`ubiquiti.svg`; the drawing is CC0). Ubiquiti, UniFi and the U logo are trademarks of Ubiquiti Inc. The mark is
used only to show which equipment this module works with. This module is not made or endorsed by Ubiquiti.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | The module backend: views, keys, config, sign-in and the messages its UIs send |
| `src/client.ts` | The connection to one controller: sign-in, polling, adopt and port changes |
| `src/http.ts` | HTTPS with the certificate pinned before a request is sent |
| `src/model.ts` | Turning the API's records into what the views show |
| `src/qr.ts`, `vendor/qrcode.cjs` | Wi-Fi join QR codes (qrcode-generator, MIT, Kazuhiko Arase) |
| `src/mock.ts`, `src/mock-cli.ts` | The mock controller; its test certificates are in `test/fixtures` |
| `ui/index.html` | The panel UI, in five views: Overview, Switches, Adopt, Wi-Fi, Setup |
| `web/index.html` | The web view's pages of the same names |
| `scripts/link-sdk.mjs` | Links `@rcs/*` from a main repo checkout |

# PicoGallery

A resource-conscious PhotoPrism display appliance for Raspberry Pi, including
the Pi Zero 2 W. A small Node.js host serves a minimal photo grid/slideshow and
proxies only the PhotoPrism reads required by that display. Cog/WPE WebKit runs
the page fullscreen under Cage/Wayland.

```text
Cog / browser → PicoGallery host :8190 → PhotoPrism viewer account
```

The current release is not a standalone photo server. PhotoPrism remains the
system of record for media, metadata, and search.

## Security model

- Same-device installs bind to `127.0.0.1` by default.
- External binds require a gateway token of at least 24 characters.
- The upstream credential stays server-side and must belong to a dedicated
  least-privilege PhotoPrism viewer account or app password.
- Only configuration, paginated photo listing, and thumbnail/preview reads are
  proxied. Session, account, administrator, download, and mutation endpoints are
  blocked.
- Use a VPN or TLS reverse proxy and firewall for displays crossing an untrusted
  network.

## Repository layout

| Path                                | Purpose                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `scripts/photoprism-host.mjs`       | Hardened static host and narrow PhotoPrism gateway   |
| `scripts/config-loader.mjs`         | Structural PicoGallery TOML configuration loader     |
| `frontend/src/minimal-photo-app.js` | Grid, preview, slideshow, and bounded virtualization |
| `config/kiosk-config-core.mjs`      | Shared browser/host kiosk profile resolver           |
| `kiosk/cog/`                        | Cage/Cog launcher and systemd assets                 |
| `install.sh`                        | Raspberry Pi provisioning and upgrade migration      |

Production installs run a minimal root-owned copy from `/opt/picogallery` under
the non-login `picogallery` account; the service does not run as the checkout
owner.

## Local development

Create an ignored `config.local.toml` from `config.example.toml`, using a
dedicated PhotoPrism viewer credential, then run:

```bash
./run.sh setup
./run.sh build
PICO_CONFIG=./config.local.toml ./run.sh photoprism
```

Open <http://127.0.0.1:8190/library/photos>.

## Raspberry Pi installation

Store the app password in a root-readable one-line file to keep it out of shell
history:

```bash
sudo ./install.sh --mode all \
  --photoprism-url http://photoprism.internal:2342 \
  --photoprism-user frame-viewer \
  --photoprism-pass-file /root/picogallery-app-password
```

Modes:

- `all`: Node host and Cog kiosk on one supported Pi; host binds to loopback.
- `server`: Node host only; binds externally and generates a gateway token.
- `kiosk`: Cog kiosk only, pointed at an existing authenticated host URL.

Original Pi Zero/Zero W ARMv6 devices support kiosk-only mode because modern
Node.js does not support ARMv6.

## Verification

```bash
npm run audit:security
npm run lint
npm test
npm --prefix frontend run lint
npm --prefix frontend run security:scan
npm --prefix frontend test
npm --prefix frontend run test:host-smoke
npm --prefix frontend run build
git diff --exit-code -- frontend/dist
```

CI performs these checks before release, validates shell entrypoints, rebuilds
the production frontend, and smoke-tests the exact release archive.

## Operations

- Liveness: `GET /api/v1/health`
- Authenticated-backend readiness: `GET /api/v1/ready`
- Host logs: `journalctl -u picogallery-photoprism -f`
- Kiosk logs: `journalctl -u picogallery-kiosk -f`
- Post-reboot acceptance: `sudo /opt/picogallery/scripts/pi-canary.sh`
- Detailed diagnostics: `sudo /opt/picogallery/scripts/pi-e2e-diagnose.sh /opt/picogallery`

See the [installation quick reference](install.md),
[architecture](docs/architecture.md), [deployment](docs/deployment.md), and the
[display HTTP contract](docs/api.md) for production details.

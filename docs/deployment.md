# Production Deployment

PicoGallery requires Node.js 22 and a reachable PhotoPrism instance. The
supported source is PhotoPrism; WebDAV and the former standalone slideshow
server are not part of the shipped runtime.

## Credentials and network boundary

Create a dedicated PhotoPrism viewer account or viewer-scoped app password.
Do not configure an administrator credential. Store secrets in
`/etc/picogallery/config.toml` with mode `0640` and never commit that file.

Same-device kiosk deployments should use:

```toml
[http]
host = "127.0.0.1"
port = 8190
```

For a display connecting over the network, explicitly bind externally and add
a random gateway token:

```toml
[http]
host = "0.0.0.0"
port = 8190
auth_token = "replace-with-at-least-24-random-characters"
```

Open the remote kiosk once with
`http://host:8190/library/photos?token=<gateway-token>`. Put the service behind a
VPN or TLS reverse proxy on untrusted networks; the Node host does not terminate
TLS. Firewall port 8190 to display and monitoring addresses only.

Rotate any credential that has appeared in Git history, shell history, logs, or
process arguments. Prefer `--photoprism-pass-file` over
`--photoprism-pass` when using the installer.

## Install

```bash
sudo ./install.sh --mode all \
  --photoprism-url http://photoprism.internal:2342 \
  --photoprism-user frame-viewer \
  --photoprism-pass-file /root/picogallery-app-password
```

`all` mode binds the host to loopback because Cog runs on the same device.
`server` mode binds externally and generates a gateway token in the protected
configuration file. Configure remote kiosk URLs using that token.

The installer copies a root-owned runtime to `/opt/picogallery`, provisions a
dedicated non-login server account, and creates a hardened Node systemd unit. It
also provisions Cage/Cog, seat/input rules, a dedicated kiosk user, readiness
waiting, crash-loop limits, and optional display-power schedules.

## Manual development and verification

```bash
npm ci --ignore-scripts
npm --prefix frontend ci --ignore-scripts
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

Start the host with a development configuration:

```bash
PICO_CONFIG=./config.local.toml ./run.sh photoprism
```

## Health and operations

- `GET /api/v1/health`: Node process liveness.
- `GET /api/v1/ready`: recent authenticated PhotoPrism reachability.
- `GET /api/v1/metrics`: gateway-authenticated request/error counters and RSS.
- Logs: `journalctl -u picogallery-photoprism -f`.
- Kiosk logs: `journalctl -u picogallery-kiosk -f`.

Alert on prolonged readiness failure, repeated host restarts, upstream
authentication failures, memory pressure, swap exhaustion, and WebKit restart
frequency. The host emits no secrets or session tokens in normal logs.

After every Raspberry Pi install, upgrade, or operating-system update, reboot
the device and run the strict hardware canary:

```bash
sudo /opt/picogallery/scripts/pi-canary.sh
```

It exits nonzero unless the host and kiosk services are enabled and active, the
authenticated PhotoPrism backend is ready, the deep SPA route and built assets
are valid, DRM/KMS is available, the current boot has no known Cage/libinput
errors, and a keyboard or mouse is visible to the kernel. For a deliberately
display-only appliance, pass `--allow-no-input`. Use
`scripts/pi-e2e-diagnose.sh` for a detailed, non-failing diagnostic dump.

## Upgrade and rollback

CI rebuilds the committed frontend from source and refuses a release if the
bundle differs. Release archives are smoke-tested after extraction and shipped
with SHA-256 checksums. Keep the previous archive and configuration backup for
rollback; configuration remains backward compatible except that externally
bound legacy installations are migrated to require a gateway token.

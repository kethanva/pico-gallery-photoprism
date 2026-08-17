# PicoGallery installation quick reference

PicoGallery is a PhotoPrism display appliance. PhotoPrism remains the system
of record; this project serves the display UI and a narrow, read-only gateway.
For architecture, API, and operational details, use
[`docs/architecture.md`](docs/architecture.md), [`docs/api.md`](docs/api.md),
and [`docs/deployment.md`](docs/deployment.md).

## Requirements

- Raspberry Pi Zero 2 W or another supported 64-bit/ARMv7 board for server
  modes.
- Raspberry Pi OS Lite 64-bit, network access to PhotoPrism, and a display for
  `all` or `kiosk` mode.
- A dedicated least-privilege PhotoPrism viewer account or app password.
- A protected one-line password file on the Pi; do not place credentials in
  shell history, this repository, or a unit command line.

The original ARMv6 Pi Zero/Zero W can run `kiosk` mode only, with the server on
another host.

## Install from a release archive

On the Pi, install the OS updates and prerequisites, then extract the release
archive. The archive contains the built frontend and the installer, so it does
not build the frontend on the constrained device.

```bash
sudo apt update
sudo apt install -y curl ca-certificates tar
curl -fsSLO https://github.com/kethanva/pico-gallery-photoprism/releases/latest/download/picogallery-release.tar.gz
curl -fsSLO https://github.com/kethanva/pico-gallery-photoprism/releases/latest/download/SHA256SUMS
grep 'picogallery-release.tar.gz$' SHA256SUMS | sha256sum -c -
sudo mkdir -p /opt/picogallery
sudo tar -xzf picogallery-release.tar.gz -C /opt/picogallery
rm picogallery-release.tar.gz SHA256SUMS
```

Create the protected app-password file and install the combined appliance:

```bash
sudo install -m 0600 /dev/null /root/picogallery-app-password
sudo editor /root/picogallery-app-password
sudo /opt/picogallery/install.sh --mode all \
  --photoprism-url http://photoprism.local:2342 \
  --photoprism-user frame-viewer \
  --photoprism-pass-file /root/picogallery-app-password
```

The installer copies a root-owned runtime to `/opt/picogallery`, creates the
non-login `picogallery` service account, installs the hardened systemd units,
and verifies liveness, backend readiness, the public-mode config rewrite, SPA
assets, and kiosk display/input prerequisites.

## Other modes

Install only the Node host (for a separate display device):

```bash
sudo /opt/picogallery/install.sh --mode server \
  --photoprism-url http://photoprism.local:2342 \
  --photoprism-user frame-viewer \
  --photoprism-pass-file /root/picogallery-app-password
```

Install only the Cog/Cage display pointed at an existing PicoGallery host:

```bash
sudo /opt/picogallery/install.sh --mode kiosk \
  --server-url http://gallery-host:8190/library/photos
```

Use `sudo /opt/picogallery/install.sh --help` for all supported flags. Prefer
`--photoprism-pass-file`; `--photoprism-pass` is retained only for controlled
non-interactive environments and may leak through shell history or process
inspection.

## Verify after reboot

Reboot after installation, then run the strict hardware acceptance test:

```bash
sudo reboot
sudo /opt/picogallery/scripts/pi-canary.sh
```

The canary returns nonzero if the host or kiosk is inactive, PhotoPrism is not
authenticated and ready, the deep SPA route or assets are broken, DRM/KMS is
missing, the current boot has display/input errors, or no keyboard/mouse is
visible. For an intentionally display-only setup, use `--allow-no-input`. For
detailed non-failing diagnostics:

```bash
sudo /opt/picogallery/scripts/pi-e2e-diagnose.sh /opt/picogallery
```

Useful checks:

```bash
curl -fsS http://127.0.0.1:8190/api/v1/health
curl -fsS http://127.0.0.1:8190/api/v1/ready
journalctl -u picogallery-photoprism -n 60 --no-pager
journalctl -u picogallery-kiosk -n 60 --no-pager
```

`/api/v1/health` proves only that the Node host is alive. `/api/v1/ready` also
requires a recent authenticated PhotoPrism response. A PhotoPrism `SIGN IN`
page means the upstream credentials or `/api/v1/config` public-mode rewrite
needs attention.

## Development install

For a checkout on a development machine, keep credentials in the ignored
`config.local.toml` and run:

```bash
./run.sh setup
./run.sh build
PICO_CONFIG=./config.local.toml ./run.sh photoprism
```

Open <http://127.0.0.1:8190/library/photos>. Run the complete verification
commands from [`docs/deployment.md`](docs/deployment.md) before producing a
release.

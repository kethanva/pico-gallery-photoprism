# Deployment

PicoGallery V2 needs Node ≥ 22.13 to run the server. The client is static and is
served by the server (or any static host / Vite dev server).

## Config resolution

The server loads the first config file it finds:

1. `$PICO_CONFIG`
2. `~/.config/picogallery/config.toml`
3. `/etc/picogallery/config.toml`

Any key can be overridden with an env var `PICO_<SECTION>_<KEY>` (upper snake),
e.g. `PICO_HTTP_PORT=9000`, `PICO_CACHE_DIR=/var/cache/pico`. Invalid config
aborts startup with a readable error.

## Local (Node)

```bash
./run.sh setup
./run.sh build
PICO_CONFIG=./config.local.toml ./run.sh start
```

`run.sh dev` instead runs the server with `tsx --watch` plus the Vite dev server
(frame on :5173 proxying the API to :8188).

## Docker

```bash
docker compose -f docker/docker-compose.yml up --build
```

- The image builds all packages and runs `server/dist/index.js`.
- Mount your config at `/config/config.toml`.
- Image cache persists in the `pico-cache` named volume (`cache.dir = "/cache"`).
- The compose file brings up a `photoprism` service alongside the frame; the
  bundled config points its `photoprism` source at `http://photoprism:2342`.
  Point it at your own PhotoPrism host instead if you already run one.

Standalone build:

```bash
docker build -f docker/Dockerfile -t picogallery:latest .
docker run -p 8188:8188 \
  -v "$PWD/docker/config:/config:ro" \
  -v pico-cache:/cache picogallery:latest
```

## Raspberry Pi kiosk (Cog + Cage / WPE WebKit)

The canonical display surface is **Cog (WPE WebKit)** under the **Cage** Wayland
kiosk compositor — no X11, no desktop. Cage opens DRM/KMS directly via `seatd`
and forces its single client (Cog) fullscreen.

### What the frame shows on :8188

The default (`photoprism`) source makes the appliance a **PhotoPrism frame**: the
`picogallery.service` unit runs [`scripts/photoprism-host.mjs`](../scripts/photoprism-host.mjs),
which serves the full **PhotoPrism Vue UI** (`frontend/dist`) on `:8188` and
reverse-proxies its API/WebSocket to the real PhotoPrism backend. Cog opens that,
so you get the normal PhotoPrism browse experience; its **native slideshow** is the
display mode and **`Esc` exits** it back to the library (a Cog kiosk delivers `Esc`
to the page, so it works). A `webdav` source has no PhotoPrism UI, so the unit
falls back to the built-in `@pico/server` slideshow client instead.

```bash
sudo ./install.sh http://<server-host>:8188
sudo systemctl start picogallery-kiosk
journalctl -u picogallery-kiosk -f
```

`install.sh` (the V2 replacement for V1's `install.sh`) options:

* `--with-server` — also install a systemd unit for the server from this repo.
* `--blank-on=HH:MM` / `--blank-off=HH:MM` — install a nightly display-blank
  schedule (both required together; omitted = display always on).

What it sets up:

1. Installs `cog`, `cage`, `seatd`; creates the `picokiosk` user in the
   `video`, `render`, `input`, `seat` groups; enables `seatd`.
2. **Launcher** `/usr/local/bin/picogallery-kiosk` (from `kiosk/cog/`): waits for
   the server's **`/api/v1/health`** (up to `WAIT_TIMEOUT`s, then launches anyway)
   so the frame never opens on a "network error" page, then runs
   `cage -- cog --platform=fdo <FRAME_URL>`.
3. **`picogallery-kiosk.service`** — system unit, runs as `picokiosk` on `tty1`
   via `seatd`, `Restart=always` for 24/7 reliability.
4. **`/etc/sudoers.d/picogallery-kiosk`** — tight passwordless allowlist
   (restart kiosk/server, reboot/poweroff only).
5. **`pico-display-power`** + `pico-display-{on,off}.timer` (only with the blank
   flags) — daily display power via `vcgencmd display_power`,
   `/sys/class/backlight/rpi_backlight/bl_power`, or `/sys/class/drm/*/dpms`.
6. Sets `gpu_mem=128` in `config.txt` if unset.

Change the frame URL or wait timeout by editing `/etc/picogallery/kiosk.env` and
`systemctl restart picogallery-kiosk`, or re-run `install.sh`.

Source for the launcher / unit / sudoers / display-power lives in
[`kiosk/cog/`](../kiosk/cog/). The old Qt/QtWebEngine kiosk under `kiosk/src/` is
deprecated — see [`kiosk/DEPRECATED.md`](../kiosk/DEPRECATED.md).

### Mimicking the kiosk off-device

Cog+Cage are Linux/Wayland-only. On macOS (or any non-Wayland host) use the host
browser to preview the production frame (served by the server on port 8188):

```bash
./run.sh kiosk        # opens the frame URL in the default browser; runs real
                      # Cog+Cage instead when invoked on a Linux box that has them
./run.sh appliance    # builds, starts the server, waits for /health, opens the kiosk
```

### Server on the same Pi

If the Pi also runs the server, add a unit like:

```ini
# /etc/systemd/system/picogallery.service
[Unit]
Description=PicoGallery server
After=network-online.target
Wants=network-online.target

[Service]
Environment=NODE_ENV=production
Environment=PICO_CONFIG=/etc/picogallery/config.toml
ExecStart=/usr/bin/node /opt/picogallery/server/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then point the kiosk at `http://localhost:8188`.

## Health & monitoring

- `GET /api/v1/health` — liveness (up as soon as the process binds).
- `GET /api/v1/ready` — readiness (`503` until the playlist is populated).

The Docker image's `HEALTHCHECK` polls `/api/v1/health`.

## Environment variable reference

| Section   | Example env                      | Config key            |
|-----------|----------------------------------|-----------------------|
| http      | `PICO_HTTP_PORT=8188`            | `http.port`           |
| http      | `PICO_HTTP_HOST=0.0.0.0`         | `http.host`           |
| http      | `PICO_HTTP_AUTHTOKEN=secret`     | `http.authToken`      |
| cache     | `PICO_CACHE_DIR=/cache`          | `cache.dir`           |
| cache     | `PICO_CACHE_MAXMB=512`           | `cache.maxMb`         |
| display   | `PICO_DISPLAY_SLIDEDURATIONSECS=10` | `display.slideDurationSecs` |

Overrides apply to existing config sections; section/array tables come from the
TOML file. See [`config.example.toml`](../config.example.toml) for every key.

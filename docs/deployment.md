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

### Two surfaces: slideshow (default) + PhotoPrism UI

The appliance runs **two** systemd units and Cog boots into the slideshow:

| Unit | Serves | Port | Role |
| ---- | ------ | ---- | ---- |
| `picogallery.service` | `@pico/server` → slideshow client (`client/dist`) | `:8188` | **Default** — Cog opens this, so the frame **auto-plays the slideshow at boot**. |
| `picogallery-photoprism.service` | [`scripts/photoprism-host.mjs`](../scripts/photoprism-host.mjs) → PhotoPrism Vue UI (`frontend/dist`) + API proxy | `:8190` | The manage/browse surface the frame hands off to. |

- **Boot → slideshow.** `FRAME_URL=http://…:8188`, so Cog shows the slideshow with
  no interaction.
- **`Esc` (or double right-click) → PhotoPrism UI.** The frame's keyboard handler
  navigates to the PhotoPrism host (`photoprismUrl` from the display config, else
  the same host on `:8190`). Leaving the page stops the slideshow rendering; the
  server engine stays authoritative and resumes if the frame returns.
  Other frame inputs: `←`/`→` prev/next, `Space` pause, `F` (or double
  middle-click) browser fullscreen. In the PhotoPrism lightbox, double
  right-click closes it and `F`/double middle-click toggles fullscreen.
- **Back → slideshow.** The PhotoPrism host injects a floating **"▶ Slideshow"**
  link (→ `/__slideshow` → `302` to `:8188`) so you can return without a reboot.

The second unit is only installed for a `photoprism` source (a `webdav` source has
no PhotoPrism UI). Override the Esc target with `photoprism_url` under `[display]`.

- **Display-only (read-only) by default.** The PhotoPrism host signs requests with
  an admin session, so it enforces read-only itself: non-`GET/HEAD/OPTIONS` API
  requests are rejected with `403`, and the served config hides every mutating UI
  surface (upload, edit, delete, archive, share, download, library, settings) via
  `readonly`, a browse-only ACL, and feature flags. Photos can only be *viewed*
  from the frame. Set `PICO_PP_READONLY=0` in the unit only for a trusted manage
  box.

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
   `cage -- cog --platform=wl <FRAME_URL>`.
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

### Keyboard / mouse detection

Input reaches the page through four layers, each of which the installer now sets
up and `install.sh` verifies layer by layer:

1. **Kernel/USB** — the Pi Zero 2 W has a single micro-B OTG port; leftover
   USB-gadget config (`dtoverlay=dwc2` in peripheral mode, `g_ether` in
   `cmdline.txt` or `/etc/modules`) switches it to *device* mode and the kernel
   never enumerates a keyboard/mouse at all. The installer's **USB host-mode
   guard** detects this, pins `dtoverlay=dwc2,dr_mode=host`, strips gadget
   module autoloads (with `.picogallery.bak` backups), and tells you to reboot.
   A udev rule also disables USB autosuspend so a mouse can't be powered off
   mid-session.
2. **udev seat tag** — wlroots/libinput only opens devices tagged onto `seat0`;
   the installer ships `72-picogallery-seat.rules` and re-triggers input+usb.
3. **Compositor startup race** — the kiosk unit now runs
   `udevadm trigger … + settle` as `ExecStartPre=`, so every kiosk (re)start
   re-applies the seat tag and waits for udev before Cage enumerates. Cold-boot
   ordering can no longer produce a frame with dead input, and hotplugged
   devices are picked up live via the persistent seat rule.
4. **Cog** — `--platform=wl` wires the compositor's `wl_seat` into the page
   (arrow keys, Space, Esc, clicks).

If input is dead, run `sudo ./install.sh` again and read the "Verifying" output:
it distinguishes *kernel sees nothing* (hardware/OTG/power) from *devices
untagged* (udev) from *compositor errors* (kiosk journal).

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

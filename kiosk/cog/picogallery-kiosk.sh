#!/usr/bin/env bash
#
# PicoGallery kiosk launcher — Cog (WPE WebKit) under the Cage Wayland kiosk
# compositor. This is the canonical display surface for the Pi appliance.
#
# Cage is a single-window Wayland compositor: it opens DRM/KMS directly (no X11,
# no desktop) and forces its one client fullscreen. Cog is the WPE WebKit browser
# launcher; run as Cage's child it inherits WAYLAND_DISPLAY and renders the UI.
#
# Configuration comes from /etc/picogallery/kiosk.env (written by install.sh):
#   FRAME_URL       the PhotoPrism UI URL to display (e.g. http://localhost:8190/library/photos)
#   WAIT_TIMEOUT    seconds to wait for the server on boot (default 120; 0 = skip)
#   COG_CONFIG      path to cog.conf WebKit settings (default /etc/picogallery/cog.conf)
#   COG_EXTRA       optional extra args passed to cog (appended after defaults)
#
# This script is invoked by picogallery-kiosk.service. Run it by hand only for
# debugging on the device (it needs seat/DRM access).

set -euo pipefail

ENV_FILE="${PICO_KIOSK_ENV:-/etc/picogallery/kiosk.env}"
CALLER_FRAME_URL="${FRAME_URL:-}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

FRAME_URL="${CALLER_FRAME_URL:-${FRAME_URL:-http://localhost:8190/library/photos}}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-120}"

# Cage/WPE needs a writable XDG_RUNTIME_DIR for its Wayland socket. The systemd
# unit supplies one via RuntimeDirectory=; this fallback covers a manual debug
# launch (e.g. run.sh kiosk) where that isn't set.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/picogallery-kiosk}"
if [ ! -d "$XDG_RUNTIME_DIR" ]; then
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 0700 "$XDG_RUNTIME_DIR"
fi

command -v cage >/dev/null 2>&1 || { echo "cage not installed (apt install cage)" >&2; exit 1; }
command -v cog  >/dev/null 2>&1 || { echo "cog not installed (apt install cog)"  >&2; exit 1; }

# Block until the server is ready, so the UI doesn't open on a "network
# error" page when Wi-Fi or the server is still coming up at boot. Launch anyway
# after the timeout (a reachable server later just loads normally).
wait_for_server() {
  [ "${WAIT_TIMEOUT}" -gt 0 ] 2>/dev/null || return 0
  # FRAME_URL may carry a path/query (e.g. /library/photos
  # autoplaying slideshow); the health endpoints live at the origin.
  #
  # Prefer /api/v1/ready: the picogallery host answers 200 only once the
  # PhotoPrism backend has been reached, so on a cold boot Cog waits for
  # Wi-Fi + backend instead of opening the UI with an empty library. A
  # foreign origin without /ready (404) falls back to plain /health liveness.
  local origin ready_url health_url code start_time now interval=3
  origin="$(printf '%s' "$FRAME_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  ready_url="${origin}/api/v1/ready"
  health_url="${origin}/api/v1/health"
  echo "[kiosk] waiting for ${ready_url} (timeout ${WAIT_TIMEOUT}s)"
  start_time="$(date +%s)"
  while true; do
    now="$(date +%s)"
    if [ "$((now - start_time))" -ge "${WAIT_TIMEOUT}" ]; then
      break
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${ready_url}" 2>/dev/null || echo 000)"
    if [ "${code}" = "200" ]; then
      echo "[kiosk] server ready"; return 0
    fi
    if [ "${code}" = "404" ] && curl -fsS --max-time 5 -o /dev/null "${health_url}" 2>/dev/null; then
      echo "[kiosk] server healthy (no readiness endpoint)"; return 0
    fi
    now="$(date +%s)"
    if [ "$((now - start_time))" -ge "${WAIT_TIMEOUT}" ]; then
      break
    fi
    sleep "${interval}"
  done
  echo "[kiosk] server not ready after ${WAIT_TIMEOUT}s; launching anyway" >&2
}

wait_for_server

# Cold-boot USB race: the unit's `udevadm settle` only waits for *queued* udev
# events — hardware that hasn't electrically enumerated yet (slow hubs and OTG
# adapters take several seconds after power-on) has nothing queued, so settle
# returns and Cage starts with zero input devices. wlroots does pick up later
# hotplug events, but waiting briefly here means the keyboard/mouse work from
# the very first frame instead of depending on that path. Non-fatal: a headless
# frame with no input attached just waits INPUT_WAIT once per boot.
INPUT_WAIT="${INPUT_WAIT:-15}"
wait_for_input() {
  [ "${INPUT_WAIT}" -gt 0 ] 2>/dev/null || return 0
  local start_time now
  start_time="$(date +%s)"
  while true; do
    now="$(date +%s)"
    if [ "$((now - start_time))" -ge "${INPUT_WAIT}" ]; then
      break
    fi
    if grep -qE 'Handlers=.*(kbd|mouse)' /proc/bus/input/devices 2>/dev/null; then
      echo "[kiosk] input devices present (waited $((now - start_time))s)"
      return 0
    fi
    sleep 1
  done
  echo "[kiosk] no keyboard/mouse after ${INPUT_WAIT}s; starting anyway (hotplug still works)" >&2
}

wait_for_input

# WPE/Cog tuning for an always-on display. Under a Wayland compositor (Cage)
# Cog must use the 'wl' platform so the compositor's wl_seat (keyboard/pointer) is
# wired into the web view — the old 'fdo' platform is deprecated (Cog warns
# "Platform module name 'fdo' is deprecated, please use 'wl' instead") and does not
# route input from the compositor into the page, so arrow-key/space slideshow
# control and clicks silently do nothing. WPE_BACKEND=fdo still selects the
# wpebackend-fdo libwpe renderer, which is correct/independent of the Cog platform.
export COG_PLATFORM_NAME="${COG_PLATFORM_NAME:-wl}"
export WPE_BACKEND="${WPE_BACKEND:-fdo}"
# Keep wlroots from tripping on VideoCore hardware cursors.
export WLR_NO_HARDWARE_CURSORS="${WLR_NO_HARDWARE_CURSORS:-1}"

# Cog / WPE WebKit tuning for the 512 MB Pi Zero 2 W.
# Use documented Cog CLI flags and cog.conf [websettings] — ad-hoc WEBKIT_* env
# names (e.g. WEBKIT_MEMORY_PRESSURE_LIMIT) are not read by Cog/WPE.
COG_CONFIG="${COG_CONFIG:-/etc/picogallery/cog.conf}"
# WebKit cache on tmpfs under the runtime dir (cleared each boot; no SD wear).
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${XDG_RUNTIME_DIR}/webkit-cache}"
mkdir -p "$XDG_CACHE_HOME" 2>/dev/null || true

COG_DEFAULT_ARGS=(
  --platform="${COG_PLATFORM_NAME}"
  --bg-color=000000
  --enable-page-cache=false
  --enable-offline-web-application-cache=false
)
if [[ -f "$COG_CONFIG" ]]; then
  COG_DEFAULT_ARGS+=( -C "$COG_CONFIG" )
fi

# shellcheck disable=SC2086
exec cage -- cog \
  "${COG_DEFAULT_ARGS[@]}" \
  ${COG_EXTRA:-} \
  "${FRAME_URL}"

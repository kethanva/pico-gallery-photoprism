#!/usr/bin/env bash
#
# PicoGallery kiosk launcher — Cog (WPE WebKit) under the Cage Wayland kiosk
# compositor. This is the canonical display surface for the Pi appliance.
#
# Cage is a single-window Wayland compositor: it opens DRM/KMS directly (no X11,
# no desktop) and forces its one client fullscreen. Cog is the WPE WebKit browser
# launcher; run as Cage's child it inherits WAYLAND_DISPLAY and renders the frame.
#
# Configuration comes from /etc/picogallery/kiosk.env (written by install.sh):
#   FRAME_URL       the PicoGallery frame to display (e.g. http://localhost:8188)
#   WAIT_TIMEOUT    seconds to wait for the server on boot (default 120; 0 = skip)
#   COG_EXTRA       optional extra args passed to cog
#
# This script is invoked by picogallery-kiosk.service. Run it by hand only for
# debugging on the device (it needs seat/DRM access).

set -euo pipefail

ENV_FILE="${PICO_KIOSK_ENV:-/etc/picogallery/kiosk.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

FRAME_URL="${FRAME_URL:-http://localhost:8188}"
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

# Block until the server answers /health, so the frame doesn't open on a "network
# error" page when Wi-Fi or the server is still coming up at boot. Launch anyway
# after the timeout (a reachable server later just loads normally).
wait_for_server() {
  [ "${WAIT_TIMEOUT}" -gt 0 ] 2>/dev/null || return 0
  local url="${FRAME_URL%/}/api/v1/health" waited=0 interval=3
  echo "[kiosk] waiting for ${url} (timeout ${WAIT_TIMEOUT}s)"
  while [ "${waited}" -lt "${WAIT_TIMEOUT}" ]; do
    if curl -fsS --max-time 5 -o /dev/null "${url}" 2>/dev/null; then
      echo "[kiosk] server ready"; return 0
    fi
    sleep "${interval}"; waited=$(( waited + interval ))
  done
  echo "[kiosk] server not ready after ${WAIT_TIMEOUT}s; launching anyway" >&2
}

wait_for_server

# WPE/Cog tuning for an always-on photo frame. Run as a Wayland client (fdo
# platform) under Cage, on a black background. (No --web-process-count: that is
# not a Cog option; a single web process is Cog's default anyway.)
export COG_PLATFORM_NAME="${COG_PLATFORM_NAME:-fdo}"
export WPE_BACKEND="${WPE_BACKEND:-fdo}"
# Keep wlroots from tripping on VideoCore hardware cursors.
export WLR_NO_HARDWARE_CURSORS="${WLR_NO_HARDWARE_CURSORS:-1}"

# shellcheck disable=SC2086
exec cage -- cog \
  --platform="${COG_PLATFORM_NAME}" \
  --bg-color=000000 \
  ${COG_EXTRA:-} \
  "${FRAME_URL}"

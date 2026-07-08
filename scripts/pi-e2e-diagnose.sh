#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only diagnostics for blank-screen issues on Pi appliances.
# Usage:
#   sudo ./scripts/pi-e2e-diagnose.sh [/path/to/repo]
# Default repo path:
#   /opt/picogallery

REPO_ROOT="${1:-/opt/picogallery}"
ASSETS="$REPO_ROOT/frontend/dist/static/build/assets.json"

echo "=== PicoGallery blank-screen E2E diagnostics ==="
echo "repo: $REPO_ROOT"
echo "time: $(date -Iseconds)"
echo

run() {
  echo "+ $*"
  "$@" || true
  echo
}

run test -d "$REPO_ROOT"
run test -f "$ASSETS"

APP_JS=""
APP_CSS=""
if [[ -f "$ASSETS" ]]; then
  APP_JS="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(m['app.js']||'');" "$ASSETS" 2>/dev/null || true)"
  APP_CSS="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(m['app.css']||'');" "$ASSETS" 2>/dev/null || true)"
fi

echo "resolved app.js: ${APP_JS:-<missing>}"
echo "resolved app.css: ${APP_CSS:-<missing>}"
echo

run ls -lah "$REPO_ROOT/frontend/dist/static/build" | sed -n '1,12p'
run systemctl status picogallery-photoprism --no-pager
run systemctl status picogallery-kiosk --no-pager
run systemctl show picogallery-kiosk -p ExecStart -p Environment
run journalctl -u picogallery-photoprism -n 120 --no-pager
run journalctl -u picogallery-kiosk -n 120 --no-pager

run curl -sS http://localhost:8190/api/v1/health
run curl -sS http://localhost:8190/api/v1/ready
run curl -sSI http://localhost:8190/library/photos
run curl -sSI http://localhost:8190/static/build/assets.json

if [[ -n "$APP_JS" ]]; then
  run curl -sSI "http://localhost:8190/static/build/$APP_JS"
fi
if [[ -n "$APP_CSS" ]]; then
  run curl -sSI "http://localhost:8190/static/build/$APP_CSS"
fi

run ls -lah /home/picokiosk/.cache
run ls -lah /home/picokiosk/.local

# ── Input pipeline (keyboard/mouse) ──────────────────────────────────────────
# Checked layer by layer so a dead keyboard/mouse points at the exact failing
# stage: USB hardware → kernel enumeration → udev seat tag → seatd → compositor.
echo "=== Input pipeline (keyboard/mouse) ==="

echo "--- Layer 1: USB hardware ---"
run lsusb
echo "+ gadget-mode config (dwc2/g_* forces the OTG port out of host mode)"
grep -E 'dwc2|otg_mode' /boot/firmware/config.txt /boot/config.txt 2>/dev/null || echo "  (no dwc2/otg lines — good)"
grep -E 'modules-load' /boot/firmware/cmdline.txt /boot/cmdline.txt 2>/dev/null || echo "  (no modules-load in cmdline — good)"
grep -E '^\s*(g_ether|g_serial|g_mass_storage|g_midi|dwc2)\s*$' /etc/modules 2>/dev/null || echo "  (no gadget modules in /etc/modules — good)"
echo

echo "--- Layer 2: kernel enumeration ---"
run cat /proc/bus/input/devices
echo "+ HID modules"
lsmod 2>/dev/null | grep -E 'usbhid|hid_generic|dwc' || echo "  (usbhid/hid_generic not listed — may be built-in; check Layer 2 devices above)"
echo

echo "--- Layer 3: udev seat tag ---"
run test -f /etc/udev/rules.d/72-picogallery-seat.rules
for ev in /dev/input/event*; do
  [[ -e "$ev" ]] || continue
  echo "+ udevadm info $ev"
  udevadm info "$ev" 2>/dev/null | grep -E 'DEVNAME|ID_INPUT_KEYBOARD|ID_INPUT_MOUSE|ID_SEAT|TAGS' || true
  echo
done

echo "--- Layer 4: seatd + kiosk user access ---"
run systemctl status seatd --no-pager
run ls -la /run/seatd.sock
run id picokiosk
echo

echo "--- Layer 5: compositor (wlroots/libinput) ---"
run systemctl show picogallery-kiosk -p ExecStartPre -p SupplementaryGroups
echo "+ this boot's libinput/seat journal lines"
journalctl -u picogallery-kiosk -b --no-pager 2>/dev/null | grep -iE 'libinput|seat|input|New device|cannot open' | tail -40 || true
echo

echo "=== End diagnostics ==="

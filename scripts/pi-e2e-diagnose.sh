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

echo "=== End diagnostics ==="

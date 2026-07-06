#!/usr/bin/env bash
#
# PicoGallery — runner (PhotoPrism Vue UI)
#
# The appliance serves the PhotoPrism SPA (frontend/dist) through
# scripts/photoprism-host.mjs on :8190 and displays it via the Cog+Cage kiosk.
#
# Usage:
#   ./run.sh setup                 Install root dev dependencies (npm install)
#   ./run.sh build                 Build the PhotoPrism UI (frontend/dist)
#   ./run.sh test                  Run unit tests
#   ./run.sh photoprism [backend]  Serve the PhotoPrism UI + proxy /api/v1
#   ./run.sh kiosk [url]           Open the UI (Cog+Cage on Pi, browser mimic on macOS)
#   ./run.sh appliance [backend]   Host + kiosk together (end-to-end mimic)
#   ./run.sh clean                 Remove node_modules
#
# Environment:
#   PICO_PP_PORT     Port for the UI host (default 8190)
#   PICO_PP_BACKEND  PhotoPrism backend URL (or pass it as an argument)
#   PICO_KIOSK_URL   UI URL override for ./run.sh kiosk
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── Locate Node 20+ ──────────────────────────────────────────────────────────
pick_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [ "$major" -ge 20 ]; then return 0; fi
  fi
  for nvmdir in "$HOME/.nvm/versions/node"/v{22,21,20}.*/bin; do
    if [ -x "$nvmdir/node" ]; then
      export PATH="$nvmdir:$PATH"
      return 0
    fi
  done
  for d in /opt/homebrew/opt/node*/bin /usr/local/opt/node*/bin; do
    if [ -x "$d/node" ]; then
      export PATH="$d:$PATH"
      return 0
    fi
  done
  echo "ERROR: Node 20+ required. Install via nvm: nvm install 22" >&2
  exit 1
}
pick_node

FRONTEND_ASSETS="$ROOT/frontend/dist/static/build/assets.json"

require_frontend_dist() {
  if [ ! -f "$FRONTEND_ASSETS" ]; then
    echo "ERROR: PhotoPrism UI not built ($FRONTEND_ASSETS missing)." >&2
    echo "Run: ./run.sh build" >&2
    exit 1
  fi
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_setup() {
  echo "Node $(node -e 'process.stdout.write(process.version)')"
  npm install
  (cd frontend && npm install --ignore-scripts --no-audit --no-fund --no-update-notifier)
  echo "✓ Dev dependencies installed"
}

cmd_build() {
  (cd frontend && npm run build)
  require_frontend_dist
  echo "✓ PhotoPrism UI built → frontend/dist"
}

cmd_test() {
  TZ=UTC node --test tests/**/*.test.mjs
  (cd frontend && npm run test)
}

cmd_clean() {
  rm -rf node_modules frontend/node_modules frontend/dist
  echo "✓ Cleaned"
}

cmd_photoprism() {
  local backend="${1:-}"
  require_frontend_dist
  exec node scripts/photoprism-host.mjs "$backend"
}

resolve_ui_url() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  if [ -n "${PICO_KIOSK_URL:-}" ]; then echo "$PICO_KIOSK_URL"; return; fi
  echo "http://localhost:${PICO_PP_PORT:-8190}/library/photos"
}

open_in_browser() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"
  else echo "Open this URL manually: $url"; fi
}

cmd_kiosk() {
  local url; url="$(resolve_ui_url "${1:-}")"
  local os; os="$(uname -s)"
  if [ "$os" = "Linux" ] && command -v cage >/dev/null 2>&1 && command -v cog >/dev/null 2>&1; then
    echo "Launching Cog+Cage kiosk → $url"
    PICO_KIOSK_ENV="${PICO_KIOSK_ENV:-/etc/picogallery/kiosk.env}" \
      FRAME_URL="$url" exec "$ROOT/kiosk/cog/picogallery-kiosk.sh"
  fi
  if [ "$os" = "Darwin" ]; then
    echo "macOS: Cog+Cage is Linux-only. Opening PhotoPrism UI in your browser → $url"
  else
    echo "cog/cage not installed; opening PhotoPrism UI in your browser → $url"
    echo "  (on the Pi, run: sudo ./install.sh)"
  fi
  open_in_browser "$url"
}

cmd_appliance() {
  local backend="${1:-}"
  require_frontend_dist
  local port="${PICO_PP_PORT:-8190}"
  echo "Starting PhotoPrism UI host on :$port ..."
  node scripts/photoprism-host.mjs "$backend" &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$port/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  cmd_kiosk "http://localhost:$port/library/photos"
  echo "Appliance running. Press Ctrl+C to stop the host."
  wait "$srv"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

case "${1:-}" in
  setup)      cmd_setup ;;
  build)      cmd_build ;;
  test)       cmd_test ;;
  clean)      cmd_clean ;;
  kiosk)      shift; cmd_kiosk "${1:-}" ;;
  appliance)  shift; cmd_appliance "${1:-}" ;;
  photoprism) shift; cmd_photoprism "${1:-}" ;;
  *)
    echo "PicoGallery"
    echo ""
    echo "Usage: ./run.sh <command>"
    echo ""
    echo "Commands:"
    echo "  setup                 Install dev dependencies (root + frontend)"
    echo "  build                 Build the PhotoPrism UI (frontend/dist)"
    echo "  test                  Run unit tests (host + frontend)"
    echo "  photoprism [backend]  Serve PhotoPrism UI + proxy /api/v1"
    echo "  kiosk [url]           Open the UI (Cog+Cage on Pi, browser elsewhere)"
    echo "  appliance [backend]   Host + kiosk together (end-to-end mimic)"
    echo "  clean                 Remove node_modules and frontend/dist"
    exit 1
    ;;
esac

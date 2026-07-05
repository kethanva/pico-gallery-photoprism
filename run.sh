#!/usr/bin/env bash
#
# PicoGallery — runner (lightweight frame architecture)
#
# The appliance serves the static frame client (frame/) through
# scripts/photoprism-host.mjs on :8190 and displays it via the Cog+Cage kiosk.
#
# Usage:
#   ./run.sh setup                 Install root dev dependencies (npm install)
#   ./run.sh test                  Run unit tests (vitest)
#   ./run.sh photoprism [backend]  Serve the frame + proxy /api/v1 to the backend
#   ./run.sh kiosk [url]           Open the frame (Cog+Cage on Pi, browser mimic on macOS)
#   ./run.sh appliance [backend]   Host + kiosk together (end-to-end mimic)
#   ./run.sh clean                 Remove node_modules
#
# Environment:
#   PICO_PP_PORT     Port for the UI host (default 8190)
#   PICO_PP_BACKEND  PhotoPrism backend URL (or pass it as an argument)
#   PICO_KIOSK_URL   Frame URL override for ./run.sh kiosk
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

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_setup() {
  echo "Node $(node -e 'process.stdout.write(process.version)')"
  npm install
  echo "✓ Dev dependencies installed"
}

cmd_test() {
  TZ=UTC npx vitest run
}

cmd_clean() {
  rm -rf node_modules
  echo "✓ Cleaned"
}

cmd_photoprism() {
  local backend="${1:-}"
  if [ ! -d frame ]; then
    echo "ERROR: frame/ not found." >&2
    exit 1
  fi
  exec node scripts/photoprism-host.mjs "$backend"
}

resolve_frame_url() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  if [ -n "${PICO_KIOSK_URL:-}" ]; then echo "$PICO_KIOSK_URL"; return; fi
  echo "http://localhost:${PICO_PP_PORT:-8190}/"
}

open_in_browser() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"
  else echo "Open this URL manually: $url"; fi
}

cmd_kiosk() {
  local url; url="$(resolve_frame_url "${1:-}")"
  local os; os="$(uname -s)"
  if [ "$os" = "Linux" ] && command -v cage >/dev/null 2>&1 && command -v cog >/dev/null 2>&1; then
    echo "Launching Cog+Cage kiosk → $url"
    PICO_KIOSK_ENV="${PICO_KIOSK_ENV:-/etc/picogallery/kiosk.env}" \
      FRAME_URL="$url" exec "$ROOT/kiosk/cog/picogallery-kiosk.sh"
  fi
  if [ "$os" = "Darwin" ]; then
    echo "macOS: Cog+Cage is Linux-only. Mimicking the frame in your browser → $url"
  else
    echo "cog/cage not installed; mimicking the frame in your browser → $url"
    echo "  (on the Pi, run: sudo ./install.sh)"
  fi
  open_in_browser "$url"
}

cmd_appliance() {
  local backend="${1:-}"
  if [ ! -d frame ]; then
    echo "ERROR: frame/ not found." >&2
    exit 1
  fi
  local port="${PICO_PP_PORT:-8190}"
  echo "Starting frame host on :$port ..."
  node scripts/photoprism-host.mjs "$backend" &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$port/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  cmd_kiosk "http://localhost:$port/"
  echo "Appliance running. Press Ctrl+C to stop the host."
  wait "$srv"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

case "${1:-}" in
  setup)      cmd_setup ;;
  test)       TZ=UTC node --test tests/**/*.test.mjs ;;
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
    echo "  setup                 Install root dev dependencies (npm install)"
    echo "  test                  Run unit tests (node --test)"
    echo "  photoprism [backend]  Serve the frame + proxy /api/v1 to the backend"
    echo "  kiosk [url]           Open the frame (Cog+Cage on Pi, browser mimic elsewhere)"
    echo "  appliance [backend]   Host + kiosk together (end-to-end mimic)"
    echo "  clean                 Remove node_modules"
    exit 1
    ;;
esac

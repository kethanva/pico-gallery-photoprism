#!/usr/bin/env bash
#
# PicoGallery — runner (single-surface PhotoPrism UI architecture)
#
# The appliance serves the vendored PhotoPrism SPA (frontend/dist) through
# scripts/photoprism-host.mjs on :8190 and displays it via the Cog+Cage kiosk.
# The old @pico server/client workspace was removed in ee99a7b — commands that
# built or started it are gone with it.
#
# Usage:
#   ./run.sh setup                 Install frontend dependencies (npm ci)
#   ./run.sh build                 Build the PhotoPrism UI (webpack → frontend/dist)
#   ./run.sh test                  Run the frontend unit tests (vitest)
#   ./run.sh photoprism [backend]  Serve the UI + proxy /api/v1 to the backend
#   ./run.sh kiosk [url]           Open the frame (Cog+Cage on Pi, browser mimic on macOS)
#   ./run.sh appliance [backend]   Host + kiosk together (end-to-end mimic)
#   ./run.sh clean                 Remove frontend build output and node_modules
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
  ( cd frontend && npm ci )
  echo "✓ Frontend dependencies installed"
}

cmd_build() {
  echo "Building PhotoPrism UI (webpack)..."
  ( cd frontend && npm run build )
  # webpack does NOT emit the SPA shell or runtime config into dist — the host
  # (scripts/photoprism-host.mjs) serves frontend/dist/index.html and reads
  # config.json, and install.sh / the release CI copy them in. Mirror that here
  # so `./run.sh build` alone produces a servable dist (otherwise the host 500s
  # on the missing shell).
  [ -f frontend/index.html ] && cp frontend/index.html frontend/dist/index.html
  [ -f frontend/config.json ] && cp frontend/config.json frontend/dist/config.json
  echo "✓ frontend/dist built"
}

cmd_test() {
  ( cd frontend && TZ=UTC npx vitest run )
}

cmd_clean() {
  rm -rf frontend/dist frontend/node_modules node_modules
  echo "✓ Cleaned"
}

cmd_photoprism() {
  # Serve the full PhotoPrism Vue UI (frontend/dist) and reverse-proxy its API
  # to a real PhotoPrism backend. Optional arg overrides the backend URL.
  local backend="${1:-}"
  if [ ! -d frontend/dist ]; then
    echo "ERROR: frontend/dist not found. Build the PhotoPrism UI first:" >&2
    echo "  ./run.sh setup && ./run.sh build" >&2
    exit 1
  fi
  exec node scripts/photoprism-host.mjs "$backend"
}

# Resolve the frame URL: explicit arg > PICO_KIOSK_URL > the local UI host's
# kiosk slideshow entry point (same path the appliance boots with).
resolve_frame_url() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  if [ -n "${PICO_KIOSK_URL:-}" ]; then echo "$PICO_KIOSK_URL"; return; fi
  echo "http://localhost:${PICO_PP_PORT:-8190}/library/photos?kiosk=true"
}

# Open a URL in the host's default browser (cross-platform mimic of the frame).
open_in_browser() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then open "$url"          # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" # Linux desktop
  else echo "Open this URL manually: $url"; fi
}

cmd_kiosk() {
  local url; url="$(resolve_frame_url "${1:-}")"
  local os; os="$(uname -s)"
  if [ "$os" = "Linux" ] && command -v cage >/dev/null 2>&1 && command -v cog >/dev/null 2>&1; then
    # Real appliance surface: Cog (WPE WebKit) under Cage. Needs seat/DRM access;
    # normally run via the systemd unit, but allow a manual launch for debugging.
    echo "Launching Cog+Cage kiosk → $url"
    PICO_KIOSK_ENV="${PICO_KIOSK_ENV:-/etc/picogallery/kiosk.env}" \
      FRAME_URL="$url" exec "$ROOT/kiosk/cog/picogallery-kiosk.sh"
  fi
  # macOS dev box (and Linux without cog/cage): Cog+Cage can't run here, so mimic
  # the frame in the local browser. Install the real stack on the Pi via install.sh.
  if [ "$os" = "Darwin" ]; then
    echo "macOS: Cog+Cage is Linux-only. Mimicking the frame in your browser → $url"
  else
    echo "cog/cage not installed; mimicking the frame in your browser → $url"
    echo "  (on the Pi, run: sudo ./install.sh)"
  fi
  open_in_browser "$url"
}

cmd_appliance() {
  # Mimic the whole appliance end to end: start the UI host in the background,
  # wait for its health endpoint, then open the frame kiosk. Ctrl+C stops both.
  local backend="${1:-}"
  if [ ! -d frontend/dist ]; then
    echo "frontend/dist missing — building first..."
    cmd_build
  fi
  local port="${PICO_PP_PORT:-8190}"
  echo "Starting PhotoPrism UI host on :$port ..."
  node scripts/photoprism-host.mjs "$backend" &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$port/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  cmd_kiosk "http://localhost:$port/library/photos?kiosk=true"
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
    echo "  setup                 Install frontend dependencies (npm ci)"
    echo "  build                 Build the PhotoPrism UI (webpack → frontend/dist)"
    echo "  test                  Run the frontend unit tests (vitest)"
    echo "  photoprism [backend]  Serve the UI + proxy /api/v1 to the backend"
    echo "  kiosk [url]           Open the frame (Cog+Cage on Pi, browser mimic elsewhere)"
    echo "  appliance [backend]   Host + kiosk together (end-to-end mimic)"
    echo "  clean                 Remove frontend build output and node_modules"
    exit 1
    ;;
esac

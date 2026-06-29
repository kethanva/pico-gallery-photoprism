#!/usr/bin/env bash
#
# PicoGallery V2 — runner
#
# Usage:
#   ./run.sh setup            Install all dependencies (pnpm install)
#   ./run.sh dev              Start server + Vite client (hot-reload, port 8188 + 5173)
#   ./run.sh build            Build all packages (shared → server → client)
#   ./run.sh start [cfg]      Build client then start server (production mode)
#   ./run.sh clean            Remove dist dirs and node_modules
#   ./run.sh typecheck        Run tsc --noEmit across all packages
#   ./run.sh kiosk [url]      Open the frame in the kiosk surface
#                             (Cog+Cage WPE WebKit on Linux/Pi; browser mimic on macOS)
#   ./run.sh appliance [cfg]  Mimic the whole appliance: server + frame kiosk together
#
# Environment:
#   PICO_CONFIG   Path to config.toml (default: ~/.config/picogallery/config.toml)
#   NODE_ENV      Set to "production" for start command (default: development)
#
# Config: copy config.example.toml to ~/.config/picogallery/config.toml and edit.
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── Locate Node 20+ ──────────────────────────────────────────────────────────
pick_node() {
  # Check current node version
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [ "$major" -ge 20 ]; then return 0; fi
  fi
  # Try nvm environments
  for nvmdir in "$HOME/.nvm/versions/node"/v{22,21,20}.*/bin; do
    if [ -x "$nvmdir/node" ]; then
      export PATH="$nvmdir:$PATH"
      return 0
    fi
  done
  # Homebrew
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

# ── Locate pnpm ──────────────────────────────────────────────────────────────
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found; installing..." >&2
  npm install -g pnpm@9 --no-fund --no-audit >/dev/null 2>&1
fi

node_version() { node -e 'process.stdout.write(process.version)'; }
pnpm_version() { pnpm --version 2>/dev/null || echo "not found"; }

# ── Config resolution ─────────────────────────────────────────────────────────
# Priority: PICO_CONFIG env > config.local.toml (project root) > ~/.config/picogallery/config.toml
resolve_config() {
  if [ -n "${PICO_CONFIG:-}" ]; then
    echo "$PICO_CONFIG"
    return
  fi
  if [ -f "$ROOT/config.local.toml" ]; then
    echo "$ROOT/config.local.toml"
    return
  fi
  local default="$HOME/.config/picogallery/config.toml"
  if [ -f "$default" ]; then
    echo "$default"
    return
  fi
  echo ""
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_setup() {
  echo "Node $(node_version)  pnpm $(pnpm_version)"
  pnpm install --frozen-lockfile
  echo "✓ Dependencies installed"
}

cmd_dev() {
  local cfg
  cfg="$(resolve_config)"
  if [ -n "$cfg" ]; then
    export PICO_CONFIG="$cfg"
    echo "Config: $cfg"
  else
    echo "WARNING: No config found. Create config.local.toml or ~/.config/picogallery/config.toml" >&2
  fi
  echo "Node $(node_version)  pnpm $(pnpm_version)"
  echo "Starting dev servers — server on :8188, client HMR on :5173"
  echo "Press Ctrl+C to stop."
  exec pnpm dev
}

cmd_build() {
  echo "Building shared → server → client..."
  pnpm --filter @pico/shared build
  pnpm --filter @pico/server build
  pnpm --filter @pico/client build
  echo "✓ Build complete"
}

cmd_start() {
  local explicit_cfg="${1:-}"
  if [ -n "$explicit_cfg" ]; then
    export PICO_CONFIG="$explicit_cfg"
  else
    local cfg
    cfg="$(resolve_config)"
    if [ -n "$cfg" ]; then
      export PICO_CONFIG="$cfg"
      echo "Config: $cfg"
    else
      echo "WARNING: No config found. Create config.local.toml or ~/.config/picogallery/config.toml" >&2
    fi
  fi
  echo "Building shared → server → client..."
  pnpm --filter @pico/shared build
  pnpm --filter @pico/server build
  pnpm --filter @pico/client build
  echo "Starting server (NODE_ENV=production, port ${PICO_HTTP_PORT:-8188})..."
  export NODE_ENV=production
  exec node server/dist/index.js
}

cmd_clean() {
  rm -rf \
    shared/dist \
    server/dist \
    client/dist \
    shared/node_modules \
    server/node_modules \
    client/node_modules \
    node_modules
  echo "✓ Cleaned"
}

cmd_typecheck() {
  pnpm -r typecheck
  echo "✓ All packages typecheck clean"
}

# Resolve the frame URL: explicit arg > PICO_KIOSK_URL > http://localhost:<port>,
# where <port> comes from PICO_HTTP_PORT or the [http] port in the resolved config.
resolve_frame_url() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then echo "$explicit"; return; fi
  if [ -n "${PICO_KIOSK_URL:-}" ]; then echo "$PICO_KIOSK_URL"; return; fi
  local port="${PICO_HTTP_PORT:-}"
  if [ -z "$port" ]; then
    local cfg; cfg="$(resolve_config)"
    if [ -n "$cfg" ] && [ -f "$cfg" ]; then
      port="$(grep -E '^[[:space:]]*port[[:space:]]*=' "$cfg" | head -1 | sed -E 's/[^0-9]//g')"
    fi
  fi
  echo "http://localhost:${port:-8188}"
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
    echo "  (on the Pi, run: sudo ./scripts/install.sh $url)"
  fi
  open_in_browser "$url"
}

cmd_appliance() {
  # Mimic the whole appliance end to end: build, start the server in the
  # background, wait for /health, then open the frame kiosk. Ctrl+C stops both.
  local cfg_arg="${1:-}"
  local cfg; cfg="${cfg_arg:-$(resolve_config)}"
  [ -n "$cfg" ] && export PICO_CONFIG="$cfg"
  echo "Building..."; cmd_build
  local url; url="$(resolve_frame_url)"
  echo "Starting server in background ($url)..."
  NODE_ENV=production node server/dist/index.js &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true' EXIT INT TERM
  # Wait for liveness before opening the frame.
  for _ in $(seq 1 30); do
    if curl -fsS "${url%/}/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  cmd_kiosk "$url"
  echo "Appliance running. Press Ctrl+C to stop the server."
  wait "$srv"
}

cmd_photoprism() {
  # Serve the full PhotoPrism Vue UI (frontend/dist) and reverse-proxy its API
  # to a real PhotoPrism backend. Optional arg overrides the backend URL.
  local backend="${1:-}"
  if [ ! -d frontend/dist ]; then
    echo "ERROR: frontend/dist not found. Build the PhotoPrism UI first:" >&2
    echo "  (cd frontend && npm ci --ignore-scripts && npm run build)" >&2
    exit 1
  fi
  exec node scripts/photoprism-host.mjs "$backend"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

case "${1:-}" in
  setup)     cmd_setup ;;
  dev)       cmd_dev ;;
  build)     cmd_build ;;
  start)     shift; cmd_start "${1:-}" ;;
  clean)     cmd_clean ;;
  typecheck) cmd_typecheck ;;
  kiosk)     shift; cmd_kiosk "${1:-}" ;;
  appliance) shift; cmd_appliance "${1:-}" ;;
  photoprism) shift; cmd_photoprism "${1:-}" ;;
  *)
    echo "PicoGallery V2"
    echo ""
    echo "Usage: ./run.sh <command>"
    echo ""
    echo "Commands:"
    echo "  setup       Install all dependencies (run once after clone)"
    echo "  dev         Start server + Vite HMR (development)"
    echo "  build       Build all packages for production"
    echo "  start [cfg] Build client + start server (production)"
    echo "  clean       Remove dist dirs and node_modules"
    echo "  typecheck   Type-check all packages"
    echo "  kiosk [url] Open the frame kiosk (Cog+Cage on Pi, browser mimic on macOS)"
    echo "  appliance [cfg]  Mimic the whole appliance: server + frame kiosk together"
    echo "  photoprism [backend-url]  Serve full PhotoPrism UI, proxy API to backend"
    echo ""
    echo "Config: copy config.example.toml to ~/.config/picogallery/config.toml"
    exit 1
    ;;
esac

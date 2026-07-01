#!/usr/bin/env bash
#
# PicoGallery V2 — one-click end-to-end installer for Raspberry Pi.
# =============================================================================
# Provisions a Raspberry Pi (Zero / Zero 2 W / 3 / 4 / 5) as a photo frame:
#   • kiosk  — Cog (WPE WebKit) under the Cage Wayland compositor (the display)
#   • server — the Fastify API + slideshow engine (Node), optional on-device
#   • all    — both, on the same Pi
#
# It checks dependencies, fixes what it can, installs packages, builds the app,
# writes configuration + systemd units, and verifies the result — idempotently.
#
# QUICK START
#   Display only (server runs elsewhere):
#     sudo ./install.sh --mode kiosk --server-url http://192.168.1.50:8188
#   Everything on this Pi (Pi Zero 2 W / Pi 4+; needs 64-bit or armv7):
#     sudo ./install.sh --mode all \
#          --photoprism-url http://192.168.68.71:2342 \
#          --photoprism-user admin --photoprism-pass 'secret'
#
# Photos come exclusively from a PhotoPrism backend over the network; the Pi
# never scans a local photo directory. The on-device Node server is a reverse proxy
# host that serves the complete PhotoPrism Vue SPA frontend locally and proxies
# API/WebSocket connections to the backend. Cog opens this frontend on port 8188.
#
# Run `sudo ./install.sh --help` for all options.
#
# Hard constraint: the original Pi Zero / Zero W is ARMv6, which modern Node.js
# does not support — those boards can only run the *kiosk*, pointed at a server
# on another host. The installer detects this and tells you.
# =============================================================================

set -Eeuo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
readonly SCRIPT_VERSION="2.0.0"
readonly SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$SCRIPT_PATH"
readonly KIOSK_ASSETS="$REPO_ROOT/kiosk/cog"
readonly CONFIG_DIR="/etc/picogallery"
readonly CACHE_DIR="/var/cache/picogallery"
readonly LOG_FILE="/var/log/picogallery-install.log"
readonly KIOSK_USER="picokiosk"
readonly SERVER_USER="picogallery"
readonly NODE_MAJOR="22"
readonly SERVER_PORT="8188"

# ── Defaults (overridable by flags) ──────────────────────────────────────────
MODE="auto"                 # auto | kiosk | server | all
SERVER_URL=""               # kiosk target; defaults to localhost in server modes
SOURCE_KIND="photoprism"    # photoprism | webdav  (no local directory source)
PP_URL="http://192.168.68.71:2342" PP_USER="" PP_PASS=""
WEBDAV_URL="" WEBDAV_USER="" WEBDAV_PASS=""
BLANK_ON="" BLANK_OFF=""
ASSUME_YES=0
DRY_RUN=0
DO_UNINSTALL=0
VERBOSE=0

# Detected at runtime
ARCH="" MODEL="" IS_PI=0 RAM_MB=0 DISK_FREE_MB=0 OS_ID="" OS_CODENAME="" BOOT_CFG=""
NODE_OK_ARCH=0              # 1 if this arch can run Node
RUN_USER="" RUN_GROUP=""    # account the server service runs as (repo owner)
MODE_WANTS_SERVER=0 MODE_WANTS_KIOSK=0
REBOOT_REQUIRED=0

# ── Logging ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_DIM=$'\033[2m'
else
  C_RESET="" C_INFO="" C_OK="" C_WARN="" C_ERR="" C_DIM=""
fi

_ts() { date '+%Y-%m-%dT%H:%M:%S'; }
_log() { printf '%s\n' "$*" | tee -a "$LOG_FILE" >/dev/null 2>&1 || true; }
info() { printf '%s[INFO]%s %s\n' "$C_INFO" "$C_RESET" "$*"; _log "[$(_ts)] [INFO] $*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$C_OK"   "$C_RESET" "$*"; _log "[$(_ts)] [ OK ] $*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; _log "[$(_ts)] [WARN] $*"; }
err()  { printf '%s[FAIL]%s %s\n' "$C_ERR"  "$C_RESET" "$*" >&2; _log "[$(_ts)] [FAIL] $*"; }
step() { printf '\n%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; _log "[$(_ts)] ==> $*"; }
debug(){ [[ "$VERBOSE" -eq 1 ]] && printf '%s      %s%s\n' "$C_DIM" "$*" "$C_RESET" || true; }
die()  { err "$*"; exit 1; }

# Error trap: report the failing line + command, then hint at the log.
on_err() {
  local exit_code=$? line=$1 cmd=$2
  err "Aborted (exit $exit_code) at line $line: $cmd"
  err "See $LOG_FILE for the full log. The installer is idempotent — fix the cause and re-run."
  exit "$exit_code"
}
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR

# ── Helpers ──────────────────────────────────────────────────────────────────
# run <cmd...> — execute (or echo in --dry-run), logging the command.
run() {
  debug "\$ $*"
  _log "[$(_ts)] \$ $*"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"
    return 0
  fi
  "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  local prompt="$1"
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  local ans
  read -r -p "$prompt [y/N] " ans || true
  [[ "$ans" =~ ^[Yy] ]]
}

valid_url()  { [[ "$1" =~ ^https?://[^[:space:]]+$ ]]; }
valid_hhmm() { [[ "$1" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; }

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
PicoGallery (PhotoPrism UI Kiosk) installer v$SCRIPT_VERSION

Usage: sudo ./install.sh [options]

Modes (--mode):
  auto      Pick a sensible mode for this board (default)
  kiosk     Install only the Cog+Cage display; requires --server-url
  server    Install only the Node server (no display)
  all       Install server + kiosk on this Pi

Options:
  --mode <m>                auto|kiosk|server|all
  --server-url <url>        Frame/API URL the kiosk opens (kiosk mode)
  --source <kind>           photoprism|webdav  (server modes; default: photoprism)
  --photoprism-url <url>    PhotoPrism base URL (default: http://192.168.68.71:2342)
  --photoprism-user <u>     PhotoPrism username
  --photoprism-pass <p>     PhotoPrism password (or app password)
  --webdav-url <url>        WebDAV base URL
  --webdav-user <u>         WebDAV username
  --webdav-pass <p>         WebDAV password
  --blank-on <HH:MM>        Blank the display at this time (needs --blank-off)
  --blank-off <HH:MM>       Wake the display at this time
  -y, --yes                 Don't prompt; accept safe defaults
  --dry-run                 Print actions without changing the system
  --verbose                 Verbose output
  --uninstall               Remove PicoGallery services, users, and config
  -h, --help                This help

Examples:
  sudo ./install.sh --mode kiosk --server-url http://192.168.1.50:8188
  sudo ./install.sh --mode all \\
       --photoprism-url http://192.168.68.71:2342 --photoprism-user admin --photoprism-pass secret -y
EOF
}

# ── Argument parsing ─────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode)            MODE="${2:?}"; shift 2 ;;
      --server-url)      SERVER_URL="${2:?}"; shift 2 ;;
      --source)          SOURCE_KIND="${2:?}"; shift 2 ;;
      --photoprism-url)  PP_URL="${2:?}"; shift 2 ;;
      --photoprism-user) PP_USER="${2:?}"; shift 2 ;;
      --photoprism-pass) PP_PASS="${2:?}"; shift 2 ;;
      --webdav-url)      WEBDAV_URL="${2:?}"; shift 2 ;;
      --webdav-user)     WEBDAV_USER="${2:?}"; shift 2 ;;
      --webdav-pass)     WEBDAV_PASS="${2:?}"; shift 2 ;;
      --blank-on)        BLANK_ON="${2:?}"; shift 2 ;;
      --blank-off)       BLANK_OFF="${2:?}"; shift 2 ;;
      -y|--yes)          ASSUME_YES=1; shift ;;
      --dry-run)         DRY_RUN=1; shift ;;
      --verbose)         VERBOSE=1; shift ;;
      --uninstall)       DO_UNINSTALL=1; shift ;;
      -h|--help)         usage; exit 0 ;;
      http://*|https://*) SERVER_URL="$1"; shift ;;   # bare URL = kiosk target
      *) die "Unknown option: $1 (try --help)" ;;
    esac
  done
}

# ── Platform detection ───────────────────────────────────────────────────────
detect_platform() {
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64|armv7l|x86_64|amd64) NODE_OK_ARCH=1 ;;
    armv6l) NODE_OK_ARCH=0 ;;
    *) NODE_OK_ARCH=0 ;;
  esac

  if [[ -r /proc/device-tree/model ]]; then
    MODEL="$(tr -d '\0' </proc/device-tree/model)"
    [[ "$MODEL" == *"Raspberry Pi"* ]] && IS_PI=1
  fi

  RAM_MB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
  DISK_FREE_MB=$(df -Pm / | awk 'NR==2{print $4}')

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"; OS_CODENAME="${VERSION_CODENAME:-}"
  fi

  if   [[ -f /boot/firmware/config.txt ]]; then BOOT_CFG="/boot/firmware/config.txt"
  elif [[ -f /boot/config.txt ]];          then BOOT_CFG="/boot/config.txt"
  else BOOT_CFG=""; fi

  info "Board:  ${MODEL:-unknown}  (arch $ARCH, ${RAM_MB} MB RAM, ${DISK_FREE_MB} MB free on /)"
  info "OS:     ${OS_ID:-unknown} ${OS_CODENAME:-} ; Node-capable arch: $([[ $NODE_OK_ARCH -eq 1 ]] && echo yes || echo NO)"
}

# Resolve MODE=auto into a concrete mode and validate arch/inputs.
resolve_mode() {
  if [[ "$MODE" == "auto" ]]; then
    if [[ "$NODE_OK_ARCH" -eq 0 ]]; then
      MODE="kiosk"
      warn "ARMv6 board: the server can't run here (Node unsupported). Choosing kiosk mode."
    elif [[ -f "$REPO_ROOT/package.json" ]]; then
      MODE="all"
    else
      MODE="kiosk"
    fi
    info "Resolved --mode auto → $MODE"
  fi

  case "$MODE" in kiosk|server|all) ;; *) die "Invalid --mode '$MODE'";; esac

  local wants_server=0 wants_kiosk=0
  [[ "$MODE" == server || "$MODE" == all ]] && wants_server=1
  [[ "$MODE" == kiosk  || "$MODE" == all ]] && wants_kiosk=1

  if [[ "$wants_server" -eq 1 && "$NODE_OK_ARCH" -eq 0 ]]; then
    die "Server mode needs a 64-bit or ARMv7 board (Node has no ARMv6 build). Use --mode kiosk and run the server on another host."
  fi
  if [[ "$wants_server" -eq 1 && ! -f "$REPO_ROOT/package.json" ]]; then
    die "Server mode must run from a full repo checkout (no package.json at $REPO_ROOT)."
  fi

  # Frame URL: local server in server modes; explicit in kiosk-only.
  if [[ "$wants_server" -eq 1 ]]; then
    SERVER_URL="${SERVER_URL:-http://localhost:$SERVER_PORT}"
  fi
  if [[ "$wants_kiosk" -eq 1 && -z "$SERVER_URL" ]]; then
    die "Kiosk mode needs --server-url (where the PicoGallery server is reachable)."
  fi
  [[ -n "$SERVER_URL" ]] && { valid_url "$SERVER_URL" || die "Invalid --server-url: $SERVER_URL"; }

  # Blank window sanity.
  if [[ -n "$BLANK_ON$BLANK_OFF" ]]; then
    [[ -n "$BLANK_ON" && -n "$BLANK_OFF" ]] || die "--blank-on and --blank-off must be given together."
    valid_hhmm "$BLANK_ON"  || die "--blank-on must be HH:MM"
    valid_hhmm "$BLANK_OFF" || die "--blank-off must be HH:MM"
  fi

  MODE_WANTS_SERVER=$wants_server
  MODE_WANTS_KIOSK=$wants_kiosk
}

# ── Preflight ────────────────────────────────────────────────────────────────
preflight() {
  [[ "$(uname -s)" == "Linux" ]] || die "This installer is for Linux (Raspberry Pi). On macOS use ./run.sh kiosk to preview the frame."
  [[ $EUID -eq 0 ]] || die "Run with sudo (installs packages, users, and systemd units)."

  if [[ "$REPO_ROOT" == /tmp* ]] || [[ "$REPO_ROOT" == /var/tmp* ]]; then
    die "Cannot install from $REPO_ROOT. The systemd service uses PrivateTmp=true for security and will fail. Please extract the release to /opt/picogallery and run it from there."
  fi

  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  : >>"$LOG_FILE" 2>/dev/null || true
  info "Logging to $LOG_FILE"

  [[ "$IS_PI" -eq 1 ]] || warn "Not detected as a Raspberry Pi — continuing anyway (useful for testing)."

  # Disk space: kiosk needs little; building the server needs room for node_modules
  # (~800 MB) and, on low-RAM boards, the ~1 GB build swapfile we add to / as well.
  local need_mb=400
  if [[ "$MODE_WANTS_SERVER" -eq 1 ]]; then
    need_mb=1500
    local cur_swap; cur_swap=$(( $(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
    if (( RAM_MB < 900 && cur_swap < 900 )); then need_mb=$(( need_mb + 1100 )); fi
  fi
  if (( DISK_FREE_MB < need_mb )); then
    die "Low disk space: ${DISK_FREE_MB} MB free, need ~${need_mb} MB. Expand the filesystem (raspi-config) or free space."
  fi

  # Network: apt + NodeSource + npm registry must be reachable.
  if ! run_quiet getent hosts deb.debian.org && ! ping -c1 -W2 deb.debian.org >/dev/null 2>&1; then
    warn "Could not resolve deb.debian.org — check networking/DNS before installing packages."
  fi

  ok "Preflight checks passed (mode=$MODE)."
}
run_quiet() { "$@" >/dev/null 2>&1; }

# ── apt ──────────────────────────────────────────────────────────────────────
APT_REFRESHED=0
apt_refresh() {
  [[ "$APT_REFRESHED" -eq 1 ]] && return 0
  step "Updating package lists"
  export DEBIAN_FRONTEND=noninteractive
  run apt-get update -qq
  APT_REFRESHED=1
}

# apt_install <pkg...> — install only what's missing, with one retry.
apt_install() {
  local missing=()
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [[ ${#missing[@]} -eq 0 ]] && { debug "already present: $*"; return 0; }
  apt_refresh
  info "Installing: ${missing[*]}"
  if ! run apt-get install -y --no-install-recommends "${missing[@]}"; then
    warn "Install failed; refreshing and retrying once…"
    run apt-get update -qq
    run apt-get install -y --no-install-recommends "${missing[@]}"
  fi
}

# ── Steps ────────────────────────────────────────────────────────────────────
step_base_packages() {
  step "Base dependencies"
  apt_install ca-certificates curl gnupg
}

# Cage/wlroots needs the KMS DRM driver; ensure it + a GPU memory split.
step_kms_boot() {
  [[ "$IS_PI" -eq 1 && -n "$BOOT_CFG" ]] || { debug "no Pi boot config; skipping KMS/gpu_mem"; return 0; }
  step "Display/boot configuration ($BOOT_CFG)"
  if ! grep -qE '^\s*dtoverlay=vc4-kms-v3d' "$BOOT_CFG"; then
    info "Enabling KMS driver (dtoverlay=vc4-kms-v3d) — required by Cage"
    run bash -c "printf '\n# Added by PicoGallery installer (Cage/WPE needs KMS)\ndtoverlay=vc4-kms-v3d\n' >> '$BOOT_CFG'"
    REBOOT_REQUIRED=1
  else
    debug "KMS driver already enabled"
  fi
  if ! grep -qE '^\s*gpu_mem=' "$BOOT_CFG"; then
    # Under the full KMS driver the GPU allocates from CMA on demand, so a big
    # gpu_mem reservation just steals system RAM. Reserve little on 512 MB
    # boards (Pi Zero 2 W) where server+kiosk share the memory.
    local gpu_mem=128
    if (( RAM_MB <= 640 )); then gpu_mem=64; fi
    info "Setting gpu_mem=$gpu_mem"
    run bash -c "printf 'gpu_mem=$gpu_mem\n' >> '$BOOT_CFG'"
    REBOOT_REQUIRED=1
  fi
}

# Building the server on a 512 MB Pi needs swap or it OOM-kills.
step_swap() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  (( RAM_MB >= 900 )) && { debug "RAM ${RAM_MB} MB — no extra swap needed"; return 0; }
  local cur_swap; cur_swap=$(( $(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
  (( cur_swap >= 900 )) && { debug "swap ${cur_swap} MB already adequate"; return 0; }
  step "Ensuring build swap (${RAM_MB} MB RAM is tight for the Node build)"
  if have dphys-swapfile; then
    if [[ -f /etc/dphys-swapfile ]]; then
      run sed -i 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
      run dphys-swapfile setup
      run dphys-swapfile swapon
    fi
  else
    local sf=/var/swap.picogallery
    if [[ ! -f "$sf" ]]; then
      info "Creating 1 GB swapfile at $sf"
      run fallocate -l 1G "$sf" || run dd if=/dev/zero of="$sf" bs=1M count=1024
      run chmod 600 "$sf"; run mkswap "$sf"
    fi
    run swapon "$sf" || true
    # Persist it: the 512 MB runtime (Node server + WebKit kiosk) also benefits
    # from swap as an OOM cushion, not just the build.
    if [[ "$DRY_RUN" -eq 0 ]] && ! grep -q "$sf" /etc/fstab 2>/dev/null; then
      printf '%s none swap sw 0 0\n' "$sf" >> /etc/fstab
    fi
  fi
  ok "Swap ready (build + runtime cushion)."
}

# Install Node (NodeSource) for arm64/armv7/x86_64; gate ARMv6 out.
step_node() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0

  # If a pre-packaged release is used (node_modules already populated), we only need node
  if [[ -d "$REPO_ROOT/node_modules" ]]; then
    step "Node.js $NODE_MAJOR"
    if have node && [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]]; then
      ok "Node $(node -v) already installed"
    else
      [[ "$NODE_OK_ARCH" -eq 1 ]] || die "No Node $NODE_MAJOR build for arch $ARCH."
      info "Installing Node $NODE_MAJOR from NodeSource"
      run bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x -o /tmp/nodesource_setup.sh"
      run bash /tmp/nodesource_setup.sh
      apt_install nodejs
      have node || die "Node install failed."
      ok "Installed Node $(node -v)"
    fi
    return 0
  fi

  step "Node.js $NODE_MAJOR + pnpm"
  if have node && [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]]; then
    ok "Node $(node -v) already installed"
  else
    [[ "$NODE_OK_ARCH" -eq 1 ]] || die "No Node $NODE_MAJOR build for arch $ARCH."
    info "Installing Node $NODE_MAJOR from NodeSource"
    run bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x -o /tmp/nodesource_setup.sh"
    run bash /tmp/nodesource_setup.sh
    apt_install nodejs
    have node || die "Node install failed."
    ok "Installed Node $(node -v)"
  fi
  # pnpm via corepack (ships with Node) — no global npm needed.
  if ! have pnpm; then
    info "Activating pnpm via corepack"
    run corepack enable || true
    run corepack prepare pnpm@9.15.9 --activate || run npm install -g pnpm@9 --no-fund --no-audit
  fi
  have pnpm || die "pnpm unavailable after corepack/npm."
  ok "pnpm $(pnpm --version 2>/dev/null)"
}

# Install workspace deps + build shared→server→client (resource-capped for small Pis).
step_build() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0

  local heap=1024
  if (( RAM_MB < 900 )); then heap=460; fi
  local nopts="--max-old-space-size=$heap"

  if [[ -f "$REPO_ROOT/server/dist/index.js" ]]; then
    step "Setting up PicoGallery from pre-built artifact"
    if [[ ! -d "$REPO_ROOT/frontend/dist" ]]; then
      info "Building PhotoPrism frontend Vue SPA (missing in workspace)"
      ( cd "$REPO_ROOT/frontend" && run npm ci && run npm run build )
    fi
    if [[ "$DRY_RUN" -ne 1 ]]; then
      mkdir -p "$REPO_ROOT/frontend/dist"
      [[ -f "$REPO_ROOT/frontend/index.html" ]] && cp "$REPO_ROOT/frontend/index.html" "$REPO_ROOT/frontend/dist/index.html" || true
      [[ -f "$REPO_ROOT/frontend/config.json" ]] && cp "$REPO_ROOT/frontend/config.json" "$REPO_ROOT/frontend/dist/config.json" || true
    fi
    if [[ -d "$REPO_ROOT/node_modules" ]]; then
      ok "Pre-packaged node_modules found — skipping package installation."
      return 0
    fi
    info "Installing production dependencies only"
    local frozen_rc=0
    trap - ERR; set +e
    ( cd "$REPO_ROOT" && run env NODE_OPTIONS="$nopts" pnpm install --prod --frozen-lockfile )
    frozen_rc=$?
    set -e; trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR
    if (( frozen_rc != 0 )); then
      warn "Frozen install failed — retrying without --frozen-lockfile"
      ( cd "$REPO_ROOT" && run env NODE_OPTIONS="$nopts" pnpm install --prod --no-frozen-lockfile )
    fi
    ok "Dependencies installed"
    return 0
  fi

  step "Building PicoGallery (the slow part on a Pi — minutes on a Zero 2 W)"
  # Cap the V8 heap so a 512 MB board builds against swap instead of OOM-killing.
  info "Installing workspace dependencies (Node heap capped at ${heap} MB)"
  # Prefer the committed lockfile for reproducibility; fall back to a normal
  # install if it ever drifts, so a fresh checkout still provisions cleanly.
  # Clear the ERR trap around the probe (set -E would otherwise fire it inside
  # the subshell and print a spurious "Aborted" before we recover).
  local frozen_rc=0
  trap - ERR; set +e
  ( cd "$REPO_ROOT" && run env NODE_OPTIONS="$nopts" pnpm install --frozen-lockfile )
  frozen_rc=$?
  set -e; trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR
  if (( frozen_rc != 0 )); then
    warn "Frozen install failed (lockfile drift?) — retrying without --frozen-lockfile"
    ( cd "$REPO_ROOT" && run env NODE_OPTIONS="$nopts" pnpm install --no-frozen-lockfile )
  fi

  # Build serially: parallel tsc + vite OOMs a 512 MB Pi. pnpm keeps topological
  # order with concurrency 1, so shared builds before server and client.
  info "Building shared → server → client (serial, low-memory)"
  ( cd "$REPO_ROOT" && run env NODE_OPTIONS="$nopts" pnpm -r --workspace-concurrency=1 run build )
  
  if [[ ! -d "$REPO_ROOT/frontend/dist" ]]; then
    info "Building PhotoPrism frontend Vue SPA"
    ( cd "$REPO_ROOT/frontend" && run npm ci && run npm run build )
  fi

  if [[ "$DRY_RUN" -ne 1 ]]; then
    mkdir -p "$REPO_ROOT/frontend/dist"
    [[ -f "$REPO_ROOT/frontend/index.html" ]] && cp "$REPO_ROOT/frontend/index.html" "$REPO_ROOT/frontend/dist/index.html" || true
    [[ -f "$REPO_ROOT/frontend/config.json" ]] && cp "$REPO_ROOT/frontend/config.json" "$REPO_ROOT/frontend/dist/config.json" || true
  fi
  
  [[ "$DRY_RUN" -eq 1 ]] || [[ -f "$REPO_ROOT/server/dist/index.js" ]] || die "Build did not produce server/dist/index.js"
  [[ "$DRY_RUN" -eq 1 ]] || [[ -d "$REPO_ROOT/frontend/dist" ]] || die "Build did not produce frontend/dist"
  ok "Build complete"
}

# Generate /etc/picogallery/config.toml from the chosen source (0640, server-readable).
step_server_config() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  step "Server configuration ($CONFIG_DIR/config.toml)"
  run install -d -m 0755 "$CONFIG_DIR"
  local cfg="$CONFIG_DIR/config.toml"
  if [[ -f "$cfg" ]] && ! confirm "Config exists at $cfg — overwrite?"; then
    info "Keeping existing config."
    return 0
  fi

  local source_block=""
  case "$SOURCE_KIND" in
    photoprism)
      [[ -n "$PP_URL" ]] || die "--photoprism-url required for --source photoprism"
      valid_url "$PP_URL" || die "Invalid --photoprism-url"
      [[ -n "$PP_USER" ]] || die "--photoprism-user required (PhotoPrism login). Pass --photoprism-user/--photoprism-pass or edit $cfg after install."
      [[ -n "$PP_PASS" ]] || warn "No --photoprism-pass given — login will fail unless PhotoPrism is public. Set the password in $cfg."
      source_block=$(cat <<EOF
[[sources]]
name             = "photoprism"
enabled          = true
url              = "$PP_URL"
username         = "$PP_USER"
password         = "$PP_PASS"
include_private  = false
include_archived = false
EOF
)
      ;;
    webdav)
      [[ -n "$WEBDAV_URL" ]] || die "--webdav-url required for --source webdav"
      valid_url "$WEBDAV_URL" || die "Invalid --webdav-url"
      source_block=$(cat <<EOF
[[sources]]
name     = "webdav"
enabled  = true
url      = "$WEBDAV_URL"
username = "$WEBDAV_USER"
password = "$WEBDAV_PASS"
EOF
)
      ;;
    *) die "Invalid --source '$SOURCE_KIND' (photoprism|webdav)";;
  esac

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s would write %s\n' "$C_DIM" "$C_RESET" "$cfg"
  else
    umask 027
    cat >"$cfg" <<EOF
# PicoGallery V2 — generated by install.sh on $(_ts). Edit and restart the service.
[display]
slide_duration_secs = 10
transition          = "fade"
order               = "shuffle"
on_this_day_boost   = true

[cache]
dir    = "$CACHE_DIR"
max_mb = 512

[http]
host = "0.0.0.0"
port = $SERVER_PORT

$source_block
EOF
    chmod 0640 "$cfg"
  fi
  ok "Wrote $cfg (source: $SOURCE_KIND)"
}

# Run the server as the *owner of the repo*, not a fresh system user: a system
# user can't traverse a clone under /home/<user> (plain Unix dir perms), so it
# couldn't read server/dist. The repo owner always can. Cache + config are made
# readable/writable to that account.
step_server_user() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  step "Server run-user + cache"
  RUN_USER="$(stat -c '%U' "$REPO_ROOT" 2>/dev/null || true)"
  [[ -z "$RUN_USER" || "$RUN_USER" == "UNKNOWN" ]] && RUN_USER="${SUDO_USER:-root}"
  RUN_GROUP="$(id -gn "$RUN_USER" 2>/dev/null || echo "$RUN_USER")"
  info "Server will run as '$RUN_USER:$RUN_GROUP' (owner of $REPO_ROOT)"
  run install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 "$CACHE_DIR"
  # Let the run-user read its config (secrets stay non-world-readable).
  if [[ -f "$CONFIG_DIR/config.toml" ]]; then
    run chgrp "$RUN_GROUP" "$CONFIG_DIR/config.toml" || true
    run chmod 0640 "$CONFIG_DIR/config.toml" || true
  fi
}

step_server_unit() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  step "Server systemd unit"
  local node_bin; node_bin="$(command -v node || echo /usr/bin/node)"
  # On a 512 MB board the server shares RAM with the WebKit kiosk; bound the V8
  # heap so a long-running playlist/cache can't balloon and OOM the frame.
  local runtime_env=""
  if (( RAM_MB < 900 )); then runtime_env="Environment=NODE_OPTIONS=--max-old-space-size=256"; fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s would write /etc/systemd/system/picogallery.service\n' "$C_DIM" "$C_RESET"
  else
    cat >/etc/systemd/system/picogallery.service <<EOF
[Unit]
Description=PicoGallery server
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_GROUP
Environment=NODE_ENV=production
Environment=PICO_CONFIG=$CONFIG_DIR/config.toml
$runtime_env
Environment=PICO_PP_PORT=8188
WorkingDirectory=$REPO_ROOT
ExecStart=$node_bin $REPO_ROOT/server/dist/index.js
Restart=always
RestartSec=3
# Hardening (server only reads the repo + writes the cache)
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=$CACHE_DIR

[Install]
WantedBy=multi-user.target
EOF
  fi
  run systemctl daemon-reload
  run systemctl enable picogallery.service
  run systemctl restart picogallery.service
  ok "picogallery.service enabled"
}

# Ensure input devices are tagged onto seat0 so wlroots/libinput (under Cage) can
# open them. Idempotent: writes the rule, reloads udev, and re-triggers input add
# events so the running system picks it up without a reboot.
SEAT_UDEV_RULE="/etc/udev/rules.d/72-picogallery-seat.rules"
install_seat_udev_rule() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s would write %s and re-trigger input devices\n' "$C_DIM" "$C_RESET" "$SEAT_UDEV_RULE"
    return 0
  fi
  cat >"$SEAT_UDEV_RULE" <<'EOF'
# PicoGallery: assign input devices to seat0 so the Cage/wlroots kiosk can read
# keyboards and mice. Needed on images where logind isn't tagging seats (DietPi).
SUBSYSTEM=="input", TAG+="seat"

# Disable USB autosuspend for all USB devices to prevent minimal distributions (DietPi)
# from turning off power to the mouse sensor/keyboard when they are inactive.
ACTION=="add", SUBSYSTEM=="usb", TEST=="power/control", ATTR{power/control}="on"
EOF
  chmod 0644 "$SEAT_UDEV_RULE"
  run udevadm control --reload
  run udevadm trigger --subsystem-match=input --action=add
  ok "Seat udev rule installed (input devices tagged onto seat0)"
}

# Remove kiosk units left by earlier versions of this project. It was renamed over
# its life (pico-google-photos → photoprism-kiosk → picogallery), and each older
# installer/hand-setup left a differently-named kiosk unit behind:
#   • pico-google-photos.service — the retired Cage + Chromium frame
#   • photoprism-kiosk.service    — the retired Qt6/QtWebEngine app
#   • pico-kiosk.service, pico-wait-online.service — older repo unit set
# A survivor is fatal: two kiosks both grab tty1 + the DRM master + the seat with no
# mutual Conflicts, so they race, neither paints, and the console hangs at
# multi-user.target (exactly the boot-hang seen on the device). Purge every unit in
# this project's `pico-*` / `photoprism-*` namespaces except the ones we currently own.
purge_legacy_kiosk() {
  local owned=" picogallery.service picogallery-kiosk.service pico-display-on.service pico-display-off.service pico-display-on.timer pico-display-off.timer "
  local removed=0 path base
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    base="$(basename "$path")"
    [[ "$owned" == *" $base "* ]] && continue      # never touch a unit we own
    removed=1
    warn "Removing stale kiosk unit (fights the frame for tty1/DRM): $base"
    run systemctl disable --now "$base" 2>/dev/null || true
    run rm -f "$path"
    run rm -rf "/etc/systemd/system/${base}.d"
    run systemctl reset-failed "$base" 2>/dev/null || true
  done < <( (ls /etc/systemd/system/pico-*.service \
                 /etc/systemd/system/pico-*.timer \
                 /etc/systemd/system/photoprism-*.service \
                 /run/systemd/system/pico-*.service \
                 /lib/systemd/system/pico-google-photos.service 2>/dev/null || true) | sort -u)
  if [[ "$removed" -eq 1 ]]; then
    run systemctl daemon-reload
    ok "Removed conflicting legacy kiosk unit(s)"
  else
    debug "no legacy kiosk units present"
  fi
}

# Cog + Cage kiosk: packages, user, env, launcher, unit, sudoers, optional blank timers.
step_kiosk() {
  [[ "$MODE_WANTS_KIOSK" -eq 1 ]] || return 0
  step "Kiosk (Cog/WPE WebKit under Cage)"
  [[ -d "$KIOSK_ASSETS" ]] || die "Kiosk assets missing at $KIOSK_ASSETS (run from a full repo checkout)."
  apt_install cog cage seatd curl adwaita-icon-theme

  info "Creating kiosk user '$KIOSK_USER' + seat/GPU groups"
  id "$KIOSK_USER" >/dev/null 2>&1 || run useradd --system --create-home --shell /usr/sbin/nologin "$KIOSK_USER"
  # Guarantee the 'seat' group exists BEFORE the loop and before the kiosk unit
  # ever starts. The unit declares SupplementaryGroups=...seat, and systemd fails
  # a service outright (216/GROUP) if a named supplementary group is missing — a
  # silent "kiosk never starts, console frozen" failure on images where the seatd
  # package didn't create the group.
  getent group seat >/dev/null 2>&1 || run groupadd --system seat
  for grp in video render input seat tty; do
    getent group "$grp" >/dev/null 2>&1 && run usermod -aG "$grp" "$KIOSK_USER" || true
  done
  run systemctl enable --now seatd.service
  # Cage acquires the seat through seatd's control socket, which is group-owned.
  # Debian doesn't always name that group 'seat', so also join whatever group
  # actually owns the live socket — otherwise Cage can't open the seat and the
  # frame stays black even though the unit reports "started".
  if [[ "$DRY_RUN" -eq 0 && -S /run/seatd.sock ]]; then
    local seat_sock_grp
    seat_sock_grp="$(stat -c '%G' /run/seatd.sock 2>/dev/null || true)"
    if [[ -n "$seat_sock_grp" && "$seat_sock_grp" != "root" ]]; then
      getent group "$seat_sock_grp" >/dev/null 2>&1 && run usermod -aG "$seat_sock_grp" "$KIOSK_USER" || true
    fi
  fi

  # Tag input devices onto seat0 so the compositor can actually read them. wlroots'
  # libinput backend only opens keyboards/mice that udev has TAG+="seat" (assigned
  # to seat0); systemd normally applies that tag, but on images where logind is
  # broken/absent (common on DietPi — dbus-org.freedesktop.login1 fails to load)
  # the seat tag is never set, so Cage comes up with a dead keyboard AND mouse even
  # though the frame renders (DRM enumerates separately). udevadm info then shows
  # ID_INPUT=1 but no TAGS=:seat:. Ship an explicit rule and re-trigger so input
  # works on this boot without waiting for a reflash.
  install_seat_udev_rule

  # Delete any retired kiosk unit from a previous project version FIRST — otherwise
  # two kiosks fight over tty1/DRM and the console hangs at multi-user.target.
  purge_legacy_kiosk

  # Free tty1 for Cage *without* removing the console recovery path. DietPi (and most
  # images) autologin a console on tty1; Cage needs that VT + the DRM master. The unit
  # carries Conflicts=getty@tty1, so systemd stops getty transiently whenever the kiosk
  # starts and — crucially — logind's autovt respawns getty on tty1 the moment the
  # kiosk stops. That means a kiosk that can't paint hands the console back instead of
  # leaving frozen boot text on a dead VT (which is what a permanent `disable` did).
  # Only stop it now so this very install doesn't leave a getty holding tty1 before the
  # first kiosk start; leave it ENABLED so recovery works on every future failure.
  # Explicitly (re-)enable first: an older version of this installer permanently
  # `disable`d getty@tty1, which is what left devices with a frozen, login-less console
  # when the kiosk didn't paint. Enabling here repairs those devices on reinstall.
  run systemctl enable getty@tty1.service 2>/dev/null || true
  run systemctl stop getty@tty1.service 2>/dev/null || true

  run install -d -m 0755 "$CONFIG_DIR"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s would write %s/kiosk.env\n' "$C_DIM" "$C_RESET" "$CONFIG_DIR"
  else
    cat >"$CONFIG_DIR/kiosk.env" <<EOF
# PicoGallery kiosk runtime config. Edit and: systemctl restart picogallery-kiosk
FRAME_URL=$SERVER_URL
WAIT_TIMEOUT=120
EOF
    chmod 0644 "$CONFIG_DIR/kiosk.env"
  fi

  run install -m 0755 "$KIOSK_ASSETS/picogallery-kiosk.sh"   /usr/local/bin/picogallery-kiosk
  run install -m 0644 "$KIOSK_ASSETS/picogallery-kiosk.service" /etc/systemd/system/picogallery-kiosk.service
  run install -m 0440 "$KIOSK_ASSETS/picogallery-kiosk.sudoers" /etc/sudoers.d/picogallery-kiosk
  run visudo -cf /etc/sudoers.d/picogallery-kiosk

  # All-mode: the kiosk targets the local server, so order it after the server.
  # (The launcher also waits on /health, so this just makes the common case clean.)
  if [[ "$MODE" == "all" && "$DRY_RUN" -eq 0 ]]; then
    install -d -m 0755 /etc/systemd/system/picogallery-kiosk.service.d
    cat >/etc/systemd/system/picogallery-kiosk.service.d/10-after-server.conf <<EOF
[Unit]
After=picogallery.service
Wants=picogallery.service
EOF
  fi

  step_blank_schedule

  run systemctl daemon-reload
  run systemctl enable picogallery-kiosk.service
  ok "picogallery-kiosk.service enabled (frame: $SERVER_URL)"
}

step_blank_schedule() {
  [[ -n "$BLANK_ON" && -n "$BLANK_OFF" ]] || return 0
  info "Display blank schedule: off $BLANK_ON → on $BLANK_OFF"
  run install -m 0755 "$KIOSK_ASSETS/pico-display-power.sh"  /usr/local/bin/pico-display-power
  run install -m 0644 "$KIOSK_ASSETS/pico-display-on.service"  /etc/systemd/system/pico-display-on.service
  run install -m 0644 "$KIOSK_ASSETS/pico-display-off.service" /etc/systemd/system/pico-display-off.service
  if [[ "$DRY_RUN" -eq 0 ]]; then
    cat >/etc/systemd/system/pico-display-on.timer <<EOF
[Unit]
Description=PicoGallery — wake display at $BLANK_OFF
[Timer]
OnCalendar=*-*-* $BLANK_OFF:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
    cat >/etc/systemd/system/pico-display-off.timer <<EOF
[Unit]
Description=PicoGallery — blank display at $BLANK_ON
[Timer]
OnCalendar=*-*-* $BLANK_ON:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  fi
  run systemctl enable pico-display-on.timer pico-display-off.timer
}

# ── Verification ─────────────────────────────────────────────────────────────
step_verify() {
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  step "Verifying"
  local failures=0

  if [[ "$MODE_WANTS_SERVER" -eq 1 ]]; then
    if systemctl is-active --quiet picogallery.service; then
      ok "server service active"
    else
      err "picogallery.service is not active — journalctl -u picogallery"; failures=$((failures+1))
    fi
    info "Waiting for /api/v1/health…"
    local up=0
    for _ in $(seq 1 30); do
      if curl -fsS --max-time 3 "http://localhost:$SERVER_PORT/api/v1/health" >/dev/null 2>&1; then up=1; break; fi
      sleep 1
    done
    [[ "$up" -eq 1 ]] && ok "server answered /health" || { err "server did not answer /health in 30s — journalctl -u picogallery"; failures=$((failures+1)); }
  fi

  if [[ "$MODE_WANTS_KIOSK" -eq 1 ]]; then
    systemctl is-enabled --quiet picogallery-kiosk.service && ok "kiosk service enabled" || { err "kiosk service not enabled"; failures=$((failures+1)); }
    systemctl is-active --quiet seatd.service && ok "seatd active" || { warn "seatd not active (needed for Cage)"; }
    # Input devices must be tagged onto seat0 or the compositor comes up with a dead
    # keyboard/mouse even though the frame renders. Check a real input device carries
    # TAGS=:seat: — the exact failure mode seen on DietPi (broken logind).
    local ev seat_tagged=0
    for ev in /dev/input/event*; do
      [[ -e "$ev" ]] || continue
      if udevadm info "$ev" 2>/dev/null | grep -q 'TAGS=.*:seat:'; then seat_tagged=1; break; fi
    done
    if [[ "$seat_tagged" -eq 1 ]]; then
      ok "input devices tagged onto seat0 (keyboard/mouse reach the kiosk)"
    else
      warn "no input device carries the seat0 udev tag — keyboard/mouse may be dead in the kiosk; re-run install or check udev"
    fi
    # A second kiosk (a leftover from an older project name) is fatal — it grabs
    # tty1/DRM and hangs the console at boot. purge_legacy_kiosk should have cleared
    # these; fail the verify if any survived so it's caught here, not on the HDMI.
    local stray
    stray="$(ls /etc/systemd/system/pico-google-photos.service \
                /etc/systemd/system/photoprism-kiosk.service \
                /etc/systemd/system/pico-kiosk.service 2>/dev/null || true)"
    if [[ -n "$stray" ]]; then
      err "conflicting legacy kiosk unit still present: $stray — remove it (systemctl disable --now <unit>; rm the unit) or it will hang the display"
      failures=$((failures+1))
    else
      ok "no conflicting legacy kiosk units"
    fi
    # KMS must be live or Cage can't open /dev/dri/card0 (silent frozen console).
    if [[ "$IS_PI" -eq 1 ]]; then
      if [[ -e /dev/dri/card0 || -e /dev/dri/card1 ]]; then
        ok "DRM/KMS device present (/dev/dri)"
      elif [[ "${REBOOT_REQUIRED:-0}" -eq 1 ]]; then
        warn "no /dev/dri card yet — KMS overlay was just added; the required reboot activates it"
      else
        err "no /dev/dri card — KMS not active; Cage cannot render. Ensure dtoverlay=vc4-kms-v3d in $BOOT_CFG and reboot"
        failures=$((failures+1))
      fi
    fi
  fi

  [[ "$failures" -eq 0 ]] || warn "$failures check(s) failed — see $LOG_FILE and the hints above."
  return 0
}

# ── Uninstall ────────────────────────────────────────────────────────────────
do_uninstall() {
  step "Uninstalling PicoGallery"
  confirm "Remove PicoGallery services, users, config, and cache?" || die "Aborted."
  # Current units + every legacy kiosk name this project shipped under previous
  # names (see purge_legacy_kiosk), so uninstall leaves nothing to fight a reinstall.
  for unit in picogallery-kiosk.service picogallery.service \
              pico-display-on.timer pico-display-off.timer \
              pico-display-on.service pico-display-off.service \
              pico-google-photos.service photoprism-kiosk.service \
              pico-kiosk.service pico-wait-online.service; do
    run systemctl disable --now "$unit" 2>/dev/null || true
    run rm -f "/etc/systemd/system/$unit"
    run rm -rf "/etc/systemd/system/$unit.d"
  done
  run rm -f /usr/local/bin/picogallery-kiosk /usr/local/bin/pico-display-power /etc/sudoers.d/picogallery-kiosk
  run rm -rf /etc/systemd/system/picogallery-kiosk.service.d
  run rm -f "$SEAT_UDEV_RULE"
  run udevadm control --reload 2>/dev/null || true
  run systemctl daemon-reload
  # Give the console back: re-enable the tty1 login the kiosk install disabled.
  run systemctl enable --now getty@tty1.service 2>/dev/null || true
  # Remove the swapfile we may have created (and its fstab entry).
  if [[ -f /var/swap.picogallery ]]; then
    run swapoff /var/swap.picogallery 2>/dev/null || true
    run sed -i '\#/var/swap.picogallery#d' /etc/fstab 2>/dev/null || true
    run rm -f /var/swap.picogallery
  fi
  run rm -rf "$CONFIG_DIR" "$CACHE_DIR"
  id "$KIOSK_USER" >/dev/null 2>&1 && run userdel -r "$KIOSK_USER" 2>/dev/null || true
  id "$SERVER_USER" >/dev/null 2>&1 && run userdel "$SERVER_USER" 2>/dev/null || true
  ok "Uninstalled. (Packages cog/cage/node left installed; remove with apt if desired.)"
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  printf '\n%s────────────────────────────────────────────────────────%s\n' "$C_OK" "$C_RESET"
  ok "PicoGallery install complete (mode: $MODE)"
  echo
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] && cat <<EOF
  Server:   http://localhost:$SERVER_PORT  (source: $SOURCE_KIND)
            status: systemctl status picogallery
            logs:   journalctl -u picogallery -f
            config: $CONFIG_DIR/config.toml
EOF
  [[ "$MODE_WANTS_KIOSK" -eq 1 ]] && cat <<EOF
  Kiosk:    frame → $SERVER_URL
            start:  systemctl start picogallery-kiosk
            logs:   journalctl -u picogallery-kiosk -f
            config: $CONFIG_DIR/kiosk.env
EOF
  if [[ "${REBOOT_REQUIRED:-0}" -eq 1 ]]; then
    echo
    warn "A reboot is required (KMS/GPU boot settings changed). Reboot now with: sudo reboot"
  elif [[ "$MODE_WANTS_KIOSK" -eq 1 ]]; then
    echo
    info "Start the frame now: sudo systemctl start picogallery-kiosk   (or reboot)"
  fi
  printf '%s────────────────────────────────────────────────────────%s\n' "$C_OK" "$C_RESET"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  [[ $EUID -eq 0 ]] || die "Run with sudo."
  detect_platform

  if [[ "$DO_UNINSTALL" -eq 1 ]]; then do_uninstall; exit 0; fi

  resolve_mode
  preflight

  echo
  info "Plan: mode=$MODE  server=$([[ $MODE_WANTS_SERVER -eq 1 ]] && echo yes || echo no)  kiosk=$([[ $MODE_WANTS_KIOSK -eq 1 ]] && echo yes || echo no)  url=$SERVER_URL"
  [[ "$DRY_RUN" -eq 1 ]] && info "DRY RUN — no changes will be made."
  confirm "Proceed with installation?" || die "Aborted by user."

  REBOOT_REQUIRED=0
  step_base_packages
  step_kms_boot
  step_swap
  step_node
  step_build
  step_server_config
  step_server_user
  step_server_unit
  step_kiosk
  step_verify
  summary
}

main "$@"

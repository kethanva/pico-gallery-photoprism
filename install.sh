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
#     sudo ./install.sh --mode kiosk --server-url http://192.168.1.50:8190
#   Everything on this Pi (Pi Zero 2 W / Pi 4+; needs 64-bit or armv7):
#     sudo ./install.sh --mode all \
#          --photoprism-url http://photoprism.local:2342 \
#          --photoprism-user frame-viewer --photoprism-pass-file /root/picogallery-app-password
#
# Photos come exclusively from a PhotoPrism backend over the network; the Pi
# never scans a local photo directory. One on-device surface:
#   :8190 — photoprism-host.mjs: PhotoPrism Vue UI (frontend/dist) + /api/v1 proxy.
#           Cog opens http://localhost:8190/library/photos (normal grid, no kiosk slideshow).
#
# Run `sudo ./install.sh --help` for all options.
#
# Hard constraint: the original Pi Zero / Zero W is ARMv6, which modern Node.js
# does not support — those boards can only run the *kiosk*, pointed at a server
# on another host. The installer detects this and tells you.
# =============================================================================

set -Eeuo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
readonly SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$SCRIPT_PATH"

SCRIPT_VERSION="2.0.0"
if [[ -d "$SCRIPT_PATH/.git" ]] && command -v git >/dev/null 2>&1; then
  RAW_VERSION="$(git -C "$SCRIPT_PATH" describe --tags --always 2>/dev/null || echo "2.0.0")"
  SCRIPT_VERSION="${RAW_VERSION#v}"
fi
readonly SCRIPT_VERSION
readonly KIOSK_ASSETS="$REPO_ROOT/kiosk/cog"
readonly CONFIG_DIR="/etc/picogallery"
readonly CACHE_DIR="/var/cache/picogallery"
readonly STATE_DIR="/var/lib/picogallery"
readonly RUNTIME_DIR="/opt/picogallery"
readonly LOG_FILE="/var/log/picogallery-install.log"
readonly KIOSK_USER="picokiosk"
readonly SERVER_USER="picogallery"
readonly NODE_MAJOR="22"
readonly SERVER_PORT="8190"

# ── Defaults (overridable by flags) ──────────────────────────────────────────
MODE="auto"                 # auto | kiosk | server | all
SERVER_URL=""               # kiosk target; defaults to localhost in server modes
SOURCE_KIND="photoprism"    # photoprism | webdav  (no local directory source)
PP_URL="" PP_USER="" PP_PASS="" PP_PASS_FILE=""
WEBDAV_URL="" WEBDAV_USER="" WEBDAV_PASS=""
BLANK_ON="" BLANK_OFF=""
ASSUME_YES=0
DRY_RUN=0
DO_UNINSTALL=0
VERBOSE=0

# Detected at runtime
ARCH="" MODEL="" IS_PI=0 RAM_MB=0 DISK_FREE_MB=0 OS_ID="" OS_CODENAME="" BOOT_CFG=""
NODE_OK_ARCH=0              # 1 if this arch can run Node
RUN_USER="" RUN_GROUP=""    # dedicated account the server service runs as
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

# state_set <key> <value> — record an install-time fact in $STATE_DIR/state so
# uninstall.sh can revert *exactly* what this install changed (original swap
# size, whether we created the seat group, …) instead of guessing.
state_set() {
  local key="$1" val="$2"
  if [[ "$DRY_RUN" -eq 1 ]]; then debug "[dry-run] state: $key=$val"; return 0; fi
  install -d -m 0755 "$STATE_DIR"
  local f="$STATE_DIR/state"
  { grep -v "^$key=" "$f" 2>/dev/null || true; printf '%s=%s\n' "$key" "$val"; } >"$f.tmp"
  mv "$f.tmp" "$f"
  chmod 0644 "$f"
}

confirm() {
  local prompt="$1"
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  local ans
  read -r -p "$prompt [y/N] " ans || true
  [[ "$ans" =~ ^[Yy] ]]
}

valid_url()  { [[ "$1" =~ ^https?://[^[:space:]]+$ ]]; }
valid_hhmm() { [[ "$1" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; }
toml_string() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

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
  --photoprism-url <url>    PhotoPrism base URL (required for --source photoprism)
  --photoprism-user <u>     PhotoPrism username
  --photoprism-pass <p>     PhotoPrism password (or app password)
  --photoprism-pass-file <f> Read the PhotoPrism app password from a protected file
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
  sudo ./install.sh --mode kiosk --server-url http://192.168.1.50:8190
  sudo ./install.sh --mode all \\
       --photoprism-url http://photoprism.local:2342 --photoprism-user frame-viewer --photoprism-pass-file /root/picogallery-app-password -y
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
      --photoprism-pass) PP_PASS="${2:?}"; warn "--photoprism-pass can leak through shell history; prefer --photoprism-pass-file"; shift 2 ;;
      --photoprism-pass-file) PP_PASS_FILE="${2:?}"; shift 2 ;;
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

  info "Installer: PicoGallery v$SCRIPT_VERSION"
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

  if [[ -n "$PP_PASS_FILE" ]]; then
    [[ -r "$PP_PASS_FILE" ]] || die "Cannot read --photoprism-pass-file: $PP_PASS_FILE"
    PP_PASS="$(<"$PP_PASS_FILE")"
    [[ "$PP_PASS" != *$'\n'* && "$PP_PASS" != *$'\r'* ]] || die "Password file must contain exactly one line"
  fi

  local wants_server=0 wants_kiosk=0
  [[ "$MODE" == server || "$MODE" == all ]] && wants_server=1
  [[ "$MODE" == kiosk  || "$MODE" == all ]] && wants_kiosk=1

  if [[ "$wants_server" -eq 1 && "$NODE_OK_ARCH" -eq 0 ]]; then
    die "Server mode needs a 64-bit or ARMv7 board (Node has no ARMv6 build). Use --mode kiosk and run the server on another host."
  fi
  if [[ "$wants_server" -eq 1 && ! -f "$REPO_ROOT/package.json" ]]; then
    die "Server mode must run from a full repo checkout (no package.json at $REPO_ROOT)."
  fi
  if [[ "$wants_server" -eq 1 && "$SOURCE_KIND" != "photoprism" ]]; then
    die "The shipped server supports only --source photoprism; WebDAV is not implemented."
  fi

  # Frame URL: local server in server modes; explicit in kiosk-only.
  if [[ "$wants_server" -eq 1 ]]; then
    SERVER_URL="${SERVER_URL:-http://localhost:$SERVER_PORT/library/photos}"
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
  if [[ -f "$LOG_FILE" ]] && (( $(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0) > 2097152 )); then
    mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
  fi
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

  # Network: apt + the signed NodeSource repository must be reachable.
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
  # Each addition is wrapped in "# BEGIN/END PicoGallery installer" markers so the
  # uninstaller can delete exactly what we appended (no orphaned lines).
  if ! grep -qE '^\s*dtoverlay=vc4-kms-v3d' "$BOOT_CFG"; then
    info "Enabling KMS driver (dtoverlay=vc4-kms-v3d) — required by Cage"
    run bash -c "printf '\n# BEGIN PicoGallery installer (Cage/WPE needs KMS)\ndtoverlay=vc4-kms-v3d\n# END PicoGallery installer\n' >> '$BOOT_CFG'"
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
    run bash -c "printf '\n# BEGIN PicoGallery installer (gpu_mem)\ngpu_mem=$gpu_mem\n# END PicoGallery installer\n' >> '$BOOT_CFG'"
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
      # Remember the pre-install size so uninstall restores the user's value,
      # not a hardcoded default.
      if ! grep -q "^CONF_SWAPSIZE=1024" /etc/dphys-swapfile 2>/dev/null; then
        local orig_size
        orig_size="$(grep -E '^#?CONF_SWAPSIZE=' /etc/dphys-swapfile 2>/dev/null | head -1 | cut -d= -f2 || true)"
        state_set DPHYS_ORIG_SWAPSIZE "${orig_size:-100}"
        run sed -i 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
        run dphys-swapfile setup
        run dphys-swapfile swapon
      fi
    fi
  else
    local sf=/var/swap.picogallery
    if [[ ! -f "$sf" ]]; then
      info "Creating 1 GB swapfile at $sf"
      run fallocate -l 1G "$sf" || run dd if=/dev/zero of="$sf" bs=1M count=1024
      run chmod 600 "$sf"; run mkswap "$sf"
      state_set SWAPFILE_CREATED 1
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

# Install Node from NodeSource's signed APT repository for supported arches.
step_node() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0

  step "Node.js $NODE_MAJOR"
  if have node && [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]]; then
    ok "Node $(node -v) already installed"
  else
    [[ "$NODE_OK_ARCH" -eq 1 ]] || die "No Node $NODE_MAJOR build for arch $ARCH."
    info "Configuring the signed NodeSource Node $NODE_MAJOR repository"
    local key_download="/tmp/picogallery-nodesource-key-$$.gpg"
    run curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_download"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      gpg --batch --yes --dearmor --output /usr/share/keyrings/nodesource.gpg "$key_download"
      printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "$NODE_MAJOR" \
        >/etc/apt/sources.list.d/nodesource.list
      chmod 0644 /usr/share/keyrings/nodesource.gpg /etc/apt/sources.list.d/nodesource.list
    fi
    run rm -f "$key_download"
    APT_REFRESHED=0
    apt_install nodejs
    have node || die "Node install failed."
    [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]] || \
      die "NodeSource installed an unsupported Node version: $(node -v 2>/dev/null || echo unknown)"
    ok "Installed Node $(node -v)"
  fi
}

# verify_frontend_bundle <assets_json>
# Ensures the committed PhotoPrism UI bundle is complete enough to boot:
# assets.json exists and declares app.js + app.css, and those files exist.
verify_frontend_bundle() {
  local assets="$1"
  local app_js app_css
  [[ -f "$assets" ]] || return 1
  app_js="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(m['app.js']||'');" "$assets" 2>/dev/null || true)"
  app_css="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(m['app.css']||'');" "$assets" 2>/dev/null || true)"
  [[ -n "$app_js" && -n "$app_css" ]] || return 1
  [[ -f "$REPO_ROOT/frontend/dist/static/build/$app_js" ]] || return 1
  [[ -f "$REPO_ROOT/frontend/dist/static/build/$app_css" ]] || return 1
  return 0
}

# Ensure the PhotoPrism Vue UI bundle is present. The bundle is committed to the
# repo (frontend/dist) because low-RAM Pis cannot run the webpack build; restore
# it from git if a previous cleanup deleted it, and only fall back to an
# on-device build on boards with enough memory.
step_build() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  local assets="$REPO_ROOT/frontend/dist/static/build/assets.json"
  if verify_frontend_bundle "$assets"; then
    ok "frontend/dist present"
    return 0
  fi
  if [[ -f "$assets" ]]; then
    warn "frontend/dist exists but the bundle is incomplete/corrupt (missing app.js/app.css mapping or files)."
  fi
  # The bundle is tracked — a missing dist usually means an old uninstall deleted
  # it. Restore from git before considering a build.
  if [[ -d "$REPO_ROOT/.git" ]] && have git; then
    info "frontend/dist missing — restoring the committed UI bundle from git"
    run git -C "$REPO_ROOT" checkout -- frontend/dist 2>/dev/null || true
    if verify_frontend_bundle "$assets"; then
      ok "frontend/dist restored from git"
      return 0
    fi
    warn "frontend/dist restore did not produce a bootable bundle."
  fi
  # In tarball/release installs there is no git metadata to restore from.
  if [[ ! -d "$REPO_ROOT/.git" ]]; then
    die "frontend/dist bundle is missing or invalid in this release package.
      Re-download the release tarball, or copy a known-good dist/:
        cd frontend && PICO_NO_SW=1 npm install && PICO_NO_SW=1 npm run build
        scp -r frontend/dist <pi>:$REPO_ROOT/frontend/"
  fi
  [[ "$DRY_RUN" -eq 1 ]] && { info "[dry-run] would build frontend/dist"; return 0; }
  # Webpack needs ~1.5+ GB; on a 512 MB board the build OOMs (even with swap it
  # thrashes for hours). Fail with instructions instead of half-installing.
  if (( RAM_MB < 1800 )); then
    die "frontend/dist missing and this board (${RAM_MB} MB RAM) cannot build it.
      Fix: git pull (the built UI is committed), or build on a PC and copy it:
        cd frontend && PICO_NO_SW=1 npm install && PICO_NO_SW=1 npm run build
        scp -r frontend/dist <pi>:$REPO_ROOT/frontend/"
  fi
  step "Building PhotoPrism UI (frontend/dist)"
  [[ -f "$REPO_ROOT/frontend/package.json" ]] || die "frontend/ missing — clone the full repo"
  (cd "$REPO_ROOT/frontend" && PICO_NO_SW=1 npm install --ignore-scripts --no-audit --no-fund --no-update-notifier && PICO_NO_SW=1 npm run build) \
    || die "frontend build failed — build on a larger machine and copy frontend/dist/"
  [[ -f "$assets" ]] || die "frontend build did not produce $assets"
  ok "frontend/dist built"
}

# Generate /etc/picogallery/config.toml from the chosen source (0640, server-readable).
step_server_config() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  step "Server configuration ($CONFIG_DIR/config.toml)"
  run install -d -m 0755 "$CONFIG_DIR"
  local cfg="$CONFIG_DIR/config.toml"
  if [[ -f "$cfg" ]]; then
    # Never clobber working credentials with empty ones: with -y and no
    # --photoprism-pass, overwriting would write password="" — the proxy then
    # cannot autologin, the public-mode masquerade turns off, and the kiosk
    # lands on the SIGN IN screen after every reinstall.
    if [[ "$SOURCE_KIND" == "photoprism" && -z "$PP_PASS" ]]; then
      info "Config exists and no --photoprism-pass was given — keeping existing credentials."
      # Existing installations may listen externally without gateway auth. The
      # host now fails closed in that state, so migrate them before returning.
      local existing_host existing_token
      existing_host="$(awk '/^\[http\]/{in_http=1;next} /^\[/{in_http=0} in_http && /^host[[:space:]]*=/{line=$0; sub(/^[^=]*=[[:space:]]*\"/,"",line); sub(/\".*/,"",line); print line; exit}' "$cfg")"
      existing_token="$(awk '/^\[http\]/{in_http=1;next} /^\[/{in_http=0} in_http && /^auth_token[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*\"/,""); sub(/\"[[:space:]]*$/,""); print; exit}' "$cfg")"
      if [[ "$existing_host" != "127.0.0.1" && "$existing_host" != "::1" && "$existing_host" != "localhost" ]] && [[ ${#existing_token} -lt 24 ]]; then
        local generated_token
        generated_token="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
        sed -i "/^\[http\]/a auth_token = $(toml_string "$generated_token")" "$cfg"
        warn "Added a gateway auth token to the existing externally-bound server config. Remote kiosk URLs must include ?token=<value from [http].auth_token>."
      fi
      return 0
    fi
    if ! confirm "Config exists at $cfg — overwrite?"; then
      info "Keeping existing config."
      return 0
    fi
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
url              = $(toml_string "$PP_URL")
username         = $(toml_string "$PP_USER")
app_password     = $(toml_string "$PP_PASS")
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

  local http_host="127.0.0.1" auth_line=""
  if [[ "$MODE" == "server" ]]; then
    http_host="0.0.0.0"
    local gateway_token
    gateway_token="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
    auth_line="auth_token = $(toml_string "$gateway_token")"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s would write %s\n' "$C_DIM" "$C_RESET" "$cfg"
  else
    (
      umask 027
      cat >"$cfg" <<EOF
# PicoGallery V2 — generated by install.sh on $(_ts). Edit and restart the service.
[display]
slide_duration_secs = 10
transition          = "fade"
order               = "shuffle"
on_this_day_boost   = true

[kiosk]
profile = "pi_zero_2"

[cache]
dir    = "$CACHE_DIR"
max_mb = 512

[http]
host = "$http_host"
port = $SERVER_PORT
$auth_line

$source_block
EOF
      chmod 0640 "$cfg"
    )
  fi
  ok "Wrote $cfg (source: $SOURCE_KIND)"
}

# Install a minimal, root-owned runtime outside the checkout and run it under a
# dedicated non-login account. This avoids granting a network service access to
# the developer's home directory or recursively changing checkout ownership.
step_server_user() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  step "Dedicated server runtime + cache"
  RUN_USER="$SERVER_USER"
  RUN_GROUP="$SERVER_USER"
  if ! id "$SERVER_USER" >/dev/null 2>&1; then
    run useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVER_USER"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] would install the minimal runtime at $RUNTIME_DIR"
  else
    rm -rf "$RUNTIME_DIR/scripts" "$RUNTIME_DIR/config" "$RUNTIME_DIR/frontend"
    install -d -o root -g root -m 0755 "$RUNTIME_DIR/scripts" "$RUNTIME_DIR/config" "$RUNTIME_DIR/frontend"
    cp -a "$REPO_ROOT/scripts/." "$RUNTIME_DIR/scripts/"
    cp -a "$REPO_ROOT/config/." "$RUNTIME_DIR/config/"
    cp -a "$REPO_ROOT/frontend/index.html" "$REPO_ROOT/frontend/static" "$REPO_ROOT/frontend/dist" "$RUNTIME_DIR/frontend/"
    chown -R root:root "$RUNTIME_DIR"
    chmod -R go-w "$RUNTIME_DIR"
  fi

  run install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 "$CACHE_DIR"
  # Let the run-user read its config (secrets stay non-world-readable).
  if [[ -f "$CONFIG_DIR/config.toml" ]]; then
    run chgrp "$RUN_GROUP" "$CONFIG_DIR/config.toml" || true
    run chmod 0640 "$CONFIG_DIR/config.toml" || true
  fi
}

step_server_unit() {
  # Deprecated: slideshow server is consolidated into the photoprism proxy service.
  # Clean up legacy picogallery.service if it exists from previous installations.
  if [[ "$DRY_RUN" -eq 0 ]]; then
    # Unconditionally stop and disable the service to prevent it from looping
    run systemctl stop picogallery.service >/dev/null 2>&1 || true
    run systemctl disable picogallery.service >/dev/null 2>&1 || true

    # Find the exact unit file location systemd is using
    local svc_file
    svc_file=$(systemctl show -p FragmentPath picogallery.service 2>/dev/null | cut -d= -f2)

    # Check standard locations if systemd did not return a path
    if [[ -z "$svc_file" || ! -f "$svc_file" ]]; then
      if [[ -f /etc/systemd/system/picogallery.service ]]; then
        svc_file="/etc/systemd/system/picogallery.service"
      elif [[ -f /lib/systemd/system/picogallery.service ]]; then
        svc_file="/lib/systemd/system/picogallery.service"
      fi
    fi

    # Delete the service file and reload systemd configuration
    if [[ -n "$svc_file" && -f "$svc_file" ]]; then
      step "Removing legacy picogallery.service from $svc_file"
      run rm -f "$svc_file" || true
      run systemctl daemon-reload || true
      ok "Legacy server service cleaned up"
    fi
  fi
  return 0
}

# The appliance surface: photoprism-host.mjs serves the PhotoPrism Vue UI on :8190
# and reverse-proxies /api/v1 to the real backend (read-only). Cog opens the normal
# photo library grid at /library/photos — no ?kiosk fullscreen slideshow boot.
step_photoprism_unit() {
  [[ "$MODE_WANTS_SERVER" -eq 1 ]] || return 0
  [[ "$SOURCE_KIND" == "photoprism" ]] || return 0
  step "PhotoPrism UI host systemd unit"
  local node_bin; node_bin="$(command -v node || echo /usr/bin/node)"
  # Plain static server + streaming proxy — needs very little heap. On a 512 MB
  # board (Pi Zero 2 W) cap it so it can never squeeze the WebKit kiosk.
  local pp_runtime_env=""
  if (( RAM_MB < 900 )); then pp_runtime_env="Environment=NODE_OPTIONS=--max-old-space-size=96"; fi
  [[ -f "$REPO_ROOT/frontend/dist/static/build/assets.json" ]] || \
    warn "frontend/dist missing — build the PhotoPrism UI before starting the host"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s[dry-run]%s would write /etc/systemd/system/picogallery-photoprism.service\n' "$C_DIM" "$C_RESET"
  else
    cat >/etc/systemd/system/picogallery-photoprism.service <<EOF
[Unit]
Description=PicoGallery PhotoPrism UI host
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_GROUP
Environment=NODE_ENV=production
Environment=PICO_CONFIG=$CONFIG_DIR/config.toml
Environment=PICO_PP_PORT=8190
$pp_runtime_env
WorkingDirectory=$RUNTIME_DIR
ExecStart=$node_bin $RUNTIME_DIR/scripts/photoprism-host.mjs
Restart=always
RestartSec=3
# Hardening (read-only: serves PhotoPrism UI + proxies to the backend).
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
TasksMax=64
MemoryMax=192M
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  fi
  run systemctl daemon-reload
  run systemctl enable picogallery-photoprism.service
  run systemctl restart picogallery-photoprism.service
  ok "picogallery-photoprism.service enabled (PhotoPrism UI on :8190)"
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
  # Re-play "add" for input AND usb so both new rules apply to devices that are
  # already plugged in (the usb trigger applies the autosuspend-off rule; without
  # it an already-connected mouse can still be powered down mid-session).
  run udevadm trigger --subsystem-match=input --action=add
  run udevadm trigger --subsystem-match=usb --action=add
  run udevadm settle --timeout=10 2>/dev/null || true
  ok "Seat udev rule installed (input devices tagged onto seat0, USB autosuspend off)"
}

# Pi Zero–family USB detection guard. The Zero 2 W has ONE usable USB port (micro-B
# OTG). Leftovers from USB-gadget experiments (dtoverlay=dwc2 in peripheral mode,
# g_ether/g_serial in cmdline.txt or /etc/modules) switch that port to *device* mode
# — the kernel then never enumerates a plugged keyboard/mouse, so input is dead at
# the hardware level no matter what udev/seatd do. Detect and repair to host mode.
step_usb_host_mode() {
  [[ "$MODE_WANTS_KIOSK" -eq 1 && "$IS_PI" -eq 1 ]] || return 0
  step "USB host-mode guard (keyboard/mouse enumeration)"
  local cfg fixed=0
  for cfg in /boot/firmware/config.txt /boot/config.txt; do
    [[ -f "$cfg" ]] || continue
    # dtoverlay=dwc2 without an explicit dr_mode forces the port out of host mode
    # (its default is peripheral/otg on most kernels). Pin it to host.
    if grep -Eq '^\s*dtoverlay=dwc2\s*$|^\s*dtoverlay=dwc2,dr_mode=(peripheral|otg)' "$cfg"; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '%s[dry-run]%s would pin dtoverlay=dwc2 to dr_mode=host in %s\n' "$C_DIM" "$C_RESET" "$cfg"
      else
        cp -a "$cfg" "${cfg}.picogallery.bak"
        sed -Ei 's/^(\s*)dtoverlay=dwc2(,dr_mode=(peripheral|otg))?\s*$/\1dtoverlay=dwc2,dr_mode=host/' "$cfg"
        warn "USB OTG was in gadget/peripheral mode in $cfg — pinned to dr_mode=host (backup: ${cfg}.picogallery.bak). Reboot required for USB input."
      fi
      fixed=1
    fi
    # cmdline.txt gadget module autoload (classic g_ether setup) re-binds the port
    # to device mode at boot even with dr_mode=host.
    local cmdline="${cfg%config.txt}cmdline.txt"
    if [[ -f "$cmdline" ]] && grep -Eq 'modules-load=[^ ]*g_(ether|serial|mass_storage|midi)' "$cmdline"; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '%s[dry-run]%s would strip gadget modules-load from %s\n' "$C_DIM" "$C_RESET" "$cmdline"
      else
        cp -a "$cmdline" "${cmdline}.picogallery.bak"
        sed -Ei 's/ ?modules-load=[^ ]*g_(ether|serial|mass_storage|midi)[^ ]*//' "$cmdline"
        warn "USB gadget modules-load removed from $cmdline (backup: ${cmdline}.picogallery.bak). Reboot required for USB input."
      fi
      fixed=1
    fi
  done
  # /etc/modules gadget autoload: same effect, different mechanism.
  if [[ -f /etc/modules ]] && grep -Eq '^\s*(g_ether|g_serial|g_mass_storage|g_midi|dwc2)\s*$' /etc/modules; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf '%s[dry-run]%s would comment gadget modules in /etc/modules\n' "$C_DIM" "$C_RESET"
    else
      cp -a /etc/modules /etc/modules.picogallery.bak
      sed -Ei 's/^\s*(g_ether|g_serial|g_mass_storage|g_midi|dwc2)\s*$/# \1 (disabled by picogallery — gadget mode kills USB host input)/' /etc/modules
      warn "USB gadget modules disabled in /etc/modules (backup: /etc/modules.picogallery.bak). Reboot required for USB input."
    fi
    fixed=1
  fi
  [[ "$fixed" -eq 0 ]] && ok "USB port is in host mode (no gadget-mode config found)"
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
  local owned=" picogallery.service picogallery-photoprism.service picogallery-kiosk.service pico-display-on.service pico-display-off.service pico-display-on.timer pico-display-off.timer "
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
  if ! getent group seat >/dev/null 2>&1; then
    run groupadd --system seat
    state_set SEAT_GROUP_CREATED 1
  fi
  for grp in video render input seat tty; do
    getent group "$grp" >/dev/null 2>&1 && run usermod -aG "$grp" "$KIOSK_USER" || true
  done
  run systemctl enable --now seatd.service
  # Cage acquires the seat through seatd's control socket, which is group-owned.
  # Debian doesn't always name that group 'seat', so also join whatever group
  # actually owns the live socket — otherwise Cage can't open the seat and input
  # (often the frame too) is dead even though the unit reports "started". The
  # socket appears asynchronously after `enable --now`, so wait for it instead
  # of silently skipping the group join on a slow boot.
  if [[ "$DRY_RUN" -eq 0 ]]; then
    local sock_waited=0
    while [[ ! -S /run/seatd.sock && "$sock_waited" -lt 10 ]]; do
      sleep 1; sock_waited=$(( sock_waited + 1 ))
    done
    if [[ -S /run/seatd.sock ]]; then
      local seat_sock_grp
      seat_sock_grp="$(stat -c '%G' /run/seatd.sock 2>/dev/null || true)"
      if [[ -n "$seat_sock_grp" && "$seat_sock_grp" != "root" ]]; then
        getent group "$seat_sock_grp" >/dev/null 2>&1 && run usermod -aG "$seat_sock_grp" "$KIOSK_USER" || true
      fi
    else
      warn "seatd socket (/run/seatd.sock) did not appear within 10s — the kiosk may not get a seat. Check: systemctl status seatd"
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
  step_usb_host_mode
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
    local target_url="$SERVER_URL"
    if [[ -z "$target_url" ]]; then
      target_url="http://localhost:8190/library/photos"
    fi
    cat >"$CONFIG_DIR/kiosk.env" <<EOF
# PicoGallery kiosk runtime config. Edit and: systemctl restart picogallery-kiosk
FRAME_URL=$target_url
WAIT_TIMEOUT=120
# Seconds the launcher waits for a keyboard/mouse to enumerate before starting
# the compositor (slow USB hubs/OTG adapters need a few seconds; 0 = don't wait).
INPUT_WAIT=15
# COG_CONFIG=/etc/picogallery/cog.conf
# COG_EXTRA=--scale=1.0
EOF
    chmod 0644 "$CONFIG_DIR/kiosk.env"
  fi

  run install -m 0644 "$KIOSK_ASSETS/cog.conf" "$CONFIG_DIR/cog.conf"
  run install -m 0755 "$KIOSK_ASSETS/picogallery-kiosk.sh"   /usr/local/bin/picogallery-kiosk
  run install -m 0644 "$KIOSK_ASSETS/picogallery-kiosk.service" /etc/systemd/system/picogallery-kiosk.service
  run install -m 0440 "$KIOSK_ASSETS/picogallery-kiosk.sudoers" /etc/sudoers.d/picogallery-kiosk
  run visudo -cf /etc/sudoers.d/picogallery-kiosk

  # All-mode: the kiosk targets the local server, so order it after the server.
  # (The launcher also waits on /api/v1/health, so this just makes the common case clean.)
  if [[ "$MODE" == "all" && "$DRY_RUN" -eq 0 ]]; then
    install -d -m 0755 /etc/systemd/system/picogallery-kiosk.service.d
    cat >/etc/systemd/system/picogallery-kiosk.service.d/10-after-server.conf <<EOF
[Unit]
After=picogallery-photoprism.service
Wants=picogallery-photoprism.service
EOF
  fi

  step_blank_schedule

  # Clear the kiosk browser's cache and local storage (removes stale Service Workers
  # and cached PhotoPrism SPA files that conflict with the new bundle). Stop the kiosk
  # first: a running WPE WebKit keeps rewriting these directories, so deleting them
  # under a live browser resurrects stale entries on its next write.
  local kiosk_was_active=0
  if [[ "$DRY_RUN" -eq 0 && -d "/home/$KIOSK_USER" ]]; then
    if systemctl is-active --quiet picogallery-kiosk.service; then
      kiosk_was_active=1
      run systemctl stop picogallery-kiosk.service || true
    fi
    info "Clearing kiosk browser cache to remove stale files..."
    run rm -rf "/home/$KIOSK_USER/.cache" "/home/$KIOSK_USER/.local" "/home/$KIOSK_USER/.config" 2>/dev/null || true
  fi

  run systemctl daemon-reload
  run systemctl enable picogallery-kiosk.service
  if [[ "$kiosk_was_active" -eq 1 ]]; then
    run systemctl restart picogallery-kiosk.service || true
    ok "picogallery-kiosk.service restarted with a clean browser profile"
  fi
  ok "picogallery-kiosk.service enabled (PhotoPrism UI: $SERVER_URL)"
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
    if systemctl is-active --quiet picogallery-photoprism.service; then
      ok "PhotoPrism UI host service active"
    else
      err "picogallery-photoprism.service is not active — journalctl -u picogallery-photoprism"; failures=$((failures+1))
    fi
    info "Waiting for PhotoPrism UI host to start on :8190…"
    local up=0
    for _ in $(seq 1 30); do
      if curl -fsS --max-time 3 "http://localhost:8190/api/v1/health" >/dev/null 2>&1; then up=1; break; fi
      sleep 1
    done
    [[ "$up" -eq 1 ]] && ok "PhotoPrism UI host answered /health" || { err "PhotoPrism UI host did not answer /health in 30s — journalctl -u picogallery-photoprism"; failures=$((failures+1)); }

    # Backend readiness: /ready answers 200 only after the PhotoPrism backend
    # was actually reached — this is what gates the kiosk launch on boot.
    if [[ "$up" -eq 1 ]]; then
      info "Waiting for the PhotoPrism backend (…/api/v1/ready)…"
      local ready=0
      for _ in $(seq 1 30); do
        if curl -fsS --max-time 3 "http://localhost:8190/api/v1/ready" >/dev/null 2>&1; then ready=1; break; fi
        sleep 1
      done
      if [[ "$ready" -eq 1 ]]; then
        ok "backend reachable through the proxy"
      else
        err "backend never became ready — check the [[sources]] url in $CONFIG_DIR/config.toml and that PhotoPrism is up"; failures=$((failures+1))
      fi

      # Appliance contract 1: with credentials configured, the proxy must
      # masquerade the config as public or the SPA bounces to the login screen.
      if grep -Eq 'password[[:space:]]*=[[:space:]]*"[^"]+"' "$CONFIG_DIR/config.toml" 2>/dev/null; then
        if curl -fsS --max-time 5 "http://localhost:8190/api/v1/config" 2>/dev/null | grep -q '"mode":"public"'; then
          ok "proxy masquerades config as public (no login screen on the kiosk)"
        else
          err "proxy did NOT rewrite /api/v1/config to public mode — the kiosk will show a SIGN IN page. Check credentials in $CONFIG_DIR/config.toml and journalctl -u picogallery-photoprism"; failures=$((failures+1))
        fi
      fi

      # Appliance contract 2: the SPA must boot from the deep kiosk route —
      # index.html with absolute asset URLs, served for /library/photos.
      if curl -fsS --max-time 5 "http://localhost:8190/library/photos" 2>/dev/null | grep -q "'/static/build/assets.json'"; then
        ok "SPA boot page served on /library/photos (absolute asset URLs)"
      else
        err "/library/photos does not serve a bootable index.html — blank screen risk. Is this checkout up to date? (git pull / re-extract the release)"; failures=$((failures+1))
      fi
    fi
  fi

  if [[ "$MODE_WANTS_KIOSK" -eq 1 ]]; then
    systemctl is-enabled --quiet picogallery-kiosk.service && ok "kiosk service enabled" || { err "kiosk service not enabled"; failures=$((failures+1)); }
    systemctl is-active --quiet seatd.service && ok "seatd active" || { warn "seatd not active (needed for Cage)"; }
    # Input pipeline, checked layer by layer so a dead keyboard/mouse points at the
    # exact failing stage instead of a generic warning:
    #   kernel (does /dev/input see a kbd/mouse at all?) → udev (seat0 tag) → compositor.
    local kbd_count=0 mouse_count=0
    if [[ -r /proc/bus/input/devices ]]; then
      kbd_count="$(grep -c 'Handlers=.*kbd' /proc/bus/input/devices 2>/dev/null || true)"
      mouse_count="$(grep -c 'Handlers=.*mouse' /proc/bus/input/devices 2>/dev/null || true)"
    fi
    if [[ "$kbd_count" -eq 0 && "$mouse_count" -eq 0 ]]; then
      warn "kernel sees NO keyboard or mouse — hardware/USB-level problem, not udev/seat:"
      warn "  • unplugged, dead hub, or under-powered USB OTG adapter"
      warn "  • USB port in gadget mode (see the USB host-mode guard above; reboot after a fix)"
      warn "  • check: cat /proc/bus/input/devices  |  lsusb"
    else
      ok "kernel sees input devices (keyboards: $kbd_count, mice: $mouse_count)"
      local ev seat_tagged=0
      for ev in /dev/input/event*; do
        [[ -e "$ev" ]] || continue
        if udevadm info "$ev" 2>/dev/null | grep -q 'TAGS=.*:seat:'; then seat_tagged=1; break; fi
      done
      if [[ "$seat_tagged" -eq 1 ]]; then
        ok "input devices tagged onto seat0 (keyboard/mouse reach the kiosk)"
      else
        warn "devices exist but none carries the seat0 udev tag — compositor input dead; re-run install or: udevadm trigger --subsystem-match=input --action=add"
      fi
      # Compositor layer: if the kiosk is up, its journal says whether libinput
      # actually opened the devices (the definitive end-to-end signal).
      if systemctl is-active --quiet picogallery-kiosk.service; then
        if journalctl -u picogallery-kiosk -b --no-pager 2>/dev/null | grep -qiE 'libinput.*(no input devices|cannot open)'; then
          warn "compositor reports no input devices — restart the kiosk: systemctl restart picogallery-kiosk"
        else
          ok "kiosk running with no libinput errors in this boot's journal"
        fi
      fi
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

  if [[ "$failures" -ne 0 ]]; then
    err "$failures required verification check(s) failed — see $LOG_FILE and the hints above."
    return 1
  fi
  ok "All required installation checks passed."
}

# ── Uninstall ────────────────────────────────────────────────────────────────
# Delegate to the comprehensive, self-contained uninstall.sh so there is a single
# source of truth for cleanup (units, users, config, caches, boot-config reverts,
# swap, backups, install log, and local build artifacts). Falls back to a minimal
# inline removal only if uninstall.sh is missing from the checkout.
do_uninstall() {
  local uninstaller="$REPO_ROOT/uninstall.sh"
  if [[ -f "$uninstaller" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] would run $uninstaller $([[ "$ASSUME_YES" -eq 1 ]] && echo --yes)"
      return 0
    fi
    step "Delegating to uninstall.sh (comprehensive cleanup)"
    local args=()
    [[ "$ASSUME_YES" -eq 1 ]] && args+=(--yes)
    exec bash "$uninstaller" "${args[@]}"
  fi

  step "Uninstalling PicoGallery (minimal fallback — uninstall.sh not found)"
  confirm "Remove PicoGallery services, users, config, and cache?" || die "Aborted."
  # Current units + every legacy kiosk name this project shipped under previous
  # names (see purge_legacy_kiosk), so uninstall leaves nothing to fight a reinstall.
  for unit in picogallery-kiosk.service picogallery-photoprism.service picogallery.service \
              pico-display-on.timer pico-display-off.timer \
              pico-display-on.service pico-display-off.service \
              pico-google-photos.service photoprism-kiosk.service \
              pico-kiosk.service pico-wait-online.service; do
    run systemctl disable --now "$unit" 2>/dev/null || true
    run rm -f "/etc/systemd/system/$unit"
    run rm -rf "/etc/systemd/system/$unit.d"
    run systemctl reset-failed "$unit" 2>/dev/null || true
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
  run rm -rf "$CONFIG_DIR" "$CACHE_DIR" "$RUNTIME_DIR"
  run rm -f "$LOG_FILE"
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
            status: systemctl status picogallery-photoprism
            logs:   journalctl -u picogallery-photoprism -f
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
    warn "A reboot is required (KMS/GPU boot settings changed)."
    if confirm "Reboot now to apply changes?"; then
      run reboot
    fi
  else
    echo
    if confirm "Installation complete. Would you like to reboot now to start the Kiosk?"; then
      run reboot
    else
      info "You can start the frame manually: sudo systemctl start picogallery-kiosk"
    fi
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
  state_set VERSION "$SCRIPT_VERSION"
  state_set MODE "$MODE"
  step_base_packages
  step_kms_boot
  step_swap
  step_node
  step_build
  step_server_config
  step_server_user
  step_server_unit
  step_photoprism_unit
  step_kiosk
  step_verify
  summary
}

main "$@"

#!/usr/bin/env bash
#
# PicoGallery Uninstaller — comprehensive, self-contained cleanup.
# =============================================================================
# Removes every trace this project leaves on a Raspberry Pi. It is the single
# source of truth for cleanup (install.sh --uninstall delegates here). It cleans:
# - Systemd services, timers, and drop-ins (current + every legacy unit name)
# - Binaries, sudoers, and the seat udev rule
# - Users and groups created for the kiosk/server (with their home dirs)
# - Configuration + cache directories, the kiosk browser cache, and the install log
# - The build swapfile (and fstab entry) / reverted dphys-swapfile size
#   (restores the exact pre-install size recorded in /var/lib/picogallery/state)
# - Boot-config additions (KMS overlay, gpu_mem) and USB host-mode backups
# - The install-state manifest (/var/lib/picogallery)
# - Local node_modules (keeps tracked frontend/dist bundle intact)
# - With --purge: the apt packages installed for the appliance (cog, cage,
#   seatd, and NodeSource nodejs + its apt repo) as well
#
# Ends with a verification sweep that reports anything still present.
#
# Usage: sudo ./uninstall.sh [-y|--yes] [--purge]
# =============================================================================

set -Eeuo pipefail

readonly CONFIG_DIR="/etc/picogallery"
readonly CACHE_DIR="/var/cache/picogallery"
readonly STATE_DIR="/var/lib/picogallery"
readonly STATE_FILE="$STATE_DIR/state"
readonly LOG_FILE="/var/log/picogallery-install.log"
readonly KIOSK_USER="picokiosk"
readonly SERVER_USER="picogallery"
readonly SEAT_UDEV_RULE="/etc/udev/rules.d/72-picogallery-seat.rules"

ASSUME_YES=0
PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    --purge)  PURGE=1; shift ;;
    -h|--help) printf 'Usage: sudo ./uninstall.sh [-y|--yes] [--purge]\n  --purge  also remove apt packages installed for the appliance\n           (cog, cage, seatd, NodeSource nodejs + repo)\n'; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 1 ;;
  esac
done

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'
else
  C_RESET="" C_INFO="" C_OK="" C_WARN="" C_ERR=""
fi

info() { printf '%s[INFO]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$C_OK"   "$C_RESET" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
err()  { printf '%s[FAIL]%s %s\n' "$C_ERR"  "$C_RESET" "$*" >&2; }
step() { printf '\n%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
die()  { err "$*"; exit 1; }

run() {
  "$@"
}

confirm() {
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  local prompt="$1" ans
  read -r -p "$prompt [y/N] " ans || true
  [[ "$ans" =~ ^[Yy] ]]
}

# state_get <key> <default> — read a fact install.sh recorded (exact original
# swap size, whether we created the seat group, …). Missing file → default.
state_get() {
  local key="$1" def="${2:-}" v=""
  if [[ -f "$STATE_FILE" ]]; then
    v="$(grep -E "^$key=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${v:-$def}"
}

[[ $EUID -eq 0 ]] || die "Run with sudo."

# Read everything we need from the manifest BEFORE any cleanup deletes it.
DPHYS_ORIG_SWAPSIZE="$(state_get DPHYS_ORIG_SWAPSIZE "")"
SEAT_GROUP_CREATED="$(state_get SEAT_GROUP_CREATED 0)"

step "Uninstalling PicoGallery"
confirm "Remove PicoGallery services, users, config, cache, and all system traces?" || die "Aborted."

# 1. Systemd Services and Timers — current units plus every legacy name this
#    project shipped under previous identities, so nothing survives to fight a
#    reinstall or to keep grabbing tty1/DRM.
info "Disabling and removing systemd services..."
for unit in picogallery-kiosk.service picogallery-photoprism.service picogallery.service \
            pico-display-on.timer pico-display-off.timer \
            pico-display-on.service pico-display-off.service \
            pico-google-photos.service photoprism-kiosk.service \
            pico-kiosk.service pico-wait-online.service; do
  run systemctl disable --now "$unit" 2>/dev/null || true
  # `systemctl disable` no-ops when the unit file is already gone (drift from a
  # partial uninstall), leaving dangling .wants symlinks that systemd complains
  # about — and a dangling kiosk symlink still races tty1 at boot. Remove the
  # symlinks explicitly from every target dir we ever installed into.
  for wants in multi-user.target.wants graphical.target.wants timers.target.wants; do
    run rm -f "/etc/systemd/system/$wants/$unit"
  done
  run rm -f "/etc/systemd/system/$unit" "/run/systemd/system/$unit" "/lib/systemd/system/$unit"
  run rm -rf "/etc/systemd/system/$unit.d"
  run systemctl reset-failed "$unit" 2>/dev/null || true
done

# seatd was enabled by install.sh for the kiosk seat; nothing else on a frame
# appliance uses it. Disable so no enabled-but-unused daemon is left behind.
if systemctl is-enabled --quiet seatd.service 2>/dev/null; then
  info "Disabling seatd.service (was enabled by the kiosk install)..."
  run systemctl disable --now seatd.service 2>/dev/null || true
fi

# 2. System binaries, sudoers, and udev rules
info "Removing binaries and udev rules..."
run rm -f /usr/local/bin/picogallery-kiosk /usr/local/bin/pico-display-power /etc/sudoers.d/picogallery-kiosk
run rm -rf /etc/systemd/system/picogallery-kiosk.service.d
run rm -f "$SEAT_UDEV_RULE"
run udevadm control --reload 2>/dev/null || true
run udevadm trigger --subsystem-match=input --action=change 2>/dev/null || true
run udevadm trigger --subsystem-match=usb --action=change 2>/dev/null || true
run udevadm settle --timeout=10 2>/dev/null || true
run systemctl daemon-reload

# 3. Restore console login
info "Restoring tty1 console login..."
run systemctl enable --now getty@tty1.service 2>/dev/null || true

# 4. Swap file / dphys-swapfile size
info "Removing build swapfile or reverting swap size..."
if [[ -f /var/swap.picogallery ]]; then
  run swapoff /var/swap.picogallery 2>/dev/null || true
  run sed -i '\#/var/swap.picogallery#d' /etc/fstab 2>/dev/null || true
  run rm -f /var/swap.picogallery
fi
if [[ -f /etc/dphys-swapfile ]] && grep -q '^CONF_SWAPSIZE=1024' /etc/dphys-swapfile; then
  # Prefer the exact pre-install size the installer recorded; 100 is the
  # Raspberry Pi OS default and only a fallback for pre-manifest installs.
  orig_swapsize="${DPHYS_ORIG_SWAPSIZE:-100}"
  [[ "$orig_swapsize" =~ ^[0-9]+$ ]] || orig_swapsize=100
  info "Reverting /etc/dphys-swapfile size to $orig_swapsize..."
  run sed -i "s/^CONF_SWAPSIZE=1024/CONF_SWAPSIZE=$orig_swapsize/" /etc/dphys-swapfile
  run dphys-swapfile setup 2>/dev/null || true
  run dphys-swapfile swapon 2>/dev/null || true
fi

# 5. Kiosk browser cache — remove explicitly first (userdel -r below also drops
#    the home dir, but do it here too in case the account was already deleted or
#    userdel fails, so no stale Service Workers / cached SPA files are left).
info "Clearing kiosk browser cache and local storage..."
run rm -rf "/home/$KIOSK_USER/.cache" "/home/$KIOSK_USER/.local" "/home/$KIOSK_USER/.config" 2>/dev/null || true

# 6. Configuration, cache, install-state manifest, install log, and the
#    installer's NodeSource bootstrap script if a failed run left it behind.
info "Removing configuration, cache, state, and install log..."
run rm -rf "$CONFIG_DIR" "$CACHE_DIR" "$STATE_DIR"
run rm -f "$LOG_FILE" /tmp/nodesource_setup.sh

# 7. Users. WPE WebKit child processes (WPEWebProcess/WPENetworkProcess) can
#    outlive the stopped kiosk unit; a surviving process makes `userdel -r` fail
#    silently and the stale home directory (browser profile) survives into the
#    next install. Kill the user's processes (escalating, with a real wait),
#    then remove the account — and remove the home dir ourselves if userdel
#    can't.
info "Removing system users..."
if id "$KIOSK_USER" >/dev/null 2>&1; then
  run pkill -u "$KIOSK_USER" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    pgrep -u "$KIOSK_USER" >/dev/null 2>&1 || break
    run pkill -KILL -u "$KIOSK_USER" 2>/dev/null || true
    sleep 1
  done
  if ! userdel -r "$KIOSK_USER" 2>/dev/null; then
    # userdel -r also exits nonzero when only the home dir was missing — the
    # account may already be gone; retry the account removal only if it isn't.
    if id "$KIOSK_USER" >/dev/null 2>&1; then
      warn "userdel -r failed — removing the account and home directory separately"
      userdel "$KIOSK_USER" 2>/dev/null || warn "could not delete user $KIOSK_USER — remove manually: userdel -r $KIOSK_USER"
    fi
    run rm -rf "/home/$KIOSK_USER"
  fi
fi
# Stale home from an earlier failed uninstall (account already gone, dir left).
if [[ -d "/home/$KIOSK_USER" ]] && ! id "$KIOSK_USER" >/dev/null 2>&1; then
  run rm -rf "/home/$KIOSK_USER"
fi
if id "$SERVER_USER" >/dev/null 2>&1; then
  userdel "$SERVER_USER" 2>/dev/null || true
  if [[ -d "/home/$SERVER_USER" ]]; then
    run rm -rf "/home/$SERVER_USER"
  fi
fi

# 7b. The 'seat' group — only if this installer created it (recorded in the
#     manifest) and no user is still a member (the seatd package may rely on it).
if [[ "$SEAT_GROUP_CREATED" == "1" ]] && getent group seat >/dev/null 2>&1; then
  if [[ -z "$(getent group seat | cut -d: -f4)" ]]; then
    run groupdel seat 2>/dev/null || true
    ok "Removed 'seat' group (created by the installer, no remaining members)"
  else
    info "Keeping 'seat' group — it still has members."
  fi
fi

# 8. Boot Config additions and backups
info "Restoring boot configuration backups or reverting appended settings..."
for cfg in /boot/firmware/config.txt /boot/config.txt; do
  if [[ -f "$cfg.picogallery.bak" ]]; then
    # USB host-mode guard saved a full backup before editing — restoring it also
    # reverts any KMS/gpu_mem block we appended to the same file.
    run mv "$cfg.picogallery.bak" "$cfg"
    ok "Restored $cfg from backup"
  elif [[ -f "$cfg" ]] && grep -q "PicoGallery installer" "$cfg"; then
    info "Removing settings appended to $cfg..."
    run cp -a "$cfg" "$cfg.picogallery-un.bak"
    # Current format: delete every "# BEGIN … # END PicoGallery installer" block
    # (covers the KMS overlay and gpu_mem in one deterministic pass).
    run sed -i '/# BEGIN PicoGallery installer/,/# END PicoGallery installer/d' "$cfg"
    # Legacy format (marker line + dtoverlay, no END marker) from older installs.
    local_removed_legacy=0
    if grep -q "# Added by PicoGallery installer" "$cfg"; then
      run sed -i '/# Added by PicoGallery installer/,/^dtoverlay=vc4-kms-v3d$/d' "$cfg"
      local_removed_legacy=1
    fi
    # The legacy layout appended gpu_mem right after the KMS block with no marker,
    # so the range delete above orphaned it. Only strip a lone gpu_mem line we
    # would have written (64/128) when we actually removed a legacy KMS block.
    if [[ "$local_removed_legacy" -eq 1 ]]; then
      run sed -i -E '/^gpu_mem=(64|128)$/d' "$cfg"
    fi
    ok "Reverted appended settings in $cfg"
  fi
  cmdline="${cfg%config.txt}cmdline.txt"
  if [[ -f "$cmdline.picogallery.bak" ]]; then
    run mv "$cmdline.picogallery.bak" "$cmdline"
    ok "Restored $cmdline"
  fi
done

if [[ -f /etc/modules.picogallery.bak ]]; then
  run mv /etc/modules.picogallery.bak /etc/modules
  ok "Restored /etc/modules"
fi

# 9. Local Project Caches (node_modules only).
#    Do NOT delete frontend/dist: the built PhotoPrism UI is a *tracked* repo
#    artifact, because the Pi appliance (512 MB) cannot run the webpack build.
#    Deleting it here bricked reinstalls — the installer then attempted an
#    on-device build that OOMs, leaving the host with nothing to serve (blank
#    screen). Removing the checkout itself is the final `rm -rf` hint below.
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_PATH/package.json" ]]; then
  info "Cleaning local node_modules in $SCRIPT_PATH..."
  run rm -rf "$SCRIPT_PATH/frontend/node_modules"
  run rm -rf "$SCRIPT_PATH/node_modules"
fi

run systemctl reset-failed 2>/dev/null || true

# 10. Packages (opt-in). Only with --purge: cog/cage/seatd exist solely for the
#     kiosk, and nodejs came from the NodeSource repo this installer added. The
#     NodeSource repo files are removed too, so apt stops tracking it. nodejs is
#     purged only when the NodeSource list is present (evidence we installed it).
if [[ "$PURGE" -eq 1 ]]; then
  step "Purging appliance packages (--purge)"
  export DEBIAN_FRONTEND=noninteractive
  run apt-get purge -y cog cage seatd 2>/dev/null || warn "cog/cage/seatd purge failed (apt busy or packages absent)"
  if [[ -f /etc/apt/sources.list.d/nodesource.list ]]; then
    run apt-get purge -y nodejs 2>/dev/null || true
    run rm -f /etc/apt/sources.list.d/nodesource.list \
              /etc/apt/keyrings/nodesource.gpg \
              /usr/share/keyrings/nodesource.gpg
    ok "Removed NodeSource nodejs and its apt repo"
  fi
  run apt-get autoremove -y 2>/dev/null || true
  ok "Packages purged"
fi

# 11. Verification sweep — prove the cleanup instead of assuming it. Reports
#     every artifact this project is known to create that still exists.
step "Verifying cleanup"
LEFTOVERS=0
check_gone() {
  local desc="$1"; shift
  local found=()
  local p
  for p in "$@"; do
    # -L too: a dangling .wants symlink fails -e but still breaks the next boot.
    if [[ -e "$p" || -L "$p" ]]; then found+=("$p"); fi
  done
  if [[ ${#found[@]} -gt 0 ]]; then
    warn "leftover $desc: ${found[*]}"
    LEFTOVERS=$((LEFTOVERS+1))
  fi
}
check_gone "systemd units" \
  /etc/systemd/system/picogallery-kiosk.service \
  /etc/systemd/system/picogallery-photoprism.service \
  /etc/systemd/system/picogallery.service \
  /etc/systemd/system/pico-display-on.timer /etc/systemd/system/pico-display-off.timer \
  /etc/systemd/system/pico-display-on.service /etc/systemd/system/pico-display-off.service \
  /etc/systemd/system/pico-google-photos.service /etc/systemd/system/photoprism-kiosk.service \
  /etc/systemd/system/pico-kiosk.service /etc/systemd/system/pico-wait-online.service \
  /etc/systemd/system/picogallery-kiosk.service.d
check_gone "enablement symlinks" \
  /etc/systemd/system/multi-user.target.wants/picogallery-kiosk.service \
  /etc/systemd/system/multi-user.target.wants/picogallery-photoprism.service \
  /etc/systemd/system/timers.target.wants/pico-display-on.timer \
  /etc/systemd/system/timers.target.wants/pico-display-off.timer
check_gone "binaries/sudoers/udev rule" \
  /usr/local/bin/picogallery-kiosk /usr/local/bin/pico-display-power \
  /etc/sudoers.d/picogallery-kiosk "$SEAT_UDEV_RULE"
check_gone "config/cache/state/log" \
  "$CONFIG_DIR" "$CACHE_DIR" "$STATE_DIR" "$LOG_FILE"
check_gone "swapfile" /var/swap.picogallery
check_gone "kiosk home directory" "/home/$KIOSK_USER"
if id "$KIOSK_USER" >/dev/null 2>&1; then
  warn "leftover user account: $KIOSK_USER"
  LEFTOVERS=$((LEFTOVERS+1))
fi
if id "$SERVER_USER" >/dev/null 2>&1; then
  warn "leftover user account: $SERVER_USER"
  LEFTOVERS=$((LEFTOVERS+1))
fi
if grep -q "PicoGallery installer" /boot/firmware/config.txt /boot/config.txt 2>/dev/null; then
  warn "leftover PicoGallery block in boot config — check /boot*/config.txt"
  LEFTOVERS=$((LEFTOVERS+1))
fi

if [[ "$LEFTOVERS" -eq 0 ]]; then
  ok "Verification clean — no PicoGallery traces found."
else
  warn "$LEFTOVERS leftover item(s) reported above — remove them manually or re-run this script."
fi

ok "Uninstalled PicoGallery successfully."
if [[ "$PURGE" -eq 0 ]]; then
  info "Packages (cog/cage/seatd/node) and the NodeSource apt repo were left installed; re-run with --purge to remove them."
fi
ok "To completely remove the codebase, delete this folder: rm -rf $SCRIPT_PATH"

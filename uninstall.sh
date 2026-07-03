#!/usr/bin/env bash
#
# PicoGallery Uninstaller
# =============================================================================
# Cleans all traces of the project on the Raspberry Pi. This includes:
# - Systemd services, timers, and drop-ins
# - Users and groups created for the kiosk/server
# - Configuration directories and caches
# - Swap files created for building
# - Udev rules and boot configuration backups
# - Local node_modules and frontend/dist build artifacts
# =============================================================================

set -Eeuo pipefail

readonly CONFIG_DIR="/etc/picogallery"
readonly CACHE_DIR="/var/cache/picogallery"
readonly KIOSK_USER="picokiosk"
readonly SERVER_USER="picogallery"
readonly SEAT_UDEV_RULE="/etc/udev/rules.d/72-picogallery-seat.rules"

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
  local prompt="$1"
  local ans
  read -r -p "$prompt [y/N] " ans || true
  [[ "$ans" =~ ^[Yy] ]]
}

[[ $EUID -eq 0 ]] || die "Run with sudo."

step "Uninstalling PicoGallery"
confirm "Remove PicoGallery services, users, config, cache, and all system traces?" || die "Aborted."

# 1. Systemd Services and Timers
info "Disabling and removing systemd services..."
for unit in picogallery-kiosk.service picogallery-photoprism.service picogallery.service \
            pico-display-on.timer pico-display-off.timer \
            pico-display-on.service pico-display-off.service \
            pico-google-photos.service photoprism-kiosk.service \
            pico-kiosk.service pico-wait-online.service; do
  run systemctl disable --now "$unit" 2>/dev/null || true
  run rm -f "/etc/systemd/system/$unit"
  run rm -rf "/etc/systemd/system/$unit.d"
done

# 2. System binaries and rules
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

# 4. Swap file
info "Removing build swapfile or reverting swap size..."
if [[ -f /var/swap.picogallery ]]; then
  run swapoff /var/swap.picogallery 2>/dev/null || true
  run sed -i '\#/var/swap.picogallery#d' /etc/fstab 2>/dev/null || true
  run rm -f /var/swap.picogallery
fi
if [[ -f /etc/dphys-swapfile ]] && grep -q '^CONF_SWAPSIZE=1024' /etc/dphys-swapfile; then
  info "Reverting /etc/dphys-swapfile size to 100..."
  run sed -i 's/^CONF_SWAPSIZE=1024/CONF_SWAPSIZE=100/' /etc/dphys-swapfile
  run dphys-swapfile setup 2>/dev/null || true
  run dphys-swapfile swapon 2>/dev/null || true
fi

# 5. Configuration and Cache
info "Removing configuration and cache directories..."
run rm -rf "$CONFIG_DIR" "$CACHE_DIR"

# 6. Users
info "Removing system users..."
id "$KIOSK_USER" >/dev/null 2>&1 && run userdel -r "$KIOSK_USER" 2>/dev/null || true
id "$SERVER_USER" >/dev/null 2>&1 && run userdel "$SERVER_USER" 2>/dev/null || true

# 7. Boot Config Backups and Settings
info "Restoring boot configuration backups or settings if available..."
for cfg in /boot/firmware/config.txt /boot/config.txt; do
  if [[ -f "$cfg.picogallery.bak" ]]; then
    run mv "$cfg.picogallery.bak" "$cfg"
    ok "Restored $cfg from backup"
  elif [[ -f "$cfg" ]] && grep -q "Added by PicoGallery installer" "$cfg"; then
    info "Removing KMS boot settings appended to $cfg..."
    run cp -a "$cfg" "$cfg.picogallery-un.bak"
    run sed -i '/# Added by PicoGallery installer/,$d' "$cfg"
    ok "Reverted settings in $cfg"
  fi
  local cmdline="${cfg%config.txt}cmdline.txt"
  if [[ -f "$cmdline.picogallery.bak" ]]; then
    run mv "$cmdline.picogallery.bak" "$cmdline"
    ok "Restored $cmdline"
  fi
done

if [[ -f /etc/modules.picogallery.bak ]]; then
  run mv /etc/modules.picogallery.bak /etc/modules
  ok "Restored /etc/modules"
fi

# 8. Local Project Caches
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_PATH/package.json" ]]; then
  info "Cleaning local project build caches and node_modules in $SCRIPT_PATH..."
  run rm -rf "$SCRIPT_PATH/frontend/node_modules"
  run rm -rf "$SCRIPT_PATH/frontend/dist"
  run rm -rf "$SCRIPT_PATH/node_modules"
fi

ok "Uninstalled PicoGallery successfully."
ok "To completely remove the codebase, you can delete this folder: rm -rf $SCRIPT_PATH"

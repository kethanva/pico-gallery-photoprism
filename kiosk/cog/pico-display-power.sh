#!/usr/bin/env bash
# pico-display-power — turn the Pi's display on/off for the blank schedule.
#
# Tries three power paths in order, so it works across Pi models:
#   1. vcgencmd display_power   — Pi 4 / Pi 5 (needs the 'video' group)
#   2. rpi_backlight sysfs      — official DSI touchscreen
#   3. DRM connector dpms sysfs — generic HDMI fallback
#
# Installed to /usr/local/bin/pico-display-power by install.sh and driven
# by the pico-display-{on,off}.timer units.
#
# Usage: pico-display-power on|off
set -euo pipefail
ACTION="${1:?Usage: pico-display-power on|off}"

turn_on() {
  if command -v vcgencmd >/dev/null 2>&1; then
    local out; out="$(vcgencmd display_power 1 2>/dev/null || true)"
    if [[ "$out" == "display_power=1" ]]; then return 0; fi
  fi
  if [ -f /sys/class/backlight/rpi_backlight/bl_power ]; then
    echo 0 >/sys/class/backlight/rpi_backlight/bl_power 2>/dev/null && return 0 || true
  fi
  for dpms in /sys/class/drm/*/dpms; do
    if [ -w "$dpms" ]; then echo on >"$dpms" 2>/dev/null || true; fi
  done
  return 0
}

turn_off() {
  if command -v vcgencmd >/dev/null 2>&1; then
    local out; out="$(vcgencmd display_power 0 2>/dev/null || true)"
    if [[ "$out" == "display_power=0" ]]; then return 0; fi
  fi
  if [ -f /sys/class/backlight/rpi_backlight/bl_power ]; then
    echo 1 >/sys/class/backlight/rpi_backlight/bl_power 2>/dev/null && return 0 || true
  fi
  for dpms in /sys/class/drm/*/dpms; do
    if [ -w "$dpms" ]; then echo off >"$dpms" 2>/dev/null || true; fi
  done
  return 0
}

case "$ACTION" in
  on)  turn_on ;;
  off) turn_off ;;
  *)   echo "Usage: pico-display-power on|off" >&2; exit 1 ;;
esac

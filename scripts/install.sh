#!/usr/bin/env bash
#
# PicoGallery appliance installer (Raspberry Pi OS Lite / Debian, 64-bit).
#
# Provisions the canonical kiosk: Cog (WPE WebKit) running under the Cage
# Wayland kiosk compositor — no X11, no desktop. This is the V2 replacement for
# V1's install.sh.
#
# Usage (on the device):
#   sudo ./scripts/install.sh http://<server-host>:8188
#
#   sudo ./scripts/install.sh --with-server http://localhost:8188
#       also installs a systemd unit for the PicoGallery server from this repo.
#
# Idempotent: re-running updates the frame URL, units, and sudoers.

set -euo pipefail

# ── Guards ────────────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: the Cog+Cage kiosk runs only on Linux (Raspberry Pi). On macOS use" >&2
  echo "       ./run.sh kiosk to mimic the frame in your local browser." >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run with sudo (it installs packages, a user, and systemd units)." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIOSK_USER="picokiosk"
WITH_SERVER=0
FRAME_URL=""

for arg in "$@"; do
  case "$arg" in
    --with-server) WITH_SERVER=1 ;;
    --blank-on=*)  BLANK_ON="${arg#*=}" ;;
    --blank-off=*) BLANK_OFF="${arg#*=}" ;;
    http://*|https://*) FRAME_URL="$arg" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done
FRAME_URL="${FRAME_URL:-http://localhost:8188}"
# Optional display-blank window (HH:MM). Both must be set to enable the schedule.
BLANK_ON="${BLANK_ON:-}"
BLANK_OFF="${BLANK_OFF:-}"

echo "==> Installing Cog (WPE WebKit) + Cage + seatd"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends cog cage seatd curl

echo "==> Creating kiosk user '$KIOSK_USER' and seat/GPU groups"
if ! id "$KIOSK_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$KIOSK_USER"
fi
# Groups Cage/wlroots need to open DRM/KMS and input via seatd.
for grp in video render input seat; do
  getent group "$grp" >/dev/null 2>&1 && usermod -aG "$grp" "$KIOSK_USER" || true
done

echo "==> Enabling seatd (seat management for the Wayland backend)"
systemctl enable --now seatd.service

echo "==> Writing /etc/picogallery/kiosk.env (frame URL: $FRAME_URL)"
install -d -m 0755 /etc/picogallery
cat >/etc/picogallery/kiosk.env <<EOF
# PicoGallery kiosk runtime config. Edit and 'systemctl restart picogallery-kiosk'.
FRAME_URL=$FRAME_URL
# Seconds to wait for the server's /api/v1/health on boot before launching anyway.
WAIT_TIMEOUT=120
# COG_EXTRA="--enable-developer-extras=false"
EOF
chmod 0644 /etc/picogallery/kiosk.env

echo "==> Installing launcher → /usr/local/bin/picogallery-kiosk"
install -m 0755 "$REPO_ROOT/kiosk/cog/picogallery-kiosk.sh" /usr/local/bin/picogallery-kiosk

echo "==> Installing systemd unit + sudoers"
install -m 0644 "$REPO_ROOT/kiosk/cog/picogallery-kiosk.service" /etc/systemd/system/picogallery-kiosk.service
install -m 0440 "$REPO_ROOT/kiosk/cog/picogallery-kiosk.sudoers" /etc/sudoers.d/picogallery-kiosk
visudo -cf /etc/sudoers.d/picogallery-kiosk >/dev/null

# ── Optional display-blank schedule ───────────────────────────────────────────
# Installs the display-power helper + on/off services, and generates timers for
# the requested window. Skipped (display always on) unless both --blank-on and
# --blank-off are given. Runs as root so vcgencmd/backlight/DRM writes all work.
if [[ -n "$BLANK_ON" && -n "$BLANK_OFF" ]]; then
  echo "==> Installing display-blank schedule (off $BLANK_ON → on $BLANK_OFF)"
  install -m 0755 "$REPO_ROOT/kiosk/cog/pico-display-power.sh" /usr/local/bin/pico-display-power
  install -m 0644 "$REPO_ROOT/kiosk/cog/pico-display-on.service"  /etc/systemd/system/pico-display-on.service
  install -m 0644 "$REPO_ROOT/kiosk/cog/pico-display-off.service" /etc/systemd/system/pico-display-off.service
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
elif [[ -n "$BLANK_ON$BLANK_OFF" ]]; then
  echo "WARNING: --blank-on and --blank-off must be set together; ignoring blank schedule." >&2
fi

# ── GPU memory split (helps WPE/Cog on older Pis) ─────────────────────────────
for boot_cfg in /boot/firmware/config.txt /boot/config.txt; do
  if [[ -f "$boot_cfg" ]]; then
    if ! grep -q '^gpu_mem=' "$boot_cfg"; then
      echo "==> Setting gpu_mem=128 in $boot_cfg (takes effect on reboot)"
      echo 'gpu_mem=128' >>"$boot_cfg"
    fi
    break
  fi
done

if [[ "$WITH_SERVER" -eq 1 ]]; then
  echo "==> Installing PicoGallery server unit (runs from $REPO_ROOT)"
  NODE_BIN="$(command -v node || true)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "WARNING: node not found on PATH; build + install Node 22 before enabling the server unit." >&2
  fi
  install -d -m 0755 /etc/picogallery
  [[ -f /etc/picogallery/config.toml ]] || cp "$REPO_ROOT/config.example.toml" /etc/picogallery/config.toml
  cat >/etc/systemd/system/picogallery.service <<EOF
[Unit]
Description=PicoGallery server
After=network-online.target
Wants=network-online.target

[Service]
Environment=NODE_ENV=production
Environment=PICO_CONFIG=/etc/picogallery/config.toml
WorkingDirectory=$REPO_ROOT
ExecStart=${NODE_BIN:-/usr/bin/node} $REPO_ROOT/server/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
fi

echo "==> Reloading systemd and enabling the kiosk"
systemctl daemon-reload
systemctl enable picogallery-kiosk.service
[[ "$WITH_SERVER" -eq 1 ]] && systemctl enable picogallery.service || true

cat <<EOF

Done. The Pi will boot into the frame at: $FRAME_URL

  Start now:    sudo systemctl start picogallery-kiosk
  Logs:         journalctl -u picogallery-kiosk -f
  Change URL:   edit /etc/picogallery/kiosk.env, then restart the service
  Restart frame (as kiosk user, passwordless): sudo systemctl restart picogallery-kiosk

The display stack is Cog (WPE WebKit) under Cage — no X11, no desktop.
EOF

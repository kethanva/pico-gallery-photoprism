#!/usr/bin/env bash
set -Eeuo pipefail

# Strict, read-only post-reboot acceptance test for a Raspberry Pi appliance.
# Unlike pi-e2e-diagnose.sh, this command returns nonzero when a required
# production invariant is not satisfied.
#
# Usage:
#   sudo /opt/picogallery/scripts/pi-canary.sh [--server-only] [--allow-no-input]

readonly HOST_ORIGIN="${PICO_CANARY_ORIGIN:-http://127.0.0.1:8190}"
readonly RUNTIME_ROOT="${PICO_CANARY_ROOT:-/opt/picogallery}"
readonly PROC_ROOT="${PICO_CANARY_PROC_ROOT:-/proc}"
readonly DEV_ROOT="${PICO_CANARY_DEV_ROOT:-/dev}"
readonly ETC_ROOT="${PICO_CANARY_ETC_ROOT:-/etc}"
CHECK_KIOSK=1
REQUIRE_INPUT=1
FAILURES=0

for arg in "$@"; do
  case "$arg" in
    --server-only) CHECK_KIOSK=0 ;;
    --allow-no-input) REQUIRE_INPUT=0 ;;
    -h|--help)
      sed -n '3,9p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

require_command() {
  command -v "$1" >/dev/null 2>&1 && pass "$1 available" || fail "$1 is required"
}

check_service() {
  local unit="$1"
  systemctl is-enabled --quiet "$unit" && pass "$unit enabled" || fail "$unit is not enabled"
  systemctl is-active --quiet "$unit" && pass "$unit active" || fail "$unit is not active"
}

check_url() {
  local label="$1" url="$2" attempts="${3:-10}" body="" code="" i
  for ((i = 1; i <= attempts; i++)); do
    body="$(mktemp)"
    code="$(curl -sS --max-time 5 -o "$body" -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$code" == "200" ]]; then
      pass "$label returned HTTP 200"
      CANARY_BODY="$body"
      return 0
    fi
    rm -f "$body"
    sleep 1
  done
  fail "$label did not return HTTP 200 (last status: ${code:-unreachable})"
  CANARY_BODY=""
  return 1
}

echo "PicoGallery Raspberry Pi post-reboot canary"
echo "runtime: $RUNTIME_ROOT"
echo "origin:  $HOST_ORIGIN"

require_command curl
require_command node
require_command systemctl

model="$(tr -d '\0' <"$PROC_ROOT/device-tree/model" 2>/dev/null || true)"
[[ "$model" == *"Raspberry Pi"* ]] && pass "Raspberry Pi hardware detected: $model" || fail "not running on Raspberry Pi hardware"

[[ -d "$RUNTIME_ROOT" ]] && pass "runtime directory exists" || fail "runtime directory missing: $RUNTIME_ROOT"
[[ -f "$RUNTIME_ROOT/frontend/dist/static/build/assets.json" ]] && pass "asset manifest exists" || fail "asset manifest missing"

check_service picogallery-photoprism.service

CANARY_BODY=""
check_url "host liveness" "$HOST_ORIGIN/api/v1/health" 30 || true
[[ -z "$CANARY_BODY" ]] || rm -f "$CANARY_BODY"
CANARY_BODY=""
check_url "authenticated backend readiness" "$HOST_ORIGIN/api/v1/ready" 30 || true
[[ -z "$CANARY_BODY" ]] || rm -f "$CANARY_BODY"

CANARY_BODY=""
if check_url "sanitized PhotoPrism configuration" "$HOST_ORIGIN/api/v1/config" 5; then
  if node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1]));if(c.mode!=='public')process.exit(1)" "$CANARY_BODY"; then
    pass "configuration is rewritten to public kiosk mode"
  else
    fail "configuration is not rewritten to public kiosk mode"
  fi
  rm -f "$CANARY_BODY"
fi

CANARY_BODY=""
if check_url "deep SPA route" "$HOST_ORIGIN/library/photos" 5; then
  grep -q "'/static/build/assets.json'" "$CANARY_BODY" && pass "deep route serves bootable SPA HTML" || fail "deep route does not contain the SPA asset bootstrap"
  rm -f "$CANARY_BODY"
fi

if [[ -f "$RUNTIME_ROOT/frontend/dist/static/build/assets.json" ]]; then
  if node -e "const fs=require('fs'),p=require('path');const root=process.argv[1],m=JSON.parse(fs.readFileSync(p.join(root,'assets.json')));for(const k of ['app.js','app.css']){if(!m[k]||!fs.existsSync(p.join(root,m[k])))process.exit(1)}" "$RUNTIME_ROOT/frontend/dist/static/build"; then
    pass "manifest references existing app.js and app.css"
  else
    fail "manifest references missing production assets"
  fi
fi

for stray in pico-google-photos.service photoprism-kiosk.service pico-kiosk.service; do
  if [[ -e "$ETC_ROOT/systemd/system/$stray" ]]; then
    fail "conflicting legacy kiosk unit exists: $stray"
  fi
done

if [[ "$CHECK_KIOSK" -eq 1 ]]; then
  check_service seatd.service
  check_service picogallery-kiosk.service
  compgen -G "$DEV_ROOT/dri/card*" >/dev/null && pass "DRM/KMS card available" || fail "no DRM/KMS card available"

  if journalctl -u picogallery-kiosk.service -b --no-pager 2>/dev/null | grep -qiE 'libinput.*(no input devices|cannot open)|failed to open.*(drm|card)|permission denied'; then
    fail "current-boot kiosk journal contains display/input initialization errors"
  else
    pass "current-boot kiosk journal has no known display/input initialization errors"
  fi

  input_count=0
  if [[ -r "$PROC_ROOT/bus/input/devices" ]]; then
    input_count="$(grep -Ec 'Handlers=.*(kbd|mouse)' "$PROC_ROOT/bus/input/devices" 2>/dev/null || true)"
  fi
  if [[ "$input_count" -gt 0 ]]; then
    pass "kernel detected keyboard/mouse input ($input_count device entries)"
  elif [[ "$REQUIRE_INPUT" -eq 1 ]]; then
    fail "kernel detected no keyboard or mouse (use --allow-no-input for display-only appliances)"
  else
    pass "input device requirement explicitly disabled"
  fi
fi

if [[ "$FAILURES" -ne 0 ]]; then
  printf '\nCANARY FAILED: %d required check(s) failed.\n' "$FAILURES" >&2
  printf 'Run: sudo %s/scripts/pi-e2e-diagnose.sh %s\n' "$RUNTIME_ROOT" "$RUNTIME_ROOT" >&2
  exit 1
fi

printf '\nCANARY PASSED: all required post-reboot checks succeeded.\n'

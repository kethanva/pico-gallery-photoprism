# Debug: kiosk doesn't start after reboot + keyboard dead

> ## ROOT CAUSE CONFIRMED (from the on-device boot photos)
> The boot photo shows, right before `Reached target multi-user.target`:
> `Started pico-google-photos.service - pico-google-photos kiosk (Cage + Chromium)`.
> That is a **retired kiosk unit from an earlier name of this project** (pre-rename:
> pico-google-photos → photoprism-kiosk → picogallery). It survived the upgrade and
> runs alongside the new `picogallery-kiosk.service` (Cage + Cog). **Two kiosks, each
> grabbing tty1 + the DRM master + the seat, with no mutual `Conflicts=`** → they race,
> neither paints, and the console freezes at `multi-user.target`. This is the real
> cause of every symptom below (no frame, dead keyboard, frozen boot text). The
> XDG_RUNTIME_DIR / single-service tty theories in the rest of this doc were guesses;
> they were not the blocker.
>
> **Fix (shipped):** `install.sh` now runs `purge_legacy_kiosk` at the top of
> `step_kiosk` — it deletes every `pico-*`/`photoprism-*` kiosk unit except the ones
> the current installer owns, before installing/enabling the Cog unit. `step_verify`
> now fails if a stray legacy unit or a missing `/dev/dri` card is detected, and
> `do_uninstall` removes the legacy names too.
>
> **Apply to the already-broken Pi (SSH):**
> ```bash
> sudo systemctl disable --now pico-google-photos.service
> sudo rm -f /etc/systemd/system/pico-google-photos.service \
>            /lib/systemd/system/pico-google-photos.service
> sudo rm -rf /etc/systemd/system/pico-google-photos.service.d
> sudo systemctl daemon-reload
> # confirm nothing else launches cage/chromium:
> grep -rIl -e cage -e chromium /etc/systemd/system /etc/xdg/autostart \
>      /var/lib/dietpi/dietpi-autostart 2>/dev/null
> sudo systemctl restart picogallery-kiosk && journalctl -u picogallery-kiosk -f
> ```
> Or just `git pull && sudo ./install.sh --mode all -y && sudo reboot` — the installer
> now purges the leftover automatically.


Hardware: Raspberry Pi running **DietPi** (arm64, deb13/trixie). Installed with
`sudo ./install.sh --mode all` (server + Cog/Cage kiosk). Install verify block was
all-green (server active, /health ok, kiosk service enabled, seatd active) and
asked for a reboot (KMS/GPU boot settings changed).

Two symptoms, same root cause (a kiosk crash-loop):

---

## Symptom 1 — browser UI never starts after reboot

`picogallery-kiosk.service` is **enabled** but fails to start at boot — the frame
(Cog/WPE under Cage) never appears.

### Most likely causes (DietPi-specific)

**A. `XDG_RUNTIME_DIR` missing (top suspect).**
The unit sets `Environment=XDG_RUNTIME_DIR=/run/user/%U`, but nothing creates
`/run/user/<picokiosk-uid>`. `picokiosk` is a `--system` user with a `nologin`
shell, so logind typically never creates that runtime dir → Cage dies with
`XDG_RUNTIME_DIR not set` / `failed to create wl_display`.
Journal tell: `XDG_RUNTIME_DIR`, `wl_display`, `Permission denied`.

**B. tty1 / DRM owned by the DietPi console.**
DietPi autologins a console on `tty1`. Cage wants `tty1` + DRM master → conflict.
Journal tell: `cannot open /dev/dri/card0`, `drm backend`, `seat`, `VT`.

### Diagnostics
```bash
systemctl --no-pager -l status picogallery-kiosk
journalctl -u picogallery-kiosk -b --no-pager | tail -40
ls -l /dev/dri/                       # card0 present? KMS active
id picokiosk                          # in video render input seat?
grep -E 'vc4-kms|gpu_mem' /boot/config.txt /boot/firmware/config.txt 2>/dev/null
sudo -u picokiosk cog --version       # cog runnable
cat /etc/picogallery/kiosk.env        # FRAME_URL correct
```

---

## Symptom 2 — keyboard dead after install/reboot

Cause: a **crash-loop**. The kiosk can't render (cause A/B above), so Cage dies
immediately. `Restart=always` + `RestartSec=3` relaunches it forever, and each
attempt grabs `tty1` + input devices via seatd. During the grabs the local console
keyboard is unusable → "keyboard not working at all" plus "kiosk UI never showed."

### Recover now — SSH from another machine
The Pi has network (health passed), so the dead local keyboard can be bypassed:
```bash
ssh root@<pi-ip>          # or ssh dietpi@<pi-ip>
sudo systemctl stop picogallery-kiosk
sudo systemctl disable picogallery-kiosk
sudo chvt 1
# if console still garbled:
sudo systemctl restart getty@tty1    # or just reboot (service now disabled)
```

### No SSH? Fallbacks
1. Power-cycle, then SSH in the moment the network is up and run stop+disable
   before the loop locks input.
2. SD-card surgery: pull the SD, mount elsewhere, delete the autostart symlink:
   ```
   rm /etc/systemd/system/multi-user.target.wants/picogallery-kiosk.service
   ```
   Reboot → console + keyboard back, kiosk disabled.

---

## Permanent fix (apply via SSH, then re-enable only after it renders)
```bash
# 1. stop the auto-loop while working
sudo systemctl disable --now picogallery-kiosk

# 2. free tty1 from DietPi's console
sudo systemctl disable --now getty@tty1.service

# 3. give picokiosk a runtime dir + BOUND the restart loop so a broken
#    config can never grab the keyboard forever
sudo install -d /etc/systemd/system/picogallery-kiosk.service.d
sudo tee /etc/systemd/system/picogallery-kiosk.service.d/20-fix.conf >/dev/null <<'EOF'
[Service]
RuntimeDirectory=picokiosk-run
Environment=XDG_RUNTIME_DIR=/run/picokiosk-run
ExecStartPre=/usr/bin/install -d -o picokiosk -g picokiosk -m 0700 /run/picokiosk-run
StartLimitIntervalSec=60
StartLimitBurst=3
EOF

sudo systemctl daemon-reload

# 4. test ONCE (won't loop), watch the log
sudo systemctl start picogallery-kiosk
journalctl -u picogallery-kiosk -f

# 5. only after the frame paints on HDMI:
sudo systemctl enable picogallery-kiosk
```

`RuntimeDirectory=` makes systemd create `/run/picokiosk-run` owned by the service
user each start (sidesteps the missing `/run/user/<uid>`).
`StartLimitBurst=3` makes a still-broken kiosk give up after 3 tries instead of
locking the keyboard.

---

## Repo fix — DONE (shipped in the unit + installer + launcher)
- `kiosk/cog/picogallery-kiosk.service`: `RuntimeDirectory=picogallery-kiosk` (0700,
  user-owned) + `XDG_RUNTIME_DIR=/run/picogallery-kiosk`; `Conflicts=getty@tty1.service`
  + `After=getty@tty1.service`; `StartLimitIntervalSec=120` / `StartLimitBurst=5` so a
  broken kiosk gives up instead of looping on the keyboard.
- `install.sh` `step_kiosk`: `systemctl disable --now getty@tty1.service` (and uninstall
  re-enables it).
- `kiosk/cog/picogallery-kiosk.sh`: ensures `XDG_RUNTIME_DIR` exists for manual launches.

### Apply to the already-broken Pi
The Pi still has the OLD unit. After pulling the repo update onto the device:
```bash
cd ~/pico-gallery-photoprism
git pull
sudo systemctl stop picogallery-kiosk           # break the loop first (or SSH-recover above)
sudo ./install.sh --mode all -y                  # idempotent: reinstalls unit, frees tty1
sudo reboot
```
Or, without re-running the installer, apply by hand: `systemctl disable --now getty@tty1.service`,
copy the new `picogallery-kiosk.service` to `/etc/systemd/system/`, `daemon-reload`,
`systemctl restart picogallery-kiosk`.

## Data to capture for a precise fix
```bash
journalctl -u picogallery-kiosk -b --no-pager | tail -40
ls -l /dev/dri/
id picokiosk
```

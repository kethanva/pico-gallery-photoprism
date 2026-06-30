# Deprecated: Qt/QtWebEngine kiosk

`kiosk/src/*` is a legacy Qt6 + **QtWebEngine** (Chromium-based) kiosk app
(`photoprism-kiosk`). It is **no longer the appliance display surface**.

The canonical kiosk is now **Cog (WPE WebKit) under the Cage Wayland compositor**:

- Launcher / unit / sudoers: [`kiosk/cog/`](cog/)
- Installer: [`install.sh`](../install.sh)
- Local mimic on a dev machine: `./run.sh kiosk`

Why the switch: QtWebEngine bundles a full Chromium and pulls the whole Qt stack —
heavy for a Pi Zero–class device. Cog+Cage is a minimal WPE WebKit browser on a
single-window Wayland compositor that opens DRM/KMS directly (no X11, no desktop),
which is the lighter, purpose-built kiosk path.

The Qt sources are kept here for reference only. The build artifacts
(`kiosk/build/`) have been removed; they are regenerable from `CMakeLists.txt` if
you ever need the old app. This directory is not part of the build or CI.

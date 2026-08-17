# Frontend Provenance & Vendoring Notice

This directory (`frontend/`) contains vendored assets from the **PhotoPrism Community Edition** web frontend (Vue 3 + Vuetify 3), adapted for the **PicoGallery** embedded appliance.

## First-Party Appliance Files

PicoGallery maintains custom, lightweight display logic isolated to these specific entrypoints:

- `src/minimal-photo-app.js` — Core minimal display application: virtualized responsive photo grid, infinite scrolling, auto-advancing fullscreen slideshow, preview modal, and memory-safe DOM recycling for low-power hardware (Raspberry Pi Zero 2 W).
- `src/kiosk-config.js` — Hardware kiosk profile resolution and runtime tuning parameters (batch sizes, spacer heights, idle timeouts).
- `tests/vitest/minimal-photo-app.test.js` & `tests/vitest/kiosk-config.test.js` — Vitest unit and integration suites for appliance frontend logic.

## Upstream Base

- **Origin**: [PhotoPrism Web Frontend](https://github.com/photoprism/photoprism/tree/develop/frontend)
- **Framework**: Vue 3 / Vuetify 3 (`vuetify@3.12.2` pinned) / Webpack / Vitest
- **Upstream Guidance**: Upstream documentation in `frontend/AGENTS.md` and `frontend/CODEMAP.md` is preserved for historical reference and upstream build maintenance.

## Re-synchronization & Maintenance Guide

When pulling security fixes or asset updates from upstream PhotoPrism:

1. Preserve the first-party appliance files listed above.
2. Maintain package version pins (especially `vuetify` pinned to `3.12.2`).
3. Rebuild production bundles using `npm run build` within `frontend/` (or `./run.sh build` from repository root).
4. Run `npm test` and `npm run test:host-smoke` to ensure end-to-end compatibility with `scripts/photoprism-host.mjs`.

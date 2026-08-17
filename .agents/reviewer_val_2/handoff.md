# Handoff Report — Reviewer 2: Frontend Virtualization, Kiosk Profiles & Smoke Suite Review

**Verdict**: APPROVE

---

## 1. Observation

### Codebase & Component Inspections
1. **Minimal Photo Display App (`frontend/src/minimal-photo-app.js`)**:
   - **Virtualizer Windowing & Pruning** (`lines 466-552`):
     - `pruneTopRowsIfNeeded()` calculates `ncol = getColumnCount()`, `maxCards = getKiosk().maxGridRows * ncol`. When DOM card count exceeds `maxCards`, it calculates `rowsToRemove = Math.ceil(excess / ncol)` and removes `rowsToRemove * ncol` cards from the top.
     - `gridWindow.startIndex` is incremented by `removeCount`, and `gridWindow.topSpacerPx` is increased by `rowsToRemove * rowHeight`, with `.pg-top-spacer` height updated dynamically.
     - `pruneBottomRowsIfNeeded()` trims excess cards from the bottom when restoring earlier rows.
     - `restoreTopRowsIfNeeded()` prepends batches of up to `ncol * getKiosk().restoreRowBatch` rows and adjusts `topSpacerPx` smoothly.
     - `scheduleRestoreTopRows()` enforces a cooldown period (`pruneCooldownMs = 350ms`) via `pruneCooldownUntil` to prevent thrashing.
   - **Texture Deallocation** (`lines 458-464`):
     - `removeCardNode(card)` explicitly executes `img.removeAttribute("src")` and `img.src = ""` prior to `card.remove()`, forcing immediate GPU/RAM decoded image release.
   - **Background Image Suspension** (`lines 677-706`):
     - `suspendGridImages()` sweeps all `.pg-image` nodes in `.pg-grid`, persists the thumbnail URL into `dataset.pgSavedSrc`, removes `src`, and clears `img.src = ""` upon entering preview/slideshow mode.
     - `resumeGridImages()` and `closePreview()` safely restore `img.src` from `dataset.pgSavedSrc` when preview closes.
   - **Slideshow Scheduler & Debounced Prefetch** (`lines 751-776, 619-655`):
     - `prefetchSlideAt()` uses `new Image()` with `decoding = "async"` and `fetchPriority = "low"`, debounced by 150ms (`slidePrefetch.timer`), with full cleanup in `cancelSlidePrefetch()`.
     - `scheduleSlideshowTick()` runs every `slideDuration * 1000` ms, seamlessly triggers `loadMore()` via `autoAdvanceOnLoad = true` when nearing batch end, and wraps around to 0 on `state.done`.
     - `maybeScheduleBackgroundFill()` maintains background loading up to `backgroundFillTarget` (default 32 photos) with 2000ms idle delay.
   - **Input Deduplication & Gestures** (`lines 267-301, 1313-1341, 1242-1288`):
     - `bindControlAction` deduplicates `pointerup`, `touchend`, and `click` with a 400ms lockout timer.
     - `onTouchEnd` detects horizontal swipes (`Math.abs(dx) >= 48px && Math.abs(dx) >= Math.abs(dy)`), advancing/reversing slides while preventing accidental dialog close (`touchSwiped = true`).
     - Key bindings (`Escape`, `f`/`F`, `s`/`S`, `ArrowLeft`/`ArrowRight`, `Space`, `Enter`) provide full keyboard navigation.

2. **Kiosk Profile Resolution & Parameter Bounds Clamping (`config/kiosk-config-core.mjs` & `config/kiosk-profiles.json`)**:
   - `resolveKioskConfigFrom()` safely parses profile configs and sets defaults (`defaultProfile: "pi_zero_2"`).
   - Bounds clamping is strictly enforced via `clampInt()`:
     - `firstPageSize`: `[4, 24]`
     - `pageSize`: `[8, 32]`
     - `maxGridRows`: `[6, 24]`
     - `restoreRowBatch`: `[1, 4]`
     - `eagerThumbCount`: `[0, 24]`
     - `thumbLoadConcurrency`: `[1, 8]`
     - `backgroundFillTarget`: `[0, 200]`
     - `backgroundFillDelayMs`: `[500, 10000]`
     - `scrollIdleMs`: `[100, 1000]`
     - `pruneCooldownMs`: `[100, 1000]`
     - `slideDuration`: `[3, 60]`
   - Image sizes are strictly validated against `ALLOWED_PREVIEW_SIZES` (`fit_720`, `fit_1280`) and `ALLOWED_THUMB_SIZES` (`fit_720`), matching the host proxy's pinned regexes.

3. **Cage/Cog Launcher & Systemd Unit (`kiosk/cog/picogallery-kiosk.sh` & `kiosk/cog/picogallery-kiosk.service`)**:
   - `wait_for_server()` polls `/api/v1/ready` (fallback `/api/v1/health`) up to 120s.
   - `wait_for_input()` and `udevadm settle` resolve cold-boot USB race conditions.
   - Systemd unit sets `User=picokiosk`, `LIBSEAT_BACKEND=seatd`, `WLR_BACKENDS=drm,libinput`, and `RuntimeMaxSec=86400` (24h recycling to prevent WPE WebKit memory creep).
   - `Conflicts=getty@tty1.service` and `OnFailure=getty@tty1.service` ensure the console is restored if the kiosk compositor crashes continuously.

### Test Execution Results
- `npm test`: **PASS** — 58/58 tests passing across 9 suites in 5.8s.
- `npm --prefix frontend run test:host-smoke`: **PASS** — 1/1 suite passing in 8.45s (Playwright Chromium headless verifies SPA boot, gateway auth 303 token exchange, photo grid rendering, preview opening, image loading, and session protection).
- `npm run lint`: **PASS** — 0 errors, 0 warnings across scripts and tests.
- `npm run audit:security`: **PASS** — 0 unwaived vulnerabilities across root and frontend, verifying patched GHSA-mh99-v99m-4gvg compatibility lines (1.1.18, 2.1.4, 5.0.9).

---

## 2. Logic Chain

1. **Step 1 — Verification of Virtualizer Windowing & Memory Bounding**:
   - Observation: `frontend/src/minimal-photo-app.js` replaces the heavy legacy Vue SPA with a ~1500 line lightweight DOM app.
   - Logic: By bounding the DOM to `maxGridRows * ncol` (~30-40 elements) and zeroing image sources on pruning, RAM footprint on Pi Zero 2 W remains strictly bounded.
   - Logic: During slideshow/preview overlay, `suspendGridImages()` clears all background thumbnail image allocations (`img.src = ""`), freeing several megabytes of GPU texture memory for high-resolution display.

2. **Step 2 — Verification of Kiosk Configuration Security & Robustness**:
   - Observation: `config/kiosk-config-core.mjs` parses profile overrides and clamps integer parameters.
   - Logic: Malformed or hostile inputs in `config.toml` or environment variables cannot exceed safe hardware thresholds or request un-allowlisted thumbnail sizes (`fit_720`/`fit_1280`).

3. **Step 3 — Verification of Display Session Lifecycle**:
   - Observation: `picogallery-kiosk.sh` blocks until the backend probe reports ready (`/api/v1/ready`), and `picogallery-kiosk.service` recycles the WebKit process every 24 hours (`RuntimeMaxSec=86400`).
   - Logic: The appliance avoids blank/error screens during system boot and survives long-term operation without unbounded memory growth.

4. **Step 4 — Verification of Automated Test Suites**:
   - Observation: All unit, smoke, lint, and security audit suites run and pass cleanly.
   - Logic: The test suite confirms end-to-end integration across the host proxy, configuration loader, and frontend display app.

5. **Step 5 — Integrity Check**:
   - Observation: Code inspections revealed no hardcoded test responses, fake mock facades, or test bypasses.
   - Logic: Implementations are genuine and robust.

---

## 3. Caveats

- On physical Raspberry Pi devices, physical DRM/KMS hardware initialization depends on kernel DRM drivers (vc4-kms-v3d) and seatd group membership (`video, render, input, seat`), which are validated by `scripts/pi-canary.sh` and `install.sh`.

---

## 4. Conclusion

The frontend virtualizer, kiosk configuration resolver, Cage/Cog launch scripts, and E2E smoke tests are well-architected, robustly tested, and fully conformant to all performance and security invariants.

**Verdict**: **APPROVE**

---

## 5. Verification Method

To independently re-verify all components:
```bash
# 1. Run root unit and invariant test suites
npm test

# 2. Run Playwright E2E browser smoke suite
npm --prefix frontend run test:host-smoke

# 3. Run ESLint code quality check
npm run lint

# 4. Run supply-chain security audit
npm run audit:security
```

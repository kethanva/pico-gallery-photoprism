# PicoGallery Frontend Virtualization & Kiosk Architecture Report

## 1. Observation

### 1.1 Minimal Photo Display App Architecture
- **Entry Point & Bootstrapping**:
  - `frontend/src/app.js:29-30`: Boots `bootMinimalPhotoApp(document.getElementById("app"))` and imports `css/minimal-app.css`. It does not mount full Vuetify or upstream PhotoPrism routing components.
  - `frontend/index.html:43-91`: Synchronously fetches `/config.json` via XMLHttpRequest, sets `document.title`, initializes `window.__CONFIG__` with relative URIs (`baseUri: ""`, `staticUri: "/static"`, `apiUri: "/api/v1"`, `contentUri: "/api/v1"`), injects `appConfig.kioskConfig`, sets `disableServiceWorker: true`, and dynamically loads hashed `app.js` and `app.css` from `/static/build/assets.json`.
  - `frontend/src/minimal-photo-app.js:1491-1504`: `bootMinimalPhotoApp(root)` executes the initialization sequence: `ensureRuntimeConfig()` -> `clearBootSplash()` -> `resetKioskConfig()` -> `$fullscreen.setVirtualOnly(getKiosk().virtualFullscreenOnly)` -> `resetRuntimeState()` -> `buildUi(root)` -> `bindListeners()` -> `setupInfiniteObservers()` -> `loadMore()`.
- **Data Mapping & Pagination**:
  - `frontend/src/minimal-photo-app.js:79-111`: `pickHash(item)` prioritizes top-level `item.Hash`, then searches `item.Files` for `Primary` and non-missing files. `mapPhoto(item)` generates `{ title, hash, thumbSrc, fullSrc }`.
  - `frontend/src/minimal-photo-app.js:1089-1091`: `pageBatchSize()` selects `getKiosk().firstPageSize` when `state.offset === 0` (default 16), otherwise `getKiosk().pageSize` (default 20).
  - `frontend/src/minimal-photo-app.js:1093-1179`: `loadMore()` requests `GET /api/v1/photos?count=<count>&offset=<offset>&merged=true&quality=0` with `AbortController` (15-second `LOAD_TIMEOUT_MS`).
- **Virtualized Grid & DOM Window Management**:
  - `frontend/src/minimal-photo-app.js:466-494`: `pruneTopRowsIfNeeded()` calculates excess cards beyond `getKiosk().maxGridRows * ncol` (e.g. 10 * 4 = 40 cards max), removes excess card DOM nodes, clears thumbnail `src` attributes, increments `gridWindow.startIndex`, increases `gridWindow.topSpacerPx`, and sets `pruneCooldownUntil` (350ms cooldown).
  - `frontend/src/minimal-photo-app.js:533-552`: `restoreTopRowsIfNeeded()` executes when scrolling up. It prepends `ncol * getKiosk().restoreRowBatch` cards, decreases `gridWindow.startIndex` and `gridWindow.topSpacerPx`, and prunes bottom cards via `pruneBottomRowsIfNeeded()`.
  - `frontend/src/minimal-photo-app.js:1463-1489`: `setupInfiniteObservers()` configures two `IntersectionObserver` instances:
    1. `state.topObserver` observing `.pg-top-sentinel` (`rootMargin: "40px 0px 0px 0px"`) to trigger `scheduleRestoreTopRows()`.
    2. `state.bottomObserver` observing `.pg-sentinel` (`rootMargin: "0px 0px 80px 0px"`) to trigger `requestLoadMore()`.
  - `frontend/src/minimal-photo-app.js:979-1006`: `ensureMoreIfBottomVisible()` and `scheduleBottomLoadCheck()` run on double `requestAnimationFrame` to trigger loading when the bottom sentinel remains in the viewport.
- **Preview & Slideshow Engine**:
  - `frontend/src/minimal-photo-app.js:677-706`: `suspendGridImages()` and `resumeGridImages()` manage grid memory during preview. When preview is open, all thumbnail `img.src` values are evacuated to `dataset.pgSavedSrc`, and `.pg-shell` is marked `.is-suspended` (with CSS `visibility: hidden; content-visibility: hidden; pointer-events: none;`).
  - `frontend/src/minimal-photo-app.js:619-655`: `scheduleSlideshowTick()` runs `setTimeout` based on `getSlideshowWait()` (`slideDuration * 1000`). When the current slide reaches the end of loaded photos, it triggers `loadMore()` and flags `autoAdvanceOnLoad = true` (`frontend/src/minimal-photo-app.js:877-891`).
  - `frontend/src/minimal-photo-app.js:751-776`: `prefetchSlideAt(index)` preloads the next slide image with a 150ms debounce and `img.fetchPriority = "low"`.
  - `frontend/src/minimal-photo-app.js:1026-1055`: `maybeScheduleBackgroundFill()` runs in the background during slideshow mode to fetch up to `backgroundFillTarget` photos (e.g. 32 on `pi_zero_2`) with `backgroundFillDelayMs` (2000ms delay).
- **Navigation & Interaction**:
  - `frontend/src/minimal-photo-app.js:1242-1288`: `onKeyDown` handles `Escape` (exit preview/fullscreen), `F` / `f` (toggle fullscreen), `S` / `s` (toggle slideshow), `ArrowRight` / `ArrowLeft` (next/previous photo), `Space` / `Spacebar` (pause/resume slideshow or open focused card), `Enter` (open focused card).
  - `frontend/src/minimal-photo-app.js:1315-1341`: `onTouchStart` / `onTouchEnd` detects horizontal swipes with `SWIPE_MIN_PX = 48` (`dx < 0` for next, `dx > 0` for previous).
  - `frontend/src/minimal-photo-app.js:267-301`: `bindControlAction` captures `pointerup`, `touchend`, and `click` with 400ms deduplication to eliminate dropped clicks under WPE WebKit.
  - `frontend/src/common/fullscreen.js:1-97`: `Fullscreen` utility handles virtual fullscreen via CSS class `.is-virtual-fullscreen` when native fullscreen APIs are disabled or unreliable (`virtualOnly = true`).

---

### 1.2 Kiosk Configuration & Profiles Architecture
- **Shared Profile Definitions (`config/kiosk-profiles.json`)**:
  - `defaultProfile`: `"pi_zero_2"`
  - Three profiles defined:
    1. `pi_zero_2`: `previewSize: "fit_720"`, `thumbSize: "fit_720"`, `firstPageSize: 16`, `pageSize: 20`, `maxGridRows: 10`, `restoreRowBatch: 2`, `eagerThumbCount: 16`, `thumbLoadConcurrency: 4`, `backgroundFillTarget: 32`, `backgroundFillDelayMs: 2000`, `scrollIdleMs: 150`, `pruneCooldownMs: 350`, `slideDuration: 12`, `autoSlideshow: true`, `virtualFullscreenOnly: true`, `suspendGridInPreview: true`, `prefetchNextSlide: true`.
    2. `balanced`: `previewSize: "fit_720"`, `thumbSize: "fit_720"`, `firstPageSize: 16`, `pageSize: 20`, `maxGridRows: 14`, `restoreRowBatch: 2`, `eagerThumbCount: 8`, `thumbLoadConcurrency: 6`, `backgroundFillTarget: 64`, `backgroundFillDelayMs: 1500`, `scrollIdleMs: 200`, `pruneCooldownMs: 350`, `slideDuration: 10`, `autoSlideshow: true`, `virtualFullscreenOnly: true`, `suspendGridInPreview: true`, `prefetchNextSlide: true`.
    3. `quality`: `previewSize: "fit_1280"`, `thumbSize: "fit_720"`, `firstPageSize: 20`, `pageSize: 24`, `maxGridRows: 16`, `restoreRowBatch: 2`, `eagerThumbCount: 10`, `thumbLoadConcurrency: 6`, `backgroundFillTarget: 96`, `backgroundFillDelayMs: 1200`, `scrollIdleMs: 150`, `pruneCooldownMs: 300`, `slideDuration: 8`, `autoSlideshow: false`, `virtualFullscreenOnly: true`, `suspendGridInPreview: true`, `prefetchNextSlide: true`.
- **Shared Resolution Logic (`config/kiosk-config-core.mjs:36-75`)**:
  - Enforces strict clamping bounds: `firstPageSize` [4..24], `pageSize` [8..32], `maxGridRows` [6..24], `restoreRowBatch` [1..4], `eagerThumbCount` [0..24], `thumbLoadConcurrency` [1..8], `backgroundFillTarget` [0..200], `backgroundFillDelayMs` [500..10000], `scrollIdleMs` [100..1000], `pruneCooldownMs` [100..1000], `slideDuration` [3..60].
  - Pinned size restrictions: `ALLOWED_PREVIEW_SIZES` (`fit_720`, `fit_1280`), `ALLOWED_THUMB_SIZES` (`fit_720`).
- **Host-Side Resolution (`scripts/kiosk-config.mjs`)**:
  - Reads `[kiosk]` section in `config.toml` via `parseKioskTomlOverrides()`.
  - Supports environment variables: `PICO_KIOSK_PROFILE`, `PICO_KIOSK_PREVIEW_SIZE`, `PICO_KIOSK_THUMB_SIZE`, `PICO_KIOSK_MAX_GRID_ROWS`, `PICO_KIOSK_BACKGROUND_FILL_TARGET`.
  - Passes resolved `kioskConfig` into `servedConfig` at `/config.json` (`scripts/photoprism-host.mjs:246-251, 514-518`).
- **Browser-Side Resolution (`frontend/src/kiosk-config.js`)**:
  - Webpack bundles `config/kiosk-profiles.json` and `config/kiosk-config-core.mjs` directly into the client bundle.
  - Client calls `resolveKioskConfig(getKioskConfig())` against `window.__CONFIG__.kioskConfig`, ensuring exact parity with the host.

---

### 1.3 Cog/Cage Kiosk Launch Environment & Hardware/Systemd Integration
- **Cage & Cog Launcher (`kiosk/cog/picogallery-kiosk.sh`)**:
  - Configuration loaded from `/etc/picogallery/kiosk.env` (`FRAME_URL`, `WAIT_TIMEOUT`, `COG_CONFIG`, `COG_EXTRA`).
  - Readiness check `wait_for_server()` (`kiosk/cog/picogallery-kiosk.sh:43-77`): Polls `/api/v1/ready` (falling back to `/api/v1/health`) up to `WAIT_TIMEOUT` (default 120s) to prevent opening the browser on an error page during boot.
  - Cold-boot USB race prevention `wait_for_input()` (`kiosk/cog/picogallery-kiosk.sh:89-106`): Checks `/proc/bus/input/devices` for `Handlers=.*(kbd|mouse)` up to `INPUT_WAIT` (default 15s) so keyboard/mouse are ready when wlroots starts.
  - WebKit platform & environment configuration:
    - `COG_PLATFORM_NAME=wl` (uses Wayland platform; legacy `fdo` platform is deprecated and drops seat input).
    - `WPE_BACKEND=fdo` (uses wpebackend-fdo rendering pipeline).
    - `WLR_NO_HARDWARE_CURSORS=1` (prevents VideoCore cursor corruption).
    - `XDG_RUNTIME_DIR=/run/picogallery-kiosk` (dedicated runtime directory with mode 0700).
    - `XDG_CACHE_HOME=$XDG_RUNTIME_DIR/webkit-cache` (places WebKit cache on tmpfs to eliminate SD card wear).
  - Invocation: `exec cage -- cog --platform=wl --bg-color=000000 --enable-page-cache=false --enable-offline-web-application-cache=false -C /etc/picogallery/cog.conf "$FRAME_URL"`.
- **Systemd Service Unit (`kiosk/cog/picogallery-kiosk.service`)**:
  - Hardened execution: `User=picokiosk`, `Group=picokiosk`, `SupplementaryGroups=video render input seat`.
  - Seat and input backend: `LIBSEAT_BACKEND=seatd`, `XDG_VTNR=1`, `WLR_BACKENDS=drm,libinput`.
  - VT arbitration: `Conflicts=getty@tty1.service` (stops console login during kiosk operation) and `OnFailure=getty@tty1.service` (restores getty on terminal failure to prevent black screen lockout).
  - Crash-loop protection: `StartLimitIntervalSec=120`, `StartLimitBurst=5`, `Restart=always`, `RestartSec=3`.
  - Cold-boot udev synchronization: `ExecStartPre=+-/usr/bin/udevadm trigger --subsystem-match=input --action=add` and `ExecStartPre=+-/usr/bin/udevadm settle --timeout=10`.
  - Daily process recycling: `RuntimeMaxSec=86400` recycles Cog/WPE every 24 hours to reclaim cumulative WebKit memory creep.
- **Display Power Management**:
  - `kiosk/cog/pico-display-power.sh:1-49`: Cascades through 3 hardware control interfaces:
    1. `vcgencmd display_power 1|0` (Raspberry Pi 4 / 5).
    2. `/sys/class/backlight/rpi_backlight/bl_power` (Raspberry Pi Official DSI touchscreen).
    3. `/sys/class/drm/*/dpms` (generic HDMI / DRM connectors).
  - Controlled via `pico-display-on.service` and `pico-display-off.service` timers.
- **Hardware Acceptance Canary (`scripts/pi-canary.sh`)**:
  - Validates hardware model (`/proc/device-tree/model` contains "Raspberry Pi").
  - Verifies service status (`picogallery-photoprism`, `seatd`, `picogallery-kiosk`).
  - Verifies HTTP liveness (`/api/v1/health`), backend readiness (`/api/v1/ready`), public config rewriting (`/api/v1/config`), deep SPA bootstrap (`/library/photos`), and assets existence.
  - Inspects DRM device nodes (`/dev/dri/card*`).
  - Greps kiosk journal for fatal errors: `libinput.*(no input devices|cannot open)|failed to open.*(drm|card)|permission denied`.
  - Checks keyboard/mouse presence in `/proc/bus/input/devices` (unless `--allow-no-input` is passed).

---

### 1.4 Embedded Device Resource Constraints (Pi Zero 2 W — 512 MB RAM)
- **Bounded DOM**:
  - Virtual grid row count capped at `maxGridRows` (10 rows for `pi_zero_2`, yielding ~40 card elements in a 4-column layout).
  - Off-screen rows above and below the viewport are pruned from the DOM, compensated by top spacer (`pg-top-spacer`).
- **Decoded Texture & Image Memory Disposal**:
  - Card removal explicitly resets `img.removeAttribute("src")` and `img.src = ""` prior to DOM node removal (`frontend/src/minimal-photo-app.js:458-464`).
  - Overlay preview open invokes `suspendGridImages()` (`frontend/src/minimal-photo-app.js:677-691`), clearing all grid image sources and setting `content-visibility: hidden` on the shell.
  - Slide prefetch cancel explicitly sets `img.src = ""` and cleans up callbacks (`frontend/src/minimal-photo-app.js:736-749`).
- **Pinned Image Dimensions**:
  - Thumbnails are strictly pinned to `fit_720` (`config/kiosk-config-core.mjs:12`).
  - Previews are strictly pinned to `fit_720` or `fit_1280` (`config/kiosk-config-core.mjs:11`).
  - Upstream gateway route filter (`ALLOWED_API_ROUTES` in `scripts/photoprism-host.mjs:270-274`) blocks any unpinned thumbnail requests.
- **WebKit Engine Tuning (`kiosk/cog/cog.conf`)**:
  - `enable-page-cache=false`: Prevents caching past pages and document DOM trees.
  - `enable-offline-web-application-cache=false`: Disables redundant client-side application cache.
  - `enable-media-stream=false` & `enable-mediasource=false`: Disables WebRTC and media source stream buffers for a still-photo appliance.
  - `XDG_CACHE_HOME` on tmpfs: avoids SD card I/O bottlenecks and write amplification.

---

### 1.5 Frontend Build Pipeline & Verification Test Setup
- **Build Pipeline**:
  - `npm --prefix frontend run build`: Runs `cross-env PICO_NO_SW=1 webpack --node-env=production`.
  - `frontend/webpack.config.js:94-106`: Produces content-hashed bundles `app.[contenthash].js`, `share.[contenthash].js`, `splash.[contenthash].js`, and `app.[contenthash].css` into `frontend/dist/static/build/`.
  - `frontend/package.json:14`: `postbuild` script triggers `node scripts/precompress.js`.
  - `frontend/scripts/precompress.js`: Uses Node 22+ built-in gzip and zstd (`zlib.zstdCompressSync`) to generate precompressed `.gz` and `.zst` siblings for all compressible assets.
  - `frontend/webpack.config.js:120-123`: Emits `assets.json` mapping asset keys to hashed filenames.
- **Test Execution Results**:
  1. **Root Test Runner (`npm test`)**:
     - Command: `node --test tests/**/*.test.mjs`
     - Result: **58 passed tests across 9 test suites, 0 failures** (Duration: ~9.5s).
     - Suites tested: `config-loader`, `install-contract`, `kiosk-config`, `photoprism-host` (static, auth proxy, gateway auth, external startup), `pi-canary`, and `security-audit`.
  2. **Root Linter (`npm run lint`)**:
     - Command: `eslint scripts tests --max-warnings 0`
     - Result: **0 errors, 0 warnings**.
  3. **Root Security Audit (`npm run audit:security`)**:
     - Command: `node scripts/security-audit.mjs . frontend`
     - Result: **0 unwaived vulnerabilities across root and frontend**. Patched `brace-expansion` compatibility lines (1.1.18, 2.1.4, 5.0.9) recognized and verified.
  4. **Frontend Unit Tests (`npm --prefix frontend test`)**:
     - Command: `cross-env TZ=UTC BUILD_ENV=development NODE_ENV=development BABEL_ENV=test vitest run`
     - Result: **77 passed test files, 1 skipped (78 total); 1,768 passed tests, 13 skipped (1,781 total)** (Duration: ~253s).
     - Includes `minimal-photo-app.test.js` (21 tests) and `kiosk-config.test.js` (3 tests).
  5. **Frontend Host Smoke Test (`npm --prefix frontend run test:host-smoke`)**:
     - Command: `node --test tests/e2e/host-smoke.test.mjs`
     - Result: **1 suite passed, 1 test passed, 0 failures** (Duration: ~10.6s).
     - Verified end-to-end: SPA boot via Playwright Chromium, gateway token exchange, PhotoPrism mock backend communication, photo rendering, overlay preview display, and session token propagation.
  6. **Frontend Lint & Security Scan (`npm --prefix frontend run lint && npm --prefix frontend run security:scan`)**:
     - Result: Clean execution, Prettier check clean, 0 unreviewed dangerous DOM XSS sinks detected.

---

## 2. Logic Chain

1. **Client Isolation & Minimal Surface**:
   - Upstream PhotoPrism Vue frontend is heavy (~100+ components, MapLibre, PhotoSphereViewer, HLS, full VueRouter). On a 512 MB Pi Zero 2 W, loading that full stack leads to immediate RAM pressure and potential OOM.
   - First-party code deliberately overrides `frontend/src/app.js` to mount only `bootMinimalPhotoApp(document.getElementById("app"))`.
   - As observed in `frontend/src/minimal-photo-app.js`, the minimal photo display app has zero dependencies on Vuetify, VueRouter, or heavy rendering libraries. It runs directly as a plain DOM application.

2. **Deterministic DOM & Memory Bounding**:
   - Unbounded photo scrolling on long collections would accumulate hundreds of `<img>` DOM nodes, each holding decoded bitmap textures in WebKit memory.
   - The virtualized grid mechanism in `minimal-photo-app.js` (`pruneTopRowsIfNeeded`, `restoreTopRowsIfNeeded`) caps active cards to `maxGridRows * ncol`.
   - Crucially, `removeCardNode` clears `img.src = ""` and removes the attribute, explicitly releasing GPU/CPU texture buffers.
   - When entering preview mode, `suspendGridImages()` clears all visible grid thumbnail URLs and hides the container via `content-visibility: hidden`. Thus, while a 720p/1280p preview is displayed, the background grid consumes near-zero bitmap RAM.

3. **Zero Configuration Drift Between Host and Client**:
   - If the Node host and the browser client had independent kiosk profile definitions or clamping bounds, mismatched pagination batches, grid sizes, or prefetch counts could occur.
   - PicoGallery solves this by placing the single source of truth in `config/kiosk-profiles.json` and the resolver in `config/kiosk-config-core.mjs`.
   - Webpack imports `config/kiosk-config-core.mjs` into `frontend/src/kiosk-config.js`, while the host imports it into `scripts/kiosk-config.mjs`. Clamping rules and default profiles are guaranteed to be identical across both environments.

4. **Hardware-Resilient Kiosk Lifecycle**:
   - On cold boot of a Raspberry Pi, several timing races occur:
     a) Network/backend availability (PhotoPrism might still be initializing).
     b) USB input device enumeration (slow USB hubs / OTG adapters take seconds to settle).
     c) VT conflict between console login (`getty@tty1`) and Cage compositor.
   - `picogallery-kiosk.sh` and `picogallery-kiosk.service` handle each race systematically:
     - `wait_for_server()` waits for `/api/v1/ready` before opening Cog.
     - `wait_for_input()` and `udevadm trigger/settle` ensure input handlers are active before Cage launches.
     - `Conflicts=getty@tty1.service` and `OnFailure=getty@tty1.service` prevent VT fight while ensuring the physical console remains accessible if the kiosk fails.
     - `RuntimeMaxSec=86400` recycles the WebKit process daily, preventing long-term WebKit memory leaks on 24/7 displays.

5. **Static Asset Performance & Zero-CPU Serving**:
   - Serving uncompressed assets on an embedded device consumes significant network bandwidth and CPU if compressed on-the-fly.
   - `frontend/scripts/precompress.js` generates `.gz` and `.zst` siblings at build time.
   - `scripts/photoprism-host.mjs:340-344, 363-368` serves precompressed files directly from disk based on `Accept-Encoding`, requiring zero runtime compression CPU on the Pi.

---

## 3. Caveats

1. **Hardware Canary Requires Physical/Mock Environment**:
   - `scripts/pi-canary.sh` tests real hardware interfaces (`/proc/device-tree/model`, `/dev/dri/card*`, `/proc/bus/input/devices`, `systemctl`). In unit tests (`tests/tests/pi-canary.test.mjs`), these paths are mocked using environment variables (`PICO_CANARY_PROC_ROOT`, `PICO_CANARY_DEV_ROOT`, `PICO_CANARY_ETC_ROOT`).
2. **Playwright Chromium vs WPE WebKit**:
   - Smoke tests (`frontend/tests/e2e/host-smoke.test.mjs`) run on Playwright Chromium in headless mode. While DOM structure, API interactions, virtual fullscreen, and gateway auth are verified identically, rendering engine differences specific to WPE WebKit (e.g. `pointerup` vs `click` subtleties) are guarded in code via `bindControlAction` and tested on-device via `scripts/pi-e2e-diagnose.sh`.
3. **Vendored PhotoPrism Frontend Code**:
   - As documented in `AGENTS.md`, `frontend/` contains vendored upstream PhotoPrism code alongside first-party code (`minimal-photo-app.js`, `kiosk-config.js`). Upstream tests run in Vitest (77 test files), but only the minimal photo app is booted in production.

---

## 4. Conclusion

- **Architecture Integrity**: The frontend virtualization and kiosk architecture is fully decoupled from the heavier upstream PhotoPrism application, achieving a lightweight, bounded footprint specifically engineered for the Raspberry Pi Zero 2 W (512 MB RAM).
- **Profile Parity**: Host and browser kiosk configuration resolution share the exact same core module (`config/kiosk-config-core.mjs`) and profile database (`config/kiosk-profiles.json`), preventing any parameter drift.
- **Resource Constraints Compliance**: All resource constraints (DOM bounding, thumbnail suspension, image texture deallocation, pinned thumbnail size enforcement, tmpfs cache, and daily WebKit recycling) are strictly implemented and verified.
- **Test & Acceptance Status**:
  - Root test runner: **58/58 passing tests (9 suites)**.
  - Root ESLint: **0 errors, 0 warnings**.
  - Security audit: **0 unwaived vulnerabilities**.
  - Frontend Vitest: **77 passed files, 1,768 passed tests**.
  - Frontend host smoke test: **1/1 passed test**.

---

## 5. Verification Method

To independently verify the frontend virtualization, kiosk configuration, and build pipeline:

1. **Run Root Unit Tests**:
   ```bash
   npm test
   ```
   *Expected*: 58 passed tests across 9 suites, 0 failures.

2. **Run Root Lint & Security Audit**:
   ```bash
   npm run lint
   npm run audit:security
   ```
   *Expected*: 0 ESLint errors/warnings; 0 dependency audit vulnerabilities.

3. **Run Frontend Unit Tests**:
   ```bash
   npm --prefix frontend test
   ```
   *Expected*: 77 passed test files, 1768 passed tests.

4. **Run Frontend E2E Host Smoke Test**:
   ```bash
   npm --prefix frontend run test:host-smoke
   ```
   *Expected*: Built display host browser smoke test passes with 0 errors.

5. **Verify Kiosk Configuration Profiles & Clamping**:
   - Inspect `config/kiosk-profiles.json` and `config/kiosk-config-core.mjs`.
   - Verify unit test coverage in `tests/tests/kiosk-config.test.mjs` and `frontend/tests/vitest/kiosk-config.test.js`.

6. **Verify Minimal Photo App Virtuality & Texture Deallocation**:
   - Inspect `frontend/src/minimal-photo-app.js:458-464` (`removeCardNode`), lines 677-691 (`suspendGridImages`), and lines 466-571 (top/bottom row pruning and restoring).

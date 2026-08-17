# Project: PicoGallery PhotoPrism Validation & Verification

## Architecture
PicoGallery is a dedicated PhotoPrism display appliance running on Linux/Raspberry Pi (including Pi Zero 2 W) with a minimal Node reverse-proxy host serving a high-performance, plain-DOM virtualized display frontend rendered fullscreen under Cage/Wayland via Cog/WPE WebKit.

```
Cog/WPE (WebKit) → PicoGallery Host (:8190) → PhotoPrism Backend (Viewer Account)
```

### Trust Boundaries & Runtime Isolation
- **Boundary A (External / Kiosk Client ↔ Host)**:
  - Default bind: `127.0.0.1`. Non-loopback binds require `PICO_PP_AUTH_TOKEN` / `[http].auth_token` with length ≥ 24.
  - Gateway query tokens (`/?token=...`) are verified via constant-time SHA-256 pre-hashed `crypto.timingSafeEqual()` and exchanged for an `HttpOnly; SameSite=Strict` cookie (`pico_auth`) via `303 See Other` redirect.
  - Pinned `ALLOWED_API_ROUTES`: exactly 3 regexes (`/api/v1/config`, `/api/v1/photos`, `/api/v1/t/:hash/:token/fit_(720|1280)`).
  - Method lockdown: only `GET` and `HEAD` permitted on `/api/*`. Request bodies are rejected with HTTP 400.
  - Host header rewritten to backend host; client headers (`Accept-Encoding`, `Cookie`, `Authorization`, `X-Auth-Token`) stripped.
- **Boundary B (Host ↔ Upstream PhotoPrism)**:
  - Upstream session lifecycle: single in-flight coalesced authentication promise (`sessionPromise`) with bounded exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s).
  - Session expiration recovery: automatic session invalidation on 401/403.
  - Config masquerade: intercepts `/api/v1/config`, strips administrative tokens and settings, and forces `{ mode: "public", public: true, authMode: "public", previewToken }`.
  - Health & readiness: unauthenticated `/api/v1/health` (process liveness) and probe-backed `/api/v1/ready` (expires after 45s without successful authenticated 2xx probe).
- **Boundary C (Frontend Display & Memory Bounding)**:
  - Plain DOM virtualized photo grid (`frontend/src/minimal-photo-app.js`) replacing Vuetify/VueRouter.
  - Windowed DOM bounding (~40 cards max) with top/bottom spacer row pruning.
  - Background thumbnail suspension during full-resolution preview overlay.
  - Pinned thumbnail and preview dimensions (`fit_720` / `fit_1280`).
  - WebKit cache relocated to tmpfs; daily 24-hour service recycling (`RuntimeMaxSec=86400`).

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Fail-Closed Non-Loopback Startup | Binds to `127.0.0.1` by default; rejects non-loopback binds unless token has ≥ 24 characters | M1 | `scripts/photoprism-host.mjs:48-51` |
| 2 | Constant-Time Token Comparison | Pre-hashes tokens via SHA-256 into 32-byte buffers before `crypto.timingSafeEqual` | M1 | `scripts/photoprism-host.mjs:276-281` |
| 3 | Gateway Token Exchange & Cookie Strip | Exchanges `?token=...` for `HttpOnly; SameSite=Strict` cookie (`pico_auth`) via 303 redirect | M1 | `scripts/photoprism-host.mjs:296-307` |
| 4 | Pinned Route Allowlist | Restricts `/api/*` to `/api/v1/config`, `/api/v1/photos`, and `/api/v1/t/:hash/:token/fit_(720\|1280)` | M1 | `scripts/photoprism-host.mjs:270-274` |
| 5 | Request Method & Body Lockdown | Allows only `GET`/`HEAD`; rejects mutations (403) and request bodies (400) | M1 | `scripts/photoprism-host.mjs:378-389` |
| 6 | SSRF & Origin Normalization | Ignores absolute request URIs; constructs upstream URLs strictly from pathname and query | M1 | `scripts/photoprism-host.mjs:390-393` |
| 7 | Hop-by-Hop & Header Stripping | Strips hop-by-hop headers, client cookies, auth tokens, and forces upstream host | M1 | `scripts/photoprism-host.mjs:319-326,399-404` |
| 8 | Security Response Headers | Sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, Referrer-Policy, and strict CSP | M1 | `scripts/photoprism-host.mjs:263-269` |
| 9 | Single In-Flight Auth Coalescing | Shares single active session promise across concurrent requests | M1 | `scripts/photoprism-host.mjs:196-222` |
| 10 | Bounded Exponential Backoff | Caps auth failure retry backoff at 30s; fails fast with 503 during backoff window | M1 | `scripts/photoprism-host.mjs:200-216` |
| 11 | Public Config Masquerade Rewrite | Synthesizes public config mode and strips privileged tokens from upstream `/api/v1/config` | M1 | `scripts/photoprism-host.mjs:133-146,441-482` |
| 12 | Session Invalidation on 401/403 | Clears `activeSessionId` on upstream auth failure to force clean re-authentication | M1 | `scripts/photoprism-host.mjs:433-439` |
| 13 | Health Endpoint | Exposes unauthenticated `/api/v1/health` for process liveness | M1 | `scripts/photoprism-host.mjs:573-577` |
| 14 | Expiring Readiness Endpoint | Exposes probe-backed `/api/v1/ready` that expires after 45s without successful probe | M1 | `scripts/photoprism-host.mjs:578-583,615-688` |
| 15 | Authenticated Metrics Endpoint | Exposes operational metrics (counters, memory, uptime, readiness) behind gateway auth | M1 | `scripts/photoprism-host.mjs:585-594` |
| 16 | Directory Traversal Mitigation | Prevents escaping frontend directory root on static asset requests | M1 | `scripts/photoprism-host.mjs:347-352` |
| 17 | SPA History Fallback | Serves `/frontend/index.html` with absolute asset URLs for deep routes | M1 | `scripts/photoprism-host.mjs:546-548` |
| 18 | Service Worker Unregister Stub | Serves `/sw.js` stub to purge legacy service workers and caches | M1 | `scripts/photoprism-host.mjs:253-261,505-512` |
| 19 | Structural TOML Scalar Parsing | Parses scalar TOML subset (strings, numbers, booleans, arrays) with comment safety | M2 | `scripts/config-loader.mjs:3-50` |
| 20 | Prototype Pollution Defense | Rejects `__proto__`, `constructor`, and `prototype` in table names and keys | M2 | `scripts/config-loader.mjs:64-98` |
| 21 | PhotoPrism Source Selection | Selects enabled PhotoPrism source; throws if multiple enabled sources exist | M2 | `scripts/config-loader.mjs:113-118` |
| 22 | Kiosk TOML Override Extraction | Extracts `[kiosk]` section overrides with profile selection and display properties | M2 | `scripts/kiosk-config.mjs:41-75` |
| 23 | Shared Profile Resolution | Merges base profile, TOML overrides, env vars, and clamps values to safe bounds | M2 | `config/kiosk-config-core.mjs:15-75` |
| 24 | Parameter Bounds Clamping | Clamps row count, durations, batch sizes, concurrency, and fill targets safely | M2 | `config/kiosk-config-core.mjs:15-21` |
| 25 | Minimal Plain-DOM Display App | Replaces heavy Vue SPA with high-efficiency minimal DOM application | M3 | `frontend/src/minimal-photo-app.js:1-750` |
| 26 | Virtualized Grid Rendering | Windowed DOM rendering (`maxGridRows * ncol`) with top/bottom spacer compensation | M3 | `frontend/src/minimal-photo-app.js` |
| 27 | Background Grid Image Suspension | Deallocates thumbnail textures (`img.src = ""`) during full preview overlay | M3 | `frontend/src/minimal-photo-app.js` |
| 28 | Slideshow Scheduler & Prefetch | Slideshow loop with smooth transitions and background page prefetch (`backgroundFillTarget`) | M3 | `frontend/src/minimal-photo-app.js` |
| 29 | Multi-Input Action Binding | Unified deduplicated event handling for touch swipe, click, and keyboard navigation | M3 | `frontend/src/minimal-photo-app.js` |
| 30 | Cog/Cage Launcher & Seatd | Cold-boot readiness wait, seatd backend, KMS/DRM rendering, and input settling | M3 | `kiosk/cog/picogallery-kiosk.sh` |
| 31 | Daily WebKit Recycling | Systemd `RuntimeMaxSec=86400` recycles browser process daily to mitigate memory leaks | M3 | `kiosk/cog/picogallery-kiosk.service` |
| 32 | Root Node Test Runner (58 Tests) | 9 test suites verifying parser, installer, kiosk config, host proxy, canary, and audit | M4 | `tests/tests/*.test.mjs` |
| 33 | ESLint Zero-Warning Enforcement | Flat config verifying TS/JS syntax and Node globals with `--max-warnings 0` | M4 | `eslint.config.mjs` |
| 34 | Dependency Security Audit Engine | Evaluates lockfile and AST rules to verify GHSA-mh99-v99m-4gvg patched backports | M4 | `scripts/security-audit.mjs` |
| 35 | Frontend Vitest Test Suite | Unit/component tests covering display, session, and components | M4 | `frontend/tests/vitest/**/*` |
| 36 | Playwright E2E Host Smoke Test | Headless browser smoke test validating SPA boot, auth exchange, grid, and slideshow | M4 | `frontend/tests/e2e/host-smoke.test.mjs` |
| 37 | Post-Reboot Canary Invariants | Strict bash invariant checker asserting services, health, readiness, and DRM devices | M4 | `scripts/pi-canary.sh` |
| 38 | 5-Layer Blank Screen Diagnostics | Hardware, kernel input, udev seat, seatd, and compositor diagnostic pipeline | M4 | `scripts/pi-e2e-diagnose.sh` |
| 39 | Production Installer Sandboxing | Dedicated `picogallery` user, root-owned `/opt/picogallery`, and strict systemd sandboxing | M4 | `install.sh` |
| 40 | Multi-Tier E2E Testing Suite | Requirements-driven Tier 1-4 opaque-box acceptance test coverage | M5 | `TEST_INFRA.md` |
| 41 | Adversarial Coverage Hardening | Tier 5 white-box stress testing, failure mode simulations, and security invariant audit | M5 | `TEST_INFRA.md` |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Host Proxy & Security Architecture | Reverse proxy, token pre-hashing constant-time safeEqual, route allowlist pinning, method/body lockdowns, session coalescing & backoff, masquerade public rewrite, health/readiness endpoints | none | DONE |
| M2 | Strict TOML Parser & Profile Resolver | Scalar TOML parser, prototype pollution defense, quote comment handling, single-source enforcement, kiosk config resolution & bounds clamping | none | DONE |
| M3 | Frontend Virtualizer & Kiosk Integration | Plain DOM virtualized grid, spacer row pruning, thumbnail suspension during preview, slideshow prefetch, unified touch/keyboard bindings, Cage/Cog launch & 24h recycling | M1, M2 | DONE |
| M4 | Test Suites, Invariants & Diagnostics | 58/58 root tests across 9 suites, ESLint 0 warnings, supply-chain security audit, Playwright host smoke test, pi-canary, pi-e2e-diagnose, install contracts | M1, M2, M3 | DONE |
| M5 | Multi-Tier E2E Testing & Adversarial Verification | Dual Track E2E acceptance tests, adversarial stress tests, security invariant audit, forensic integrity verification | M4 | DONE |

---

## Interface Contracts

### Host Proxy ↔ Frontend Browser (`/api/v1/*`, `/config.json`)
- `/api/v1/config`: `GET`/`HEAD` -> returns JSON `{ mode: "public", public: true, authMode: "public", previewToken: string }`.
- `/api/v1/photos`: `GET`/`HEAD` -> returns PhotoPrism photo list JSON.
- `/api/v1/t/:hash/:token/fit_(720|1280)`: `GET`/`HEAD` -> streams JPEG/WebP thumbnail or preview image.
- `/config.json`: `GET`/`HEAD` -> returns `{ serverUrl: "", disableServiceWorker: true, kioskConfig: {...} }`.
- `/api/v1/health`: `GET`/`HEAD` -> returns `{ status: "ok", uptimeSecs: number }`.
- `/api/v1/ready`: `GET`/`HEAD` -> returns `{ status: "ok", checkedAt: number }` (200) or `{ status: "unavailable", reason: string }` (503).
- Gateway Auth: `/?token=<token>` -> `303 See Other` to clean path + `Set-Cookie: pico_auth=<token>; Path=/; HttpOnly; SameSite=Strict`.

### Config Loader ↔ Runtime (`scripts/config-loader.mjs`)
- `parsePicoConfig(tomlString)`: Returns parsed JavaScript object graph. Throws on syntax error, duplicate key, or prototype pollution (`__proto__`, `constructor`, `prototype`).
- `selectPhotoPrismSource(config)`: Returns single active photoprism source object or `null`. Throws if multiple photoprism sources are enabled.

### Kiosk Resolver ↔ Browser/Host (`config/kiosk-config-core.mjs`)
- `resolveKioskConfig(overrides, baseProfiles, envVars)`: Returns normalized configuration object with clamped integer parameters:
  - `maxGridRows`: `[6, 24]`
  - `slideDuration`: `[3, 60]`
  - `restoreRowBatch`: `[1, 4]`
  - `thumbLoadConcurrency`: `[1, 8]`
  - `backgroundFillTarget`: `[0, 200]`

---

## Code Layout
- `scripts/photoprism-host.mjs`: HTTP server, reverse proxy, authentication, route allowlist, session lifecycle, health & metrics.
- `scripts/config-loader.mjs`: Strict structural TOML subset parser.
- `scripts/kiosk-config.mjs`: Node-side kiosk configuration loader and resolver.
- `scripts/security-audit.mjs`: Dependency vulnerability auditor with GHSA-mh99-v99m-4gvg backport patch verifier.
- `scripts/pi-canary.sh`: Post-reboot acceptance and system invariant verification script.
- `scripts/pi-e2e-diagnose.sh`: 5-layer diagnostic script for display, hardware, driver, seatd, and compositor.
- `config/kiosk-config-core.mjs`: Shared profile resolution and bounds clamping logic.
- `config/kiosk-profiles.json`: Baseline kiosk hardware profiles (`pi_zero_2`, `balanced`, `quality`).
- `frontend/src/minimal-photo-app.js`: Minimal plain DOM display application (virtualizer, preview, slideshow).
- `frontend/src/kiosk-config.js`: Webpack bundle entry for browser kiosk config resolution.
- `kiosk/cog/picogallery-kiosk.sh`: Kiosk session launcher with backend wait and input settling.
- `kiosk/cog/picogallery-kiosk.service`: Systemd unit for Cage/Cog kiosk session.
- `tests/tests/`: 9 root Node test suites (`config-loader`, `install-contract`, `kiosk-config`, `photoprism-host`, `pi-canary`, `security-audit`).
- `frontend/tests/e2e/host-smoke.test.mjs`: Playwright headless browser E2E smoke test.

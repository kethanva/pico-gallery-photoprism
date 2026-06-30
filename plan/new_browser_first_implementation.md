# PicoGallery V2 — Browser-First Implementation Plan

> **Status:** Implementation-ready specification for a brand-new, independent repository.
> **Audience:** An autonomous LLM coding agent (and human reviewers).
> **Relationship to V1:** This is **not** a refactor of the existing Rust repo
> (`/Volumes/SSD/projects/PHOTOS_RELATED/pico-gallery`). It is a clean reimplementation
> that borrows only **product behavior** and **high-level concepts**. The original repo
> and `plan/split_client_server_implementation.md` are references only — consult them to
> validate feature parity, never to copy code.
>
> **Self-containment guarantee:** Everything an agent needs to build V2 from zero is in
> this document. Sections are ordered so each builds on the last. Implementation phases
> (§11) and milestones (§12) are sized so a fresh agent can execute one in a single
> session with only the context named in that milestone.

---

## 0. The One Architectural Decision That Shapes Everything

V2 replaces V1's **native renderer** (SDL2 → KMS/DRM framebuffer) with **a browser**.
That single move deletes the largest and most device-coupled half of the codebase
(`renderer.rs`, `osd.rs`, `menu.rs`, `night.rs`, SDL2, DRM, font rendering, color
management, blur). Visual behavior (transitions, Ken Burns, OSD pill, clock, night
dimming) moves into HTML/CSS/JS, where it is simpler, testable in a headless browser,
and runs on **any** display surface (Pi kiosk, phone, smart TV, desktop).

The server keeps the genuinely hard, reusable parts: **photo sources, image
resize+cache, the playlist/state engine, and the control API.**

### 0.1 Language/runtime decision (RECOMMENDED — override here if you disagree)

**Primary recommendation: a unified TypeScript stack.**

| Package        | Stack                                              |
| -------------- | -------------------------------------------------- |
| `server/`      | Node 20 LTS + Fastify + `sharp` (libvips)          |
| `client/`      | Vanilla TypeScript + Vite (no UI framework)        |
| `shared/`      | TypeScript DTOs + `zod` schemas                    |

**Rationale (tied to the stated objectives):**

- *Easy for LLM agents to implement incrementally* — one language across all three
  packages, the largest single lever on agent throughput and on tech-debt avoidance.
- *Browser-first* — the client is the product's center of gravity; TS is its native tongue.
- *Minimal dependencies* — `sharp` is one dependency that replaces V1's four image crates
  (`image`, `fast_image_resize`, `zune-jpeg`, `stackblur-iter`, `qcms`).
- *Fast builds / fast iteration* — Vite HMR + `tsx` server reload beat Rust rebuild times,
  which matters when an agent loops edit→run→observe.
- The Pi Zero's 512 MB ceiling — V1's central constraint — **no longer binds our code**,
  because on the Pi Zero we now ship *only a browser*. Node's ~70–90 MB baseline lives on
  the **server** (Pi 4/5, NAS, or any host), which has the RAM.

**Documented alternative: Rust + `axum` + `image`/`fast_image_resize` for the server**
(client stays browser TS either way).

| Dimension                | TS (Node/Fastify)        | Rust (axum)                    |
| ------------------------ | ------------------------ | ------------------------------ |
| Server RAM baseline      | ~70–90 MB                | ~5–15 MB                       |
| Image resize quality/speed | `sharp`/libvips (excellent) | `fast_image_resize` (excellent) |
| Agent implementation speed | **Fastest**            | Slower (more ceremony)         |
| One language end-to-end  | **Yes** (client+server+shared) | No (TS client, Rust server) |
| Single static binary deploy | No (needs Node)       | **Yes**                        |
| Sub-256 MB server target | Marginal                 | **Comfortable**                |

**Choose Rust if** your server must also run on a 512 MB Pi Zero, or you want a single
static binary and zero runtime. **Otherwise choose TS.** The rest of this document is
written for the **TS** recommendation; every API contract, data model, phase, and
acceptance criterion is language-neutral, so swapping in the Rust server changes *only*
the server-internal sections (§5 implementation notes, §7) — the contracts in §8/§9 are
identical.

> The plan proceeds on the TS recommendation. If you want Rust, say so before Phase 0;
> §8 (API), §9 (data models), §3 (client), and §11/§12 phases are reused unchanged.

---

## 1. Existing Repository Analysis (V1)

### 1.1 Overall architecture

V1 is a **single-process, single-threaded Rust appliance** that renders a photo
slideshow directly to the Linux KMS/DRM framebuffer via SDL2 — no desktop environment.
It is a Cargo workspace: a binary crate (`picogallery`), a `core` crate (the plugin
trait), and seven optional plugin crates (photo sources), compiled in via feature flags.
A built-in raw-TCP HTTP server offers a phone "remote control" page. Configuration is a
single TOML file; deployment is a systemd unit, cross-compiled for ARM.

It targets two devices: a **Pi 4** (capable) and a **Pi Zero 2 W** (512 MB, 1 core) —
hence the obsessive memory discipline (`opt-level="z"`, single-threaded Tokio,
megapixel caps, double-buffering).

### 1.2 Module inventory

| Module (`src/…`)      | LOC  | Purpose                                                            | Dependencies                          | Complexity | V2 disposition |
| --------------------- | ---- | ----------------------------------------------------------------- | ------------------------------------- | ---------- | -------------- |
| `slideshow.rs`        | 1436 | Engine: merged playlist, ordering, prefetch, state, thermal guard | core, cache, renderer, plugins        | High       | **Split** → server engine + client loop |
| `renderer.rs`         | 1343 | SDL2/KMS draw loop, transitions, Ken Burns, double-buffer         | sdl2, drm, image                      | High       | **Replace** with browser CSS |
| `osd.rs`              | 805  | On-screen metadata pill, clock, status icons (font8x8)            | font8x8                               | High       | **Replace** with DOM overlay |
| `menu.rs`             | 493  | On-screen right-click settings menu, live source switch           | renderer                              | High       | **Replace** with client settings/remote UI |
| `config.rs`           | 607  | TOML config model + schedule/night window logic + tests           | serde, toml, chrono                   | Medium     | **Rewrite** (zod + TOML/env) |
| `cache.rs`            | 326  | LRU disk image cache, FNV-1a keys, index.json                     | tokio fs                              | Medium     | **Rewrite** (content-hash cache) |
| `remote.rs`           | 217  | Raw-TCP HTTP remote (next/prev/pause/favorite + JSON status)      | tokio net                             | Low        | **Replace** with Fastify routes + client `/remote` |
| `wifi.rs`             | 154  | Apply Wi-Fi creds to host OS (nmcli/wpa_supplicant)               | tokio process                         | Low        | **Defer** → optional Pi-only device module |
| `exif_util.rs`        | 106  | EXIF capture-date + orientation extraction                       | kamadak-exif                          | Low        | **Rewrite** (`exifr`) |
| `night.rs`            | 89   | Per-slide dim + warm pixel pass                                   | —                                     | Low        | **Replace** with client CSS filter |
| `display_power.rs`    | 80   | HDMI power via `vcgencmd` + CEC (`cec-client`)                    | tokio process                         | Low        | **Defer** → optional Pi-only device module |
| `main.rs`             | 575  | CLI (clap), plugin registry, wiring, default-config template      | clap                                  | Medium     | **Rewrite** (server bootstrap) |
| `lib.rs`              | 21   | Module re-exports                                                 | —                                     | Trivial    | Remove |

### 1.3 The plugin system (the keeper concept)

`core/src/lib.rs` defines `trait PhotoPlugin` — the single best idea in V1 and the one
abstraction worth carrying forward (renamed `PhotoSource` in V2):

```
PhotoMeta { id, filename, width, height, taken_at?, download_url?, extra: map }
AuthStatus = Authenticated | PendingUserAction{message, poll_interval} | NotAuthenticated
trait PhotoPlugin (Send+Sync):
  name(), display_name(), version()
  init(cfg)                         async
  auth_status() / authenticate()    async   (headless OAuth device-flow support)
  list_photos(limit, offset)        async → Vec<PhotoMeta>   (offset paging)
  get_photo_bytes(meta, w, h)       async → Vec<u8>          (CDN-thumb-aware)
  set_favorite(meta, fav)           async   (default: unsupported)
  refresh_auth() / shutdown()       async
```

The engine talks only to `dyn PhotoPlugin`, so sources are pluggable. **Keep this shape
verbatim** in V2 as a TS interface (§9.3).

### 1.4 Plugins (photo sources)

| Plugin          | LOC  | What it does                                              | V2 action |
| --------------- | ---- | -------------------------------------------------------- | --------- |
| `photoprism`    | 1520 | Streams from a PhotoPrism server; rich typed filter model | **Keep** — port filters faithfully (§ flagship source) |
| `webdav`        | 1105 | Nextcloud/Synology/ownCloud over WebDAV                  | **Keep** |
| `directory`     | 628  | Local folder; sub-folders as albums; rescan interval      | **Keep** (default source) |
| `google-photos` | 520  | Google **Drive** via `rclone` sync (Photos API removed)   | **Defer** (nice-to-have) |
| `amazon-photos` | 462  | Amazon Photos via LWA OAuth                               | **Drop** (legacy) |
| `local`         | 246  | Like `directory` but multiple root paths                  | **Merge** into `directory` (accept N paths) |
| `usb`           | 274  | Auto-mount USB sticks, scan, hot-plug                     | **Defer** (Pi-only nice-to-have) |

### 1.5 API contracts (V1)

V1 has exactly one external contract — the remote (`remote.rs`):

```
GET  /                → control page (HTML)
GET  /api/status      → {paused,index,total,filename,album,favorite}
POST /api/next | /api/prev | /api/pause | /api/favorite → {ok:true}
```

No authentication ("trusted LAN only"). The internal command enum
(`SlideshowCmd`) is the real interaction vocabulary: `Next, Prev, TogglePause,
ToggleFavorite, Quit, OpenMenu/CloseMenu/Menu*, Text*`. The menu/text commands are
on-screen-UI concerns that **vanish** in V2 (the browser owns UI).

### 1.6 Storage / caching

Disk LRU cache (`cache.rs`): resized JPEGs at `<dir>/<sanitized-key>-<fnv1a>.jpg`, an
in-memory LRU mirrored to `index.json` (batched writes for SD-card wear), 0700 perms,
per-entry and total size caps. No database. **V2 keeps a disk cache but re-keys it by
content hash (§5.3) and adds HTTP caching so the browser caches too.**

### 1.7 Image pipeline (V1)

`get_photo_bytes` (per source, picks the smallest CDN thumbnail ≥ display) → memory/MP
gate → `zune-jpeg` SIMD decode → `fast_image_resize` Lanczos3 → optional `stackblur`
letterbox → `qcms` color transform → SDL2 texture. **All of this except "pick a source
thumbnail / fetch bytes" collapses into one `sharp` pipeline on the server + the
browser's own decoder in V2.**

### 1.8 Build / deploy / config

Cargo workspace, `Cross.toml` for ARM cross-compile, `opt-level="z"`+LTO+`panic=abort`,
`profile.release-fast` for on-device builds, `cargo-deb` packaging, `picogallery.service`
systemd unit, `install.sh`/`uninstall.sh`/`run.sh`. Single TOML config
(`~/.config/picogallery/config.toml`), generated via `--generate-config`.

### 1.9 Technical debt & unnecessary complexity (to NOT carry forward)

- **Native rendering stack** is ~3,600 LOC of device-coupled code (renderer/osd/menu/
  night) that a browser replaces with a few hundred lines of CSS/TS.
- **On-screen menu + USB-keyboard text editing** (`menu.rs`, `Text*` commands) — an
  entire input subsystem that exists only because there is no browser. Gone in V2.
- **font8x8 bitmap text** — replaced by real web typography.
- **Two manual image buffers + megapixel OOM gates** — artifacts of the 512 MB client.
  The browser manages its own decode memory; the server resizes down before sending.
- **Per-source CDN-thumbnail-size juggling** (`max_thumb`, `allow_original`) — V2 always
  fetches a reasonable source rendition and resizes server-side, so the client only ever
  receives display-sized bytes.
- **Compile-time plugin feature flags** — V2 loads sources at runtime from config; no
  rebuild to enable a source.
- **Tight coupling**: `slideshow.rs` directly drives the renderer, the cache, the
  plugins, the remote, *and* device power. V2 separates these into server engine vs.
  image service vs. transport vs. (optional) device control.

### 1.10 Reusable concepts (carry forward)

`PhotoPlugin` trait shape · `PhotoMeta` fields · `AuthStatus` device-flow ·
PhotoPrism typed filter model · ordering modes (shuffle/chrono/newest/date-cluster/
on-this-day) · night & schedule **windows** (half-open, overnight-aware — the logic and
its tests in `config.rs` are correct; re-port the *behavior*) · disk-cache size budgeting ·
the remote-control UX (prev/pause/next/favorite + live status).

---

## 2. Functional Requirements

### 2.1 Core (must exist in V2)

1. Fullscreen slideshow in a browser with configurable per-slide duration.
2. Transitions: cut, fade (crossfade), slide-left, slide-right; configurable duration.
3. Photo ordering: shuffle, chronological, newest-first, date-cluster; on-this-day boost.
4. OSD metadata pill (album / date / filename / title / location) — toggleable.
5. Optional clock overlay.
6. Fill vs. letterbox; letterbox blur fill.
7. Ken Burns slow zoom/pan (opt-in; respects reduced-motion).
8. Night mode (dim + warm) on a local-time window (overnight-aware).
9. Display on/off **schedule** window (server can drive HDMI power on Pi; browser hides).
10. Photo sources, runtime-pluggable: **directory** (default), **photoprism**, **webdav**.
11. Server-side image resize to display size, with a disk cache + HTTP caching.
12. Server-authoritative playlist/cursor so multiple frames stay in sync.
13. Remote control: prev / pause / next / favorite + live status (phone web page).
14. Favorites (where the source supports it; PhotoPrism does).
15. EXIF capture-date + orientation handling.
16. Memory-safety: skip absurd images rather than crash (server-side guard).
17. Network resiliency: client shows a "disconnected" badge and keeps showing the last
    slide(s) when the server is unreachable.
18. Config via file + env; sane defaults; one-command first run.
19. Health/readiness endpoints; structured logs.

### 2.2 Nice-to-have (optional, later phases)

- Browse/search grid view (virtualized thumbnails, query box).
- PWA/offline (service worker caches last N slides; installable).
- Optional pre-shared-token auth + security headers (needed if exposed beyond LAN).
- Prometheus metrics endpoint.
- `rclone` / Google Drive source; USB hot-plug source (Pi-only).
- Drag-and-drop **upload** into a writable `directory` source (V1 had no uploads).
- Device control module (HDMI CEC, Wi-Fi provisioning) — Pi-only adapter.
- Multiple independent "frames" with per-frame display config.

### 2.3 Legacy (do NOT carry forward)

- Native SDL2/KMS rendering; on-screen menu; USB-keyboard text editing; font8x8.
- Compile-time plugin feature flags.
- Amazon Photos source.
- Per-source CDN-thumbnail-size configuration knobs.
- `--generate-config` template-string machinery (replaced by documented defaults + env).

---

## 3. New Architecture (V2)

### 3.1 Shape

```
            ┌──────────────────────── Server host (Pi 4/5, NAS, Docker, any Linux/Mac) ────────────────────────┐
            │                                                                                                    │
            │   sources/ ──┐                                                                                     │
            │  directory   │     ┌───────────┐     ┌──────────────┐      ┌───────────────────────────────────┐  │
            │  photoprism  ├────▶ │  engine   │ ──▶ │  HTTP layer  │ ◀──▶ │  static client SPA (built assets) │  │
            │  webdav      │     │ (playlist,│     │  (Fastify)   │      └───────────────────────────────────┘  │
            └──────────────┘     │  cursor,  │     │  REST + SSE  │                                              │
                   ▲             │  ordering,│     └──────┬───────┘                                              │
                   │             │  schedule)│            │                                                      │
            ┌──────┴───────┐     └─────┬─────┘            │   GET /api/v1/photos/:id/image?w&h  (heavy path)     │
            │ image service│◀──────────┘                  │            │                                          │
            │ sharp resize │                              │            ▼                                          │
            │ + disk cache │◀─────────────────────────────┴───  content-hash disk cache  ───┐                    │
            └──────────────┘                                                                 │                    │
            │  (optional, Pi-only)  device/ : HDMI-CEC power · Wi-Fi provisioning            │                    │
            └─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                         │  HTTP/LAN  (REST + SSE + cached images)
                                                         ▼
            ┌──────────────── Display surface: any browser (Pi kiosk / phone / smart TV / desktop) ─────────────┐
            │  Frame view  /         → SSE-driven slideshow: preload next, crossfade, Ken Burns, OSD, night CSS  │
            │  Remote view /remote   → prev / pause / next / favorite + live status                              │
            │  Browse view /browse   → (nice-to-have) virtualized thumbnail grid + search                        │
            └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Package boundaries & dependency graph

```
shared  ─────────────┐  (DTOs + zod schemas; zero runtime deps beyond zod)
   ▲                 │
   │                 ▼
server ──────▶  (depends on shared)        client ──────▶ (depends on shared, type-only)
   │  fastify, sharp, exifr, toml, zod, pino                │  vite (dev), no UI framework
   └── sources, engine, images, http, device, telemetry     └── slideshow, overlay, control, api, sw
```

Rules:
- `shared` depends on nothing app-specific (only `zod`). It is the **only** thing both
  sides import. Breaking the contract is a compile error on both sides — the point.
- `client` imports `shared` **types only** (no server code reachable from the browser).
- `server` never imports `client`; it serves the client's *built* static output.
- Inside `server`, the dependency direction is one-way:
  `http → engine → {sources, images}`; `images → cache`; `device` is leaf/optional.
  No module reaches "up". This is the coupling fix for V1's god-object `slideshow.rs`.

### 3.3 What optimizes for what

| Goal              | Mechanism                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| Simplicity        | Browser renders; server is a typed API in front of sources               |
| Maintainability   | 3 packages, one-way deps, files < 300 LOC, one source per file           |
| Testability       | Pure engine (no I/O), `fastify.inject()` API tests, Playwright for client |
| Browser perf      | Server sends display-sized images; HTTP-immutable cache; compositor-only motion |
| Fast builds       | Vite + tsx; no native compile in the hot loop                            |
| Low memory        | Resize-before-send; streamed responses; bounded disk cache               |

### 3.4 API versioning

All routes under `/api/v1`. The version is a path prefix (simplest, proxy-friendly).
Breaking changes ship as `/api/v2` alongside `/api/v1` until clients migrate. The
`shared` package exports types namespaced `v1` so multiple versions can coexist in code.

### 3.5 Storage abstraction

Two storage concerns, both behind small interfaces so they can be swapped:

- `ImageCache` — `get(key) / put(key, bytes) / has(key)`; default impl = disk LRU.
- `StateStore` — slideshow cursor + favorites + per-source paging tokens; default impl =
  in-memory + periodic JSON snapshot (matches V1's single-appliance model). A future
  SQLite impl is a drop-in if multi-frame/persistent history is needed (YAGNI now).

### 3.6 Configuration system

Single source of truth: a TOML file, with **every** key overridable by an env var
(`PICO_<SECTION>_<KEY>`), validated by one `zod` schema that also produces the typed
config object and the documented defaults. No template-string generator (V1's
`default_config()`); instead, `config.example.toml` + `zod` defaults + a `GET /api/v1/config`
that returns the *effective* config the client needs. (Details §8.4, §9.4.)

### 3.7 Extensibility model (justified, minimal)

The **only** extension point is `PhotoSource` (§9.3). Sources are discovered at runtime
from config, not compiled in. A new source = one file in `server/src/sources/` + one
line in the registry + a `zod` schema fragment. No general "plugin host", no dynamic
loading, no ABI — that complexity isn't earned (KISS/YAGNI). Device control (CEC/Wi-Fi)
is **not** an extension point; it's an optional internal module gated by platform.

---

## 4. Browser-First Frontend Design

The client is a **static SPA** (no SSR — it is a single-user appliance UI, not a
content site). Three surfaces (routes), one tiny bundle.

| Decision               | Choice                                  | Why |
| ---------------------- | --------------------------------------- | --- |
| Framework              | **None** (vanilla TS modules)           | Microsite JS budget < 80 KB (per web perf rules); a slideshow + 4 buttons does not need React. Keeps the bundle tiny and the code agent-legible. (If a framework is later justified, prefer Preact/lit — see trade-offs §7.) |
| Build                  | **Vite**                                | Fast HMR, tiny output, first-class TS, code-splitting per route. |
| Routing                | Minimal path router (3 routes)          | `/` frame, `/remote` control, `/browse` grid. ~30 LOC. |
| State                  | Server-pushed via SSE + a tiny store    | Server is authoritative; client holds only ephemeral UI state. No client state library. |
| Data fetching          | Typed `fetch` wrapper + `EventSource`   | Stale-while-revalidate is irrelevant (server pushes); just fetch images + subscribe. |
| Styling                | CSS custom-property tokens, per-surface CSS | Per web coding-style: tokens for color/space/duration/easing; compositor-only animation. |
| Image strategy         | Server returns display-sized image; `<img decode()>` before swap | No client-side resize; explicit `width/height`; eager+`fetchpriority=high` for the visible slide. |
| Caching                | HTTP immutable + (nice-to-have) service worker Cache Storage | ETag = content hash, `Cache-Control: immutable`. SW keeps last N slides for offline. |
| Accessibility          | `aria-live` caption, labeled controls, `prefers-reduced-motion` | Reduced motion ⇒ disable Ken Burns + force cut transition. |

### 4.1 Frame view (`/`) — the product

Rendering strategy: **two stacked `<img>` layers** (`A`, `B`) inside a fixed
full-viewport stage. The current slide is opaque; the next is preloaded into the hidden
layer. On advance, crossfade by animating `opacity` (and for slide-L/R, `transform:
translateX`) — both compositor-friendly. Ken Burns animates `transform: scale()+translate()`
on the active layer over the slide duration. After the transition, the old layer's `src`
is cleared to release memory.

Flow:
1. On load: `GET /api/v1/config` (display settings) and `GET /api/v1/slideshow/state`.
2. Open `EventSource('/api/v1/events')`.
3. Render `state.photo` into layer A using
   `/api/v1/photos/{id}/image?w={screenW}&h={screenH}&fit={cover|contain}`.
4. The server advances the cursor on its timer and emits a `state` SSE event for the
   **next** photo; on receipt, the client preloads it into the hidden layer (`img.decode()`),
   then plays the transition and swaps.
5. Overlay layer (absolutely positioned DOM): OSD pill (album · date · title · location),
   optional clock (updates per minute), disconnect badge.
6. Night mode: client computes the local-time window from config and toggles a CSS
   `filter: brightness(x) sepia(y)` on the stage — zero server cost.
7. Resilience: if `EventSource` errors, show the disconnect badge, keep the current slide,
   and let the browser auto-reconnect (EventSource does this natively with backoff).

Why server-authoritative timing (not a client timer): it keeps multiple frames in sync,
makes the phone remote actually control what's on the wall, and keeps the "what's showing
now" truth in one place (matches V1's single-slideshow model).

### 4.2 Remote view (`/remote`) — phone control

A faithful port of V1's control page as a route: four big touch buttons (◀ ⏸ ▶ ♥) +
a live status line driven by the same SSE stream (or a 2 s poll fallback). `POST
/api/v1/control`. Dark theme, `color-scheme: dark`, large hit targets, `:active`
feedback. This satisfies the design-quality "intentional states" checklist.

### 4.3 Browse view (`/browse`) — nice-to-have

Virtualized thumbnail grid (IntersectionObserver lazy-load, fixed-size cells, windowed
rendering) over `GET /api/v1/photos?limit&offset&q=`. A search box maps `q` to the
source query (PhotoPrism Q-language passthrough; substring for directory/webdav).
Clicking a thumb issues `POST /api/v1/control {action:"goto", id}`.

### 4.4 Offline / PWA (nice-to-have)

Service worker: cache-first for `/api/v1/photos/*/image` (immutable), network-first for
state. Keep the last N image responses so a network drop still shows recent photos.
Installable manifest so a kiosk can "Add to Home Screen". Reduced to: if SSE is down,
cycle the SW-cached images locally and show the disconnect badge (mirrors V1's RAM-disk
fallback, §3 of the split doc).

### 4.5 Responsive & breakpoints

The frame is intrinsically full-viewport (object-fit handles any panel). The remote and
browse views are tested at 320 / 375 / 768 / 1024 / 1440 / 1920 with no overflow and
working touch targets (per web testing rules).

---

## 5. Backend Design

### 5.1 HTTP layer (Fastify)

- Serves the built client as static files (`@fastify/static`) at `/`, and the API at
  `/api/v1/*`. One origin ⇒ no CORS in the default (co-hosted) deployment; CORS is
  opt-in for the independent-client deployment (§14).
- SSE endpoint (`/api/v1/events`) implemented as a long-lived `text/event-stream`
  response fed by an in-process event bus the engine publishes to.
- All inputs validated by `zod` at the boundary (query/body/params). Reject early with a
  consistent error envelope (§8.6).
- Optional bearer-token guard (§10), security headers via `@fastify/helmet`, optional
  `@fastify/rate-limit` on control + image routes.

### 5.2 Engine (pure, testable core)

Owns the **playlist** and the **cursor**. No I/O — it depends on `sources` only to
*list* metadata at startup/refresh and emits events; image bytes are the image service's
job. Responsibilities:

- Build a merged playlist from all enabled sources (`listPhotos` paged).
- Apply ordering: `shuffle | chronological | newest_first | date_cluster`, plus
  on-this-day boosting (weave photos whose `takenAt` month/day == today toward the front).
  Port the *behavior* from V1; the logic is small and pure.
- Maintain `{ index, paused, startedAt }`; advance on a timer (`slide_duration_secs`);
  honor pause; support `next/prev/goto/toggle_pause/favorite`.
- Apply the display **schedule** window: when "off", pause advancing and emit a
  `display:off` event (client blanks; optional device module powers HDMI off).
- Refresh sources periodically (rescan directory, re-page PhotoPrism) without dropping
  the cursor.
- Publish a `SlideshowState` event on every change. **This is the single source of truth.**

### 5.3 Image service (`sharp`) + content-hash cache

`GET /api/v1/photos/:id/image?w&h&fit&fmt`:

1. Resolve `id` → `{sourceName, localId}` → the source.
2. Ask the source for a rendition ≥ requested size (`source.getOriginal(meta, w, h)`):
   returns a readable stream/bytes + a stable `contentHash` (the source's own hash if it
   exposes one — PhotoPrism does; else a hash of bytes).
3. **Cache key** = `sha256(contentHash : w : h : fit : fmt)` (content-hash-cache pattern:
   path-independent, auto-invalidating). If present on disk, stream it.
4. Else: `sharp(input).rotate() /*EXIF*/ .resize(w, h, { fit }) .toFormat(fmt, {quality})`,
   write to cache, stream out. Guard: reject inputs over a configured pixel/byte ceiling
   *before* decode (server-side replacement for V1's MP gate).
5. Response headers: `ETag: "<cacheKey>"`, `Cache-Control: public, max-age=31536000,
   immutable`, correct `Content-Type`. Honor `If-None-Match` ⇒ `304`.

`fmt=auto` negotiates from `Accept`: AVIF (opt-in, costlier) → WebP → JPEG. Default WebP
with JPEG fallback.

Sequence (cache miss):

```
client ──GET /photos/ID/image?w=1920&h=1080──▶ http ──▶ image svc ──▶ cache.has(key)? no
   │                                                          │
   │                                          source.getOriginal(meta,1920,1080) ──▶ source/CDN/disk
   │                                                          │  bytes + contentHash
   │                                          sharp.rotate().resize().toFormat(webp)
   │                                                          │  cache.put(key, out)
   ◀───────────── 200 image/webp (immutable, ETag) ──────────┘
(next request, any client) ─▶ cache.has(key)? yes ─▶ 200 from disk (or 304 on If-None-Match)
```

### 5.4 Sources

Each source is one file implementing `PhotoSource` (§9.3). Ported from V1:

- **directory** — recursive scan of one or many roots; sub-folders = albums;
  `rescan_interval_secs`; `allowed_albums` filter; orders (shuffle/alphabetical/
  date_modified). Reads bytes from disk; `getOriginal` returns a file stream.
- **photoprism** — the flagship. Port V1's **typed filter model** exactly: `album(s)`,
  `favorites`, `quality`, `country/state/city`, `year`, `after/before`, `color`, `mono`,
  `panorama`, `orientation`, `people`, `labels`, `keywords`, `memories`, `media_type`,
  raw `query` (Q-language), `include_private/archived` (excluded by default), `order`,
  `per_page`. Auth via session (username/password or app password). `getOriginal` requests
  the smallest PhotoPrism thumbnail ≥ display (we then resize precisely with sharp), with
  original (`/dl/<hash>`) fallback. `setFavorite` supported. `skip_tls_verify`,
  `request_timeout_secs`.
- **webdav** — Nextcloud/Synology/ownCloud; PROPFIND listing, basic/bearer auth,
  `skip_tls_verify`. `getOriginal` GETs the file.

Sources register in `sources/registry.ts`; the engine builds only those present+enabled
in config.

### 5.5 Device control (optional, Pi-only, leaf module)

`device/` runs host commands and is **disabled by default and on non-Linux**:
- HDMI power on/off (`vcgencmd display_power` + CEC `cec-client` standby/on) driven by
  the schedule events from the engine. Port of `display_power.rs`.
- Wi-Fi provisioning (`nmcli`) at startup from config. Port of `wifi.rs`.
This module imports nothing from the engine except subscribing to its event bus — it is a
sink, not a dependency. (Thermal throttling is dropped: with rendering off-box, server
CPU pressure only affects resize, which the OS scheduler handles; revisit only if needed.)

### 5.6 Telemetry

- Logging: `pino` (structured JSON; pretty in dev). One request-id per request.
- Health: `GET /api/v1/health` (liveness, always 200 if process up),
  `GET /api/v1/ready` (200 once ≥1 source initialized and playlist non-empty).
- Metrics (nice-to-have): `GET /api/v1/metrics` Prometheus — cache hit ratio, resize
  duration histogram, playlist size, SSE client count, source errors.

---

## 6. Repository Structure

(Full tree in §3.1's prose; canonical layout below.)

```
pico-gallery-photoprism/
├── package.json                # pnpm workspace root; scripts: dev, build, test, lint
├── pnpm-workspace.yaml         # packages: client, server, shared
├── tsconfig.base.json          # shared compiler options (strict, ESNext, project refs)
├── .github/workflows/ci.yml    # typecheck · lint · unit · integration · e2e · build · docker
├── config.example.toml         # documented default config
├── README.md                   # quickstart (local, Docker, kiosk)
│
├── shared/                     # contract package (imported by both sides)
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── photo.ts            # PhotoMeta, AuthStatus
│       ├── config.ts           # DisplayConfig, SourceConfig (+ zod schemas)
│       ├── api.ts              # request/response DTOs (v1)
│       └── events.ts           # SSE event union (v1)
│
├── server/
│   ├── package.json
│   └── src/
│       ├── index.ts            # bootstrap: load config → build sources → engine → http
│       ├── config/             # load (TOML+env) + validate (zod) + effective-config
│       ├── http/               # fastify app, routes/, sse.ts, static.ts, errors.ts, auth.ts
│       ├── engine/             # playlist.ts, ordering.ts, cursor.ts, scheduler.ts, bus.ts
│       ├── images/             # service.ts (sharp), cache.ts (disk LRU), exif.ts, guard.ts
│       ├── sources/            # source.ts (interface), registry.ts, directory.ts,
│       │                       #   photoprism.ts, webdav.ts
│       ├── device/             # (optional) display-power.ts, wifi.ts, platform.ts
│       └── telemetry/          # logger.ts, health.ts, metrics.ts
│
├── client/
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   ├── public/                 # manifest.webmanifest, icons, sw.js (nice-to-have)
│   └── src/
│       ├── main.ts             # router → mounts a surface
│       ├── api/                # client.ts (typed fetch), events.ts (EventSource)
│       ├── slideshow/          # stage.ts, transitions.ts, kenburns.ts, preload.ts
│       ├── overlay/            # osd.ts, clock.ts, night.ts, disconnect.ts
│       ├── control/            # remote.ts
│       ├── browse/             # grid.ts, search.ts (nice-to-have)
│       └── styles/             # tokens.css, frame.css, remote.css, browse.css
│
├── docker/
│   ├── Dockerfile              # multi-stage: build client+server → slim runtime
│   └── docker-compose.yml      # server (+ optional photoprism) for local/prod
├── scripts/
│   ├── kiosk-setup.sh          # provision a Pi as a Chromium/WPE kiosk → server URL
│   └── dev.ts                  # run server + vite together
├── docs/
│   ├── architecture.md         # (generated from this plan's §3–§5)
│   ├── api.md                  # endpoint reference (§8)
│   ├── sources.md              # configuring each source
│   └── deployment.md           # §14
└── tests/
    ├── integration/            # fastify.inject API + image golden tests
    └── e2e/                    # playwright: frame, remote, offline, visual regression
```

| Dir          | Why it exists |
| ------------ | ------------- |
| `shared/`    | The contract. Single definition of every DTO/event/config type; compile-time parity between client and server. |
| `server/`    | The headless daemon: sources, engine, image service, transport, optional device control. Independently deployable. |
| `client/`    | The browser SPA. Independently deployable (can be hosted on a CDN pointing at a remote server). |
| `docker/`    | Reproducible build + run; optional bundled PhotoPrism for a one-command demo. |
| `scripts/`   | Dev orchestration + Pi kiosk provisioning (the replacement for V1's `install.sh`). |
| `docs/`      | Human-facing docs; derived from this plan. |
| `tests/`     | Cross-package integration + e2e (per-package unit tests live beside their code). |

---

## 7. Technology Choices

| Concern            | Choice                         | Alternatives considered            | Trade-off / rationale |
| ------------------ | ------------------------------ | ---------------------------------- | --------------------- |
| Frontend framework | **None (vanilla TS) + Vite**   | React, Preact, lit, Svelte         | A slideshow + a few controls doesn't justify a framework; bundle < 80 KB; agent-legible. Preact/lit are the fallback if the browse view grows complex. |
| Backend framework  | **Fastify (Node 20)**          | Express, Hono, Koa; **axum (Rust)** | Fastify: fast, schema-first, great plugin ecosystem, `inject()` for tests. Rust/axum is the documented alt for sub-256 MB / single-binary (§0.1). |
| Image processing   | **`sharp` (libvips)**          | `jimp` (pure JS, slow); ImageMagick CLI; Rust `image` | `sharp` is the fastest Node option, handles EXIF rotation, AVIF/WebP/JPEG, streaming. Prebuilt ARM/x64 binaries. |
| EXIF               | **`exifr`**                    | `exif-parser`, sharp metadata only | `exifr` is fast and reads orientation + capture date; sharp `.rotate()` handles pixels. |
| Validation/schemas | **`zod`**                      | `ajv`/JSON-Schema, `valibot`       | One schema → types + runtime validation + defaults; shared by config and API boundary. |
| Config format      | **TOML (+ env overrides)**     | YAML, JSON, dotenv-only            | Parity with V1's TOML; comments; `@iarna/toml`. Env overrides for secrets/containers. |
| Logging            | **`pino`**                     | `winston`, console                 | Low-overhead structured logs; pretty transport in dev. |
| Realtime           | **SSE (`EventSource`)**        | WebSocket, long-poll               | One-way server→client fits exactly; auto-reconnect built in; proxy-friendly; simpler than WS. |
| Package manager    | **pnpm workspaces**            | npm/yarn workspaces, Turborepo     | Fast, strict, first-class monorepo; no extra build orchestrator needed at this size. |
| Tests              | **Vitest + Playwright**        | Jest + Cypress                     | Vitest aligns with Vite/TS, fast; Playwright for cross-browser + visual regression. |
| Lint/format        | **ESLint + Prettier**          | Biome                              | Mature, matches the user's web hook rules; Biome is a viable faster alt. |
| CI                 | **GitHub Actions**             | GitLab CI, Circle                  | Repo will live on GitHub (V1 does); free ARM-less builds; Playwright action. |
| Container          | **Docker (multi-stage)**       | Nix, buildpacks                    | Ubiquitous; multi-stage keeps runtime image slim (node-slim + built assets). |
| Kiosk browser (Pi) | **Chromium kiosk** (Pi Zero 2/4) / **WPE WebKit** (Pi Zero) | Firefox kiosk | Chromium `--kiosk` is simplest on Pi 4 / Zero 2 W; WPE/cog is lighter for the original Pi Zero. Documented in `scripts/kiosk-setup.sh`. |

---

## 8. API Specification (v1)

Base path: `/api/v1`. All responses JSON unless noted. Errors use the envelope in §8.6.
All write endpoints require the bearer token **iff** auth is enabled (§10).

### 8.1 Config & state

**`GET /config`** → effective display config the client needs.
```json
{ "slideDurationSecs": 10, "transition": "fade", "transitionMs": 800,
  "fillScreen": false, "letterboxBlur": true, "kenBurns": false,
  "showOsd": true, "showClock": false, "order": "shuffle",
  "night": { "start": "21:00", "end": "07:00", "dimPercent": 25, "warmth": 30 } | null,
  "schedule": { "on": "07:00", "off": "22:00" } | null }
```

**`GET /slideshow/state`** → current slideshow truth.
```json
{ "index": 42, "total": 1280, "paused": false, "displayOn": true,
  "photo": { "id": "photoprism:ps6abc", "filename": "DSC_001.jpg",
             "title": "Sunset", "album": "Italy 2024",
             "location": "Florence, Italy", "takenAt": "2024-06-01T18:22:00Z",
             "width": 6000, "height": 4000, "favorite": true } }
```
Validation: none (read). Errors: `503` if no playlist yet.

### 8.2 Realtime

**`GET /events`** (SSE, `text/event-stream`). Emits named events:
```
event: state         data: <SlideshowState as in /slideshow/state>
event: display       data: { "on": false }
event: source        data: { "name": "photoprism", "auth": "pending", "message": "...", "pollSecs": 5 }
```
Sends a `state` event immediately on connect, then on every change. Client auto-reconnects.

### 8.3 Control

**`POST /control`** — mutate the cursor.
```
request:  { "action": "next" | "prev" | "toggle_pause" | "pause" | "resume"
                     | "favorite" | "goto", "id"?: string }
response: 200 { "ok": true }
errors:   400 invalid action · 401 if auth required · 429 if rate-limited · 503 shutting down
```
Behavior mirrors V1 `SlideshowCmd` (Next/Prev/TogglePause/ToggleFavorite) plus `goto`.
Every successful control broadcasts a `state` SSE event.

### 8.4 Photos

**`GET /photos/:id/image`** — the heavy path. Display-sized image bytes.
```
query:    w (int 16..8192, required) · h (int 16..8192, required)
          · fit = "cover" | "contain"  (default "contain")
          · fmt = "auto" | "webp" | "jpeg" | "avif" (default "auto")
response: 200  Content-Type: image/webp|jpeg|avif
                ETag: "<cacheKey>"  Cache-Control: public, max-age=31536000, immutable
          304  when If-None-Match matches
errors:   400 bad dims · 404 unknown id · 413 source image exceeds guard · 502 source fetch failed
```

**`GET /photos/:id/meta`** → `PhotoMeta` (the `photo` object shape from §8.1).
Errors: `404`.

**`GET /photos`** — paginated browse/search.
```
query:    limit (1..200, default 60) · offset (>=0) · q (optional source query)
response: 200 { "items": PhotoMeta[], "total": number, "limit": n, "offset": n }
```
(Consistent paginated envelope per the common API-response pattern.)

### 8.5 Sources & auth

**`GET /sources`** → `[{ "name":"photoprism", "displayName":"PhotoPrism",
"auth":"authenticated|pending|unauthenticated", "photoCount": 1280 }]`.

**`POST /sources/:name/auth`** → begin/continue device-flow auth.
```
response: 200 { "status": "authenticated" }
       |  200 { "status": "pending", "message": "Visit … and enter CODE", "pollSecs": 5 }
       |  200 { "status": "unauthenticated", "error": "…" }
```
Client polls `GET /sources` (or watches the `source` SSE event) until authenticated.

### 8.6 Health & errors

`GET /health` → `200 {"status":"ok"}` (liveness).
`GET /ready` → `200 {"status":"ready"}` or `503 {"status":"starting"}`.
`GET /metrics` → Prometheus text (nice-to-have).

**Error envelope** (all 4xx/5xx):
```json
{ "error": { "code": "BAD_REQUEST", "message": "w must be 16..8192" } }
```
`code` ∈ `BAD_REQUEST | UNAUTHORIZED | NOT_FOUND | PAYLOAD_TOO_LARGE | RATE_LIMITED |
SOURCE_ERROR | UNAVAILABLE`. Messages are user-safe and never leak secrets/paths.

### 8.7 Worked example

```
# Frame boots
GET /api/v1/config            → {…display settings…}
GET /api/v1/slideshow/state   → {index:0,total:1280,photo:{id:"directory:Italy/DSC_001.jpg",…}}
GET /api/v1/photos/directory:Italy%2FDSC_001.jpg/image?w=1920&h=1080&fit=contain
                              → 200 image/webp  (cached, immutable)
# Phone taps Next
POST /api/v1/control {"action":"next"}     → 200 {"ok":true}
#  ↳ all frames receive:  event: state  data:{index:1,photo:{id:"directory:Italy/DSC_002.jpg",…}}
```

---

## 9. Data Models

### 9.1 PhotoMeta (the universal photo record)

```ts
interface PhotoMeta {
  id: string;            // "<sourceName>:<localId>", globally unique, URL-safe-encoded
  sourceName: string;    // "directory" | "photoprism" | "webdav"
  filename: string;
  title?: string;        // source title (PhotoPrism)
  album?: string;        // folder name or PhotoPrism album title
  location?: string;     // "City, Country" if known
  takenAt?: string;      // ISO 8601; from EXIF or source
  width: number;         // source pixels (0 if unknown)
  height: number;
  favorite: boolean;     // false if source has no favorites concept
  downloadUrl?: string;  // optional source-internal hint for getOriginal
  contentHash?: string;  // stable hash for cache keying (source-provided or computed)
  extra?: Record<string,string>;
}
```
Maps 1:1 to V1 `PhotoMeta` + a few promoted fields (title/album/location/favorite) that
V1 stuffed into `extra`. `id` namespacing matches V1's `cache_key = "{plugin}/{id}"`.

### 9.2 Slideshow / display

```ts
interface SlideshowState {
  index: number; total: number; paused: boolean; displayOn: boolean;
  photo: PhotoMeta | null; startedAt: string; // ISO
}
type Transition = "cut" | "fade" | "slide_left" | "slide_right";
type PhotoOrder  = "shuffle" | "chronological" | "newest_first" | "date_cluster";
interface DisplayConfig {
  slideDurationSecs: number; transition: Transition; transitionMs: number;
  fillScreen: boolean; letterboxBlur: boolean; kenBurns: boolean;
  showOsd: boolean; showClock: boolean; order: PhotoOrder; onThisDayBoost: boolean;
  maxImageMb: number; maxMegapixels: number;        // server guard
  night?: { start: string; end: string; dimPercent: number; warmth: number };
  schedule?: { on: string; off: string };
}
```
Direct port of V1 `DisplayConfig` (snake→camel). The half-open, overnight-aware
window semantics (and their unit tests) port verbatim from V1 `config.rs`.

### 9.3 PhotoSource interface (the one extension point)

```ts
interface PhotoSource {
  readonly name: string;
  readonly displayName: string;
  init(cfg: SourceConfig): Promise<void>;
  authStatus(): Promise<AuthStatus>;
  authenticate(): Promise<AuthStatus>;
  listPhotos(limit: number, offset: number): Promise<PhotoMeta[]>;
  // Return a rendition >= (w,h) plus a stable hash; engine/sharp resizes precisely.
  getOriginal(meta: PhotoMeta, w: number, h: number):
      Promise<{ stream: Readable; contentType: string; contentHash: string }>;
  setFavorite?(meta: PhotoMeta, favorite: boolean): Promise<void>;
  search?(q: string, limit: number, offset: number): Promise<PhotoMeta[]>;
  dispose(): Promise<void>;
}
type AuthStatus =
  | { kind: "authenticated" }
  | { kind: "pending"; message: string; pollSecs: number }
  | { kind: "unauthenticated"; error?: string };
```
This is V1's `PhotoPlugin` trait, 1:1, minus the on-device concerns. `getOriginal`
replaces `get_photo_bytes` and *returns a stream* (memory-friendly) instead of a `Vec<u8>`,
and defers exact resizing to the central image service rather than each source.

### 9.4 Config (root) & relationships

```ts
interface RootConfig {
  display: DisplayConfig;
  cache: { dir?: string; maxMb: number };            // default 256 MB, ~/.cache or /var/lib
  http:  { host: string; port: number;               // default 0.0.0.0:8188 (parity w/ V1)
           authToken?: string; corsOrigins?: string[] };
  sources: SourceConfig[];                            // one entry per enabled source
  device?: { hdmiPower: boolean; wifi?: { ssid: string; password: string; country?: string } };
}
type SourceConfig =
  | ({ name: "directory" } & DirectoryConfig)
  | ({ name: "photoprism" } & PhotoPrismConfig)
  | ({ name: "webdav" } & WebDavConfig);
```
`PhotoPrismConfig` carries the full filter set from §5.4 (album(s), favorites, quality,
geo, dates, color/mono/panorama/orientation, people/labels/keywords, memories,
media_type, raw query, include_private/archived, order, per_page, transport).

**Entity relationships:** `RootConfig 1—N SourceConfig`; engine builds `N PhotoSource`
→ one merged `Playlist (ordered [PhotoMeta])` → one `SlideshowState (cursor)`. Image
service maps `PhotoMeta.id → PhotoSource → bytes → CacheEntry(key)`. No relational DB;
the only persisted artifacts are the disk image cache and an optional state snapshot.

### 9.5 Indexes / lookups

In-memory only: `Map<id, PhotoMeta>` for O(1) `:id` resolution; the playlist is an array
+ cursor index. Disk cache is content-addressed (the filename *is* the index). If a
SQLite `StateStore` is added later, index `photo(contentHash)` and `favorite(id)`.

---

## 10. Migration Mapping (V1 → V2)

| V1 (existing)                              | V2 (new)                                            | Action  | Note |
| ------------------------------------------ | --------------------------------------------------- | ------- | ---- |
| `core/src/lib.rs` `PhotoPlugin`/`PhotoMeta`| `shared/src/photo.ts` + `server/src/sources/source.ts` | Rewrite | Port trait shape 1:1 |
| `plugins/directory`                        | `server/src/sources/directory.ts`                   | Rewrite | Default source |
| `plugins/local`                            | folded into `directory.ts` (accepts N roots)         | Merge   | Remove duplicate |
| `plugins/photoprism`                       | `server/src/sources/photoprism.ts`                  | Rewrite | Port full filter model |
| `plugins/webdav`                           | `server/src/sources/webdav.ts`                      | Rewrite |  |
| `plugins/google-photos` (rclone)           | `server/src/sources/rclone.ts`                      | Rewrite | **Defer** (nice-to-have) |
| `plugins/usb`                              | `server/src/sources/usb.ts`                         | Rewrite | **Defer**, Pi-only |
| `plugins/amazon-photos`                    | —                                                   | **Delete** | Legacy |
| `src/slideshow.rs` (engine)                | `server/src/engine/*` + `client/src/slideshow/*`    | Split   | Server owns cursor; client owns pixels |
| `src/renderer.rs` (SDL2/KMS)               | `client/src/slideshow/{stage,transitions,kenburns}` | Replace | Browser renders |
| `src/osd.rs`                               | `client/src/overlay/{osd,clock}`                    | Replace | DOM overlay |
| `src/menu.rs` (on-screen menu)             | `client/src/control/*` (+ future settings UI)       | Replace | No on-device menu |
| `src/night.rs`                             | `client/src/overlay/night.ts` (CSS filter)          | Replace | Zero server cost |
| `src/cache.rs` (LRU disk)                  | `server/src/images/cache.ts`                        | Rewrite | Re-key by content hash |
| `src/remote.rs` (raw-TCP HTTP)             | `server/src/http/*` + `client/src/control/remote.ts`| Replace | Fastify + SPA route |
| `src/config.rs` (TOML)                     | `server/src/config/*` + `shared/src/config.ts`      | Rewrite | zod + TOML + env |
| `src/exif_util.rs`                         | `server/src/images/exif.ts`                         | Rewrite | `exifr` + sharp rotate |
| `src/wifi.rs`                              | `server/src/device/wifi.ts`                         | Rewrite | **Defer**, Pi-only |
| `src/display_power.rs` (CEC/vcgencmd)      | `server/src/device/display-power.ts`                | Rewrite | **Defer**, Pi-only |
| `src/main.rs` (clap + registry)            | `server/src/index.ts` + `sources/registry.ts`       | Rewrite | Runtime source loading |
| image crates (`image`,`fast_image_resize`,`zune-jpeg`,`stackblur`,`qcms`) | `sharp` (+ browser decode) | Replace | 5 deps → 1 |
| `sdl2`, `drm`, `font8x8`                   | —                                                   | **Delete** | Browser replaces |
| `build.rs`, `Cross.toml`, `cargo-deb`      | `docker/`, `vite.config.ts`, `scripts/`             | Replace |  |
| `install.sh` / `picogallery.service`       | `scripts/kiosk-setup.sh` + `docker-compose.yml`     | Replace |  |
| thermal-throttle guard (`slideshow.rs`)    | —                                                   | **Delete** | Off-box rendering removes the need |

Migration decisions in one line each: *keep the plugin abstraction and PhotoPrism's
filter intelligence; delete everything that exists only because there was no browser;
collapse the five-crate image pipeline into `sharp` + the browser; turn compile-time
feature flags into runtime config.*

---

## 11. Implementation Plan (phased)

Each phase is independently shippable, ends green (lint+typecheck+tests), and is sized
for one agent session. Complexity: **S** ≤ ~½ session, **M** ~1 session, **L** ~1½.

### Phase 0 — Scaffold & contract  ·  Complexity: S
- **Objective:** Working pnpm monorepo; `shared` types; server boots, serves
  `GET /health`; client builds an empty frame.
- **Creates:** workspace root (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`),
  `shared/src/{index,photo,config,api,events}.ts` (stubs), `server/src/index.ts` +
  `http/app.ts` (+ `/health`), `client/{index.html,vite.config.ts,src/main.ts}`,
  `.github/workflows/ci.yml`, ESLint/Prettier, `config.example.toml`.
- **Deps:** none prior.
- **Acceptance:** `pnpm i && pnpm build` succeeds; `pnpm dev` serves the client and
  `GET /api/v1/health` → 200; CI green.
- **Tests:** one server unit test (`health` returns ok via `fastify.inject`).

### Phase 1 — Image service + directory source  ·  Complexity: M
- **Objective:** `GET /photos/:id/image?w&h` returns a resized image from a local folder,
  cached on disk with immutable headers.
- **Creates:** `sources/source.ts`, `sources/directory.ts`, `sources/registry.ts`,
  `images/service.ts` (sharp), `images/cache.ts`, `images/exif.ts`, `images/guard.ts`,
  `http/routes/photos.ts`, `config/*` (load+zod, directory only).
- **Depends on:** Phase 0.
- **Acceptance:** point `directory.path` at `sample_photos/`; request `?w=800&h=600` →
  correct-size WebP; second request is a cache hit; `If-None-Match` → 304; oversized
  input → 413.
- **Tests:** unit (cache key/eviction, guard, exif orientation), integration (golden
  resize bytes within tolerance; 304 path).

### Phase 2 — Engine, state, control, SSE  ·  Complexity: M
- **Objective:** Server-authoritative playlist + cursor; `state`/`control`/`events`
  endpoints; advances on a timer; ordering modes.
- **Creates:** `engine/{playlist,ordering,cursor,scheduler,bus}.ts`,
  `http/routes/{slideshow,control}.ts`, `http/sse.ts`.
- **Depends on:** Phase 1 (sources for the playlist).
- **Acceptance:** with directory source, `GET /slideshow/state` shows photo 0; after
  `slideDurationSecs`, an SSE `state` event advances; `POST /control {next|prev|pause}`
  works and broadcasts; ordering modes produce expected sequences.
- **Tests:** unit (ordering incl. on-this-day boost, cursor wrap, pause), integration
  (control → SSE event sequence via an injected SSE client).

### Phase 3 — Client frame view  ·  Complexity: M
- **Objective:** Fullscreen slideshow driven by SSE with crossfade + preload.
- **Creates:** `client/src/slideshow/{stage,transitions,preload}.ts`,
  `client/src/api/{client,events}.ts`, `styles/{tokens,frame}.css`, router in `main.ts`.
- **Depends on:** Phases 1–2.
- **Acceptance:** opening `/` shows the current photo at display size; advances on SSE
  with a visible crossfade; next image is `decode()`d before swap (no flash); window
  resize re-requests at new dimensions.
- **Tests:** Playwright — frame loads, `h1`/`img` visible, advances after a mocked SSE
  event, no console errors; visual snapshot at 1920×1080.

### Phase 4 — Overlay: OSD, clock, night, Ken Burns  ·  Complexity: S
- **Objective:** Metadata pill, optional clock, night CSS filter, Ken Burns; reduced-motion.
- **Creates:** `client/src/overlay/{osd,clock,night,disconnect}.ts`, `slideshow/kenburns.ts`.
- **Depends on:** Phase 3.
- **Acceptance:** OSD shows album·date·title·location and toggles via config; night window
  dims/warms; Ken Burns animates on `transform`; `prefers-reduced-motion` disables KB and
  forces cut; disconnect badge appears when SSE drops.
- **Tests:** Playwright (OSD text present; reduced-motion path; emulated offline → badge);
  visual snapshots day vs. night.

### Phase 5 — Remote control view  ·  Complexity: S
- **Objective:** `/remote` phone page: prev/pause/next/favorite + live status.
- **Creates:** `client/src/control/remote.ts`, `styles/remote.css`.
- **Depends on:** Phases 2–3.
- **Acceptance:** buttons hit `/control`; status line updates from SSE; works at 320–1440
  with large touch targets and `:active` feedback; favorite reflects state.
- **Tests:** Playwright (tap next advances frame in a second tab; visual at 375).

### Phase 6 — PhotoPrism source + favorites  ·  Complexity: L
- **Objective:** Stream from PhotoPrism with the full typed filter model; favorites.
- **Creates:** `sources/photoprism.ts`, its zod config fragment, auth/session handling.
- **Depends on:** Phases 1–2.
- **Acceptance:** against a test PhotoPrism (docker), photos list with filters
  (album/favorites/quality/geo/dates/people/labels/orientation/memories/raw query);
  private+archived excluded by default; `setFavorite` round-trips; thumbnail selection ≥
  display then sharp-resized.
- **Tests:** unit (query builder for every filter → expected PhotoPrism params), integration
  (mocked PhotoPrism HTTP; favorite POST).

### Phase 7 — WebDAV source  ·  Complexity: M
- **Objective:** Nextcloud/Synology/ownCloud listing + streaming.
- **Creates:** `sources/webdav.ts` + config fragment.
- **Acceptance:** PROPFIND lists images; auth (basic/bearer); `skip_tls_verify`; bytes stream.
- **Tests:** unit (PROPFIND XML parse), integration (mock WebDAV).

### Phase 8 — Config system, schedule, on-this-day polish  ·  Complexity: S
- **Objective:** Full TOML+env config; effective `/config`; schedule window pauses
  advancing + emits `display` events; ordering polish.
- **Creates:** finalize `config/*`, `engine/scheduler.ts`, `config.example.toml`, `docs/sources.md`.
- **Acceptance:** every key overridable by `PICO_*` env; bad config fails fast with a clear
  message; schedule "off" blanks the client; on-this-day boost verified.
- **Tests:** unit (zod validation, env override precedence, window logic ports from V1).

### Phase 9 — Resiliency & offline (PWA)  ·  Complexity: M  ·  *nice-to-have*
- **Objective:** Service worker caches last N slides; client survives server drops.
- **Creates:** `client/public/{sw.js,manifest.webmanifest,icons}`, SW registration.
- **Acceptance:** kill the server mid-show → frame keeps cycling cached slides + shows
  disconnect badge; recovers on reconnect; installable.
- **Tests:** Playwright offline emulation.

### Phase 10 — Auth, security headers, rate limiting  ·  Complexity: S  ·  *nice-to-have*
- **Objective:** Optional bearer token on writes/images; helmet headers; rate limits.
- **Creates:** `http/auth.ts`, helmet+rate-limit wiring, CORS for split deploy.
- **Acceptance:** with `authToken` set, unauthenticated control → 401; headers present;
  control route rate-limited; CORS allows configured origins only.
- **Tests:** integration (401/200 matrix; header assertions).

### Phase 11 — Browse / search grid  ·  Complexity: M  ·  *nice-to-have*
- **Objective:** Virtualized thumbnail grid + search; click-to-goto.
- **Creates:** `client/src/browse/{grid,search}.ts`, `styles/browse.css`, `/photos` wiring.
- **Acceptance:** scroll loads lazily; `q` filters; click issues `goto`; no overflow 320–1920.
- **Tests:** Playwright (lazy-load, search, goto).

### Phase 12 — Device control (Pi-only)  ·  Complexity: M  ·  *nice-to-have*
- **Objective:** HDMI CEC/vcgencmd power on schedule; Wi-Fi provisioning.
- **Creates:** `server/src/device/{display-power,wifi,platform}.ts`.
- **Acceptance:** on Linux/Pi, schedule "off" powers HDMI off; "on" restores; non-Linux =
  logged no-op; Wi-Fi applied at startup when configured.
- **Tests:** unit (command construction; platform gate); manual on-device note.

### Phase 13 — Packaging & docs  ·  Complexity: M
- **Objective:** Docker image (server serves built client), compose with optional
  PhotoPrism, Pi kiosk provisioning script, README/docs.
- **Creates:** `docker/Dockerfile`, `docker/docker-compose.yml`, `scripts/kiosk-setup.sh`,
  `README.md`, `docs/{architecture,api,deployment}.md`.
- **Acceptance:** `docker compose up` serves a working frame from `sample_photos/`;
  kiosk script boots a Pi into the frame URL; docs cover local/Docker/kiosk + every env var.
- **Tests:** CI builds the image; a smoke test curls `/health` + one image inside the container.

---

## 12. Code Generation Plan (agent-sized milestones)

Milestones map ~1:1 to phases but list the **minimum context** an agent must load — no
milestone needs more than its named files plus `shared/`.

| # | Goal | Required context (read these only) | Files produced | Validation checklist |
|---|------|-------------------------------------|----------------|----------------------|
| M0 | Scaffold + contract | this §3, §6, §9 | workspace, `shared/*` stubs, server `/health`, client shell, CI | `pnpm build` ok · `/health` 200 · CI green |
| M1 | Image service + directory | §5.3, §5.4, §8.4, §9.1, `shared/photo.ts` | `images/*`, `sources/{source,directory,registry}.ts`, `routes/photos.ts`, `config` (dir) | resized bytes · cache hit · 304 · 413 guard |
| M2 | Engine + control + SSE | §5.2, §8.1–8.3, §9.2 | `engine/*`, `routes/{slideshow,control}.ts`, `sse.ts` | advance timer · control mutates · SSE broadcast · ordering |
| M3 | Frame view | §4.1, §8.2, §8.4, `shared/*` | `slideshow/{stage,transitions,preload}`, `api/*`, `frame.css` | shows photo · crossfade on SSE · decode-before-swap |
| M4 | Overlay | §4.1, §9.2 | `overlay/*`, `kenburns.ts` | OSD · night window · reduced-motion · disconnect badge |
| M5 | Remote | §4.2, §8.3 | `control/remote.ts`, `remote.css` | buttons → control · live status · touch sizes |
| M6 | PhotoPrism | §5.4, §9.3, V1 README PhotoPrism filters (parity check only) | `sources/photoprism.ts` | every filter → params · private/archived excluded · favorite |
| M7 | WebDAV | §5.4, §9.3 | `sources/webdav.ts` | list · auth · stream |
| M8 | Config/schedule | §3.6, §8.1, §9.4, V1 `config.rs` window tests (parity) | `config/*`, `scheduler.ts`, `config.example.toml` | env overrides · fail-fast · schedule off blanks |
| M9 | Offline/PWA | §4.4 | `public/sw.js`, manifest | survives server kill · installable |
| M10 | Auth/security | §10, §8.6 | `http/auth.ts`, helmet/rate-limit | 401 matrix · headers · CORS |
| M11 | Browse/search | §4.3, §8.4 | `browse/*` | lazy-load · search · goto |
| M12 | Device (Pi) | §5.5, V1 `display_power.rs`/`wifi.rs` (parity) | `device/*` | schedule powers HDMI · platform gate |
| M13 | Packaging/docs | §6, §14 | `docker/*`, `scripts/kiosk-setup.sh`, docs | compose up works · kiosk boots · docs complete |

Parallelizable once M0–M2 land: **M6, M7** (sources) and **M3→M4→M5** (client) are
independent tracks; **M10, M11, M12** are independent leaves.

---

## 13. Testing Strategy

Coverage target ≥ 80% on server engine/images/sources and shared (per testing rules).

- **Unit** (Vitest): ordering (shuffle determinism with seed, chronological, date-cluster,
  on-this-day), cache key derivation + LRU eviction + budget edge cases (port V1's three
  cache tests), config zod validation + env precedence + window logic (port V1's
  `parse_hhmm`/`time_in_window` tests verbatim — they are correct), PhotoPrism query
  builder (one assertion per filter), EXIF orientation, image guard thresholds.
- **Integration** (Vitest + `fastify.inject`): every endpoint's happy + error path; image
  resize golden tests (decode result within pixel tolerance); 304/ETag; SSE event sequence
  for a control action; mocked PhotoPrism/WebDAV HTTP.
- **Browser/E2E** (Playwright, Chrome+Firefox+WebKit per web rules): frame loads &
  advances on SSE; crossfade; remote control mutates the frame in a second tab; reduced-
  motion; offline badge + SW fallback; browse lazy-load/search.
- **Visual regression** (Playwright screenshots): frame 1920×1080 day/night; remote at
  320/768/1024/1440; browse grid. Snapshot both states where they exist.
- **Performance benchmarks:** resize throughput (images/s by size), cache-hit latency
  (target < 10 ms to first byte), client bundle budget (**fail CI if > 80 KB gz**),
  Lighthouse on `/` and `/remote` (LCP < 2.5 s, CLS < 0.1, TBT < 200 ms per perf rules).

**Success criteria:** all suites green; coverage ≥ 80% on core server packages; bundle
under budget; Lighthouse targets met; visual snapshots stable.

---

## 14. Deployment

### 14.1 Local development
`pnpm dev` runs the server (`tsx watch`) and Vite together; the client proxies `/api` to
the server. Point `directory.path` at `sample_photos/` for instant content.

### 14.2 Docker (co-hosted: server serves client)
Multi-stage `Dockerfile`: build `shared`→`server`→`client`, then copy built client into
the server's static dir on a `node:20-slim` runtime (sharp's prebuilt ARM/x64 binaries
included). `docker-compose.yml` runs the server and (optionally) a PhotoPrism instance for
a one-command demo. Volumes: photo dir(s) (read-only), cache dir, config file.

### 14.3 Production
- **Server:** container on a Pi 4/5, NAS, or any host; or `node` under systemd. Expose
  `:8188`. Mount config + cache + photo volumes.
- **Client (display):** any browser to `http://<server>:8188/`. For a Pi photo-frame,
  `scripts/kiosk-setup.sh` provisions Chromium `--kiosk --app=<url>` (Pi 4 / Zero 2 W) or
  WPE/cog (Pi Zero) on boot via a systemd user service — the V2 replacement for V1's
  `install.sh`. The display device runs **no project code**.
- **Independent client deploy (optional):** host `client/dist` on any static host/CDN and
  set `VITE_API_BASE` to the remote server; enable CORS (§10) + token auth on the server.

### 14.4 Environment & secrets
Every config key has a `PICO_*` env override. Secrets (PhotoPrism password/app-password,
WebDAV password, `authToken`, Wi-Fi PSK) come from env or a `chmod 600` config file —
never committed. Startup validates required secrets and fails fast with a clear message.

### 14.5 CI/CD
GitHub Actions: install → typecheck → lint → unit → integration → Playwright → build →
bundle-budget gate → build & push Docker image (tagged by version + `latest`). Optional
release job mirrors V1's `release.sh` (changelog + GitHub release).

### 14.6 Rollback
Server is stateless except the **disposable** disk cache; roll back by redeploying the
prior image tag. Config is backward-compatible within a major version (additive zod keys
with defaults). No DB migrations to reverse. The client is static — revert by serving the
prior `dist`.

---

## 15. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Chromium too heavy on an original Pi Zero (512 MB) | Med | Med | Recommend Pi Zero 2 W / Pi 4 for kiosk; document WPE WebKit/cog as the light browser; provide a no-JS `<meta refresh>` fallback frame page. |
| Node server RAM too high for a 512 MB server box | Low | Med | Server targets Pi 4/5/NAS (RAM available); document the Rust/axum server alternative (§0.1) for sub-256 MB hosts; cap with `--max-old-space-size`. |
| `sharp`/libvips native binary unavailable for the target arch | Low | High | Pin a version with prebuilt linux-arm64/x64; CI builds the Docker image on the target arch; fall back to libvips system package. |
| AVIF encode CPU cost spikes resize latency | Med | Low | Default WebP; AVIF opt-in per request/Accept; cache absorbs repeats. |
| SSE blocked/buffered by a reverse proxy | Med | Med | Document `proxy_buffering off`; client falls back to 2 s polling of `/slideshow/state` if `EventSource` fails repeatedly. |
| PhotoPrism API/auth drift (sessions, thumbnail names) | Med | Med | Pin tested PhotoPrism version in compose; isolate all API quirks in `photoprism.ts` behind the `PhotoSource` interface; contract tests against a mock. |
| Browser image-memory growth on long-running frames | Med | Med | Two-layer cap (clear old `src` after swap); server sends display-sized bytes only; periodic `location.reload()` option for 24/7 kiosks. |
| Multi-frame state contention (different resolutions) | Low | Low | Cursor is resolution-independent (PhotoMeta, not bytes); each frame requests its own `w/h`; cache keys include dimensions. |
| Scope creep into a "plugin host" / framework | Med | Med | Hold the line: the only extension point is `PhotoSource`; no UI framework until the browse view demonstrably needs one (YAGNI). |
| Losing feature parity vs. V1 silently | Med | Med | §2 is the parity checklist; each phase's acceptance maps to a feature; a final parity pass diffs V2 behavior against V1 README. |

---

## Appendix A — Parity checklist (validate against V1 only here)

Slideshow ✓ duration ✓ transitions(cut/fade/slide L,R) ✓ ordering(shuffle/chrono/newest/
date_cluster) ✓ on-this-day ✓ OSD pill ✓ clock ✓ fill/letterbox ✓ letterbox blur ✓
Ken Burns ✓ night mode ✓ display schedule ✓ favorites ✓ EXIF date+orientation ✓
memory guard ✓ remote(prev/pause/next/favorite + status) ✓ sources(directory[+multi-path],
photoprism[full filters], webdav) ✓ resize+cache ✓ config(file+env) ✓ health ✓.
Deferred (nice-to-have): google-drive/rclone, usb, device CEC, Wi-Fi, browse/search,
PWA/offline, auth. Dropped (legacy): amazon-photos, on-screen menu, native renderer.

## Appendix B — Assumptions

1. The display device can run a modern browser (Chromium/WebKit ≥ 2022). 2. The server
host has more than 512 MB RAM (else choose the Rust server, §0.1). 3. Server and frames
share a trusted LAN by default; exposure beyond it enables auth (§10). 4. PhotoPrism (if
used) is reachable on the LAN with a service/app account. 5. One logical slideshow per
server instance by default (multi-frame shows the same cursor); per-frame independent
playlists are out of scope for V1-parity. 6. Photo sources are read-only; uploads are an
explicit nice-to-have, not parity.
```

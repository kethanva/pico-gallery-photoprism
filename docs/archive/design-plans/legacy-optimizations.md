# Archived performance and security optimizations

> **Archive notice (2026-08-08):** This document describes the superseded
> Fastify/sharp implementation, not the current PhotoPrism gateway. It is kept
> only for historical rationale.

Latest optimizations for Pi Zero 2 W (512 MB RAM, VideoCore IV GPU) and security hardening.

## Server / Appliance

### Concurrency Limiter (util/limiter.ts)
Bounds concurrent image decodes. At a slide swap, client fires current photo + 64px blur backdrop + cold-start prefetch near-simultaneously → 2–3 full-res decodes in-flight → OOM risk. Limiter queues resize/encode ops: max 2 in-flight on Pi, one-per-core elsewhere. Cache hits bypass (fast path untouched).

**Impact:** Stable memory under load.  
**Tests:** 3 (concurrent cap, FIFO, exception-release).

### Cursor Persistence Throttled (state-store.ts + engine/index.ts)
Was writing JSON cursor to SD every slide (~10s) = ~8600 writes/day flash wear + I/O contending cache reads. Now coalesced to ≤1 write per 60s; sync flush on engine.stop() guarantees graceful-restart durability. Power-cut loses ≤60s of progress.

**Impact:** ~8500 fewer SD writes/day, ~67% less disk I/O.  
**Tests:** 5 (defer-and-coalesce, latest-wins, sync-flush, round-trip, no-op-on-empty).

### Per-Encoder Sharp Tuning (service.ts)
WebP effort 4→2 on low-mem hosts: ~50% faster encode, ~5% larger file. Only pays on cache miss → pure first-view latency. AVIF stays low-effort. Split `.toFormat()` into `.webp()/.avif()/.jpeg()` for encoder-specific options.

**Impact:** Faster first-view on cold cache (Pi CPU-bound).

### Cache Miss Skips Syscall (cache.ts)
`get()` checks in-memory entry map before open() → miss returns instantly without a doomed filesystem call. Common path (first-view, cold cache).

**Impact:** Single-digit ms on every cache miss.

**Tests:** 8 → 13 (45 baseline + 8 new).

---

## Client / UI

### Blur Backdrop from 64px Thumbnail (stage.ts + frame.css)
Was: second full-res decode + GPU texture upload + blur(32px) on 1920px surface per slide.  
Now: 64px source, blur(18px). Blur cost ∝ radius; decode/texture ∝ pixels — both slashed. Visually identical (heavy blur of small upscaled = same aesthetic). **Biggest GPU win.**

### Removed Backdrop-Filter on OSD (frame.css)
`backdrop-filter: blur(12px)` on pill re-samples photo behind it every frame — slow/broken on VideoCore. Replaced with opaque translucent black (0.82 + hairline border). Same readability, near-zero GPU cost.

### Will-Change Scoped to Animation (frame.css)
Was: permanent on both layers → pinned two full-screen RGBA textures (~16 MB VRAM) idle on 512 MB board.  
Now: only during `.entering`/`.leaving` (+ `.ken-burns img` while animating). Frees idle VRAM between slides.

### Paint Containment (frame.css)
`contain: layout paint` on `.slide-layer` isolates raster; one repaint doesn't ripple.

### Blur Thumbnail Prefetch (main.ts)
Warmed into cache at swap time → appears with photo instead of popping a frame late.

### Input Hardening (remote.css + frame.css)
- `overscroll-behavior: none` (no rubber-band)
- `user-select: none`
- `-webkit-tap-highlight-color: transparent`
- `touch-action: manipulation` (no double-tap zoom)
- Remote: min-height 56px tap targets, `:focus-visible` for a11y

**Bundle:** CSS +0.57 kB (gzip +0.02 kB), JS +0.12 kB (gzip +0.01 kB). Negligible.

---

## Security

### Auth Bypass Hole Closed (http/app.ts)
Localhost kiosk bypass now reads real TCP peer (`req.socket.remoteAddress`), not spoofable `req.ip` (which trusts `X-Forwarded-For` when `trustProxy:true`). Prevents `X-Forwarded-For: 127.0.0.1` header spoofing auth.

**Tests:** Added regression test (remote peer + spoofed XFF still 401).

### snapThumbSize Corrected (sources/photoprism.ts)
Was: `[320,720,1280,1920,2048,3840]` (invalid fit_320, missing 1600/2560/4096/5120).  
Now: `[720,1280,1600,1920,2048,2560,3840,4096,5120,7680]` (verified against PhotoPrism source).  
Floor 720 (PhotoPrism minimum). Fixes 64px blur backdrop → fit_720 (not invalid fit_320).

**Tests:** 4 (clamp, snap, cap, exhaustive range check).

---

## Read-Only Conversion

Removed write paths for PhotoPrism backend integration:
- Favorite toggle (removed client button + handler)
- Config: `cors_origins`, `perPage`, `maxThumb`, entire `[device]` block
- Source: `toggleFavorite`, `setFavorite`
- API: removed `favorite` from control actions

Keeps all read paths: `listPhotos`, `getOriginal`, `search`.

---

## Other Fixes

### Config Env Overrides (config/loader.ts)
`PICO_HTTP_PORT` against a config with no `[http]` section was silently dropped. Now creates section if missing before assigning field.

**Tests:** Added case for missing section + override.

### Engine Tests Cache Isolation (engine/*.test.ts)
Tests randomly failed from shared `~/.cache/picogallery/slideshow-state.json`. Now creates isolated mkdtemp() per test, cleaned in afterAll.

### Ordering Single-Pass Boost (engine/ordering.ts)
On-this-day boost was two filter() calls building Date objects. Now single-pass partition.

---

## Baseline → 60 Tests, All Green

No behavior change on cache-hit path (90%+ of runtime). Gains accumulate: combined UI + server, per-slide GPU + CPU + SD cost on Pi Zero 2 materially lower.

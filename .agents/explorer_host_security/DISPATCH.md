## 2026-08-17T18:19:45Z

You are Explorer 1: Host Proxy & Security Architecture.
Working directory: /Volumes/SSD/projects/PHOTOS_RELATED/pico-gallery-photoprism/.agents/explorer_host_security
Read /Volumes/SSD/projects/PHOTOS_RELATED/pico-gallery-photoprism/.agents/ORIGINAL_REQUEST.md, AGENTS.md, docs/architecture.md, docs/api.md, scripts/photoprism-host.mjs, scripts/config-loader.mjs, config/kiosk-config-core.mjs, and scripts/security-audit.mjs.
Investigate:
1. Host proxy architecture, gateway auth token handling (PICO_PP_AUTH_TOKEN / config.toml, loopback vs non-loopback binds, timingSafeEqual constant-time check).
2. ALLOWED_API_ROUTES pinning (exactly 3 regexes: config, photos, fit_(720|1280) thumbnails).
3. Upstream session lifecycle, single in-flight auth coalescing, bounded exponential backoff, health/readiness endpoints.
4. TOML parser subset rules in scripts/config-loader.mjs.
5. Security audit mechanism and invariant verification.
Write your detailed report to /Volumes/SSD/projects/PHOTOS_RELATED/pico-gallery-photoprism/.agents/explorer_host_security/handoff.md and update progress.md.
Send a message when done with your key findings and report path.

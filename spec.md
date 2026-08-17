# PicoGallery (PhotoPrism appliance) Specification

Architecture, trust boundaries, and the failure model are specified in
`docs/architecture.md` and are **not duplicated here**. This file states the
requirements that document assumes.

## 1. Overview

A resource-conscious PhotoPrism display appliance for Raspberry Pi, including
the Pi Zero 2 W. A Node host serves a minimal photo grid/slideshow and proxies
only the read-only PhotoPrism calls that display requires; Cog/WPE WebKit shows
it fullscreen under Cage/Wayland.

PhotoPrism is the system of record. This appliance owns no media, no metadata,
and no search.

## 2. Core stack

- **Runtime**: Node.js **22+**, ESM (`.mjs`) throughout. No TypeScript at runtime.
- **Browser**: Cog / WPE WebKit under Cage (Wayland).
- **Frontend**: vendored PhotoPrism Vue app; first-party display logic is `frontend/src/minimal-photo-app.js`.
- **Config**: a strict scalar subset of TOML, parsed by `scripts/config-loader.mjs`.
- **Test**: `node --test`. **Lint**: eslint, `--max-warnings 0`.
- **Target**: Raspberry Pi Zero 2 W as the floor; host port 8190 by default.

## 3. Functional requirements

### 3.1 Host (`scripts/photoprism-host.mjs`)

Serves `frontend/index.html` + `frontend/dist`; validates kiosk configuration;
authenticates the display gateway; proxies a read-only PhotoPrism route
allowlist with a viewer-scoped `X-Auth-Token`; exposes health and readiness;
shuts down cleanly.

### 3.2 Route allowlist

`ALLOWED_API_ROUTES` in `scripts/photoprism-host.mjs` is exactly three regexes,
matched only for `GET`/`HEAD`:

```js
/^\/api\/v1\/config$/
/^\/api\/v1\/photos$/
/^\/api\/v1\/t\/[A-Za-z0-9]+\/[A-Za-z0-9._~-]+\/fit_(720|1280)$/
```

Note the thumbnail route is pinned to **`fit_720` and `fit_1280` only** — adding
a new display size is an allowlist change, not just a frontend change.

Everything else — session, account, administration, mutation, download,
arbitrary endpoints, and every other thumbnail size — is **not proxied**.

Gateway auth accepts a `Bearer` header or a `pico_auth=` cookie, compared with
`timingSafeEqual`. Keep the constant-time comparison.

`/api/v1/config` is rewritten into public mode so the kiosk never renders a
sign-in page.

### 3.3 Display (`minimal-photo-app.js`)

Paginated fetch, bounded virtualized grid, preview, slideshow state. Resource
bounds are a requirement, not an optimization: the grid must not retain an
unbounded number of decoded images.

### 3.4 Kiosk

`kiosk/cog/` provides the Cage/Cog launcher and systemd units
(`picogallery-kiosk`). `config/kiosk-config-core.mjs` is the single source of
kiosk profile resolution, shared by host and browser.

### 3.5 Provisioning

`install.sh` provisions and migrates the appliance, logging to
`/var/log/picogallery-install.log`, and **verifies its own work**: services
active, `/api/v1/health` answering, `/api/v1/config` actually rewritten to public mode,
and no libinput/DRM failures in the kiosk journal.

## 4. Security requirements

These are invariants. Changing any of them is a security change.

- Default bind `127.0.0.1`. A non-loopback bind is **rejected at startup** unless `PICO_PP_AUTH_TOKEN` (or `[http].auth_token`) is ≥24 characters — `photoprism-host.mjs:48`.
- `/?token=…` exchanges the query token for an HttpOnly, SameSite cookie, then redirects to strip it from the URL.
- Upstream credentials never reach the browser; the host injects its token only into allowlisted upstream calls.
- The PhotoPrism credential must be a dedicated least-privilege viewer account or app password.
- Production runs a root-owned copy from `/opt/picogallery` under the non-login `picogallery` account, never as the checkout owner.
- Displays crossing an untrusted network require a VPN or TLS reverse proxy plus a firewall.
- `npm run audit:security` gates releases.

## 5. Non-functional requirements

- Must run within a Pi Zero 2 W's memory budget with the WebKit process resident.
- Upstream auth is coalesced with bounded exponential backoff; proxy and rewrite operations are time- and size-limited.
- Readiness must reflect real upstream reachability (recent authenticated 2xx) and must expire when probes stop.
- Systemd restarts the host and recycles WebKit daily on constrained devices.

## 6. Failure modes & required behavior

| Condition                         | Required behavior                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| PhotoPrism unreachable            | Host stays live; readiness goes false; backoff, do not hammer.                        |
| Upstream auth fails               | Coalesced retry with bounded backoff. No credential in any client-visible response.   |
| `/api/v1/config` rewrite fails    | Surfaced as an install-time failure — the kiosk would otherwise show a sign-in page.  |
| Non-loopback bind without a token | Refuse to start.                                                                      |
| Config invalid                    | Strict parser rejects it with a specific error; do not start on a half-parsed config. |
| Config changed                    | Requires a service restart. Not hot-reloaded, by design.                              |
| libinput/DRM unavailable          | Detected and reported by `install.sh` and `pi-canary.sh`.                             |

## 7. Out of scope

- Acting as a photo server; any write, delete, or edit path against PhotoPrism.
- A slideshow database, API framework, SSE engine, image transcoder, or multi-source abstraction.
- WebSocket proxying.
- More than one PhotoPrism source per host, or horizontal state coordination.

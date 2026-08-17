# Architecture

PicoGallery is a single-purpose PhotoPrism display appliance. The shipped
runtime is intentionally small:

```text
Cog / WPE WebKit
      │ same-origin HTTP
      ▼
scripts/photoprism-host.mjs
  ├─ serves frontend/index.html and frontend/dist
  ├─ validates kiosk configuration
  ├─ authenticates the display gateway
  └─ proxies a small read-only PhotoPrism route allowlist
      │ viewer-scoped X-Auth-Token
      ▼
PhotoPrism
```

There is no independent slideshow database, Fastify API, SSE engine, image
transcoder, or multi-source abstraction in the current release. PhotoPrism owns
media and metadata; `frontend/src/minimal-photo-app.js` owns pagination,
virtualized grid rendering, preview, and slideshow state in the browser.

## Trust boundaries

- The host binds to the configured `[http].host`; `127.0.0.1` is the safe
  same-device default.
- Any non-loopback bind is rejected unless a gateway token of at
  least 24 characters is configured. Opening `/?token=...` exchanges the query
  token for an HttpOnly, SameSite cookie and redirects to remove it from the URL.
- Upstream credentials never reach the browser. The host creates one coalesced
  PhotoPrism session and injects its token only into allowlisted upstream calls.
- Only `GET/HEAD /api/v1/config`, `/api/v1/photos`, and thumbnail routes used by
  the minimal display are proxied. Account, session, administration, mutation,
  download, and arbitrary PhotoPrism endpoints are not exposed.
- The PhotoPrism credential must belong to a dedicated viewer account. An
  administrator credential violates the deployment model even though mutations
  are blocked at the gateway.

## Runtime modules

- `scripts/photoprism-host.mjs`: HTTP boundary, static files, gateway auth,
  upstream session lifecycle, route policy, health/readiness, and shutdown.
- `scripts/config-loader.mjs`: strict structural parser for PicoGallery's scalar
  TOML subset and explicit PhotoPrism source selection.
- `config/kiosk-config-core.mjs`: shared host/browser kiosk profile resolution.
- `frontend/src/minimal-photo-app.js`: resource-bounded display application.
- `kiosk/cog/`: Cage/Cog launcher and systemd assets.
- `install.sh`: appliance provisioning and migration.

## Failure model

Liveness reports that the Node process can serve requests. Readiness requires a
recent authenticated 2xx response from PhotoPrism and expires if probes stop.
Authentication calls are coalesced and use bounded exponential backoff. Proxy
and rewrite operations have time and size limits. Systemd restarts the host and
recycles the WebKit process daily on constrained devices.

## Architectural constraints

- One PhotoPrism source per host.
- One Node host process; no horizontal state coordination is required.
- WebSocket proxying is intentionally absent because the minimal frontend does
  not use PhotoPrism WebSockets.
- Configuration changes require a service restart.

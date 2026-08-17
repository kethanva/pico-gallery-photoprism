# Display Host HTTP Contract

The host exposes a narrow kiosk contract, not the full PhotoPrism API.

## Authentication

Loopback-only installations may omit gateway authentication. External binds
must configure `[http].auth_token` or `PICO_PP_AUTH_TOKEN` with at least 24
characters. A kiosk initially opens:

```text
http://frame-host:8190/library/photos?token=<gateway-token>
```

The host responds with a `303`, stores the token in an HttpOnly SameSite cookie,
and removes it from the visible URL. API clients may instead send
`Authorization: Bearer <gateway-token>`.

Health endpoints deliberately do not require the gateway token so local service
managers can probe them. Do not expose them as an Internet monitoring surface.

## Local endpoints

| Method | Path | Result |
|---|---|---|
| GET | `/api/v1/health` | Process liveness and uptime. |
| GET | `/api/v1/ready` | `200` only after a recent authenticated PhotoPrism probe; otherwise `503`. |
| GET | `/api/v1/metrics` | Gateway-authenticated counters, readiness, uptime, and RSS. |
| GET | `/config.json` | Resolved, non-secret kiosk configuration. |
| GET | `/library/photos` | Minimal display SPA history fallback. |

## Allowlisted PhotoPrism reads

| Method | Path | Purpose |
|---|---|---|
| GET/HEAD | `/api/v1/config` | Runtime preview token and public display configuration. |
| GET/HEAD | `/api/v1/photos?...` | Paginated photo metadata for the grid/slideshow. |
| GET/HEAD | `/api/v1/t/:hash/:token/fit_720` | Thumbnail/preview bytes. |
| GET/HEAD | `/api/v1/t/:hash/:token/fit_1280` | Optional higher-resolution preview bytes. |

Every other `/api/*` route returns `403`. Upstream session and administrator
objects are never exposed. Non-GET/HEAD requests are rejected.

Upstream authentication failure returns `503` with `Retry-After`; upstream
network failure returns `502`. Malformed request URLs return `400` without
terminating the process.

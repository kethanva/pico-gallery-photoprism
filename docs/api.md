# API (v1)

Base path: `/api/v1`. All responses are JSON unless noted. Errors use a
consistent envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "Photo not found" } }
```

If `http.authToken` is configured, every `/api/*` request must send
`Authorization: Bearer <token>` or receive `401`.

## Health

| Method | Path        | Notes                                                        |
|--------|-------------|--------------------------------------------------------------|
| GET    | `/health`   | `{ "status": "ok", "ts": "…" }` once the process is up.      |
| GET    | `/ready`    | `200 { status:"ready", total }` or `503` until playlist filled.|

## Slideshow

| Method | Path                  | Notes                                              |
|--------|-----------------------|----------------------------------------------------|
| GET    | `/slideshow/state`    | Current `{ index, total, paused, displayOn, photo, startedAt }`. |
| GET    | `/events`             | **SSE** stream. Emits `state` (and `display`) events. |

SSE example:

```
event: state
data: {"index":1,"total":9,"paused":false,"photo":{"id":"photoprism:…","filename":"…",…}}
```

## Control

| Method | Path        | Body                                                       |
|--------|-------------|------------------------------------------------------------|
| POST   | `/control`  | `{ "action": "next" \| "prev" \| "pause" \| "resume" \| "toggle_pause" \| "goto", "id"?: string }` |

Acks with `{ "ok": true }` and broadcasts the new state to all SSE clients via a
`state` event. Actions are local slideshow navigation only (read-only viewer; the
PhotoPrism backend is never modified). `goto` with an unknown `id` → `404`; `goto`
requires `id`.

## Photos

| Method | Path                     | Notes                                            |
|--------|--------------------------|--------------------------------------------------|
| GET    | `/photos?offset&limit`   | `{ items, total, offset, limit }` page of the playlist. |
| GET    | `/photos/:id/meta`       | One `PhotoMeta`, or `404`. `id` is URL-encoded.  |
| GET    | `/photos/:id/image?w&h&fit&fmt` | Resized image bytes.                      |

Image query params: `w`, `h` (target box), `fit` = `cover` \| `contain`,
`fmt` = `auto` \| `webp` \| `jpeg` \| `avif` (`auto` negotiates from `Accept`).

Responses:
- `200` with `ETag`, `Cache-Control: public, max-age=31536000, immutable`, and
  `X-Cache: HIT|MISS`.
- `304` when `If-None-Match` matches the `ETag`.
- `413 PAYLOAD_TOO_LARGE` when an original exceeds the MB / megapixel guard.
- `502 SOURCE_ERROR` when the source fetch or decode fails.
- `404 NOT_FOUND` / `503 UNAVAILABLE` as applicable.

## Sources & auth

| Method | Path                   | Notes                                              |
|--------|------------------------|----------------------------------------------------|
| GET    | `/sources`             | `[{ name, displayName, auth, photoCount }]`.       |
| POST   | `/sources/:name/auth`  | Triggers auth; returns `{ status, message?, pollSecs?, error? }`. |

`auth` / `status` is one of `authenticated` \| `pending` \| `unauthenticated`.

## Config

| Method | Path              | Notes                          |
|--------|-------------------|--------------------------------|
| GET    | `/config`         | Effective display settings.    |

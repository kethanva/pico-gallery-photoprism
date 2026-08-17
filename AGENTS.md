# AGENTS.md — PicoGallery (PhotoPrism appliance)

Single source of truth for coding agents. `CLAUDE.md` is a symlink to this file.

Deep documentation already exists and is accurate — **read it rather than
re-deriving**: `docs/architecture.md` (trust boundaries, runtime modules,
failure model), `docs/api.md`, `docs/deployment.md`, `docs/sources.md`,
`README.md`. This file records what those do not.

## What this is

A single-purpose **PhotoPrism display appliance** for Raspberry Pi (incl. Zero
2 W). A small Node host serves a minimal photo grid/slideshow and proxies only
the read-only PhotoPrism calls that display needs. Cog/WPE WebKit renders it
fullscreen under Cage/Wayland.

```
Cog/WPE → picogallery host :8190 → PhotoPrism (viewer account)
```

It is **not** a photo server. PhotoPrism stays the system of record for media,
metadata, and search. There is no slideshow database, no SSE engine, no
transcoder, no multi-source abstraction — and adding one is a scope change, not
a feature.

## Layout

| Path                                                 | Purpose                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/photoprism-host.mjs`                        | HTTP boundary: static files, gateway auth, upstream session lifecycle, route allowlist, health/readiness, shutdown |
| `scripts/config-loader.mjs`                          | Strict structural parser for PicoGallery's scalar TOML subset                                                      |
| `config/kiosk-config-core.mjs`                       | Shared host/browser kiosk profile resolution                                                                       |
| `frontend/src/minimal-photo-app.js`                  | The display app: pagination, virtualized grid, preview, slideshow                                                  |
| `kiosk/cog/`                                         | Cage/Cog launcher + systemd assets                                                                                 |
| `install.sh`                                         | Pi provisioning and upgrade migration                                                                              |
| `scripts/security-audit.mjs`                         | Security gate, run via `npm run audit:security`                                                                    |
| `scripts/pi-canary.sh`, `scripts/pi-e2e-diagnose.sh` | On-device diagnostics                                                                                              |

**`frontend/` is a vendored PhotoPrism Vue frontend**, not first-party code.
`frontend/AGENTS.md` is _upstream PhotoPrism's_ guidance and refers to a build
system this repo does not have (`make build-js`, `assets/templates/*.gohtml`,
TestCafe acceptance targets, gettext extraction). Do not follow it as if it
described this project. First-party frontend code is
`frontend/src/minimal-photo-app.js` and `frontend/src/kiosk-config.js`.

## Commands

Requires **Node 22+** (`run.sh` locates it).

```bash
./run.sh setup                  # npm install at repo root
./run.sh build                  # build frontend/dist
./run.sh test                   # unit tests
./run.sh photoprism [backend]   # host the UI + proxy /api/v1
./run.sh kiosk [url]            # Cog+Cage on Pi, browser mimic on macOS
./run.sh appliance [backend]    # host + kiosk together, end-to-end
./run.sh clean

npm test                        # node --test tests/**/*.test.mjs
npm run lint                    # eslint scripts tests --max-warnings 0
npm run audit:security          # scripts/security-audit.mjs . frontend
```

Env: `PICO_PP_PORT` (default 8190), `PICO_PP_BACKEND`, `PICO_KIOSK_URL`.

Tests live in `tests/tests/`: `config-loader`, `photoprism-host`,
`kiosk-config`, `install-contract`, `pi-canary`, `security-audit`.

## Logging

- **Host**: stdout/stderr → systemd journal, unit `picogallery-photoprism`.
- **Kiosk**: journal, unit `picogallery-kiosk`.
- **Install**: the one real log _file_ in this project — `/var/log/picogallery-install.log`.
- No application log file at runtime. The journal is the sink.

## How to debug

```bash
sudo bash scripts/pi-e2e-diagnose.sh          # start here on-device
sudo bash scripts/pi-canary.sh                # post-deploy health check

journalctl -u picogallery-photoprism -f
journalctl -u picogallery-kiosk -f
curl -s localhost:8190/api/v1/health
```

Common causes, in the order they occur:

- **Kiosk shows a PhotoPrism SIGN IN page** → the proxy failed to rewrite `/api/v1/config` into public mode. Check credentials in `$CONFIG_DIR/config.toml` and the host journal. `install.sh` asserts this explicitly at the end of provisioning.
- **Black screen / no input** → libinput or DRM. Both `pi-canary.sh` and `install.sh` grep the kiosk journal for `libinput.*(no input devices|cannot open)` and `failed to open.*(drm|card)`.
- **Readiness flapping** → readiness requires a _recent_ authenticated 2xx from PhotoPrism and expires if probes stop. A ready→not-ready flip usually means upstream, not the host.
- **Config change had no effect** → configuration changes require a service restart, by design.

## Error handling

- Liveness ≠ readiness. Liveness says the Node process can serve; readiness requires a recent authenticated 2xx from PhotoPrism. Keep them distinct.
- Upstream authentication calls are **coalesced** (one in-flight session attempt, shared) with bounded exponential backoff. Do not add a second independent auth path.
- Proxy and rewrite operations carry time and size limits. Any new proxied route must inherit them.
- Systemd restarts the host and recycles the WebKit process daily on constrained devices — a long-running leak is mitigated, not solved. Do not rely on that.

## Security invariants (do not weaken)

- Default bind is `127.0.0.1`. A non-loopback bind is **rejected at startup** unless `PICO_PP_AUTH_TOKEN` (or `[http].auth_token`) is ≥24 characters — `photoprism-host.mjs:48`.
- `/?token=…` exchanges the query token for an HttpOnly, SameSite cookie (`pico_auth=`) and redirects to strip it from the URL. Tokens are compared with `timingSafeEqual` — keep it constant-time.
- Upstream credentials never reach the browser. The host injects its token only into allowlisted upstream calls.
- `ALLOWED_API_ROUTES` is **exactly three regexes**, `GET`/`HEAD` only: `/api/v1/config`, `/api/v1/photos`, and `/api/v1/t/<hash>/<token>/fit_(720|1280)`. The thumbnail size is pinned — a new display size needs an allowlist edit, not just a frontend change. Account, session, administration, mutation, and download endpoints are unreachable. **Widening this allowlist is a security change** — treat it as one.
- The PhotoPrism credential must be a dedicated least-privilege viewer account or app password, even though mutations are blocked at the gateway.
- Production runs a root-owned copy at `/opt/picogallery` under the non-login `picogallery` account — never as the checkout owner.

## Graphify

This project has a knowledge graph at `graphify-out/`.

**It indexes `HEAD`, not your working tree.** The report records the indexed
commit (`b85df4b7` in the current report); compare it with `git rev-parse HEAD`.
It cannot see untracked files, so confirm every load-bearing claim against the
working tree before relying on the graph.

- Read `graphify-out/GRAPH_REPORT.md` before reading source files, running grep/glob searches, or answering codebase questions — then confirm anything load-bearing against the actual file.
- If `graphify-out/wiki/index.md` exists, navigate it instead of raw files.
- For cross-module "how does X relate to Y", prefer `graphify query`, `graphify path`, or `graphify explain` over grep — those traverse EXTRACTED + INFERRED edges.
- After modifying code, run `graphify update .` if the CLI is available (AST-only, no API cost).

## Conventions

- Root `plan.md` is the only active implementation plan; root `spec.md` owns
  requirements. Superseded designs live under `docs/archive/design-plans/` and
  must remain clearly labeled historical.
- First-party runtime changes belong in `scripts/`, `config/`,
  `frontend/src/minimal-photo-app.js`, or `kiosk/cog/`; do not treat the rest of
  the vendored PhotoPrism frontend as an unconstrained rewrite surface.
- Any new proxied route requires a `spec.md` security review, allowlist tests,
  time/size bounds, and matching `docs/api.md` documentation.
- Config changes update `config.example.toml`, the relevant docs, and tests in
  the same change. Configuration is restart-applied, never half hot-reloaded.
- Keep Pi Zero 2 W memory bounds explicit in browser-facing changes: bounded
  DOM, bounded decoded images, and pinned thumbnail sizes.

## Do NOT

- Do NOT add WebSocket proxying. It is absent deliberately; the minimal frontend does not use PhotoPrism WebSockets.
- Do NOT add a second PhotoPrism source per host, or horizontal state coordination. One source, one process, by design.
- Do NOT treat `frontend/AGENTS.md` as this project's guidance (see above).
- Do NOT commit `config.local.toml`, credentials, or `node_modules/`.
- Do NOT add a slideshow database, API framework, SSE engine, or transcoder — see `docs/architecture.md`.

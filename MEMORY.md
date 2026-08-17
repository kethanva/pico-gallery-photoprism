# MEMORY — PicoGallery (PhotoPrism appliance)

Durable decisions and hard-won gotchas. Append when something is learned that
the code does not explain. Keep entries short; anything longer belongs in
`docs/architecture.md`.

## Architectural decisions

- **PhotoPrism owns everything; this is a display client.** The current release deliberately has no slideshow database, Fastify API, SSE engine, image transcoder, or multi-source abstraction. Earlier designs had them (archived under `docs/archive/design-plans/`); they were removed because they did not fit a Pi Zero 2 W. Re-adding one is a scope reversal, not a feature.
- **The gateway is an allowlist, not a proxy.** Only `GET`/`HEAD` on `/api/v1/config`, `/api/v1/photos`, and display thumbnail routes. Everything else is unreachable. This is why an administrator credential is still forbidden even though mutations are blocked — defence in depth.
- **`/api/v1/config` is rewritten into public mode.** Without that rewrite the kiosk renders PhotoPrism's SIGN IN page and the appliance is useless. This is the single most load-bearing transformation in the host, and `install.sh` asserts it explicitly at provisioning time.
- **Liveness and readiness are different questions.** Liveness = the Node process can serve. Readiness = a recent authenticated 2xx from PhotoPrism, and it _expires_ if probes stop. Collapsing them would make a dead upstream look healthy.
- **No WebSocket proxying, deliberately.** The minimal frontend does not use PhotoPrism WebSockets, so the surface is not exposed.
- **One source, one process.** No horizontal state coordination is needed, which is why none exists.
- **Config is not hot-reloaded.** Changes require a service restart, by design — it removes a whole class of half-applied-config states.

## Gotchas

- **`frontend/` is a vendored PhotoPrism Vue fork, and `frontend/AGENTS.md` is upstream's own guidance.** It references `make build-js`, `assets/templates/*.gohtml`, TestCafe acceptance targets, and gettext extraction — none of which exist at this repo's root. Following it wastes a session. First-party frontend code is `minimal-photo-app.js` and `kiosk-config.js`.
- **No upstream provenance is recorded for the fork.** Nobody knows which PhotoPrism commit it came from or what was changed locally, which makes applying an upstream security patch a guess.
- **Four zero-byte files are committed at the repo root**: `PhotoPrism`, `pages`, `slideshow`, `thumbnails`. Almost certainly accidental (a shell redirect), but they are tracked, so they survive clones.
- **Historical designs have one archive.** The former `plan/` and `plans/`
  directories were consolidated under `docs/archive/design-plans/` on
  2026-08-08. Root `plan.md` / `spec.md` are the only active sources; archived
  Qt, split-server, and browser-first designs are context, not requirements.
- **`SIGN IN` page on the kiosk is always the config rewrite**, not the browser and not the network. Check credentials in `$CONFIG_DIR/config.toml` and the host journal first.
- **Production does not run from the checkout.** `install.sh` copies to a root-owned `/opt/picogallery` running as the non-login `picogallery` user. Editing the checkout on-device changes nothing until reinstall.

## Operational

- Two units: `picogallery-photoprism` (host) and `picogallery-kiosk` (Cog/Cage). Both log to the journal.
- The only runtime log _file_ is `/var/log/picogallery-install.log`, written by `install.sh`, and it is not rotated.
- `scripts/pi-e2e-diagnose.sh` for a full on-device dump; `scripts/pi-canary.sh` for a post-deploy pass/fail.
- Both `install.sh` and `pi-canary.sh` grep the kiosk journal for `libinput.*(no input devices|cannot open)` and `failed to open.*(drm|card)` — black-screen reports are usually one of those.
- Systemd recycles the WebKit process daily on constrained devices. That masks slow leaks; do not read "it stays up" as "it does not leak".

# PicoGallery (PhotoPrism appliance) Plan

Requirements in `spec.md`, architecture in `docs/architecture.md`, agent
conventions in `AGENTS.md`.

Current branch: `2026-07-09-revampui`, at v2.11.1. Use `git status --short` for
the authoritative staged/unstaged state; generated bundles and documentation
can make a copied change count stale.

## Recently landed

- [x] Scrub private LAN host and credentials from the public tree
- [x] Restore grid after preview close; single-source kiosk config
- [x] Ship `config/` in the release tarball; smoke-test kiosk config at runtime
- [x] Fix fullscreen re-entry and slideshow restart from grid photos
- [x] Parallel eager thumbnail fetches for grid load speed
- [x] Fix intermittent infinite scroll when the bottom sentinel stays visible
- [x] Install-time verification: services active, `/api/v1/health` answering, `/api/v1/config` rewritten to public mode, libinput/DRM journal check

## Release integrity work

- [ ] **Commit the runtime changes atomically.** The working tree contains the
      host hardening, strict config loader, security audit, installer/kiosk tools,
      tests, and rebuilt frontend assets. Stage the dependent source, package-lock,
      test, and generated-bundle changes together; a partial commit can create a
      tree that no longer installs or builds.
- [ ] **Complete the root-to-`scripts/` diagnostic move atomically.** The root
      copy of `pi-e2e-diagnose.sh` is deleted and the shipped copy is under
      `scripts/`; stage both sides of the move.
- [ ] **Commit rebuilt frontend bundles with their manifest.** `assets.json`
      must resolve every generated `app.js`, `app.css`, and share asset in the same
      commit, and CI must continue to enforce reproducibility.
- [x] Documentation topology and required root files reconciled (2026-08-08):
      active requirements/plan are unique, historical designs are archived, and
      `AGENTS.md` now includes explicit conventions. Runtime/API facts still change
      with their owning code and tests.

## Open items

- [ ] **`frontend/` is a vendored PhotoPrism fork with no recorded provenance.** Nothing in the repo states which upstream commit it was taken from, what was changed, or how to re-sync. Add a `frontend/NOTICE`-adjacent provenance note (upstream ref + list of local modifications) — without it, a security patch upstream cannot be applied with any confidence.
- [ ] **`frontend/AGENTS.md` is upstream's and actively misleading** here: it points at `make build-js`, `assets/templates/*.gohtml`, TestCafe acceptance targets, and gettext extraction, none of which exist in this repo's root. Either prefix it with a "this is vendored upstream guidance" banner or delete it, so agents stop following it.
- [ ] **Zero-byte placeholder files at repo root**: `PhotoPrism`, `pages`, `slideshow`, `thumbnails`. All 0 bytes, all committed, all apparently accidental. Confirm and remove.
- [x] **Obsolete `OPTIMIZATIONS.md` archived (2026-08-08).** It described the
      superseded Fastify/sharp architecture and now lives with historical designs.
- [ ] **Review `diff.patch` (35K).** It is not documentation; determine whether
      it contains any unlanded change before removing it.
- [x] **Unfilled scaffolding templates deleted** (2026-08-06). `plans/plan.md` and `plans/spec.md` were pure `[bracketed placeholder]` templates with zero project content, and untracked. This file and `spec.md` at root are now the single answer to "where is the plan".
- [x] **Historical plans consolidated (2026-08-08).** The former `plan/` and
      `plans/` trees now live in `docs/archive/design-plans/` with a status index;
      root `plan.md` is the only active plan.
- [ ] **No coverage measurement.** The test suites exercise the route allowlist
      and token exchange, but CI does not publish a coverage threshold or report.
- [ ] **No log rotation story for `/var/log/picogallery-install.log`.** It grows across every upgrade.

## Verification

```bash
npm run lint                 # eslint, --max-warnings 0
npm test                     # node --test tests/**/*.test.mjs
npm run audit:security
./run.sh build
./run.sh appliance <backend> # end-to-end mimic
```

On-device after deploy:

```bash
sudo bash scripts/pi-canary.sh
curl -s localhost:8190/api/v1/health
journalctl -u picogallery-photoprism -n 60 --no-pager
journalctl -u picogallery-kiosk -n 60 --no-pager
```

Confirm the kiosk shows photos and **not** a PhotoPrism sign-in page — that is
the single highest-signal check that the gateway is behaving.

# Forensic Integrity Audit Report: PicoGallery Validation Integrity Forensics

**Work Product**: PicoGallery PhotoPrism Appliance (`scripts/photoprism-host.mjs`, `scripts/config-loader.mjs`, `scripts/security-audit.mjs`, `config/kiosk-config-core.mjs`, `scripts/kiosk-config.mjs`, `frontend/src/minimal-photo-app.js`, `tests/tests/`)  
**Profile**: General Project (Integrity Forensics)  
**Verdict**: **CLEAN**

---

## 1. Observation

### Forensic Item 1 — Genuine Logic Across All Components
- **`scripts/photoprism-host.mjs`**: Implements complete HTTP reverse proxy with stream piping (`req.pipe(upstream)`, `stream.pipe(res)`), dynamic header sanitization (`stripHopByHop`), fail-closed external host binding rejection, gateway token cookie exchange (`303 See Other`), upstream session lifecycle management with exponential backoff (`getSessionId`), public config masquerade rewriting (`rewriteAuthPayload`), and timer-based active readiness probing (`probeBackend`). No facade implementations, no dummy constant returns, and no mock pass-throughs detected.
- **`scripts/config-loader.mjs`**: Implements genuine line-by-line lexical TOML scalar parser (`parsePicoConfig`) handling quoted strings, comments, scalar arrays, numbers, and booleans. Explicitly tracks keys per table scope with `Object.hasOwn(table, key)` to detect duplicates.
- **`config/kiosk-config-core.mjs` & `scripts/kiosk-config.mjs`**: Implements pure functional profile resolution (`resolveKioskConfigFrom`) with strict integer clamping on all parameters (`maxGridRows`, `slideDuration`, `restoreRowBatch`, `thumbLoadConcurrency`, `backgroundFillTarget`).
- **`scripts/security-audit.mjs`**: Spawns real `npm audit --json`, parses dependency tree, evaluates locked `brace-expansion` versions, verifies exact patched backports, and validates waiver propagation across dependency graphs.
- **`frontend/src/minimal-photo-app.js`**: Full plain-DOM virtualized photo grid with windowed DOM bounding (~40 cards max), spacer row height compensation, touch/swipe/keyboard navigation, and image texture suspension during preview overlay.
- **Artifact Search**: Search for pre-populated logs (`*.log`), pre-computed outputs, or dummy attestation files across repository returned 0 results.

### Forensic Item 2 — `safeEqual` Pre-Hashing & Constant-Time Comparison
- Location: `scripts/photoprism-host.mjs:276-281`
```javascript
276: function safeEqual(left, right) {
277:   if (!left || !right) return false;
278:   const h1 = createHash('sha256').update(String(left)).digest();
279:   const h2 = createHash('sha256').update(String(right)).digest();
280:   return timingSafeEqual(h1, h2);
281: }
```
- Line 277: Input validation guards against falsy/null/undefined inputs without throwing.
- Lines 278-279: Both inputs are SHA-256 digested into fixed 32-byte buffers `h1` and `h2`.
- Line 280: Compares equal-length buffers via `timingSafeEqual(h1, h2)`, guaranteeing constant-time comparison and preventing `RangeError` length mismatch leaks.

### Forensic Item 3 — `ALLOWED_API_ROUTES` Pinning
- Location: `scripts/photoprism-host.mjs:270-274`
```javascript
270: const ALLOWED_API_ROUTES = [
271:   /^\/api\/v1\/config$/,
272:   /^\/api\/v1\/photos$/,
273:   /^\/api\/v1\/t\/[A-Za-z0-9]+\/[A-Za-z0-9._~-]+\/fit_(720|1280)$/,
274: ];
```
- Exactly 3 regular expressions are defined.
- Method validation (`photoprism-host.mjs:315-317, 379-389`): Only `GET` and `HEAD` methods are permitted. Non-GET/HEAD methods are rejected with HTTP 403. Request bodies (`Transfer-Encoding` or `Content-Length > 0`) are rejected with HTTP 400.
- Thumbnails are strictly pinned to sizes `fit_720` and `fit_1280`.

### Forensic Item 4 — `scripts/config-loader.mjs` Prototype Pollution Protections
- Location: `scripts/config-loader.mjs:67, 81, 94`
- Array table headers (`[[key]]`): `scripts/config-loader.mjs:67`:
  `if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(\`prototype pollution vector blocked on line \${lineNumber}\`);`
- Table headers & subsections (`[part]`): `scripts/config-loader.mjs:81`:
  `if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw new Error(\`prototype pollution vector blocked on line \${lineNumber}\`);`
- Key assignments (`key = val`): `scripts/config-loader.mjs:94`:
  `if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(\`prototype pollution vector blocked on line \${lineNumber}\`);`
- Duplicate key check: `scripts/config-loader.mjs:95`: `Object.hasOwn(table, key)` avoids prototype lookup.

### Forensic Item 5 — `scripts/security-audit.mjs` Dependency Parsing & Version Validation
- Location: `scripts/security-audit.mjs:16-69`
- `isPatchedBraceExpansion(version)`:
  - Major 1: `minor > 1 || (minor === 1 && patch >= 17)` (verifies 1.1.17+, 1.1.18)
  - Major 2: `minor > 1 || (minor === 1 && patch >= 3)` (verifies 2.1.3+, 2.1.4)
  - Major 3: `minor > 0 || (minor === 0 && patch >= 3)` (verifies 3.0.3)
  - Major 4: `return false` (correctly rejects all 4.x)
  - Major 5: `major > 5 || (major === 5 && (minor > 0 || patch >= 8))` (verifies 5.0.8+, 5.0.9)
- `lockedBraceVersions(lock)`: Authentically extracts `brace-expansion` packages from `package-lock.json`.
- `unwaivedVulnerabilities`: Validates GHSA-mh99-v99m-4gvg, propagates waivers strictly along dependency strings, rejects direct non-brace advisory objects, and filters by severity threshold.

### Forensic Item 6 — Test Suite Authenticity Across All 9 Test Suites in `tests/tests/`
- All 9 test suites across 6 test files execute real assertions:
  1. `tests/tests/config-loader.test.mjs` (8 tests): parser syntax, comments, prototype pollution, single source selection.
  2. `tests/tests/install-contract.test.mjs` (6 tests): non-login sandboxing, systemd containment directives, uninstall paths.
  3. `tests/tests/kiosk-config.test.mjs` (6 tests): TOML override parsing, bounds clamping, env var merging.
  4. `tests/tests/photoprism-host.test.mjs` — static serving (9 tests): health, readiness, security headers, assets, SW unregister.
  5. `tests/tests/photoprism-host.test.mjs` — auth masquerade proxy (10 tests): config rewriting, session injection, SSRF origin normalization, write blocking, readiness probe transitions.
  6. `tests/tests/photoprism-host.test.mjs` — gateway authentication (7 tests): unauthenticated 401, 303 token exchange, cookie strip, Bearer auth, metrics protection, size enforcement.
  7. `tests/tests/photoprism-host.test.mjs` — unsafe external startup (3 tests): fail-closed external binds, URL validation.
  8. `tests/tests/pi-canary.test.mjs` (4 tests): invariant verification, inactive service failure, `--server-only` mode, legacy conflict detection.
  9. `tests/tests/security-audit.test.mjs` (5 tests): patched backport detection, lockfile version extraction, advisory filtering.
- Total assertions: 58 tests passed with 0 failures.

---

## 2. Logic Chain

1. **Premise**: An integrity violation occurs if code contains hardcoded test results, facade stubs, bypassed security checks, fake supply chain validations, or unverified test assertions.
2. **Analysis of Implementation Code**: Direct inspection of `scripts/photoprism-host.mjs`, `scripts/config-loader.mjs`, `scripts/security-audit.mjs`, and `config/kiosk-config-core.mjs` establishes that all components execute authentic runtime computations.
3. **Analysis of Security Invariants**:
   - `safeEqual` eliminates timing attacks by pre-hashing both tokens to fixed SHA-256 digests before constant-time comparison.
   - `ALLOWED_API_ROUTES` is strictly pinned to exactly 3 regexes with GET/HEAD method enforcement and request body rejection.
   - TOML parsing enforces prototype pollution protections across array tables, section headers, and key assignments.
   - Security audit performs authentic version checking against GHSA-mh99-v99m-4gvg.
4. **Analysis of Test Suites**: All 9 root test suites run genuine network calls, process spawns, and assertion checks.
5. **Deduction**: The codebase and test infrastructure satisfy all forensic integrity criteria without facade or shortcut mechanisms.

---

## 3. Caveats

- **Scope Boundary**: Audit focused on first-party appliance code (`scripts/`, `config/`, `frontend/src/minimal-photo-app.js`, `kiosk/`, and `tests/tests/`). Upstream vendored PhotoPrism Vue dependencies in `frontend/` are evaluated as external assets per `AGENTS.md`.

---

## 4. Conclusion

**Binary Verdict**: **CLEAN**  
All forensic checks passed. No hardcoded results, no facade implementations, no prototype pollution vulnerabilities, and no bypassed security invariants were found.

---

## 5. Verification Method

To independently reproduce the forensic verification:

```bash
# 1. Run root unit & invariant test suite (58/58 passing across 9 suites)
npm test

# 2. Run static ESLint quality gate (0 warnings, 0 errors)
npm run lint

# 3. Run dependency security audit across root and frontend
npm run audit:security

# 4. Run frontend E2E browser smoke test
npm --prefix frontend run test:host-smoke
```

---

## 6. Raw Execution Evidence

### A. `npm test` Output
```text
# Subtest: photoprism-host — PhotoPrism UI static serving (9 tests) ... ok
# Subtest: photoprism-host — auth masquerade proxy (10 tests) ... ok
# Subtest: photoprism-host — gateway authentication (7 tests) ... ok
# Subtest: photoprism-host — unsafe external startup (3 tests) ... ok
# Subtest: Raspberry Pi post-reboot canary (4 tests) ... ok
# Subtest: dependency audit exception (5 tests) ... ok
# Subtest: structural PicoGallery config loader (8 tests) ... ok
# Subtest: production installer contract (6 tests) ... ok
# Subtest: kiosk-config (host) (6 tests) ... ok

1..9
# tests 58
# suites 9
# pass 58
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### B. `npm run lint` Output
```text
> pico-gallery@2.11.1 lint
> eslint scripts tests --max-warnings 0
(exit code 0)
```

### C. `npm run audit:security` Output
```text
> pico-gallery@2.11.1 audit:security
> node scripts/security-audit.mjs . frontend

.: dependency audit passed; brace-expansion compatibility lines patched: 1.1.18, 5.0.9
frontend: dependency audit passed; brace-expansion compatibility lines patched: 1.1.18, 2.1.4, 5.0.9
(exit code 0)
```

### D. `npm --prefix frontend run test:host-smoke` Output
```text
> photoprism@1 test:host-smoke
> node --test tests/e2e/host-smoke.test.mjs

TAP version 13
# Subtest: built display host browser smoke
    # Subtest: boots the built SPA, exchanges gateway auth, renders a photo, and opens its preview
    ok 1 - boots the built SPA, exchanges gateway auth, renders a photo, and opens its preview
1..1
# tests 1
# suites 1
# pass 1
# fail 0
(exit code 0)
```

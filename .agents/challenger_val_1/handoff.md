# Empirical Adversarial Challenge Report — Challenger 1: Host Proxy, Auth & Parser

**Verdict**: **APPROVE**  
**Role**: Challenger 1 (Host Proxy, Auth & Parser Adversarial Stress Tester)  
**Target Milestone**: M5 (Multi-Tier E2E Testing & Adversarial Verification)  
**Date**: 2026-08-17T18:49:00Z  

---

## 1. Observation

### Mandate 1: Malformed Inputs to TOML Parser & Prototype Pollution Attacks
- **Source Code Inspected**: `scripts/config-loader.mjs:52-101` (`parsePicoConfig`, `stripComment`, `parseValue`).
- **Observed Behavior**:
  - `stripComment` iterates character-by-character tracking quote states and escaped quote characters (`\"` and `\'`), safely preserving `#` characters enclosed in quotes (`val = "foo # bar"`) while stripping trailing inline comments.
  - `parsePicoConfig` checks table names (`[table]`), array tables (`[[table]]`), and assignment keys (`key = value`) against prototype pollution vectors (`__proto__`, `constructor`, `prototype`) at lines 67, 81, and 94, immediately throwing an Error with message `prototype pollution vector blocked on line <lineNumber>`.
  - 17 distinct prototype pollution vectors across keys, root tables, nested tables, and array tables were executed against `parsePicoConfig`. Every vector was blocked with an exception; subsequent inspections confirmed `({}).polluted === undefined` and `Object.prototype.polluted === undefined`.
  - Syntax edge cases tested: unterminated quotes, invalid JSON escapes, unquoted values, duplicate keys, table-scalar collisions, nested array tables, non-scalar arrays, and ambiguous PhotoPrism sources. All failed closed with explicit error messages.

### Mandate 2: Timing Safety & Token Comparison in `safeEqual`
- **Source Code Inspected**: `scripts/photoprism-host.mjs:276-281`.
  ```javascript
  function safeEqual(left, right) {
    if (!left || !right) return false;
    const h1 = createHash('sha256').update(String(left)).digest();
    const h2 = createHash('sha256').update(String(right)).digest();
    return timingSafeEqual(h1, h2);
  }
  ```
- **Observed Behavior**:
  - `timingSafeEqual` in Node requires both input buffers to possess identical byte lengths, throwing `RangeError: Input buffers must have the same byte length` if unequal lengths are passed directly.
  - `safeEqual` pre-hashes both `String(left)` and `String(right)` into 32-byte SHA-256 digests (`Buffer.byteLength === 32`) before invoking `timingSafeEqual(h1, h2)`.
  - Tested comparisons across variable string lengths (1 character vs 10,000 characters, 32 characters vs 10,000 characters), non-string types (integers, objects, arrays), and falsy values (`null`, `undefined`, `""`, `0`, `false`, `NaN`). Zero unhandled exceptions or crashes occurred.
  - High-precision timing distribution benchmarking across 5,000 iterations per scenario demonstrated uniform execution latency across varying byte mismatch positions (index 0, index 32, index 63, and length mismatches).

### Mandate 3: Unpinned API Routes, Mutation Methods & Body Lockdowns
- **Source Code Inspected**: `scripts/photoprism-host.mjs:270-274, 315-317, 378-398, 595-600`.
- **Observed Behavior**:
  - `ALLOWED_API_ROUTES` strictly permits only 3 regular expressions: `/^\/api\/v1\/config$/`, `/^\/api\/v1\/photos$/`, `/^\/api\/v1\/t\/[A-Za-z0-9]+\/[A-Za-z0-9._~-]+\/fit_(720|1280)$/`.
  - HTTP mutation methods (`POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`) on `/api/*` endpoints are intercepted at line 379 and rejected with HTTP 403 (`{"error":"this host is display-only: modifications are disabled"}`).
  - Requests carrying a body via `Content-Length > 0` or `Transfer-Encoding: chunked` are intercepted at line 385 and rejected with HTTP 400 (`{"error":"request bodies are not accepted"}`).
  - Probed unpinned thumbnail dimensions (`fit_2048`, `fit_500`, `tile_100`, `tile_500`, `raw`) -> HTTP 403.
  - Probed forbidden upstream routes (`/api/v1/session`, `/api/v1/users`, `/api/v1/albums`, `/api/v1/settings`, etc.) -> HTTP 403.
  - Probed path traversal attempts (`/api/v1/photos/../session`, `/api/v1/config/../users`, `/api/v1/photos/../../etc/passwd`, `/api//v1/config`) -> normalized and rejected (HTTP 403). Double-slash `/api/v1/session` resolves to `/v1/session`, falls through to static history fallback, and returns `index.html` (SPA shell) without contacting upstream PhotoPrism or leaking session endpoints.
  - Directory traversal attacks on static routes (`/../package.json`, `/../../../../etc/passwd`) are blocked by `contained.startsWith('..')` returning HTTP 403 or SPA index fallback.

### Mandate 4: External Non-Loopback Bind Enforcement
- **Source Code Inspected**: `scripts/photoprism-host.mjs:40-51`.
  ```javascript
  const PORT = Number(process.env.PICO_PP_PORT || loadedConfig.config?.http?.port || 8190);
  const HOST = process.env.PICO_PP_HOST || loadedConfig.config?.http?.host || '127.0.0.1';
  const GATEWAY_TOKEN = String(process.env.PICO_PP_AUTH_TOKEN || loadedConfig.config?.http?.auth_token || '');
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

  if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase()) && GATEWAY_TOKEN.length < 24) {
    console.error('ERROR: an external bind requires PICO_PP_AUTH_TOKEN or [http].auth_token with at least 24 characters.');
    process.exit(1);
  }
  ```
- **Observed Behavior**:
  - Tested external binds across `0.0.0.0`, `192.168.1.100`, `10.0.0.1`, `172.16.0.1`, and `203.0.113.1` with empty token -> exit code 1, stderr matching `external bind requires PICO_PP_AUTH_TOKEN`.
  - Tested external binds with 23-character tokens -> exit code 1, stderr matching `external bind requires PICO_PP_AUTH_TOKEN`.
  - Tested external binds with valid ≥24-character token (`123456789012345678901234`) -> host starts up cleanly and serves requests.
  - Tested loopback interfaces (`127.0.0.1`, `::1`, `localhost`, `LOCALHOST`) without tokens -> allowed to start and serve requests cleanly.
  - Tested port validation: invalid ports (`0`, `-1`, `70000`, `abc`, `81.90`) trigger exit code 1 with `invalid listen port`.

### Mandate 5: Full Regression & Invariant Verification
- **Root Unit Tests (`npm test`)**: 58/58 tests passed across all 9 test suites with 0 failures, 0 skipped, 0 cancelled.
- **Static Code Quality (`npm run lint`)**: 0 errors, 0 warnings across all files.
- **Dependency Security Audit (`npm run audit:security`)**: 0 unwaived vulnerabilities across root and frontend lockfiles; verified GHSA-mh99-v99m-4gvg patch compatibility lines.
- **Frontend Vitest Unit Suite (`npm --prefix frontend run test`)**: 77 test files passed, 1,768 test assertions passed.
- **Playwright Headless Browser Smoke Test (`npm --prefix frontend run test:host-smoke`)**: Passed cleanly.

---

## 2. Logic Chain

1. **Parser Robustness**: Because `scripts/config-loader.mjs` validates every identifier against prototype pollution vectors (`__proto__`, `constructor`, `prototype`) and employs strict regex matching for scalar assignments, attackers cannot pollute JavaScript object prototypes or inject arbitrary nested object mutations via crafted TOML configurations.
2. **Timing Attack Resilience**: Because `scripts/photoprism-host.mjs:276-281` hashes both input tokens with SHA-256 into fixed-length 32-byte digests before performing `timingSafeEqual`, input length differences are masked, buffer exception risks are completely mitigated, and execution time remains constant regardless of the position of mismatched bytes.
3. **Gateway Route & Method Containment**: Because `scripts/photoprism-host.mjs` enforces a strict method filter (allowing only `GET` and `HEAD`), rejects any request with a body (`Content-Length` or chunked transfer), and restricts path routing to `ALLOWED_API_ROUTES` (3 pinned regexes), no attacker can trigger state-mutating actions, upload files, access administrative endpoints, or request unpinned thumbnail dimensions.
4. **Network Exposure Protection**: Because `scripts/photoprism-host.mjs` checks `LOOPBACK_HOSTS.has(String(HOST).toLowerCase())` and halts process execution with exit code 1 if `GATEWAY_TOKEN.length < 24`, the host proxy cannot be inadvertently exposed to non-loopback networks without strong gateway authentication.

---

## 3. Caveats

- Verification of hardware-specific DRM/KMS device bindings and seatd daemon integration was validated via canary invariant contracts (`tests/pi-canary.test.mjs`), as this test run was executed on a macOS development environment rather than an ARM Linux target.
- Host startup times under heavy concurrent process spawning on macOS can range from 800ms to 2.5s; test harnesses should account for process bootstrap duration when polling `/api/v1/health`.

---

## 4. Conclusion

All empirical adversarial tests and invariant verifications for Host Proxy, Auth & Parser passed cleanly. No security vulnerabilities, prototype pollution avenues, timing leakages, route bypasses, or bind enforcement flaws were found.

**Final Assessment**: **APPROVE**

---

## 5. Verification Method

To independently verify all findings and reproduce the results, run:

```bash
# 1. Run full root test runner (58 tests across 9 suites)
npm test

# 2. Run static ESLint quality gate (0 warnings, 0 errors)
npm run lint

# 3. Run supply-chain security audit
npm run audit:security

# 4. Run frontend unit and smoke test suites
npm --prefix frontend run test
npm --prefix frontend run test:host-smoke
```

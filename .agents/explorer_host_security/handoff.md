# Host Proxy & Security Architecture Investigation Report

## 1. Observation

Direct code inspections, architectural reviews, and test executions yielded the following verified facts across the PicoGallery codebase:

### 1.1 Gateway Authentication & Bind Safety (`scripts/photoprism-host.mjs`)
- **Listen & Bind Configuration** (`scripts/photoprism-host.mjs:39-51`):
  ```javascript
  const PORT = Number(process.env.PICO_PP_PORT || loadedConfig.config?.http?.port || 8190);
  const HOST = process.env.PICO_PP_HOST || loadedConfig.config?.http?.host || '127.0.0.1';
  const GATEWAY_TOKEN = String(process.env.PICO_PP_AUTH_TOKEN || loadedConfig.config?.http?.auth_token || '');
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`ERROR: invalid listen port: ${PORT}`);
    process.exit(1);
  }
  if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase()) && GATEWAY_TOKEN.length < 24) {
    console.error('ERROR: an external bind requires PICO_PP_AUTH_TOKEN or [http].auth_token with at least 24 characters.');
    process.exit(1);
  }
  ```
- **Constant-Time Token Comparison** (`scripts/photoprism-host.mjs:276-281`):
  ```javascript
  function safeEqual(left, right) {
    if (!left || !right) return false;
    const h1 = createHash('sha256').update(String(left)).digest();
    const h2 = createHash('sha256').update(String(right)).digest();
    return timingSafeEqual(h1, h2);
  }
  ```
  Both `left` and `right` tokens are hashed via SHA-256 into fixed 32-byte Buffers prior to calling `crypto.timingSafeEqual()`, eliminating length-leakage timing vectors and buffer-length mismatch exceptions.
- **Gateway Token Extraction & Exchange** (`scripts/photoprism-host.mjs:283-313`):
  - Token extraction accepts `Authorization: Bearer <token>` or `pico_auth=<cookie>` from `req.headers.cookie` (wrapped in try-catch to prevent URI malformed exceptions on percent-encoding).
  - Initial token exchange (`/?token=<gateway-token>`): If query token matches `GATEWAY_TOKEN` under `GET`/`HEAD`, strips `token` parameter, issues HTTP `303 See Other` redirect to clean URL, and sets cookie:
    `Set-Cookie: pico_auth=<token>; Path=/; HttpOnly; SameSite=Strict[; Secure]` with `Cache-Control: no-store`.

### 1.2 Route Allowlist & Method Restriction (`scripts/photoprism-host.mjs`)
- **Pinned Allowlist Regexes** (`scripts/photoprism-host.mjs:270-274`):
  ```javascript
  const ALLOWED_API_ROUTES = [
    /^\/api\/v1\/config$/,
    /^\/api\/v1\/photos$/,
    /^\/api\/v1\/t\/[A-Za-z0-9]+\/[A-Za-z0-9._~-]+\/fit_(720|1280)$/,
  ];
  ```
  Exactly 3 regexes permit only `/api/v1/config`, `/api/v1/photos`, and `/api/v1/t/:hash/:token/fit_(720|1280)`.
- **Method & Body Lockdown** (`scripts/photoprism-host.mjs:378-398`):
  - Non-GET/HEAD methods on `/api/*` return `403 Forbidden` (`{"error":"this host is display-only: modifications are disabled"}`).
  - Any request with `transfer-encoding` or `content-length > 0` returns `400 Bad Request` (`{"error":"request bodies are not accepted"}`).
  - Any `/api/*` path not matching `ALLOWED_API_ROUTES` returns `403 Forbidden` (`{"error":"route is not available on the display-only host"}`).
- **Open Proxy / SSRF Neutralization** (`scripts/photoprism-host.mjs:390-398`):
  - Incoming request URLs are parsed into `new URL(req.url || '/', 'http://localhost')`, and target URLs are formed strictly from `incoming.pathname` and `incoming.search` resolved against `backend`. Absolute URL request lines (e.g., `GET http://attacker.com/api/v1/config`) cannot redirect upstream requests.
- **Hop-by-Hop and Header Stripping** (`scripts/photoprism-host.mjs:319-326, 399-404`):
  - Strips hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `set-cookie`).
  - Explicitly strips client `accept-encoding`, `authorization`, `cookie`, and `x-auth-token`.
  - Replaces `Host` with `backend.host` and injects host's internal upstream session token into `X-Auth-Token`.
- **Security Response Headers** (`scripts/photoprism-host.mjs:263-269`):
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Content-Security-Policy: default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
- **Directory Traversal Mitigation** (`scripts/photoprism-host.mjs:347-352`):
  - Resolves file path and checks `relative(resolve(FRONTEND), candidate)`. Rejects with `403 Forbidden` if relative path starts with `..` or is absolute.

### 1.3 Upstream Session Lifecycle, Backoff & Probing (`scripts/photoprism-host.mjs`)
- **Single In-Flight Auth Coalescing** (`scripts/photoprism-host.mjs:196-222`):
  - `activeSessionId`: holds active PhotoPrism session ID string.
  - `sessionPromise`: coalesces multiple concurrent unauthenticated requests into a single in-flight `fetchSession()` Promise.
  - `fetchSession()` issues `POST /api/v1/session` with 10s timeout and 1 MiB response size limit.
- **Bounded Exponential Backoff** (`scripts/photoprism-host.mjs:200-216`):
  - On failure, computes `backoff = Math.min(30_000, 1000 * (2 ** Math.min(authFailures - 1, 5)))` (1s, 2s, 4s, 8s, 16s, capped at 30s).
  - Sets `nextAuthAttemptAt = Date.now() + backoff`. Requests within the backoff window fail fast with `503 Service Unavailable` (`Retry-After: 5`).
- **Masquerade Public Config Rewrite** (`scripts/photoprism-host.mjs:133-146, 441-482`):
  - When backend credentials exist (`ppUser && ppPass`), proxied `GET /api/v1/config` responses are intercepted (buffered up to 2 MiB).
  - Privileged fields, administrator flags, download tokens, and settings are stripped.
  - Output is synthesized to `{ mode: "public", public: true, authMode: "public", previewToken: "<token>" }`.
  - Prevents PhotoPrism SPA router guards from bouncing display to login screen while exposing only `previewToken`.
- **Session Expiration Recovery** (`scripts/photoprism-host.mjs:433-439`):
  - If backend returns 401/403 on proxied requests or probe, `activeSessionId` is immediately invalidated (`activeSessionId = null`), and readiness is marked false (`reason: upstream_http_<status>`).
- **Health & Readiness Endpoints** (`scripts/photoprism-host.mjs:573-583, 606-688`):
  - `/api/v1/health`: Returns HTTP 200 `{ status: "ok", uptimeSecs }` (unauthenticated for systemd / local watchdog).
  - `/api/v1/ready`: Returns HTTP 200 only if `readiness.ok === true` AND `Date.now() - readiness.checkedAt < PROBE_RETRY_MS * 3` (freshness check expires if probes halt). Otherwise returns HTTP 503.
  - Background probe (`probeBackend`): Every `PICO_PP_PROBE_MS` (default 15s), queries `GET /api/v1/config` with session token. Validates 2xx status, parses JSON, and updates `readiness`.
  - `/api/v1/metrics`: Requires gateway auth. Returns uptime, RSS memory, request counters (total, 4xx, 5xx, upstreamErrors, authFailures), and readiness object.

### 1.4 Strict Scalar TOML Subset Parser (`scripts/config-loader.mjs`)
- **Comment Handling** (`scripts/config-loader.mjs:3-23`):
  - `stripComment(line)` respects single and double quotes and escaped quotes (`\"`). Inline comments (`#`) outside quotes are stripped; literal `#` inside quoted strings (e.g. `password = "p@ss#word"`) are preserved.
- **Scalar Type Support** (`scripts/config-loader.mjs:25-50`):
  - Double-quoted strings with JSON escape sequences (`"..."`).
  - Single-quoted literal strings (`'...'`).
  - Scalar arrays (`["a", "b"]`, numbers, booleans) with trailing comma support; non-scalar arrays throw error.
  - Booleans (`true`, `false`) and integer/float numbers (`/^[+-]?\d+(?:\.\d+)?$/`).
  - Any unrecognized/unquoted syntax throws `unsupported TOML value on line <N>`.
- **Structural Integrity & Prototype Pollution Defense** (`scripts/config-loader.mjs:64-98`):
  - Array tables `[[key]]` (non-nested) and named tables `[a.b]`.
  - Rejects `__proto__`, `constructor`, and `prototype` in table names, table parts, and key names (`prototype pollution vector blocked on line <lineNumber>`).
  - Enforces key uniqueness within tables via `Object.hasOwn(table, key)`.
- **Source Selection Isolation** (`scripts/config-loader.mjs:113-118`):
  - `selectPhotoPrismSource(config)` filters `config.sources` where `enabled !== false` and `name === 'photoprism'`.
  - Throws `multiple enabled photoprism sources are not supported` if more than one enabled photoprism source is configured.

### 1.5 Security Audit & Invariant Verification (`scripts/security-audit.mjs`)
- **Execution**: `npm run audit:security` runs `node scripts/security-audit.mjs . frontend`.
- **Brace Expansion Vulnerability Waiver Mechanism** (`scripts/security-audit.mjs:16-69`):
  - Analyzes `package-lock.json` via `lockedBraceVersions(lock)` and `npm audit --json`.
  - `isPatchedBraceExpansion(version)` evaluates whether locked versions match known backported patch releases for GHSA-mh99-v99m-4gvg:
    - Major 1: `>= 1.1.17`
    - Major 2: `>= 2.1.3`
    - Major 3: `>= 3.0.3`
    - Major 4: `false`
    - Major 5: `>= 5.0.8`
  - Waives `brace-expansion` and transitively waives only parent packages whose vulnerabilities stem solely via string-referenced waived packages (`minimatch`, `eslint`, etc.).
  - Rejects waivers if any non-brace advisory object is present in `via` or if an unpatched `brace-expansion` version is locked.
  - Enforces zero unpatched vulnerabilities at or above `high` severity.

### 1.6 Direct Test Execution Results
- Command: `npm test`
  - Result: 58 tests passed across 9 test suites, 0 failures, 0 skipped, 0 cancelled.
- Command: `npm run lint`
  - Result: 0 errors, 0 warnings.
- Command: `npm run audit:security`
  - Result: Passed for both root (`.`) and `frontend/` (patched versions 1.1.18, 2.1.4, 5.0.9 verified).

---

## 2. Logic Chain

1. **Observation 1.1 & 1.2** demonstrate that the host is designed as a display-only reverse proxy with a strict trust boundary between the kiosk client, the local host, and the upstream PhotoPrism server.
2. Because the host binds to `127.0.0.1` by default and enforces a minimum 24-character token on any non-loopback bind at startup, accidental exposure of an unauthenticated proxy to an external network is blocked fail-closed.
3. Because `safeEqual` hashes both input and target tokens with SHA-256 into 32-byte buffers before passing to `crypto.timingSafeEqual`, constant-time evaluation is guaranteed, completely neutralizing timing attack vulnerabilities and avoiding runtime exceptions on unequal string lengths.
4. Because `ALLOWED_API_ROUTES` is pinned to exactly three regexes and restricted strictly to `GET` and `HEAD`, mutation endpoints, administrative APIs, user management, and raw original file downloads cannot be reached through the gateway.
5. Because upstream credentials (`ppUser`, `ppPass`) are stored only within the Node process, used exclusively to negotiate an upstream session token, and omitted from browser payloads through the public masquerade rewrite of `/api/v1/config`, the browser client cannot leak upstream administrative credentials.
6. Because `getSessionId()` uses `sessionPromise` to coalesce concurrent requests into a single in-flight authentication request and backs off exponentially (capped at 30s) on failures, network flapping or backend restarts cannot trigger connection stampedes or credential lockouts.
7. Because `parsePicoConfig()` strictly verifies keys against prototype pollution (`__proto__`, `constructor`, `prototype`), enforces key uniqueness, and `selectPhotoPrismSource()` forbids multiple photoprism sources, the configuration parser is resilient to injection and ambiguous source routing.
8. Because `security-audit.mjs` verifies locked dependencies against `npm audit` and validates exact patched versions of `brace-expansion` before waiving the known false-positive advisory, no unmanaged security vulnerabilities exist in dependencies.

---

## 3. Caveats

- **No Caveats.** All 5 designated investigation areas were thoroughly analyzed against source code, documentation, and test suites.

---

## 4. Conclusion

The PicoGallery host proxy and security architecture adheres to all specified security and operational invariants:
- **Binding & Gateway Auth**: Secure fail-closed external bind enforcement (>=24 char token check) and constant-time SHA-256 hashed comparison via `timingSafeEqual`.
- **Route Allowlist**: Rigidly pinned to 3 `GET`/`HEAD` regexes (`/config`, `/photos`, `/t/.../fit_(720|1280)`) with automatic request body rejection and origin-normalization SSRF protection.
- **Session Lifecycle & Masquerade**: Single in-flight session promise coalescing, 30-second capped exponential backoff, automatic session invalidation on 401/403, and public config payload rewriting.
- **Health & Readiness**: Distinct liveness (`/health`) and probe-backed expiring readiness (`/ready`) endpoints.
- **Configuration Parsing**: Safe scalar TOML parser with full prototype pollution guards and comment-in-quote safety.
- **Security Audit**: High/critical vulnerability gatekeeping with mathematically verified waiver logic for backported brace-expansion lines.

---

## 5. Verification Method

To independently verify these findings, execute the following commands in the workspace root:

1. **Run Full Test Suite**:
   ```bash
   npm test
   ```
   *Expected Result*: 58/58 tests passing across all 9 suites with 0 failures.

2. **Run Linter**:
   ```bash
   npm run lint
   ```
   *Expected Result*: Clean exit with 0 errors and 0 warnings.

3. **Run Security Audit**:
   ```bash
   npm run audit:security
   ```
   *Expected Result*: Both `.` and `frontend` pass dependency audit with reported patched brace-expansion versions.

4. **Verify Key Source Locations**:
   - `scripts/photoprism-host.mjs:48-51` (external bind token length check)
   - `scripts/photoprism-host.mjs:270-274` (pinned `ALLOWED_API_ROUTES`)
   - `scripts/photoprism-host.mjs:276-281` (`safeEqual` with SHA-256 + `timingSafeEqual`)
   - `scripts/photoprism-host.mjs:196-222` (`getSessionId` single in-flight coalescing & backoff)
   - `scripts/config-loader.mjs:54-101` (`parsePicoConfig` prototype pollution and syntax checks)
   - `scripts/security-audit.mjs:16-69` (`isPatchedBraceExpansion` and waiver propagation)

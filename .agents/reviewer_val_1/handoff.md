# Reviewer 1 Handoff Report: Core Host, Proxy & Security Invariants

## Review Summary

**Verdict**: **APPROVE**  
**Role**: Reviewer 1 (Core Host, Proxy & Security Invariants Reviewer)  
**Date**: 2026-08-18  
**Scope**: Host proxy security invariants, strict TOML parser defenses, supply-chain security audit, and independent verification test execution.

---

## 1. Observation

Direct code and test observations:

1. **Constant-Time Gateway Token Comparison (`scripts/photoprism-host.mjs:276-281`)**:
   ```javascript
   function safeEqual(left, right) {
     if (!left || !right) return false;
     const h1 = createHash('sha256').update(String(left)).digest();
     const h2 = createHash('sha256').update(String(right)).digest();
     return timingSafeEqual(h1, h2);
   }
   ```
   Both operands are hashed to fixed 32-byte buffers before passing to `crypto.timingSafeEqual()`, preventing length leakage and `RangeError` length mismatch crashes.

2. **Pinned Route Allowlist (`scripts/photoprism-host.mjs:270-274, 315-317`)**:
   ```javascript
   const ALLOWED_API_ROUTES = [
     /^\/api\/v1\/config$/,
     /^\/api\/v1\/photos$/,
     /^\/api\/v1\/t\/[A-Za-z0-9]+\/[A-Za-z0-9._~-]+\/fit_(720|1280)$/,
   ];
   ```
   Only `GET` and `HEAD` methods are permitted (`scripts/photoprism-host.mjs:316`). Mutations (`POST`, `PUT`, `DELETE`) are rejected with `403 Forbidden` (`scripts/photoprism-host.mjs:379-384`). Request bodies (`Transfer-Encoding` or `Content-Length > 0`) are rejected with `400 Bad Request` (`scripts/photoprism-host.mjs:385-389`).

3. **Loopback vs Non-Loopback Bind Enforcement (`scripts/photoprism-host.mjs:40-51`)**:
   ```javascript
   const HOST = process.env.PICO_PP_HOST || loadedConfig.config?.http?.host || '127.0.0.1';
   const GATEWAY_TOKEN = String(process.env.PICO_PP_AUTH_TOKEN || loadedConfig.config?.http?.auth_token || '');
   const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
   ...
   if (!LOOPBACK_HOSTS.has(String(HOST).toLowerCase()) && GATEWAY_TOKEN.length < 24) {
     console.error('ERROR: an external bind requires PICO_PP_AUTH_TOKEN or [http].auth_token with at least 24 characters.');
     process.exit(1);
   }
   ```
   Non-loopback host binds immediately exit with code 1 if token is shorter than 24 characters.

4. **Session Promise Coalescing & 30s Exponential Backoff (`scripts/photoprism-host.mjs:196-222`)**:
   ```javascript
   async function getSessionId() {
     if (!ppUser || !ppPass) return null;
     if (activeSessionId) return activeSessionId;
     if (sessionPromise) return sessionPromise;
     if (Date.now() < nextAuthAttemptAt) throw new Error('upstream authentication backoff is active');

     sessionPromise = (async () => {
       try {
         console.log('[proxy] authenticating upstream');
         const id = await fetchSession();
         activeSessionId = id;
         authFailures = 0;
         nextAuthAttemptAt = 0;
         return id;
       } catch (error) {
         authFailures += 1;
         metrics.authFailures += 1;
         const backoff = Math.min(30_000, 1000 * (2 ** Math.min(authFailures - 1, 5)));
         nextAuthAttemptAt = Date.now() + backoff;
         log('error', 'upstream_auth_failed', { retryMs: backoff, message: error.message });
         throw error;
       } finally {
         sessionPromise = null;
       }
     })();
     return sessionPromise;
   }
   ```
   In-flight session retrieval is shared across concurrent requests. Backoff bounds retries exponentially (1s, 2s, 4s, 8s, 16s, capped at 30s) and fails fast with 503 during active backoff.

5. **Config Masquerade Public Rewriting (`scripts/photoprism-host.mjs:132-146, 441-482`)**:
   ```javascript
   function rewriteAuthPayload(pathname, body) {
     const parsed = JSON.parse(body);
     if (pathname === '/api/v1/config') {
       return JSON.stringify({
         mode: 'public',
         public: true,
         authMode: 'public',
         previewToken: typeof parsed?.previewToken === 'string' ? parsed.previewToken : 'public',
       });
     }
     throw new Error(`unsupported rewrite path: ${pathname}`);
   }
   ```
   Sensitive fields (download tokens, admin settings, session configurations) are discarded; only safe public mode and preview token are forwarded.

6. **Probe-Backed Expiring Readiness (`scripts/photoprism-host.mjs:578-583, 606-688`)**:
   ```javascript
   if (parsedUrl.pathname === '/api/v1/ready') {
     const ready = readiness.ok && Date.now() - readiness.checkedAt < PROBE_RETRY_MS * 3;
     res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
     res.end(JSON.stringify({ status: ready ? 'ok' : 'unavailable', reason: readiness.reason, checkedAt: readiness.checkedAt || null }));
     return;
   }
   ```
   Readiness expires after 45s (`PROBE_RETRY_MS * 3`) without a successful authenticated upstream probe.

7. **TOML Prototype Pollution Defenses & Quote Comments (`scripts/config-loader.mjs:3-23, 64-98`)**:
   - `stripComment()` respects quote boundaries and escape characters, preserving `#` inside strings (`scripts/config-loader.mjs:16-20`).
   - `parsePicoConfig()` explicitly blocks `__proto__`, `constructor`, and `prototype` in table names, dotted sub-tables, and property keys (`scripts/config-loader.mjs:67, 81, 94`).
   - Rejects nested array tables and duplicate keys (`scripts/config-loader.mjs:68, 95-97`).
   - `selectPhotoPrismSource()` enforces single active photoprism source (`scripts/config-loader.mjs:113-118`).

8. **Test Execution Results**:
   - `npm test`: 58 tests passed across 9 suites (0 failures, 0 skipped).
   - `npm run lint`: ESLint exited with code 0 (0 errors, 0 warnings).
   - `npm run audit:security`: Exited with code 0. Confirmed 0 unpatched high/critical vulnerabilities across root and frontend, with patched `brace-expansion` backports validated (`1.1.18`, `2.1.4`, `5.0.9`).

---

## 2. Logic Chain

1. **Cryptographic Invariance**: Observation 1 confirms that `safeEqual` performs SHA-256 digests on both inputs before `timingSafeEqual`. This guarantees equal buffer lengths of 32 bytes and constant-time execution, neutralizing timing side-channel attacks against gateway authentication.
2. **Gateway Lockdown**: Observations 2 and 3 ensure that the host reverse proxy exposes only a minimal read-only surface (`GET`/`HEAD` on 3 specific URL regex patterns) and forbids external exposure without a high-entropy gateway token (≥ 24 chars).
3. **Upstream Session Resilience**: Observation 4 demonstrates that upstream authentication requests are deduplicated via a shared promise and throttled with exponential backoff capped at 30s, preventing upstream auth storm/thundering herd failures.
4. **Credential Isolation**: Observation 5 confirms that upstream credentials never reach the browser client. The host proxies authenticated calls and rewrites `/api/v1/config` to synthetic public mode, retaining only the preview token for rendering.
5. **Dynamic Readiness**: Observation 6 ensures that `/api/v1/ready` reflects actual, recent upstream reachability rather than static process uptime.
6. **Parser Robustness**: Observation 7 confirms that TOML configuration parsing is protected against object prototype pollution vectors and syntax ambiguities.
7. **Integrity & Verification**: Observation 8 confirms that all test suites, static analysis checks, and security audit verifications pass cleanly with genuine logic and zero artificial shortcuts or facade mocks.

---

## 3. Adversarial Challenge & Stress Test Results

### Challenge Summary
**Overall risk assessment**: **LOW**

### Challenges Evaluated:
1. **Timing Attack on Gateway Auth**:
   - *Assumption*: Gateway token comparison could leak secret length.
   - *Result*: Pre-hashing via SHA-256 ensures fixed 32-byte buffer comparison regardless of input lengths. **PASS**.
2. **SSRF via Absolute URL Request Target**:
   - *Assumption*: Requesting `GET http://attacker.com/api/v1/config` might cause the proxy to connect to an external server.
   - *Result*: `scripts/photoprism-host.mjs:392-393` extracts strictly `pathname` and `search` and creates a URL against `backend`, discarding incoming scheme and host. **PASS**.
3. **HTTP Method / Mutation Bypasses**:
   - *Assumption*: An attacker might try `POST`, `PUT`, `DELETE`, or chunked uploads to modify upstream PhotoPrism data.
   - *Result*: Blocked at lines 379-389 with 403 / 400 responses. **PASS**.
4. **Prototype Pollution via Malicious TOML**:
   - *Assumption*: Malicious `.toml` keys like `[__proto__]` or `constructor = "evil"` could alter JavaScript `Object.prototype`.
   - *Result*: Strict checks in `scripts/config-loader.mjs` throw explicit errors blocking all vector keys. **PASS**.
5. **Readiness Flapping / Stale Retention**:
   - *Assumption*: The server might claim readiness long after PhotoPrism dies.
   - *Result*: Readiness timestamp check expires after `PROBE_RETRY_MS * 3` (45s), automatically switching `/api/v1/ready` to HTTP 503. **PASS**.

---

## 4. Integrity Attestation

- **No Hardcoded Test Results**: Implementation files (`photoprism-host.mjs`, `config-loader.mjs`, `security-audit.mjs`) contain genuine domain logic and dynamic handling.
- **No Facade Implementations**: Real HTTP/HTTPS sockets, real streaming pipelines, genuine cryptographic operations, and strict regex parsers are implemented.
- **No Shortcuts / External Delegations**: All security controls are enforced in first-party code.
- **No Fabricated Logs**: Independent executions of `npm test`, `npm run lint`, and `npm run audit:security` completed with exit code 0.

---

## 5. Caveats

- Hardware-level DRM/KMS buffer settling and WebKit rendering are tested in end-to-end device integration suites (covered by Sentinel/Challengers on target architecture).
- Upstream PhotoPrism backend must be configured with a dedicated viewer account per security architecture recommendations.

---

## 6. Conclusion

The core host proxy, security invariants, TOML configuration parser, and dependency audit mechanisms strictly meet all security and functional requirements specified in `PROJECT.md`, `AGENTS.md`, and `ORIGINAL_REQUEST.md`.

**Verdict**: **APPROVE**

---

## 7. Verification Method

To independently verify all findings:

```bash
# 1. Run root test suites (58 tests across 9 suites)
npm test

# 2. Run ESLint zero-warning gate
npm run lint

# 3. Run supply-chain security audit
npm run audit:security
```

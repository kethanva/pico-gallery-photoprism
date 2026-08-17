# E2E Test Infra: PicoGallery PhotoPrism Appliance

## Test Philosophy
- **Requirement-Driven & Opaque-Box**: Derived from `ORIGINAL_REQUEST.md`, `AGENTS.md`, and system security invariants. Exercises the appliance through public HTTP endpoints, CLI test runners, process boundaries, and browser engines.
- **Methodology**: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- **Progressive Testability**: Verification does not rely on internal modules; test suites run cleanly on local development environments (macOS/Linux) and embedded hardware (Raspberry Pi).

## Feature Inventory Coverage

| # | Feature | Source (Requirement) | Tier 1 (Feature Coverage) | Tier 2 (Boundary & Corner) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|---------------------|:-------------------------:|:--------------------------:|:----------------------:|:-------------------:|
| 1 | Fail-Closed Non-Loopback Startup | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 2 | Constant-Time safeEqual SHA-256 | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 3 | Gateway Token Exchange & Cookie Strip | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 4 | Pinned ALLOWED_API_ROUTES | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 5 | Request Method & Body Lockdown | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 6 | SSRF & Origin Normalization | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 7 | Hop-by-Hop & Header Stripping | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 8 | Security Response Headers | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 9 | Single In-Flight Auth Coalescing | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 10 | Bounded Exponential Backoff | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 11 | Public Config Masquerade Rewrite | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 12 | Session Invalidation on 401/403 | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 13 | Health Endpoint | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 14 | Expiring Readiness Endpoint | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 15 | Authenticated Metrics Endpoint | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 16 | Directory Traversal Mitigation | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 17 | SPA History Fallback | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 18 | Service Worker Unregister Stub | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 19 | Structural TOML Scalar Parsing | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 20 | Prototype Pollution Defense | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 21 | PhotoPrism Source Selection | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 22 | Kiosk TOML Override Extraction | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 23 | Shared Profile Resolution | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 24 | Parameter Bounds Clamping | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 25 | Minimal Plain-DOM Display App | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 26 | Virtualized Grid Rendering | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 27 | Background Grid Image Suspension | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 28 | Slideshow Scheduler & Prefetch | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 29 | Multi-Input Action Binding | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 30 | Cog/Cage Launcher & Seatd | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 31 | Daily WebKit Recycling | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 32 | Root Node Test Runner (58 Tests) | ORIGINAL_REQUEST §1, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 33 | ESLint Zero-Warning Enforcement | ORIGINAL_REQUEST §2, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 34 | Dependency Security Audit Engine | ORIGINAL_REQUEST §3, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 35 | Frontend Vitest Test Suite | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 36 | Playwright E2E Host Smoke Test | ORIGINAL_REQUEST §4, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 37 | Post-Reboot Canary Invariants | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 38 | 5-Layer Blank Screen Diagnostics | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |
| 39 | Production Installer Sandboxing | ORIGINAL_REQUEST §5, AGENTS.md | 5 | 5 | ✓ | ✓ |

---

## Test Architecture
- **Root Unit/Integration Test Runner**: `npm test` (invoking `node --test tests/**/*.test.mjs`), executing all 9 test suites.
- **Linter Gate**: `npm run lint` (`eslint scripts tests --max-warnings 0`).
- **Security Audit Gate**: `npm run audit:security` (`node scripts/security-audit.mjs . frontend`).
- **Frontend E2E Smoke Runner**: `npm --prefix frontend run test:host-smoke` (Playwright headless Chromium).
- **Frontend Component/Unit Runner**: `npm --prefix frontend run test` (Vitest).
- **Diagnostics Verification**: Direct execution assertions in `tests/tests/pi-canary.test.mjs` and `tests/tests/install-contract.test.mjs`.

---

## Real-World Application Scenarios (Tier 4)

| # | Scenario | Features Exercised | Target Verification |
|---|----------|--------------------|---------------------|
| 1 | Cold Appliance Boot & Gateway Auth | F1, F3, F13, F14, F17, F20, F25, F36 | Live token exchange via cookie, public config masquerade rewrite, index.html boot, zero console errors |
| 2 | High-Concurrency Upstream Session Stampede | F2, F9, F10, F12, F14, F15 | 100 concurrent requests during backend cold start coalesce into single auth session without 500 crashes |
| 3 | Memory-Constrained Long Running Slideshow | F24, F25, F26, F27, F28, F31 | Continuous slideshow cycling deallocates off-screen grid thumbnails, bounds DOM to ~40 cards, and survives 24h cycle |
| 4 | Malicious Input & Attack Injection | F2, F4, F5, F6, F7, F8, F16, F20 | Path traversals, prototype pollutions (`__proto__`), unpinned thumbnail sizes, non-GET mutations, and SSRF hosts rejected fail-closed |
| 5 | Post-Reboot Production Invariant Audit | F32, F33, F34, F37, F38, F39 | Automated canary and installer contracts assert systemd units, permissions, sandboxing, and patched dependencies |

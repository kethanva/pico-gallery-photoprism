# Orchestration Plan: PicoGallery PhotoPrism Validation & Verification

## Objective
Execute complete validation, stress testing, and verification of the PicoGallery PhotoPrism appliance across host proxy, configuration parsing, frontend virtualization, and kiosk layers per all requirements in ORIGINAL_REQUEST.md.

## Acceptance Criteria
1. Root Node test runner (`npm test`) passes with 58/58 passing tests across all 9 suites with 0 failures.
2. ESLint validation (`npm run lint`) reports 0 errors and 0 warnings.
3. Security audit suite (`npm run audit:security`) executes and confirms 0 unwaived vulnerabilities across root and frontend.
4. Frontend test suites (`npm run test` & `npm run test:host-smoke` in `frontend/`) pass cleanly.
5. All security & operational invariants are validated (safeEqual() constant-time SHA-256 comparison, ALLOWED_API_ROUTES pinning, credential protection, git status clean & synced).

## Step-by-Step Plan
1. **Step 0: Initial Survey (Exploration)**
   - Spawn 3 parallel explorers / spec miners to survey:
     - Explorer 1 (Host Proxy & Security Invariants): `scripts/photoprism-host.mjs`, `scripts/config-loader.mjs`, `config/kiosk-config-core.mjs`, security tests.
     - Explorer 2 (Frontend Virtualization & Kiosk): `frontend/src/minimal-photo-app.js`, `frontend/src/kiosk-config.js`, `kiosk/cog/`, frontend tests.
     - Explorer 3 / Spec Miner (Test Suites, Invariants & Diagnostics): Root tests, security audits, pi-canary, pi-e2e-diagnose, install contracts.
2. **Step 1: Feature Inventory & Architecture Synthesis**
   - Synthesize survey findings into `PROJECT.md` with Feature Inventory, Milestones, and Interface Contracts.
3. **Step 2: Dual Track Validation Execution**
   - Track 1 (Implementation & Target Testing): Validate and ensure all 58 root tests, frontend tests, ESLint, and security audits pass.
   - Track 2 (E2E & Stress Testing): Build comprehensive multi-tier test cases and stress verifications.
4. **Step 3: Forensic Audit & Review**
   - Reviewers, Challengers, and Forensic Auditor verify integrity and correctness.
5. **Step 4: Completion & Final Reporting**
   - Synthesize final findings and deliver completion report to caller.

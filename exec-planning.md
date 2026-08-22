# exec-planning.md — Execution Source of Truth

> Governed by `AGENTS.md` (master meta prompt) and the loop-engineering-kit
> execution contract. Every iteration: pick the highest-priority bounded
> incomplete item, verify dependencies, implement minimum change, verify,
> update this file.

## Loop budgets (default)

```yaml
max_iterations: 5
max_repairs: 2
max_consecutive_no_progress: 2
token_budget: medium
cost_budget: zero-spend
wall_clock_budget_seconds: 1800
terminal_on: [SHIPPED, BLOCKED, HANDOFF, BUDGET_EXHAUSTED, POLICY_VIOLATION, FAILED]
```

## Work items

Format per AGENTS.md §32:
ID | Priority | Status | Dependencies | Scope | Acceptance Criteria | Tests | Security Considerations | Documentation Changes

Statuses: `TODO` → `IN_PROGRESS` → `REVIEW` → `DONE` | `BLOCKED` | `CANCELLED`

---

### FND-1 — Monorepo scaffold + contracts package

- **ID:** FND-1
- **Priority:** P0
- **Status:** DONE
- **Dependencies:** none
- **Scope:** npm-workspaces monorepo matching the §2 directory skeleton
  (minimal, empty placeholders where needed); root tooling: TypeScript,
  ESLint-config-ready, vitest; `packages/contracts` with zod schemas for the
  first domain entities (`Organization`, `User`, `Role`, `AuditEvent`) and a
  versioned `PlatformCapability` type; `apps/api` health endpoint wired to
  contracts; CI workflow file running lint+typecheck+test; ADR-0001 (monorepo
  layout) and ADR-0002 (contracts-first design).
- **Acceptance criteria:**
  1. `npm install` succeeds from repo root.
  2. `npm run build`, `npm run lint`, `npm run test` all pass.
  3. `GET /health` on apps/api returns `{ status: "ok" }`.
  4. Contracts export typed schemas validated by at least one unit test each.
  5. No secrets committed; `.gitignore` covers env/node_modules/dist.
- **Tests:** contract schema unit tests; api health route integration test.
- **Security Considerations:** no provider tokens; strict TS; dependency
  versions pinned via lockfile.
- **Documentation Changes:** add ADR-0001/ADR-0002 under `docs/adr/`; update
  README stub.

### FND-2 — Database layer (packages/db) + migrations

- **ID:** FND-2
- **Priority:** P0
- **Status:** DONE
- **Dependencies:** FND-1
- **Scope:** Postgres client wrapper, migration runner, initial migrations for
  organizations/users/roles/audit_log, tenant-isolation helpers.
- **Acceptance criteria:** migrations up/down cleanly on a local Postgres;
  repository functions covered by integration tests; org-scoping enforced in queries.
- **Tests:** integration tests against disposable DB (docker or embedded).
- **Security Considerations:** parameterized queries only; least-privilege DB roles documented.
- **Documentation Changes:** docs/architecture/data-model.md stub.

### FND-3 — Auth service + RBAC

- **ID:** FND-3
- **Priority:** P0
- **Status:** DONE
- **Dependencies:** FND-2
- **Scope:** session auth, password hashing (argon2), RBAC middleware,
  audit-log writes on auth events. OAuth/OIDC deferred to FND-7.
- **Acceptance criteria:** register/login/logout flows tested; RBAC denies
  cross-org access (isolation tests).
- **Tests:** unit + integration incl. tenant-isolation cases.
- **Security Considerations:** argon2id; httpOnly secure cookies; CSRF protection; rate limiting on auth routes.
- **Documentation Changes:** SECURITY.md initial draft.

### FND-7 — OAuth/OIDC federation

- **ID:** FND-7
- **Priority:** P2
- **Status:** DONE
- **Dependencies:** FND-3
- **Scope:** OIDC authorization-code flow with PKCE S256 (Google shape +
  generic issuer via discovery), HMAC-signed single-use state + nonce,
  id_token RS256 verification against JWKS (node:crypto, zero new deps),
  account find-or-link via `user_identities` (migration 0003), session
  issuance identical to local auth, in-test mock OIDC provider contract tests.
- **Acceptance criteria:** full browser-flow roundtrip tested against mock
  provider (no real external calls); state/nonce/PKCE validated; tampered,
  replayed, expired, wrong-audience tokens rejected without session issuance.
- **Tests:** unit (PKCE/state/JWKS) + 7-test HTTP contract suite.
- **Security Considerations:** PKCE S256; state+nonce; JWT verified vs JWKS,
  never trusted decode; dev-only default secrets documented in SECURITY.md;
  in-memory pending-flow store is single-process (see BK-4/hardening).
- **Documentation Changes:** SECURITY.md OAuth/OIDC section.

### FND-4 — Queue abstraction

- **ID:** FND-4
- **Priority:** P0
- **Status:** DONE
- **Dependencies:** FND-2
- **Scope:** `packages/events`: transport-agnostic queue/event-bus interface
  (`publish(event)`, `subscribe(pattern, handler)`, close); in-process
  implementation with retry/backoff + capped DLQ; typed domain events
  (all AGENTS.md §20 events) as zod discriminated union validated on publish
  AND consume. ack/nack and durable transports deferred to the durable adapter
  work item (see BK-2).
- **Acceptance criteria:** in-memory bus passes unit tests incl. retry →
  dead-letter path; every §20 domain event validates against its schema; no
  transport-specific logic leaks into consumers.
- **Tests:** unit (publish/subscribe/retry/DLQ); contract test for all §20 events.
- **Security Considerations:** payloads schema-validated on consume; no
  secrets in payloads; orgId/actor fields required where applicable.
- **Documentation Changes:** ADR-0004 (in-process bus now, Kafka/NATS-compatible later).

### FND-5 — Object storage adapter

- **ID:** FND-5
- **Priority:** P1
- **Status:** DONE
- **Dependencies:** FND-1
- **Scope:** `packages/storage` port + local-filesystem adapter;
  S3-compatible adapter shape (client injected, not required); API:
  put/get/delete/stat/exists (signed URLs deferred — see BK-3); MIME sniffing on put; size limits.
- **Acceptance criteria:** local adapter passes integration tests (roundtrip,
  delete, oversize reject, mime mismatch handling); interface stable for S3 swap.
- **Tests:** integration against temp dir; unit for MIME/size guards.
- **Security Considerations:** path traversal prevention (key sanitization),
  MIME verification, size caps, non-world-readable file defaults.
- **Documentation Changes:** ADR-0005 (storage port).

### FND-6 — Observability baseline

- **ID:** FND-6
- **Priority:** P1
- **Status:** DONE
- **Dependencies:** FND-1
- **Scope:** `packages/observability`: structured JSON logger (pino),
  request-log middleware for apps/api (replaces console.log), field redaction,
  OpenTelemetry wrapper hooks (opt-in), timing helper for AI cost tracking later.
- **Acceptance criteria:** auth routes emit structured JSON logs without
  tokens/passwords; OTel wrapper compiles and is opt-in via env.
- **Tests:** unit for logger redaction; request-log snapshot test.
- **Security Considerations:** default redaction of password/token/cookie fields.
- **Documentation Changes:** docs/architecture/observability.md stub.

### AFF-1 — Affiliate core domain model

- **ID:** AFF-1
- **Priority:** P0
- **Status:** DONE
- **Dependencies:** FND-2
- **Scope:** Normalized affiliate slice per AGENTS.md §3: migration 0006
  (affiliate_providers, merchants, products, offers, campaigns,
  affiliate_links, conversions with idempotent ingestion + partial unique
  indexes), org-scoped parameterized repos, contracts schemas incl. campaign
  transition validation and commission constraints.
- **Acceptance criteria:** lifecycle provider→merchant→product→offer→link→conversion
  tested; duplicate conversion ingest returns same row once; cross-org reads
  isolated; expired links unresolved; illegal campaign transitions rejected.
- **Tests:** 31 affiliate schema tests + integration suite on scratch DB.
- **Security Considerations:** parameterized SQL only; org-scoping enforced; slug uniqueness typed error.
- **Documentation Changes:** data-model.md migration-numbering note.

### FND-8 — Account recovery (service layer)

- **ID:** FND-8
- **Priority:** P1
- **Status:** DONE
- **Dependencies:** FND-3
- **Scope:** Migration 0005 (recovery_tokens + users.email_verified); email
  verification + password reset service functions: single-use SHA-256 tokens,
  race-safe claims, session invalidation on reset, anti-enumeration reset
  requests (uniform 429 via bucket-before-lookup), EmailSender port +
  NoopEmailSender; HTTP wiring deliberately deferred.
- **Acceptance criteria:** verify/reset flows tested incl. replay, expiry,
  wrong-purpose, concurrency (exactly-one-wins), rate guard, audit events;
  ghost-email rate-limit symmetry regression-tested.
- **Tests:** 7+ integration tests on disposable DB.
- **Security Considerations:** raw tokens never logged/stored hashed; no existence oracle.
- **Documentation Changes:** none yet (routes doc when wired).

### SEC-1 — OAuth security hardening

- **ID:** SEC-1
- **Priority:** P0
- **Status:** DONE
- **Dependencies:** FND-7
- **Scope:** Redirect-host allowlist + APP_BASE_URL-derived redirect_uri
  (Host-header trust removed); collision-proof `@oidc.invalid` synthetic
  identity emails; state single-use confirmed + regression test; SECURITY.md
  OAuth hardening section.
- **Acceptance criteria:** attacker Host → 400 untrusted_host; redirect_uri never Host-derived when APP_BASE_URL set; replay rejected.
- **Tests:** 9-test oauth.security suite + existing contract suites green.
- **Security Considerations:** documented residual: port-insensitive host match; multi-instance flow store still pending.
- **Documentation Changes:** SECURITY.md.

---

### BK-3 — Signed-URL support for storage port

- **ID:** BK-3
- **Priority:** P2
- **Status:** DONE
- **Dependencies:** FND-5
- **Scope:** `signedUrl(key, {ttl})` on the StorageAdapter port; local adapter
  HMAC-signed URL handler; S3 adapter maps to native presigned URLs.
- **Acceptance criteria:** expired/tampered URLs rejected; tests per adapter.
- **Tests:** unit + integration.
- **Security Considerations:** HMAC with secret from env/secret manager; short TTL defaults.
- **Documentation Changes:** ADR-0005 update.

### BK-4 — Migration shape assertions + production wiring hardening

- **ID:** BK-4
- **Priority:** P1
- **Status:** DONE
- **Dependencies:** FND-2, FND-3, FND-7
- **Scope:** Post-migration schema shape assertion (drift detection — 0003's
  `IF NOT EXISTS` can silently adopt divergent tables); wire authService into
  apps/api production entrypoint (bare boot currently serves /health only);
  shared resetSchema across integration suites drops all tables incl. user_identities.
- **Acceptance criteria:** migrator fails loudly on schema drift; bare server
  boot serves auth routes; full suite green without IF-NOT-EXISTS tolerance.
- **Tests:** drift-detection unit test; smoke test of wired entrypoint.
- **Security Considerations:** drift could silently drop constraints (UNIQUE) — fail closed.
- **Documentation Changes:** runbook note on migrations.

## Changelog of this file

| Date       | Change                                        |
| ---------- | --------------------------------------------- |
| 2026-08-21 | Initial plan created; FND-1..FND-3 defined.   |
| 2026-08-21 | FND-1 executed, independently verified (PASS), repairs applied (build hardened with `tsc -b --force` + clean script; `*.tsbuildinfo` gitignored); marked DONE. Backlog added: BK-1 vitest v4 upgrade. |
| 2026-08-21 | FND-2 executed, independently verified (PASS): migrations up/down/idempotent on real DB, tenant isolation proven independently, zero injection surface; repairs applied (status flip, least-privilege roles doc). Next: FND-3. |
| 2026-08-21 | FND-3 executed (argon2id sessions auth, RBAC matrix, CSRF header, login rate limit, audit events, SECURITY.md), independently verified PASS via live HTTP probing (59/59 tests); marked DONE. Deferred: OAuth/OIDC (FND-7), email verification/reset, distributed rate limiter. |
| 2026-08-22 | FND-4 detailed + executed (`packages/events` in-memory bus, §20 domain events, retry+DLQ, publish/consume validation), independently verified PASS (77/77 tests + independent probes); marked DONE. Backlog added: BK-2 durable queue adapter (ack/nack, Redis Streams/Kafka-class). Next: FND-5. |
| 2026-08-22 | FND-5 executed (`packages/storage`: LocalFs + injected-S3 adapters, traversal-safe keys, MIME sniffing, size caps), independently verified PASS (134/134 tests + 33/33 independent security probes); marked DONE; CHANGELOG.md created; BK-3 signed URLs added. Next: FND-6. |
| 2026-08-22 | FND-6 executed (`packages/observability`: pino JSON logging w/ redaction, request logs, opt-in OTel via optional peerDeps, timer helper; wired into apps/api), independently verified PASS (148/148 tests + live leak-probe of auth routes); marked DONE. Phase 1 infra complete. Next: FND-7. |
| 2026-08-22 | Parallel 3-agent iteration: FND-7 (OIDC+PKCE, mock-provider contract tests, JWKS RS256 verify), BK-1 (vitest ^4.1.11, npm audit 5→0 vulns), BK-3 (HMAC signed URLs + verifySignedRequest) executed and independently verified PASS (197/197 tests, live OAuth security probes 29/29). All defined work items DONE. Backlog added: BK-4 migration shape assertion; tracked: prod wiring of authService in apps/api entrypoint. Phase 2 detailing next. |
| 2026-08-22 | Docs iteration: THREAT-MODEL/PRIVACY/COMPLIANCE/CONTRIBUTING.md authored from code evidence; surfaced OAuth Host-trust, limiter-eviction, synthetic-email, dev-secret-guard gaps → SEC-1 + BK-4 scope. |
| 2026-08-22 | Parallel 4-agent batch executed: BK-4 (drift detection w/ schema fingerprints, prod auth wiring fail-fast DATABASE_URL, dev-secret boot guard, limiter expired-only eviction), BK-2 (RedisStreamsEventBus at-least-once, XAUTOCLAIM reclaim, capped DLQ streams, withIdempotency dedupe, contract parity both adapters), FND-8 (account recovery service layer, race-safe single-use tokens, anti-enumeration uniform 429), SEC-1 (Host allowlist, APP_BASE_URL redirect_uri, @oidc.invalid synthetic emails, state single-use), AFF-1 (affiliate core domain: 0006 migration, 7 org-scoped repos, contracts schemas). Verifier found blocker D1 (contracts barrel TDZ cycle crashing built artifacts node-first) → repaired via capabilities.ts extraction + regression guard; D2 numbering note; R1 ghost-email rate symmetry fixed. Re-verified: CONTRACTS_BOOT_OK, plain-node API boot /health 200, 299/299 tests. |

## Backlog

### BK-1 — Upgrade vitest 2.x → 4.x to clear npm audit findings

- **ID:** BK-1
- **Priority:** P2
- **Status:** DONE
- **Dependencies:** none
- **Scope:** Major-upgrade dev test chain (esbuild/vite/vitest GHSA-67mh-4wv8); dev-only exposure.
- **Acceptance criteria:** `npm audit` reports no high/critical; all tests still pass.

### BK-2 — Durable queue adapter

- **ID:** BK-2
- **Priority:** P2
- **Status:** DONE
- **Dependencies:** FND-4
- **Scope:** Redis Streams or Kafka/NATS-class adapter behind the EventBus
  port; at-least-once delivery + ack/nack + idempotent consume for money-path
  events (ConversionRecorded/CommissionRecorded); document `timer.unref`
  behavior for standalone bus use.
- **Acceptance criteria:** adapter passes same contract tests as in-memory bus;
  money-path events survive process restart (integration).
- **Tests:** contract suite reuse + restart-survival integration.
- **Security Considerations:** no secrets in payloads; consumer auth on the broker.
- **Documentation Changes:** ADR update.

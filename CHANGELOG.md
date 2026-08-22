# CHANGELOG.md

All notable changes to this project. Format based on Keep a Changelog.

## [0.1.0] — 2026-08-22 (unreleased working tree)

### Added — Phase 1 Foundation

- **FND-1** npm-workspaces monorepo scaffold; `packages/contracts` (zod:
  Organization, User/RBAC roles, AuditEvent, PlatformCapability ×10,
  ProviderCapabilityMatrix, auth schemas); zero-dep `apps/api` with
  `GET /health`; CI (lint→typecheck→build→test); ADR-0001/0002.
- **FND-2** `packages/db`: postgresjs client, SQL migration runner
  (idempotent up/down + `schema_migrations`), 0001_init schema
  (organizations/users/audit_log), org-scoped repositories,
  `assertOrgScope` tenancy helper; disposable dev Postgres on :5433;
  ADR-0003; data-model docs.
- **FND-3** `services/auth`: Argon2id passwords, hashed session tokens,
  RBAC matrix (viewer/member/admin/owner), CSRF header check, login rate
  limiting, audit events on auth flows; HTTP routes in apps/api with
  httpOnly/SameSite cookies; SECURITY.md threat-model-lite.
- **FND-4** `packages/events`: transport-agnostic EventBus port,
  in-memory implementation with exponential-backoff retry and capped DLQ,
  all 14 §20 domain events as validated zod discriminated union (validated
  on publish and consume); ADR-0004.
- **FND-5** `packages/storage`: StorageAdapter port; LocalFsStorageAdapter
  (traversal-safe keys, MIME sniffing, size caps, 0600 files);
  S3-compatible adapter over injected client; ADR-0005.
- **FND-6** `packages/observability`: pino structured JSON logging with
  field redaction, request logs (pathname-only), opt-in OpenTelemetry wrapper,
  timing helper; wired into apps/api.
- **FND-7** OAuth/OIDC: authorization-code flow with PKCE S256, HMAC-signed
  single-use state + nonce, RS256 id_token verification against JWKS via
  node:crypto (zero new deps), `user_identities` account linking (migration
  0003), mock-provider HTTP contract test suite; SECURITY.md OAuth section.
- **BK-3** Signed URLs: `signedUrl()` + `verifySignedRequest()` (HMAC-SHA256,
  constant-time compare, TTL) on the storage port; S3 presign delegation.

### Changed

- **BK-1** vitest ^2.1.8 → ^4.1.11 (vite 8 chain); Node engines >=20.19;
  CI on Node 22; `npm audit` findings 5 → 0.

### Added — hardening & affiliate core

- **BK-4** Migration drift detection (schema fingerprints, fail-closed);
  production auth wiring (fail-fast DATABASE_URL); dev-secret boot guard;
  rate-limiter expired-only eviction.
- **BK-2** `RedisStreamsEventBus`: at-least-once delivery via Redis Streams
  (consumer groups, XAUTOCLAIM reclaim, capped DLQ streams), restart survival,
  `withIdempotency` dedupe store; shared behavioral contract suite across both buses.
- **FND-8** Account recovery service layer: email verification + password reset,
  single-use hashed tokens, race-safe claims, session invalidation,
  anti-enumeration uniform rate limiting.
- **SEC-1** OAuth hardening: redirect-host allowlist + APP_BASE_URL-derived
  redirect_uri, `@oidc.invalid` synthetic identity emails, state single-use.
- **AFF-1** Affiliate core domain: migration 0006 (providers, merchants,
  products, offers, campaigns, links, conversions) with org-scoped repos,
  idempotent conversion ingestion, campaign transition validation.
- **Docs** THREAT-MODEL.md, PRIVACY.md, COMPLIANCE.md, CONTRIBUTING.md.

### Added — Phase 2 completion

- **AFF-2** `/go/{slug}` redirect service: 302 w/ UTM merge, fire-and-forget
  click recording (migration 0007 — hashed-truncated IPs, never raw),
  ClickRecorded domain events, RBAC-guarded org clicks listing.
- **AFF-3** Campaign/link/conversion HTTP APIs (RBAC + CSRF + legal-transition
  validation) and HMAC-SHA256 signed webhook ingestion with ±300s replay
  window, constant-time compare, and idempotent dedupe.
- **ADT-1** `packages/platform-adapters`: versioned PlatformPolicyRegistry,
  capability-gated BasePlatformAdapter, TikTok Shop / Shopee / Meta / YouTube
  skeletons with deterministic request signing (injected fetch + getSecret);
  contract-parity test against PlatformCapability.

### Fixed

- Prod wiring: linkRoutes now receives authService (clicks endpoint 503 → 401).
- Fail-closed guard extended to CLICK_SALT + WEBHOOK_INGEST_SECRET dev defaults.

### Fixed

- **D1** Circular-import TDZ in `@zaff/contracts` barrel crashing built
  artifacts under plain node (`capabilities.ts` extraction + module-graph
  regression guard).
- **FND-6** `packages/observability`: pino structured JSON logging with
  default redaction (password/token/sessionToken/cookie/authorization/
  set-cookie → `[Redacted]`, nested to 3 levels), `logRequest` /
  `requestLogMiddleware` helpers wired into apps/api (pathname-only URLs,
  x-request-id passthrough/generation), opt-in OTel wrapper
  (`OTEL_EXPORTER_OTLP_ENDPOINT`; optional peer deps, dynamic import,
  fail-open no-op), `startTimer` helper for future AI cost tracking;
  docs/architecture/observability.md.

### Verification

Each work item independently verified (executor ≠ verifier): full gates
re-run from scratch, live security probing (tenant isolation, CSRF, rate
limit, traversal matrix, MIME mismatch, OAuth state/nonce/PKCE tampering,
signed-URL tamper suite), migrations proven on real scratch databases.
Final suite: 26 files / 197 tests passing; `npm audit` clean.

### Security

- Parameterized SQL everywhere; migrator DDL restricted to repo-owned files.
- No raw tokens/passwords logged or stored (sessions store SHA-256 hashes).
- Key allowlist + magic-byte MIME enforcement in storage layer.

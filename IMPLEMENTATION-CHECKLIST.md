# IMPLEMENTATION-CHECKLIST.md

Mirrors `exec-planning.md` (the execution source of truth). Statuses:
- [x] DONE (independently verified) · [ ] TODO · [~] IN_PROGRESS/BLOCKED (note why)

## Phase 0 — Discovery
- [x] Repository assessment (greenfield)
- [x] Loop-engineering-kit agents+skills installed (`.opencode/`)
- [x] ROADMAP.md + exec-planning.md created

## Phase 1 — Foundation
- [x] FND-1 Monorepo scaffold + packages/contracts (+CI, ADR-0001/0002)
- [x] FND-2 packages/db: migrator, orgs/users/audit_log, tenant-scoped repos (ADR-0003)
- [x] FND-3 services/auth: argon2id sessions, RBAC, CSRF, rate limit, audit; SECURITY.md
- [x] FND-4 packages/events: EventBus port, in-memory bus, §20 domain events, retry+DLQ (ADR-0004)
- [x] FND-5 packages/storage: LocalFs adapter, traversal-safe keys, MIME sniffing, S3 shape (ADR-0005)
- [x] FND-6 packages/observability: pino JSON logs + redaction, request logs, opt-in OTel
- [x] FND-7 OAuth/OIDC: PKCE S256, signed state+nonce, JWKS RS256 verify, account linking
- [x] BK-1 vitest ^4.1.11 upgrade — npm audit 5 → 0 vulnerabilities

## Phase 2 — Affiliate Core (in progress)
- [x] AFF-1 Affiliate core domain model (migration 0006, org-scoped repos, contracts)
- [x] ADT-1 Adapter framework + policy registry + TikTok/Shopee/Meta/YouTube gated skeletons
- [x] AFF-2 `/go/{slug}` redirect + hashed-IP click attribution
- [x] AFF-3 Campaign APIs + signed idempotent webhook ingestion

## Foundation extras
- [x] FND-8 Account recovery service layer (HTTP wiring pending)
- [x] SEC-1 OAuth hardening (Host allowlist, APP_BASE_URL redirect_uri, state single-use)
- [x] BK-4 Migration drift detection + prod auth wiring + dev-secret guard + limiter eviction
- [x] BK-2 Durable Redis Streams queue adapter (at-least-once + idempotency)
- [x] Required docs: SECURITY, THREAT-MODEL, PRIVACY, COMPLIANCE, CONTRIBUTING, CHANGELOG

## Backlog / hardening
- [ ] BK-2 Durable queue adapter (ack/nack, at-least-once for money-path events)
- [ ] BK-3 Signed URLs — DONE
- [ ] BK-4 Migration drift assertions + production wiring of authService entrypoint
- [ ] Email verification / password reset flows
- [ ] Distributed rate limiting (Redis-backed)

## Verification log (executor ≠ verifier on every item)
| Item | Tests at ship | Independent evidence |
|------|---------------|----------------------|
| FND-1 | 19 | fresh clean-build gates + live /health curl |
| FND-2 | 30 | migrations on scratch DB, cross-org isolation probe |
| FND-3 | 59 | 14/14 live HTTP security probes (CSRF, cookies, hash-only storage) |
| FND-4 | 77 | 58/58 behavioral probes (retry/DLQ/validation) |
| FND-5 | 134 | 33/33 security probes (traversal matrix, oversize, MIME mismatch) |
| FND-6 | 148 | redaction probes + live auth-route leak check |
| FND-7 + BK-1 + BK-3 | 197 | 29/29 OAuth security probes, audit 0 vulns, signed-URL tamper suite |
| BK-4 + BK-2 + FND-8 + SEC-1 + AFF-1 | 299 | drift probe (dropped column detected), restart-survival + exactly-once probes, anti-enumeration probes, Host-attacker 400s, cross-org affiliate isolation; blocker D1 (contracts TDZ) found by verifier → repaired → CONTRACTS_BOOT_OK + plain-node API boot /health 200 |

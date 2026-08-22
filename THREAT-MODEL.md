# THREAT-MODEL.md

Status: STRIDE-lite per component, grounded in the code **as of this writing**
(Phase 1 complete: FND-1..FND-7, BK-1, BK-3; see `IMPLEMENTATION-CHECKLIST.md`).
Supersedes nothing — extends `SECURITY.md` (which remains the authoritative
summary of protections). Revisit at every phase gate.

Scope of this document: only components that actually exist today.
`apps/api` HTTP surface (`auth-routes.ts`, `oauth-routes.ts`),
`services/auth`, `packages/db`, `packages/events`, `packages/storage`,
`packages/observability`. Affiliate/content/publishing phases are out of scope
until implemented.

---

## 1. Authentication (`services/auth/src/service.ts`)

| Threat | Mitigation in place | Residual risk |
| --- | --- | --- |
| Password theft | Argon2id via `@node-rs/argon2` (`passwords.ts:4`); raw passwords never stored or logged | Offline cracking if DB leaks; no MFA |
| User enumeration on login | Dummy-hash timing equalization for unknown emails (`service.ts:43-49`); generic error `invalid_credentials` | Register endpoint returns distinct `email_taken` 409 (`service.ts:104-109`) — enumeration possible there by design tradeoff |
| Session token theft | 256-bit random tokens (`tokens.ts`); DB stores SHA-256 hash only (`sessions.token_hash`, unique — `migrations/0002_auth.sql:11`) | Cookie exfiltration via XSS — no SPA exists yet, so attack surface is minimal today |
| Session replay after expiry | Server-side `expires_at > now()` check in the lookup query (`service.ts:312`) | Expired session rows are not garbage-collected yet |
| Brute force | Fixed-window rate limiter on `/auth/login` keyed `ip:/auth/login`, default 10/min → 429 (`apps/api/src/auth-routes.ts:28-46,154-159`) | **In-memory, single-process**; resets on restart; bucket map clears wholesale above 10k entries (collateral unblocking) |
| Account lockout bypass | N/A | No lockout/MFA exists at all |

## 2. CSRF / cookies (`apps/api/src/auth-routes.ts`)

- Mutating auth routes require custom header `x-requested-with: zaff`
  (`isCsrfOk`, `auth-routes.ts:245-247`). Browsers cannot set this cross-origin
  without a granted CORS preflight (none is granted).
- Cookie: single `zaff_session`; `HttpOnly; SameSite=Lax; Path=/`;
  `Secure` added only when `NODE_ENV=production` or `secureCookies` dep
  (`buildSessionCookie`, `auth-routes.ts:48-62`; OAuth variant
  `oauth-routes.ts:127-137`, gated on env only).

Residual: header-check scheme assumes same-site SPA+API deployment; revisit if
cookies ever become cross-site (noted in `SECURITY.md`).

## 3. OAuth / OIDC (`apps/api/src/oauth-routes.ts`, `services/auth/src/oauth/*`)

Implemented controls:

- PKCE S256 with fresh 256-bit verifier per flow (`oauth/pkce.ts`).
- HMAC-SHA256-signed state binding `{nonce, issuedAt, redirectTo}`, constant-time
  compare, 10-minute max age (`oauth/state.ts`; `OAUTH_STATE_MAX_AGE_SEC = 600`,
  `oauth-routes.ts:15`).
- Single-use flows: pending flows keyed by SHA-256 of the state are deleted on
  first callback use → replays fail `unknown_state` (`oauth-routes.ts:201-204`).
- `id_token` verified against provider JWKS (RS256 + HS256 for oct keys);
  issuer, audience, expiry, max-age, nonce validated; `alg=none` and
  algorithm/key-type mismatches rejected; decode-only never used for decisions
  (`oauth/verify.ts`, `oauth/jwk.ts`).
- Identity linking only when provider asserts `email_verified: true`; otherwise
  fresh personal org/user; unverified collisions refused 409
  (`service.ts:212-263`).
- Provider registry allowlist: unknown provider → 404, registered-but-
  unconfigured → 503 (`resolveProvider`, `oauth-routes.ts:64-82`).

Known gaps:

| Gap | Detail |
| --- | --- |
| In-memory pending-flow store | Module-level `Map` (`oauth-routes.ts:50`); lost on restart, invisible to other replicas. Blocks multi-instance OAuth deployment. |
| Dev-default secrets | `DEV_STATE_SECRET = "zaff_dev_state_secret_change_me"` fallback when `OAUTH_STATE_SECRET` unset (`oauth-routes.ts:18,154`). MUST be overridden outside development. |
| Callback URI built from `Host` header | `callbackUriFor` trusts `req.headers.host` (`oauth-routes.ts:98-101`); behind an uncontrolled proxy this permits redirect-URI manipulation attempts — mitigated by provider-side redirect-URI registration but worth hardening (allowlist hosts). |
| No email verification / password reset | Registration trusts input (`SECURITY.md`). |
| Fallback synthetic emails | Missing email claims synthesize `<sub>@<issuer-host>` (`oauth-routes.ts:103-112`) — a placeholder identity that occupies the unique email slot. |

## 4. Database layer (`packages/db`)

| Control | Evidence |
| --- | --- |
| Tenant isolation | Every org-scoped query takes explicit `orgId` and filters on it; returned rows pass `assertOrgScope(row, orgId)` which throws `OrgScopeError` on mismatch (`src/scope.ts:16-22`). HTTP layer additionally compares `requester.orgId` to path org and returns 403 (`auth-routes.ts:191-193,204-206`). Cross-org reads covered by integration tests (`db.integration.test.ts`). |
| SQL injection | Parameterized postgresjs tagged templates only for all values (ADR-0003). The sole string-interpolated execution surface is `tx.unsafe(migration.up/down)` in the migrator (`src/migrator.ts:63,82`) — input is repo-owned `.sql` files read from disk (`loadMigrationsFromDir`), not user input. Acceptable; do not extend `unsafe()` beyond migration sources. |
| Migration drift | **Accepted gap until BK-4**: migration 0003 uses `CREATE TABLE IF NOT EXISTS` (`migrations/0003_oidc.sql:4`), which can silently adopt a divergent pre-existing table missing constraints (e.g., the `UNIQUE (issuer, subject)`). BK-4 adds post-migration shape assertions to fail closed. |
| Least privilege | Documented split of runtime DML role vs migration DDL role; dev currently maps both to container superuser (`docs/architecture/data-model.md:26-34`). Not yet enforced by provisioning tooling. |

## 5. Object storage (`packages/storage`)

Media keys/bytes are treated as untrusted-adjacent input (ADR-0005).

| Threat | Mitigation | Evidence |
| --- | --- | --- |
| Path traversal | Aggressive key allowlist `[A-Za-z0-9._/-]`; rejects absolute paths, drive letters, `.`/`..` segments, empty segments, NUL, percent-encoded separators, non-ASCII (incl. unicode dot look-alikes), >512 chars | `src/keys.ts` (`validateKey`) |
| Content-type confusion | Magic-byte sniffing on put (png/jpeg/gif/webp/pdf/json/text); declared-binary mismatch is hard reject `CONTENT_TYPE_MISMATCH` | `src/mime.ts` |
| Oversize payloads | Per-object `maxBytes` (default 50 MiB) enforced before write | adapters |
| Unauthorized reads | Signed URLs: `signedUrl(key,{ttl})`, default TTL 300 s, GET-only; local adapter HMAC-SHA256 over `key+"\n"+expires`; verification pins 64-hex signature length then `crypto.timingSafeEqual`; fails closed | `src/signing.ts`; ADR-0005 §BK-3 |
| Weak signing secret | Resolution order: config → `STORAGE_SIGNING_SECRET` env → **dev-only default** `zaff_dev_signing_secret_change_me`. Production must inject from secret manager. | ADR-0005 |
| World-readable blobs | Local FS writes mode `0600` | ADR-0005 |

Residual: S3 adapter re-sniffs nothing on read (cost tradeoff); revisit once
user-uploaded media shares a bucket with system-generated assets (ADR-0005).
The package ships **no HTTP route** — applications must wire
`verifySignedRequest` before streaming (`ADR-0005` boundary section); apps/api
does not serve `/storage/*` today, so there is currently no exposed route to
protect.

## 6. Event bus (`packages/events`)

| Aspect | Reality today |
| --- | --- |
| Delivery semantics | In-memory bus is **at-most-once** (`memory.ts:41`, ADR-0004). Handler failure → exponential-backoff retry (default 3 attempts, 25 ms base) → capped DLQ (1000 entries, oldest evicted). Nothing persists across restart. Money-path events (ConversionRecorded/CommissionRecorded) will require the durable adapter (BK-2, at-least-once + ack/nack + idempotent consume) before scale. |
| Malicious/forged events | Zod discriminated union validates payloads **on publish AND consume** (`typed-bus.ts`); invalid consume-side payloads fail validation into retry/DLQ rather than reaching handlers raw. |
| Payload leakage | Events carry orgId/actor where applicable; schema tests assert required fields. Consumers depend on the port only — no transport logic leaks. |
| Replay/duplication | Envelopes carry uuid `id` to enable future deduplication; dedup itself is NOT implemented (meaningful only once a durable adapter lands). |

## 7. Observability (`packages/observability`)

| Threat | Mitigation | Limitation |
| --- | --- | --- |
| Secret leakage into logs | pino redaction of `password, token, sessionToken, cookie, authorization, set-cookie` → `[Redacted]` (`logger.ts:6-13`) | Redaction enumerates paths to **three levels of nesting** only (`*.f`, `*.*.f`, `*.*.*.f` — fast-redact single-level wildcard constraint, `logger.ts:15-24`). Deeper objects and **arrays of objects are NOT matched** — do not place sensitive values inside arrays. |
| Query-string leakage in request logs | `pathnameOnly()` strips everything from `?` (`request-log.ts:12-15`) | Headers are never logged wholesale; keep it that way |
| OTel export | Opt-in via env, optional peer deps, dynamic import, fail-open no-op (`otel.ts`) | Export pipeline security depends on collector deployment — not yet specified |

---

## CURRENT GAPS (explicit list)

These are real, accepted-for-phase gaps. Do not claim them fixed anywhere.

1. **No HTTPS/TLS termination story.** Assumed reverse-proxy/platform
   responsibility; `Secure` cookie flag appears only under
   `NODE_ENV=production` / `secureCookies` dep. No HSTS, no TLS config in repo.
   (`SECURITY.md`; `auth-routes.ts:60`)
2. **Dev-default secrets.** `OAUTH_STATE_SECRET` falls back to a documented
   dev value (`oauth-routes.ts:18`); storage signing secret likewise
   (`ADR-0005`). No startup guard refuses production boot on dev defaults.
3. **Single-process rate limiter.** In-memory fixed window
   (`auth-routes.ts:28-46`); not shared across replicas, lost on restart.
   Redis-backed distributed limiter tracked in checklist.
4. **Single-process OAuth pending-flow store.** In-memory Map
   (`oauth-routes.ts:50`); blocks multi-instance OAuth.
5. **No email delivery.** No email verification, password reset, or any mail
   transport exists. Registration trusts input.
6. **Migration drift tolerance until BK-4.** `IF NOT EXISTS` in 0003 can
   silently adopt divergent tables lacking constraints; migrator has no shape
   assertion (`migrator.ts`).
7. **At-most-once events.** In-memory bus loses events on restart/DLQ
   exhaustion; unacceptable for money paths at scale (BK-2 pending).
8. **No MFA, no account lockout, no "revoke all sessions".**
9. **Audit log integrity.** Append-only by convention; no tamper evidence,
   no retention policy enforcement.
10. **Expired sessions not purged.** Expiry enforced at lookup only.
11. **No CSP/security headers middleware** on apps/api responses.
12. **Rate limiter map eviction** clears ALL buckets past 10k entries
    (`auth-routes.ts:38`) — a memory-pressure valve that also unblocks
    attackers momentarily.

## Rules for extending this model

1. New external-facing component ⇒ new STRIDE-lite table here before merge.
2. New accepted gap ⇒ add to CURRENT GAPS with owner work-item ID.
3. Never resolve a gap in docs before it is verified in code.

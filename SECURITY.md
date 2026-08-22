# SECURITY.md

Status: initial threat-model-lite for Phase 1 (FND-1..FND-3). Revisit at each phase gate.

## What is protected today

### Passwords
- Hashed with argon2id (`@node-rs/argon2`, prebuilt binaries) before storage;
  raw passwords never persisted or logged.
- Verification failures against unknown emails are equalized with a dummy-hash
  comparison to reduce timing-based user enumeration.

### Sessions
- Session tokens: 32 random bytes, base64url-encoded (256-bit entropy).
- Only a SHA-256 hash of the token is stored (`sessions.token_hash`, unique);
  the raw token exists only in the client cookie.
- Cookies: `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` added when
  `NODE_ENV=production`.
- Sessions expire server-side (`sessions.expires_at`); expiry checked on lookup.

### CSRF
- Mutating `/auth` routes require the custom header
  `x-requested-with: zaff`. Browsers cannot set this cross-origin without a
  successful CORS preflight, which we do not grant. This is a deliberate
  "double-submit-lite" scheme appropriate to a same-site SPA + API deployment;
  revisit if cookies become cross-site.

### Rate limiting
- `/auth/login` is limited per IP+route via an in-memory fixed-window limiter
  (default 10/min), returning `429`.
- **Known gap:** single-process, dev-grade. A distributed limiter (Redis-backed)
  is required before multi-instance deployment.

### Tenant isolation
- Every user row carries `org_id`; org-scoped queries filter on it
  (see `docs/adr/ADR-0003-parameterized-tenant-scoped-sql.md`).
- HTTP routes compare `requester.orgId` with the requested org id and return
  `403` on mismatch (users list, audit log).
- RBAC hierarchy `viewer < member < admin < owner` enforced by the pure
  `can(role, action)` function in `@zaff/auth`.

### Audit trail
- Register, login success, login failure, logout are recorded in `audit_log`
  with org, actor, action, and target. Metadata never contains credentials.

### OAuth / OIDC (FND-7)

- **Authorization-code flow with PKCE (S256)** — every login generates a fresh
  256-bit `code_verifier`; only `S256(code_verifier)` is sent to the provider.
- **Signed state + nonce** — the `state` parameter is
  `base64url(payload) + "." + HMAC-SHA256` (constant-time signature compare)
  binding `{nonce, issuedAt, redirectTo}`; states older than 10 minutes are
  rejected. The nonce is stored server-side per pending flow and re-checked
  against the returned `id_token`.
- **Single-use flows** — pending flows (PKCE verifier + nonce, keyed by
  SHA-256 of the signed state) are deleted on first callback use, so replayed
  callbacks fail with `unknown_state`. **Known limitation:** the store is
  in-memory and single-process; multi-instance deployments need a shared store
  before OAuth goes to production.
- **JWT verification, not trusted decode** — `id_token`s are verified against
  the provider's JWKS (`kid` lookup; RS256 via `node:crypto`, plus HS256 for
  oct keys), and validated for issuer, audience (client id), expiry, max age,
  and nonce. Decoding without verification is never used for auth decisions.
  `alg=none` and algorithm/key-type mismatches are rejected.
- **Identity linking policy** — new OIDC identities are linked to an existing
  local account only when the provider asserts `email_verified: true`;
  otherwise a fresh personal org/user is created. Unverified-email collisions
  are refused (`409`) rather than silently merged. All link/registration
  events land in the audit log (`user.oauth_registered`, `user.oauth_linked`,
  `auth.login` with `via: oidc`).
- **Provider registry** — only preconfigured providers are routable
  (currently `google`, endpoints from live discovery); unknown providers →
  `404`, registered-but-unconfigured → `503 oauth_not_configured`. Client
  secrets come from env/secret manager, never from the browser.
- State HMAC secret comes from `OAUTH_STATE_SECRET` (a clearly-marked dev-only
  default exists for local runs and MUST be overridden outside development).

## Known gaps (accepted for current phase)

- **In-memory OAuth flow store** — see above; required before multi-instance
  deployment of OAuth routes.
- **No email verification / password reset** — registration trusts input.
- **In-memory rate limiter** — resets on process restart, not shared across
  replicas.
- **No account lockout / MFA** — rate limiting is the only brute-force brake.
- **No TLS termination story** — assumed to be handled by the reverse proxy /
  platform; `Secure` cookies only when `NODE_ENV=production`.
- **Session revocation is all-or-nothing per session** — no "revoke all
  sessions" admin operation yet.
- **Audit log retention/integrity** — append-only by convention, no tamper
  evidence yet.

## Rules

1. Never log raw session tokens, passwords, password hashes, or cookies.
2. Parameterized SQL only; no string-interpolated SQL anywhere.
3. Never return tokens or password material in HTTP response bodies.
4. Generic auth errors only (`invalid email or password`) — no user enumeration.
5. New auth-adjacent routes must go through `requireUser`/`requireRole` +
   tenant-org checks; do not bypass `AuthService`.
6. Dev DB credentials (`zaff_dev_only`) are disposable/local-only; never reuse
   them elsewhere.

## Hardening (BK-4)

### Migration drift detection (`@zaff/db`)
- `migrateUp` now records a canonical fingerprint of the applied schema shape
  (public table → column → data type, sorted) in
  `schema_migrations.schema_shape` after every run.
- On re-runs against an existing database, the live shape is diffed against the
  recorded fingerprint; any divergence (missing/extra tables or columns, type
  changes) aborts startup with `MigrationDriftError` listing each divergence.
  This catches manual out-of-band schema edits that `IF NOT EXISTS` dev
  tolerance would otherwise mask.

### Production auth wiring (`apps/api`)
- `apps/api/src/index.ts` now constructs a real `AuthService` from
  `DATABASE_URL` (fail-fast with a clear error when unset); bare
  `node apps/api/dist/index.js` serves `/auth/*`, `/orgs/*`, and `/audit`
  instead of returning 404/503.

### Dev-secret guard
- New boot-time check (`assertNoDevSecrets`) refuses to start when
  `NODE_ENV=production` while `OAUTH_STATE_SECRET` or `STORAGE_SIGNING_SECRET`
  is unset (dev-default fallback would activate) or set to the documented
  dev-default values. The API logs and exits non-zero.
- The OAuth state secret dev fallback remains for local development only;
  production deployments must inject both secrets from a secret manager.

### Rate-limiter eviction fix
- The login rate limiter no longer calls `buckets.clear()` past 10k keys
  (which momentarily unblocked all tracked attackers). It now evicts only
  expired buckets on a periodic sweep and, under memory pressure, only the
  oldest-window buckets; unrelated live buckets keep their counts and remain
  correctly limited.

## OAuth hardening

- **Redirect-host allowlist (no Host-header trust)** — OAuth callback
  (`redirect_uri`) values are built ONLY from the configured app base URL
  (`APP_BASE_URL` env or `appBaseUrl` option; dev-only default
  `http://localhost:3000`). When no base URL is configured, the request Host is
  used only after it passes an allowlist: `OAUTH_ALLOWED_REDIRECT_HOSTS`
  (comma-separated hostnames; dev-only default `localhost,127.0.0.1`). Requests
  whose Host is missing or not on the list are rejected with
  `400 untrusted_host` before any redirect or provider interaction — a spoofed
  `Host: evil.example` can never steer the authorization code to an attacker.
- **Synthetic identity emails cannot collide with real mailboxes** — when a
  provider does not return an email claim, identities get a deterministic,
  collision-free sentinel: `oidc-<sha256(issuer|sub)[0:24]>@oidc.invalid`. The
  reserved `.invalid` TLD (RFC 2606/6761) is non-routable, so sentinels can
  never occupy a real user's unique email slot, and hashing issuer+sub keeps
  distinct providers/subjects from producing identical addresses. Linking to an
  existing account still requires `email_verified: true` (see identity linking
  policy above).
- **State single-use regression-tested** — pending flows are deleted *before*
  any upstream token exchange on first callback use; replaying the same signed
  state is rejected with `400 unknown_state`. Covered by unit tests
  (`apps/api/test/oauth.security.test.ts`) and by the mock-provider integration
  test ("rejects replaying a consumed callback").

# PRIVACY.md

Status: honest inventory of personal data that exists **as of this writing**
(Phase 1 complete). No affiliate, catalog, or content data has been collected
yet — those phases are unimplemented. Retention rules below are *proposed*
(not enforced by code) except where noted. Subject-rights handling is TODO.

## 1. Data inventory (what PII exists today)

| Data | Where stored | Created by | Sensitive? |
| --- | --- | --- | --- |
| Email address (local accounts) | `users.email` (unique) — `packages/db/migrations/0001_init.sql` | `/auth/register` (`apps/api/src/auth-routes.ts:147-152`) | Yes |
| Password hash (argon2id) | `users.password_hash` — `migrations/0002_auth.sql:2-6` | `services/auth/src/passwords.ts` | Derived credential; raw passwords never stored or logged |
| OAuth-linked accounts: empty-string password hash | `service.ts:239` writes `passwordHash: ""` for OIDC-only users | FND-7 | Not a credential |
| OIDC identity | `user_identities (issuer, subject)` — `migrations/0003_oidc.sql`; issuer also copied into audit metadata (`service.ts:207,250`) | OAuth callback → `loginWithOidc` | Pseudonymous identifier from provider |
| Session token **hash** (SHA-256) | `sessions.token_hash` (unique) — `0002_auth.sql:11` | Login/OIDC login | High value if DB leaks, but only hashes are stored; raw token lives solely in the client cookie |
| Audit events | `audit_log (org_id, actor_user_id, action, target_type, target_id, metadata jsonb)` — `0001_init.sql` | Register / login success / login failure / logout / oauth register+link (`service.ts`) | Contains user IDs and action history; metadata for OIDC logins includes issuer + subject |
| IP addresses | **Not stored anywhere in the DB.** The login rate limiter uses the socket remote address transiently as a rate-limit key only (`auth-routes.ts:104-106,155`) — never persisted, never logged | Rate limiter | Minimal |

Not collected today: names, addresses, phone numbers, payment data,
third-party tracking identifiers, analytics beacons, cookies beyond the
session cookie (below). There is no web frontend yet (`apps/web` does not
exist), so no client-side telemetry of any kind.

## 2. Cookie inventory

Exactly one cookie:

| Name | Purpose | Flags |
| --- | --- | --- |
| `zaff_session` | Session authentication (opaque 256-bit base64url token) | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Expires` = server session TTL (7 days); `Secure` added when `NODE_ENV=production` or `secureCookies` dep (`apps/api/src/auth-routes.ts:48-62`, OAuth variant `oauth-routes.ts:127-137`) |

No analytics, marketing, or third-party cookies. No third-party trackers,
CDN-hosted scripts, or external font/analytics embeds exist anywhere in the
repo.

## 3. Logging privacy

- Structured pino JSON logs with default redaction of
  `password / token / sessionToken / cookie / authorization / set-cookie`
  → `[Redacted]` (`packages/observability/src/logger.ts:6-24`). Limitation:
  redaction covers three nesting levels and not arrays of objects.
- Request logs record method, **pathname only** (query strings stripped via
  `pathnameOnly`, `request-log.ts:12-15`), status, duration, request id.
  No IPs, no user agents, no query parameters.
- Rules inherited from `SECURITY.md`: never log raw tokens, passwords, hashes,
  or cookies.

## 4. Retention rules (PROPOSED — not yet implemented)

| Data class | Proposed retention | Enforcement status |
| --- | --- | --- |
| Session rows | Delete on logout (done); purge expired rows after 30 days | Logout delete implemented (`service.ts:327-340`); expired-row purge **TODO** |
| Password hashes | Life of account | Enforced implicitly |
| `user_identities` | Life of account; delete on unlink (no unlink endpoint exists yet) | **TODO** |
| `audit_log` | Security-relevant events; propose 12 months, then aggregate/delete | No retention job exists — **TODO** |
| Application logs | Propose 30 days, redacted per §3 | Log rotation/retention owned by deployment — undocumented, **TODO** |
| Storage blobs | Deleted objects removed immediately; local adapter delete is idempotent (`packages/storage` ADR-0005) | Implemented at adapter level |

No automated retention jobs run anywhere in the codebase today.

## 5. Subject rights (access / deletion / rectification) — TODO

Nothing is implemented. When built, minimum expectations:

1. **Access/export:** user profile (email, role, created_at), own audit
   entries, active sessions count, linked OIDC identities (issuer only).
2. **Deletion:** delete/reanonymize `users` row, cascade sessions and
   identities, scrub `actor_user_id` references in `audit_log` while keeping
   the event (replace actor with a tombstone id) to preserve security history.
3. **Rectification:** email change requires re-verification once email
   delivery exists (it does not today — see THREAT-MODEL gaps).
4. Cross-border/processor considerations are N/A until third-party providers
   (OAuth issuer aside) are integrated. Google OAuth receives standard
   authorization redirects; no zaff-side data is shared with it beyond the
   OIDC handshake itself.

## 6. Data flows today (complete list)

```
Browser ──HTTP──▶ apps/api ──▶ Postgres (PII above)
                    │
                    ├──▶ Identity provider (Google OIDC: authorize redirect +
                    │    code/id_token exchange; JWKS fetch)
                    └──▶ stdout logs (redacted JSON)
```

That is the entire surface. No outbound calls to ad networks, trackers, or AI
providers exist yet.

## 7. Commitments

1. No third-party trackers or beacon scripts will be added without a privacy
   review entry in this file.
2. Any new PII column must be added to §1 with storage location and purpose.
3. Cookies beyond the single session cookie require an inventory update here.

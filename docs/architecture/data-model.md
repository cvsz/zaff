# Data model (Phase 1)

PostgreSQL (disposable dev instance on `127.0.0.1:5433`, container
`zaff-postgres`). Client: `postgresjs` (`packages/db`), no ORM. Migrations:
plain SQL with `-- migrate:up` / `-- migrate:down` sections, tracked in
`schema_migrations`. Migration numbers are monotonic but NOT contiguous:
`0004` was reserved/skipped during concurrent development, so the sequence
jumps (e.g. `0003_oidc` → `0005_account_recovery`). Do not renumber existing
migrations.

## Tables (0001_init)

| Table | Purpose | Key columns |
| --- | --- | --- |
| `organizations` | Tenant root | `id uuid pk default gen_random_uuid()`, `name text not null`, `created_at timestamptz` |
| `users` | Org members | `id uuid pk`, `org_id uuid not null -> organizations(id)`, `email text unique not null`, `role text check in ('owner','admin','member','viewer')`, `created_at`; index `(org_id)` |
| `audit_log` | Immutable audit trail | `id uuid pk`, `org_id uuid -> organizations(id)`, `actor_user_id uuid null -> users(id)`, `action`, `target_type`, `target_id`, `metadata jsonb default '{}'`, `created_at`; index `(org_id, created_at desc)` |
| `schema_migrations` | Migration bookkeeping | `name text pk`, `applied_at timestamptz` |

## Tenancy rule

Every org-scoped query MUST take an explicit `orgId` parameter and filter by
it (`WHERE org_id = $1`). Rows returned to callers carry `orgId` and pass
through `assertOrgScope(row, orgId)` before use. Cross-org reads are covered
by integration tests in `packages/db/test/db.integration.test.ts`. All values
are passed as postgresjs parameters — no string interpolation of values into
SQL.

## Database roles (least privilege)

- Application runtime connects with a role limited to DML on `public` tables
  (SELECT/INSERT/UPDATE/DELETE) — no DDL, no superuser.
- Only the migration runner may run DDL; it should use a separate migration
  role. In dev both map to the container superuser for simplicity; production
  deployments MUST provision distinct roles via secret manager.
- The test default (`postgres/zaff_dev_only` on 127.0.0.1:5433) is a disposable
  dev-only credential and must never be used outside local/CI environments.

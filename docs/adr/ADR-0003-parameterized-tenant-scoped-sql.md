# ADR-0003: Parameterized, tenant-scoped SQL (no ORM)

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

FND-2 introduces the database layer. Options considered: full ORM (Prisma/
Drizzle), query builder, raw SQL client.

## Decision

Use `postgresjs` directly with handwritten SQL and a thin migration runner.
All values pass through postgresjs parameters (tagged templates); never
interpolate values into SQL strings. Every org-scoped query takes an explicit
`orgId` and filters on it; `assertOrgScope()` guards returned rows.

## Consequences

- Full SQL visibility; easy EXPLAIN and index tuning.
- Tenant isolation is enforced explicitly per query and verified by
  integration tests (cross-org read filtering).
- No ORM migrations/metadata lock-in; migrations are plain SQL with up/down
  sections recorded in `schema_migrations`.
- Cost: manual row mapping (small, typed) and discipline required to keep
  queries parameterized — covered by review checklist and tests.

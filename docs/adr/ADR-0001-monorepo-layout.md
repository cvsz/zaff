# ADR-0001: Monorepo layout

## Status

Accepted

## Context

The Affiliate Automation OS spans multiple apps (web, admin, creator-studio, analytics, api, worker, scheduler), many domain services, and shared packages (contracts, db, ui, platform-adapters, etc.). Domain changes frequently cut across layers (a schema change in contracts affects api and workers simultaneously). Separate repositories would create version-skew, cross-repo PR coordination, and duplicated tooling setup.

## Decision

Use a single npm-workspaces monorepo with `apps/*`, `services/*`, and `packages/*`, matching the directory skeleton in AGENTS.md §2. Shared TypeScript configuration lives in a root `tsconfig.base.json`; project references coordinate typechecking; vitest and eslint run from the root across all workspaces. Internal packages are consumed via workspace protocol (`@zaff/*`).

## Consequences

- Cross-cutting changes are atomic single PRs; CI validates all affected packages together.
- The repo will grow large; per-package ownership must be enforced through directory conventions and CODEOWNERS as teams scale.
- npm-workspaces is sufficient now; migrating to Turborepo/Nx later only requires adding task caching on top of existing scripts.
- Placeholder directories exist before their implementation begins; they are intentionally empty (.gitkeep) to keep the skeleton discoverable.

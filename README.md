# zaff — Affiliate Automation OS

Self-hostable, policy-controlled affiliate commerce and content operating system.
Connects affiliate/catalog data and publishing workflows across TikTok, Shopee,
Facebook/Instagram, and YouTube using official APIs, OAuth, webhooks, and
platform-compliant automation.

See `AGENTS.md` for the product vision, `ROADMAP.md` for phases, and
`exec-planning.md` for the execution source of truth.

## Layout

- `apps/*` — deployable applications (api, web, admin, creator-studio, analytics, worker, scheduler)
- `services/*` — domain services
- `packages/*` — shared libraries (`@zaff/*`)
- `docs/adr/` — architecture decision records

## Requirements

- Node.js >= 18 (CI uses Node 20)

## Commands

```bash
npm install        # install all workspaces
npm run build      # build all workspaces
npm run lint       # eslint
npm run typecheck  # tsc project references
npm test           # vitest across all workspaces
```

## Status

Phase 1 (Foundation) in progress. Current state: monorepo scaffold,
`packages/contracts`, `apps/api` health endpoint, CI workflow. See
`IMPLEMENTATION-CHECKLIST.md` when it lands.

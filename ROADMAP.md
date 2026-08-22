# ROADMAP.md

> Execution source of truth lives in `exec-planning.md`. This file defines the
> phase structure; work items are tracked in `exec-planning.md` and mirrored in
> `IMPLEMENTATION-CHECKLIST.md` as they are added.

## Guiding rules

- Incremental delivery: every iteration ships one bounded, verified vertical slice.
- Never mark unverified work complete.
- Never merge/deploy/publish or enable irreversible autonomous behavior without explicit authorization.
- Provider capabilities are declared, never assumed (`capability` matrix per adapter).
- All automation is policy-controlled with human approval gates for high-risk actions.

## Phase 0 — Discovery ✅ (initial assessment complete)

- [x] Inspect repository state (greenfield: `AGENTS.md` only)
- [x] Select loop-engineering-kit agents/skills as execution framework
- [x] Create `ROADMAP.md` + `exec-planning.md`
- [ ] Architecture decision records (ADR-0001 …) — first batch in FND-1

## Phase 1 — Foundation ✅ (complete)

Goal: runnable monorepo skeleton with auth-ready boundaries.

- [x] Monorepo tooling (npm workspaces), lint + typecheck + test CI skeleton (FND-1)
- [x] `packages/db` schema migrations (orgs, users, roles, audit log) (FND-2)
- [x] `services/auth` session auth + RBAC middleware; OAuth/OIDC done in FND-7 (FND-3)
- [x] `packages/contracts` (zod schemas shared across apps/services) (FND-1)
- [x] Queue abstraction — `packages/events` in-memory bus, §20 domain events, retry+DLQ; durable adapter deferred to BK-2 (FND-4)
- [x] Object storage adapter — `packages/storage` local FS + injected-client S3 shape; signed URLs deferred (FND-5)
- [x] Observability baseline — `packages/observability` pino JSON logs, redaction, opt-in OTel (FND-6)
- [x] Secrets/config loading conventions (dev-only DB default documented; secret-manager adapters pending)

## Phase 2 — Affiliate Core (in progress)

- Normalized domain model: AffiliateProvider, Merchant, Product, Offer,
  Commission, AffiliateLink, Campaign, Conversion
- [x] AFF-1: migration 0006 + org-scoped repos + contracts schemas for
  providers/merchants/products/offers/campaigns/links/conversions
  (idempotent conversion ingestion, campaign transition validation)
- [ ] Adapter interfaces + capability registry wiring to PlatformCapabilityMatrix
- [ ] TikTok / Shopee / Meta / YouTube adapter skeletons with sandbox contract tests
- [ ] `/go/{slug}` link redirect service with click attribution (privacy-conscious)
- [ ] Campaign HTTP API + conversion ingestion (webhook + manual)
- [x] Account recovery service layer (FND-8); HTTP wiring pending

## Phase 3 — Content Studio

- Content planner (strategy objects per product)
- Copy generator (TH/EN, brand voice, claim grounding)
- Image pipeline (templates → variables → generation → QA → storage)
- Video factory pipeline stages (script → storyboard → render queue)
- Asset library with immutable creative IDs

## Phase 4 — Publishing

- Normalized `publish(content, destinations, schedule)` API
- Drafts, scheduling, retries, idempotency keys, rate limiting
- Dead-letter queue + partial-failure recovery
- Approval inbox integration (MANUAL … AUTONOMOUS_WITH_POLICY modes)

## Phase 5 — Analytics

- Attribution chain: Impression → Click → Redirect → Conversion → Commission
- Metrics: CTR, CVR, EPC, ROAS, net commission, content/product/platform ROI
- Executive dashboard + time-series comparisons + anomaly flags

## Phase 6 — Intelligence

- Opportunity/viral/commission scoring model (configurable weights)
- Trend intelligence pipeline (permitted sources only, lifecycle classification)
- Recommendation service with min-sample thresholds + confidence intervals

## Phase 7 — Automation

- Autonomous campaign loop behind policy engine
- Autonomy levels + sensitive-category approval enforcement
- Full audit trail for every autonomous action

## Phase 8 — Optimization

- Experimentation engine (hook/thumbnail/CTA/timing experiments)
- Learning loop feeding performance back into scoring/recommendations

## Phase 9 — Production Hardening

- Security review, threat-model update, load testing
- Backup/restore drills, DR runbooks, SLOs + alerts
- Cost controls per AI operation, budget dashboards

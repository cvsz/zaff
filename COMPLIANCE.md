# COMPLIANCE.md

Status: **current-state + design-requirements** document. Everything in
§1–§2 exists in code; everything in §3 onward is a binding requirement for
future phases and is **NOT yet implemented**. This document must never claim
compliance that the code does not demonstrate.

Last updated: Phase 1 complete (FND-1..FND-7, BK-1, BK-3). See
`IMPLEMENTATION-CHECKLIST.md`.

## 1. What is implemented today (Phase 1)

| Area | State | Evidence |
| --- | --- | --- |
| Audit trail for auth events | Register, login success/failure, logout, OAuth register/link recorded with org/actor/action/target — no credentials in metadata | `services/auth/src/service.ts` (all `appendAuditEvent` calls); `packages/db/migrations/0001_init.sql` |
| Tenant isolation | Org-scoped queries + `assertOrgScope`; cross-org HTTP 403 | `packages/db/src/scope.ts`; `apps/api/src/auth-routes.ts:191-193,204-206` |
| Parameterized SQL only | postgresjs tagged templates everywhere; migrator `unsafe()` restricted to repo-owned migration files | ADR-0003; `packages/db/src/migrator.ts:63,82` |
| Credential hygiene | Argon2id passwords; SHA-256-only session token storage; redacted logging | `SECURITY.md`; `THREAT-MODEL.md` |
| Input validation on auth routes | Zod schemas from `@zaff/contracts` parsed at route boundary | `auth-routes.ts:148,160` |
| Known accepted gaps | Documented honestly (dev-default secrets, single-process limiter/flow store, no email verification, drift tolerance until BK-4) | `THREAT-MODEL.md` §CURRENT GAPS |

## 2. Platform / commercial-content compliance — NOT YET IMPLEMENTED

There is currently **no affiliate integration, content generation, or
publishing code of any kind** (Phases 2+ are undesigned per
`exec-planning.md`). The following are **design requirements**, not
achievements:

### 2.1 Affiliate disclosure obligations

Any future content pipeline MUST support per-platform required disclosures,
sourced from a versioned `PlatformPolicyRegistry` (planned per AGENTS.md §25)
— never hard-coded assumptions:

| Platform | Requirement to encode |
| --- | --- |
| TikTok | Commercial Content toggle / branded-content disclosure where official APIs expose it; paid-partnership labeling |
| Meta (FB/IG) | Paid-partnership label via Branded Content tools; "commercial content" tagging where API-supported |
| YouTube | Paid promotion disclosure flag (`paidPromotion`) on uploads via the official Data API; video description disclosure text |
| Shopee (affiliate) | Follow Shopee Affiliate Program terms for link usage; no fabricated discounts/scarcity |

Requirements: disclosure state must be part of the content record itself,
rendered into captions/descriptions/metadata by the publishing adapters, and
blockable by policy check before publish.

### 2.2 AI-generated content disclosure

Where a target platform requires labeling synthetic/AI-generated media, the
publishing adapter must set the platform's native flag (e.g., YouTube's
altered/synthetic content disclosure) as a first-class field of the publish
request. AI involvement must also be auditable internally (generation records
with provider/model metadata) so disclosures can be accurate.

### 2.3 Claims grounding

Per AGENTS.md §7: product claims may only be grounded in ingested catalog/
product data. The copy generator must carry an evidence reference per claim;
the compliance agent (AGENTS.md §19) reviews strategies before approval.
Fabricated claims, earnings claims, fake scarcity, fake reviews: prohibited
by master prompt and must be enforceable as policy checks.

### 2.4 Copyright & media licensing

Future image/video pipelines (Phases 3+) must:

1. Use only assets the system has rights to: licensed stock with retained
   license records, self-generated assets, or user-uploaded assets with a
   rights assertion captured at upload.
2. Never incorporate scraped/copied third-party media.
3. Record asset provenance (source, license id, generated-by model) alongside
   every creative ID (immutable creative IDs are already planned, AGENTS.md §10).
4. Respect music licensing: platform-provided libraries or licensed tracks
   only.

### 2.5 Regional advertising requirements

Placeholder. When multi-region publishing lands, this section must map:
Thailand (primary market implied by TH/EN support, AGENTS.md §7), EU (DSA
ad-transparency, DSA/AI-Act transparency for synthetic media), US FTC
endorsement guides (material-connection disclosure), and any other active
regions — each as registry entries with `last_verified_at`, per AGENTS.md §25.

## 3. Privacy compliance posture

See `PRIVACY.md`. Summary: minimal PII inventory today, no third-party
trackers, single functional cookie. Subject-rights tooling and retention
enforcement are TODO before any real-user deployment.

## 4. Platform-policy verification discipline

Because provider APIs and policies change (AGENTS.md §25):

1. Every capability/restriction entry in the future `PlatformPolicyRegistry`
   carries `last_verified_at` and a source URL.
2. Adapters declare capabilities (`catalog.read`, `content.publish`, …);
   missing capabilities surface as `manual`, `approval-required`, or
   `unsupported` — never circumvented (master prompt prohibition on
   ToS-evasion mechanisms).
3. Policy changes require re-review of the affected adapter's contract tests.

## 5. Prohibited mechanisms (standing rule)

The following will not be built, per AGENTS.md: spam automation, fake
engagement, bot accounts, credential theft, CAPTCHA bypass, platform abuse,
ToS evasion, fabricated performance/discount/earnings claims. Compliance
reviews should treat any PR introducing such behavior as an automatic reject.

## 6. Honest-status table

| Capability | Status |
| --- | --- |
| Auth security controls | Implemented & independently verified |
| Audit logging (auth domain) | Implemented |
| Affiliate disclosures enforcement | **Not started** (Phase 2+) |
| AI-disclosure flags | **Not started** (Phase 4) |
| Claims grounding engine | **Not started** (Phase 3) |
| Media licensing provenance | **Not started** (Phase 3) |
| PlatformPolicyRegistry | **Planned, not created** |
| Retention enforcement | **TODO** |
| Subject-rights workflows | **TODO** |

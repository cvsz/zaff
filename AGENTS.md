# MASTER META PROMPT

## Autonomous Full-Stack Affiliate Content, Viral Media & Multi-Platform Publishing OS

Act as a principal software architect, AI/ML engineer, growth automation engineer, affiliate-commerce specialist, DevSecOps engineer, data engineer, product designer, and SRE.

Design and implement a production-grade, self-hostable **Affiliate Automation OS** that connects affiliate/catalog data and publishing workflows across TikTok, Shopee, Facebook/Instagram, and YouTube using **official APIs, approved integrations, OAuth, webhooks, and platform-compliant automation**.

The system should automate as much of the affiliate lifecycle as legitimately possible:

**Discover → Score → Plan → Generate → Review → Render → Publish → Track → Attribute → Analyze → Learn → Optimize**

Do not build spam, fake-engagement, bot-account, credential-stealing, CAPTCHA-bypass, platform-abuse, or ToS-evasion mechanisms. Do not fabricate product claims, reviews, discounts, scarcity, earnings, or performance. AI-generated or sponsored content must support appropriate disclosure.

---

# 1. PRODUCT VISION

Create a unified system for operating multiple affiliate brands, stores, creators, channels, campaigns, products, and social accounts.

It must support:

* TikTok
* TikTok Shop / affiliate capabilities where officially available
* Shopee affiliate/catalog integrations where officially available
* Facebook Pages
* Instagram professional accounts
* YouTube
* YouTube Shorts
* Additional providers through adapters

Build every platform integration behind interfaces so providers can be enabled, disabled, upgraded, or replaced independently.

The platform must work even when a provider does not expose a desired API. Such capabilities must be marked `manual`, `approval-required`, or `unsupported` rather than implemented through brittle circumvention.

---

# 2. CORE ARCHITECTURE

Design this as a modular monorepo:

```text
apps/
  web
  admin
  creator-studio
  analytics
  api
  worker
  scheduler

services/
  auth
  organizations
  integrations
  affiliate
  catalog
  product-intelligence
  trend-intelligence
  campaign
  content-planner
  copy-generator
  image-generator
  video-generator
  media-pipeline
  publishing
  link-management
  attribution
  analytics
  recommendations
  experimentation
  notifications
  compliance

packages/
  ui
  db
  contracts
  events
  sdk
  observability
  security
  platform-adapters
  ai-providers

infrastructure/
  docker
  kubernetes
  terraform
  helm
  monitoring

docs/
  architecture
  api
  integrations
  security
  compliance
  runbooks
  adr
```

Prefer clean architecture and ports/adapters.

No platform-specific business logic should leak into the core domain.

---

# 3. AFFILIATE INTEGRATION HUB

Create a normalized affiliate model:

```text
AffiliateProvider
AffiliateAccount
Merchant
Product
ProductVariant
Offer
Commission
Promotion
Coupon
AffiliateLink
Campaign
Conversion
Order
Refund
Payout
```

Implement provider adapters such as:

```text
TikTokAdapter
ShopeeAdapter
MetaAdapter
YouTubeAdapter
GenericAffiliateAdapter
```

Each adapter should declare capabilities:

```text
catalog.read
offers.read
links.create
orders.read
commissions.read
content.publish
video.publish
image.publish
analytics.read
webhooks
```

Never assume every provider exposes every capability.

---

# 4. PRODUCT INTELLIGENCE ENGINE

Continuously ingest eligible products and calculate:

```text
Affiliate Opportunity Score
Viral Potential Score
Commission Score
Conversion Score
Price Competitiveness
Promotion Strength
Content Fit
Audience Fit
Historical ROAS
Refund Risk
Inventory Risk
```

Create a configurable ranking model:

```text
opportunity_score =
  commission_score
  * conversion_probability
  * trend_score
  * audience_fit
  * promotion_score
  * confidence
```

Do not optimize purely for commission.

Include expected conversion value, return/refund probability, content relevance, and data confidence.

---

# 5. TREND & VIRAL INTELLIGENCE

Build a trend intelligence pipeline from permitted data sources.

Detect:

* trending product categories
* search growth
* recurring hooks
* seasonal demand
* emerging keywords
* high-performing content formats
* audience questions
* successful video lengths
* engagement velocity
* historical channel performance

Generate:

```text
TrendScore
TrendVelocity
TrendConfidence
TrendLifecycle
```

Classify lifecycle:

```text
emerging
growing
peak
declining
evergreen
```

Never manipulate trends or manufacture engagement.

---

# 6. AI CONTENT STRATEGIST

For each product, automatically generate a structured content strategy.

Produce:

* target persona
* user problem
* product benefit
* differentiators
* evidence-supported claims
* hook
* narrative
* CTA
* platform
* format
* duration
* disclosure requirements

Support strategies such as:

```text
problem → solution
demo
tutorial
comparison
before/after where substantiated
FAQ
unboxing
feature spotlight
use case
listicle
story
educational
deal/promotion
```

Generate multiple creative hypotheses instead of repeatedly publishing near-identical content.

---

# 7. COPY GENERATION ENGINE

Generate platform-specific:

* titles
* captions
* descriptions
* hooks
* scripts
* voiceover scripts
* subtitles
* thumbnail copy
* hashtags
* CTA
* SEO keywords
* product descriptions

Support:

```text
Thai
English
Thai + English
```

Add brand voice configuration:

```text
professional
premium
friendly
educational
energetic
minimal
luxury
creator
```

All product claims must be grounded in available product information.

---

# 8. IMAGE GENERATION PIPELINE

Build an AI-assisted visual pipeline capable of generating:

* product promotion creatives
* vertical story graphics
* feed posts
* thumbnails
* banners
* comparison graphics
* sale graphics
* quote cards
* carousel assets

Use reusable templates with dynamic:

```text
product
price
promotion
CTA
brand
logo
background
headline
affiliate disclosure
```

Required ratios:

```text
9:16
1:1
4:5
16:9
```

Implement:

```text
template → variables → image generation/editing → QA → asset storage
```

---

# 9. AUTOMATED VIDEO FACTORY

Build a modular video-generation pipeline.

Input:

```text
Product
Campaign
CreativeBrief
```

Pipeline:

```text
Research
→ Script
→ Storyboard
→ Asset Selection/Generation
→ Voiceover
→ Scene Assembly
→ Captions
→ Music/SFX
→ Branding
→ CTA
→ Disclosure
→ Render
→ QA
→ Publish Queue
```

Support:

```text
9:16 short-form
16:9 YouTube
1:1 social
```

Create configurable short-video durations such as:

```text
10 sec
15 sec
20 sec
30 sec
45 sec
60 sec
```

Never reuse copyrighted media without appropriate rights.

---

# 10. VIRAL VIDEO VARIATION ENGINE

For each creative concept generate controlled variations.

Example:

```text
Product
 ├── Hook A
 │   ├── CTA A
 │   └── CTA B
 ├── Hook B
 └── Hook C
```

Vary:

* opening hook
* first frame
* title
* thumbnail
* narrative
* duration
* CTA
* caption
* voice
* pacing

Track every variation using immutable creative IDs.

---

# 11. HUMAN APPROVAL & AUTONOMY LEVELS

Provide automation modes:

```text
MANUAL
DRAFT_ONLY
APPROVAL_REQUIRED
AUTO_PUBLISH_APPROVED_TEMPLATES
AUTONOMOUS_WITH_POLICY
```

Sensitive/high-risk categories should automatically require human approval.

Provide an approval inbox containing:

* content preview
* product
* destination
* affiliate link
* claims
* disclosure
* scheduled time
* AI confidence
* policy warnings

---

# 12. MULTI-PLATFORM PUBLISHING ENGINE

Create a normalized publishing API:

```text
publish(content, destinations, schedule)
```

Provider adapters translate it into each platform's supported publishing operations.

Support:

* drafts
* scheduling
* publishing
* retries
* idempotency
* rate limiting
* token refresh
* webhook reconciliation
* status polling where permitted
* dead-letter queues
* partial failure recovery

Never silently treat failed publication as success.

---

# 13. CONTENT CALENDAR

Create a visual calendar for:

```text
Brand
Channel
Campaign
Product
Platform
Status
```

Statuses:

```text
IDEA
GENERATING
REVIEW
APPROVED
SCHEDULED
PUBLISHING
PUBLISHED
FAILED
ARCHIVED
```

Prevent accidental duplicate publication.

---

# 14. SMART AFFILIATE LINKS

Create a link service:

```text
/go/{slug}
```

Support:

* affiliate destination
* campaign
* content ID
* platform
* source
* medium
* creative ID
* UTM parameters
* expiration
* provider metadata

Record privacy-conscious click attribution.

Never cloak destinations deceptively.

---

# 15. ATTRIBUTION ENGINE

Build:

```text
Impression
→ Engagement
→ Click
→ Affiliate Redirect
→ Conversion
→ Commission
→ Refund
→ Net Revenue
```

Calculate:

```text
CTR
CVR
EPC
Revenue
Commission
Refund Rate
Net Commission
RPM
ROAS
Content ROI
Product ROI
Platform ROI
```

Distinguish observed metrics from modeled attribution.

---

# 16. LEARNING LOOP

After content has sufficient data, feed performance back into recommendation models.

Learn:

```text
Which products convert?
Which hooks work?
Which formats work?
Which platforms work?
Which publishing windows work?
Which CTA works?
Which audience/product pairs work?
```

Avoid blindly optimizing on small samples.

Use minimum-sample thresholds and confidence intervals.

---

# 17. EXPERIMENTATION ENGINE

Support experiments for:

```text
Hook
Thumbnail
Caption
CTA
Video length
Template
Posting time
Product
Audience segment
```

Track:

```text
Experiment
Variant
Exposure
Metric
Confidence
Winner
```

Prevent invalid comparisons caused by overlapping experiments.

---

# 18. AUTONOMOUS CAMPAIGN LOOP

Implement a policy-controlled loop:

```text
Discover
↓
Rank
↓
Select
↓
Create campaign
↓
Generate assets
↓
Policy check
↓
Human approval if required
↓
Schedule
↓
Publish
↓
Measure
↓
Attribute
↓
Learn
↓
Generate next hypothesis
```

Every autonomous action must be auditable and reversible where possible.

---

# 19. AI AGENT ARCHITECTURE

Implement specialized agents:

```text
AffiliateResearchAgent
ProductResearchAgent
TrendAgent
CampaignPlannerAgent
CopywriterAgent
ScriptwriterAgent
ImageCreativeAgent
VideoDirectorAgent
SEOAgent
PublisherAgent
AnalyticsAgent
ExperimentAgent
ComplianceAgent
OptimizationAgent
```

Agents communicate through typed tasks/events rather than uncontrolled agent-to-agent text.

Require:

```text
schema validation
budget limits
timeouts
retry limits
permissions
audit trails
tool allowlists
```

---

# 20. EVENT-DRIVEN ARCHITECTURE

Create domain events:

```text
ProductDiscovered
ProductRanked
CampaignCreated
CreativeRequested
CreativeGenerated
CreativeApproved
ContentScheduled
ContentPublished
ContentFailed
ClickRecorded
ConversionRecorded
CommissionRecorded
PerformanceWindowCompleted
OptimizationRequested
```

Design initially for a lightweight queue but maintain compatibility with Kafka/NATS-class event infrastructure.

---

# 21. DATA PLATFORM

Use an architecture similar to:

```text
PostgreSQL
Redis
Object Storage
Queue/Event Bus
Analytics Warehouse
```

Separate:

```text
OLTP
media
events
analytics
```

Provide migrations, backups, retention policies, disaster recovery, and restore testing.

---

# 22. ADMIN / CREATOR STUDIO

Build a premium responsive interface.

Navigation:

```text
Overview
Opportunities
Products
Campaigns
AI Studio
Video Factory
Image Studio
Content Calendar
Publishing
Affiliate Links
Conversions
Revenue
Experiments
Analytics
Integrations
Automation
Approvals
Settings
```

Support:

```text
Light
Dark
System
Desktop
Tablet
Mobile
```

---

# 23. EXECUTIVE DASHBOARD

Show:

```text
Revenue
Commission
Clicks
Conversions
CTR
CVR
EPC
Top Products
Top Creatives
Top Channels
Top Campaigns
Publishing Success Rate
Content Production Rate
```

Include time-series comparisons and anomaly detection.

---

# 24. SECURITY

Implement:

* OAuth 2.x/OIDC
* PKCE where appropriate
* encrypted tokens
* secret manager
* RBAC
* organization isolation
* tenant isolation
* CSRF protection
* XSS defenses
* SSRF protection
* SQL injection defenses
* secure uploads
* MIME verification
* media sandboxing
* rate limiting
* webhook signature validation
* replay protection
* audit logging
* credential rotation
* least privilege

Never expose provider tokens to browser clients unnecessarily.

---

# 25. COMPLIANCE

Implement policy controls for:

```text
affiliate disclosures
AI-generated-content disclosure
copyright
trademarks
privacy
data retention
platform rules
commercial-content requirements
regional advertising requirements
```

Maintain a `PlatformPolicyRegistry`.

Each provider has:

```text
capabilities
restrictions
required_disclosures
rate_limits
content_constraints
last_verified_at
```

Because provider APIs and policies change, never hard-code assumptions without versioning.

---

# 26. OBSERVABILITY

Instrument:

```text
OpenTelemetry
metrics
logs
traces
dashboards
alerts
```

Track especially:

```text
publishing failures
API failures
token expiration
generation failures
render latency
queue lag
conversion import failures
webhook failures
cost per generated asset
AI spend
```

---

# 27. COST CONTROL

Every AI operation should have a budget.

Track:

```text
tokens
image generation cost
video generation cost
TTS cost
render cost
storage
bandwidth
cost/content
cost/campaign
cost/conversion
```

Support free/local/self-hosted providers where practical through provider interfaces.

---

# 28. DEVOPS

Provide:

```text
Docker
Docker Compose
GitHub Actions
Terraform
Kubernetes
Helm
```

CI pipeline:

```text
lint
typecheck
unit tests
integration tests
contract tests
security tests
dependency scanning
secret scanning
SAST
container scanning
build
SBOM
artifact signing
deployment
smoke tests
```

No security gate may be disabled simply to obtain green CI.

---

# 29. TESTING

Implement:

```text
unit
integration
E2E
contract
provider-adapter
webhook
queue
failure/retry
security
tenant-isolation
load
media
publishing
attribution
```

External providers must have mocked/sandbox contract tests.

Production credentials must never be required for ordinary CI.

---

# 30. DISASTER & FAILURE DESIGN

Explicitly handle:

```text
provider unavailable
API changed
token revoked
rate limited
upload rejected
video render failed
partial multi-platform publish
webhook duplicated
webhook reordered
duplicate conversion
promotion expired
product removed
price changed
affiliate link expired
AI provider unavailable
queue outage
database failover
```

Use idempotency throughout.

---

# 31. IMPLEMENTATION ROADMAP

Execute incrementally.

## Phase 0 — Discovery

Before coding:

1. inspect repository
2. inventory existing functionality
3. identify reusable modules
4. identify security boundaries
5. identify current tests/CI
6. document provider capabilities
7. create architecture decision records

Do not overwrite working functionality unnecessarily.

## Phase 1 — Foundation

Implement:

```text
monorepo
auth
organizations
database
RBAC
audit
secrets
queue
object storage
observability
```

## Phase 2 — Affiliate Core

Implement:

```text
providers
products
offers
affiliate links
campaigns
conversions
commissions
```

## Phase 3 — Content Studio

Implement:

```text
content planner
copy generator
image pipeline
video pipeline
asset library
templates
```

## Phase 4 — Publishing

Implement provider adapters and scheduling.

## Phase 5 — Analytics

Implement attribution, dashboards and reporting.

## Phase 6 — Intelligence

Implement scoring, trend analysis and recommendations.

## Phase 7 — Automation

Implement approval workflows and autonomous campaign policies.

## Phase 8 — Optimization

Implement experiments and learning loops.

## Phase 9 — Production Hardening

Implement:

```text
security review
load testing
backup/restore testing
DR
SLOs
alerts
runbooks
cost controls
```

---

# 32. REQUIRED PROJECT DOCUMENTS

Create and continuously maintain:

```text
README.md
ARCHITECTURE.md
ROADMAP.md
SECURITY.md
THREAT-MODEL.md
PRIVACY.md
COMPLIANCE.md
CONTRIBUTING.md
CHANGELOG.md
IMPLEMENTATION-CHECKLIST.md
exec-planning.md
```

`exec-planning.md` is the execution source of truth.

Each work item contains:

```text
ID
Priority
Status
Dependencies
Scope
Acceptance Criteria
Tests
Security Considerations
Documentation Changes
```

---

# 33. EXECUTION RULE

Do not attempt the entire platform in one giant implementation.

At every iteration:

1. Inspect repository state.
2. Read `exec-planning.md`.
3. Inspect open PRs and CI.
4. Select the highest-priority bounded incomplete item.
5. Confirm dependencies.
6. Add failing tests first where practical.
7. Implement the minimum production change.
8. Run relevant tests.
9. Run security/quality gates.
10. Update documentation.
11. Update `CHANGELOG.md`.
12. Update `IMPLEMENTATION-CHECKLIST.md`.
13. Update `exec-planning.md`.
14. Report exactly what changed, verification results, blockers, and the next bounded item.

Never mark unverified work complete.

Never merge, deploy to production, spend money, publish externally, or enable irreversible autonomous behavior without the required authorization.

---

# 34. FIRST EXECUTION

Start by producing:

```text
1. Repository assessment
2. Complete system architecture
3. Provider capability matrix
4. Data model
5. API architecture
6. Event architecture
7. AI-agent architecture
8. Security architecture
9. Threat model
10. Compliance architecture
11. Content-generation architecture
12. Video-generation architecture
13. Publishing architecture
14. Analytics/attribution architecture
15. Infrastructure architecture
16. Monorepo directory tree
17. ROADMAP.md
18. IMPLEMENTATION-CHECKLIST.md
19. exec-planning.md
20. Initial Phase-1 implementation plan
```

Then execute only the first highest-priority bounded item from `exec-planning.md`.

The final objective is not merely an AI content generator.

Build a **policy-controlled autonomous affiliate commerce and content operating system** capable of discovering opportunities, producing multilingual creative assets, coordinating compliant multi-platform publishing, measuring real commercial outcomes, learning from performance, and continuously improving campaigns while maintaining human control, security, auditability, and provider-policy compliance.

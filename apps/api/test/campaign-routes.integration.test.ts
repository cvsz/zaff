import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import postgres from "postgres";
import { AuthService, hashPassword } from "@zaff/auth";
import {
  createDb,
  createOffer,
  createProduct,
  createUser,
  listAuditEvents,
  listConversionsByOrg,
  migrateUp,
  upsertProvider,
} from "@zaff/db";
import { createTypedDomainEventBus, type DomainEvent } from "@zaff/events";
import { registerCampaignRoutes } from "../src/campaign-routes.js";

const TEST_URL =
  process.env.ZAFF_TEST_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff";

let dbAvailable = true;
try {
  const probe = postgres(TEST_URL, { connect_timeout: 3, max: 1 });
  await probe`SELECT 1`;
  await probe.end();
} catch {
  dbAvailable = false;
}

const suite = describe.skipIf(!dbAvailable);

const TIKTOK_SECRET = "test-tiktok-ingest-secret";
const SHOPEE_SECRET = "test-shopee-ingest-secret";

interface Jar {
  cookie: string;
}

function csrfHeaders(jar?: Jar): Record<string, string> {
  return {
    "x-requested-with": "zaff",
    "content-type": "application/json",
    ...(jar ? { cookie: jar.cookie } : {}),
  };
}

function signedWebhook(
  base: string,
  providerCode: string,
  secret: string,
  payloadBody: string,
  options: { timestampSeconds?: number; signatureOverride?: string; omitSignature?: boolean } = {}
): Promise<Response> {
  const timestampSeconds =
    options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature =
    options.signatureOverride ??
    createHmac("sha256", secret)
      .update(`${providerCode}.${timestampSeconds}.${payloadBody}`)
      .digest("hex");
  return fetch(`${base}/webhooks/affiliates/${providerCode}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zaff-timestamp": String(timestampSeconds),
      ...(options.omitSignature ? {} : { "x-zaff-signature": signature }),
    },
    body: payloadBody,
  });
}

function conversionPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    externalOrderId: "order-1001",
    linkSlug: "promo-1",
    amount: 100,
    currency: "THB",
    occurredAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  });
}

suite("apps/api campaign & conversion routes", () => {
  const db = createDb(TEST_URL);
  const authService = new AuthService(db);
  const { typed } = createTypedDomainEventBus();

  let server: Server;
  let baseUrl: string;
  const observedEvents: DomainEvent[] = [];

  let orgAId: string;
  let _orgBId: string;
  let ownerJar: Jar;
  let adminJar: Jar;
  let memberJar: Jar;
  let viewerJar: Jar;
  let ownerBJar: Jar;

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS audit_log, sessions, users, organizations, schema_migrations, conversions, affiliate_links, campaigns, offers, products, merchants, affiliate_providers, clicks CASCADE"
    );
  }

  async function loginJar(email: string, password: string): Promise<Jar> {
    const session = await authService.login(email, password);
    return { cookie: `zaff_session=${session.token}` };
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);

    const owner = await authService.register({
      orgName: "Routes Org A",
      email: `owner-a-${Date.now()}@routes.test`,
      password: "owner-pass-123",
    });
    orgAId = owner.orgId;
    ownerJar = await loginJar(owner.email, "owner-pass-123");

    const adminEmail = `admin-a-${Date.now()}@routes.test`;
    await createUser(db, {
      orgId: orgAId,
      email: adminEmail,
      role: "admin",
      passwordHash: await hashPassword("admin-pass-123"),
    });
    adminJar = await loginJar(adminEmail, "admin-pass-123");

    const memberEmail = `member-a-${Date.now()}@routes.test`;
    await createUser(db, {
      orgId: orgAId,
      email: memberEmail,
      role: "member",
      passwordHash: await hashPassword("member-pass-123"),
    });
    memberJar = await loginJar(memberEmail, "member-pass-123");

    const viewerEmail = `viewer-a-${Date.now()}@routes.test`;
    await createUser(db, {
      orgId: orgAId,
      email: viewerEmail,
      role: "viewer",
      passwordHash: await hashPassword("viewer-pass-123"),
    });
    viewerJar = await loginJar(viewerEmail, "viewer-pass-123");

    const ownerB = await authService.register({
      orgName: "Routes Org B",
      email: `owner-b-${Date.now()}@routes.test`,
      password: "owner-pass-123",
    });
    _orgBId = ownerB.orgId;
    ownerBJar = await loginJar(ownerB.email, "owner-pass-123");

    typed.subscribe("ConversionRecorded", (event) => {
      observedEvents.push(event);
    });

    await upsertProvider(db, { orgId: orgAId, code: "tiktok", name: "TikTok Affiliate" });

    const handleCampaignRoute = registerCampaignRoutes({
      db,
      authService,
      bus: typed,
      appBaseUrl: "https://links.example.test",
      webhookSecrets: { tiktok: TIKTOK_SECRET, shopee: SHOPEE_SECRET },
    });

    server = await new Promise<Server>((resolve, reject) => {
      const instance = createServer((req, res) => {
        void (async () => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          const result = await handleCampaignRoute(req, res, pathname);
          if (!result.handled) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not_found" }));
          }
        })().catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      instance.once("error", reject);
      instance.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (!dbAvailable) return;
    await typed.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db.end();
  });

  it("allows admin+ to create a campaign and rejects duplicate names", async () => {
    const created = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      method: "POST",
      headers: csrfHeaders(ownerJar),
      body: JSON.stringify({ name: "Owner Campaign", objective: "awareness", budgetLimit: 500 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { campaign: { status: string; name: string } };
    expect(body.campaign.status).toBe("draft");
    expect(body.campaign.name).toBe("Owner Campaign");

    const duplicate = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      method: "POST",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ name: "Owner Campaign" }),
    });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: string }).error).toBe("duplicate_name");
  });

  it("lists campaigns for member+ and denies viewer", async () => {
    const memberOk = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      headers: { cookie: memberJar.cookie },
    });
    expect(memberOk.status).toBe(200);
    const body = (await memberOk.json()) as { campaigns: unknown[] };
    expect(body.campaigns.length).toBeGreaterThanOrEqual(1);

    const viewerDenied = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      headers: { cookie: viewerJar.cookie },
    });
    expect(viewerDenied.status).toBe(403);

    const crossOrg = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      headers: { cookie: ownerBJar.cookie },
    });
    expect(crossOrg.status).toBe(403);
  });

  it("denies campaign creation below admin and without CSRF header", async () => {
    const memberDenied = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      method: "POST",
      headers: csrfHeaders(memberJar),
      body: JSON.stringify({ name: "Member Campaign" }),
    });
    expect(memberDenied.status).toBe(403);

    const noCsrf = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminJar.cookie },
      body: JSON.stringify({ name: "No Csrf Campaign" }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("validates legal status transitions and returns 404 for unknown campaigns", async () => {
    const created = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns`, {
      method: "POST",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ name: "Transition Probe" }),
    });
    const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

    const activated = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns/${campaignId}/status`, {
      method: "PATCH",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ status: "active" }),
    });
    expect(activated.status).toBe(200);
    expect(((await activated.json()) as { campaign: { status: string } }).campaign.status).toBe("active");

    const illegal = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns/${campaignId}/status`, {
      method: "PATCH",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ status: "draft" }),
    });
    expect(illegal.status).toBe(409);
    expect(((await illegal.json()) as { error: string }).error).toBe("transition_illegal");

    const missing = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns/00000000-0000-4000-8000-000000000000/status`, {
      method: "PATCH",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ status: "paused" }),
    });
    expect(missing.status).toBe(404);

    const memberDenied = await fetch(`${baseUrl}/orgs/${orgAId}/campaigns/${campaignId}/status`, {
      method: "PATCH",
      headers: csrfHeaders(memberJar),
      body: JSON.stringify({ status: "paused" }),
    });
    expect(memberDenied.status).toBe(403);
  });

  it("creates affiliate links with shortUrl and enforces slug uniqueness", async () => {
    const first = await fetch(`${baseUrl}/orgs/${orgAId}/links`, {
      method: "POST",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ slug: "promo-1", targetUrl: "https://merchant.example/p/1" }),
    });
    expect(first.status).toBe(201);
    const body = (await first.json()) as { slug: string; shortUrl: string };
    expect(body.slug).toBe("promo-1");
    expect(body.shortUrl).toBe("https://links.example.test/go/promo-1");

    const duplicate = await fetch(`${baseUrl}/orgs/${orgAId}/links`, {
      method: "POST",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({ slug: "promo-1", targetUrl: "https://merchant.example/p/2" }),
    });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: string }).error).toBe("slug_taken");

    const memberDenied = await fetch(`${baseUrl}/orgs/${orgAId}/links`, {
      method: "POST",
      headers: csrfHeaders(memberJar),
      body: JSON.stringify({ targetUrl: "https://merchant.example/p/3" }),
    });
    expect(memberDenied.status).toBe(403);
  });

  it("rejects webhook calls with bad signatures", async () => {
    const tamperedBody = await signedWebhook(baseUrl, "tiktok", TIKTOK_SECRET, conversionPayload(), {
      signatureOverride: createHmac("sha256", "wrong-secret")
        .update(`tiktok.${Math.floor(Date.now() / 1000)}.${conversionPayload()}`)
        .digest("hex"),
    });
    expect(tamperedBody.status).toBe(401);

    const mismatched = await signedWebhook(
      baseUrl,
      "tiktok",
      TIKTOK_SECRET,
      '{"externalOrderId":"tampered"}',
      {
        signatureOverride: createHmac("sha256", TIKTOK_SECRET)
          .update(`tiktok.${Math.floor(Date.now() / 1000)}.{"other":"body"}`)
          .digest("hex"),
      }
    );
    expect(mismatched.status).toBe(401);
    expect(((await mismatched.json()) as { error: string }).error).toBe("invalid_signature");
  });

  it("rejects stale timestamps as replays", async () => {
    const response = await signedWebhook(
      baseUrl,
      "tiktok",
      TIKTOK_SECRET,
      conversionPayload({ externalOrderId: "stale-order" }),
      { timestampSeconds: Math.floor(Date.now() / 1000) - 301 }
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("replay_rejected");
  });

  it("rejects webhooks with missing or malformed auth headers", async () => {
    const noSignature = await signedWebhook(
      baseUrl,
      "tiktok",
      TIKTOK_SECRET,
      conversionPayload({ externalOrderId: "no-sig" }),
      { omitSignature: true }
    );
    expect(noSignature.status).toBe(401);

    const malformedSig = await signedWebhook(
      baseUrl,
      "tiktok",
      TIKTOK_SECRET,
      conversionPayload({ externalOrderId: "bad-hex" }),
      { signatureOverride: "zzzz-not-hex" }
    );
    expect(malformedSig.status).toBe(401);
  });

  it("returns 404 for unknown provider codes on an otherwise valid webhook", async () => {
    const response = await signedWebhook(
      baseUrl,
      "shopee",
      SHOPEE_SECRET,
      conversionPayload({ externalOrderId: "shopee-order-1" }),
      {}
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("unknown_provider");
  });

  it("returns 422 for unresolvable link slugs", async () => {
    const response = await signedWebhook(
      baseUrl,
      "tiktok",
      TIKTOK_SECRET,
      conversionPayload({ linkSlug: "no-such-slug" }),
      {}
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe("unresolvable_link");
  });

  it("returns 400 with issue summary for malformed payloads", async () => {
    const response = await signedWebhook(
      baseUrl,
      "tiktok",
      TIKTOK_SECRET,
      JSON.stringify({ externalOrderId: "", amount: -5, currency: "THBB" }),
      {}
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("invalid_payload");
    expect(body.issues).toContain("externalOrderId");
  });

  it("ingests a valid webhook end-to-end with commission math, event, audit, and dedup", async () => {
    const product = await createProduct(db, {
      orgId: orgAId,
      title: "Test Widget",
    });
    const offer = await createOffer(db, {
      orgId: orgAId,
      productId: product.id,
      url: "https://merchant.example/offer",
      commissionType: "percentage",
      commissionValue: 10,
    });
    await fetch(`${baseUrl}/orgs/${orgAId}/links`, {
      method: "POST",
      headers: csrfHeaders(adminJar),
      body: JSON.stringify({
        slug: "offer-link",
        offerId: offer.id,
        targetUrl: "https://merchant.example/widget",
      }),
    });

    const occurredAt = new Date().toISOString();
    const payloadBody = JSON.stringify({
      externalOrderId: "tt-order-77",
      linkSlug: "offer-link",
      amount: 250.5,
      currency: "THB",
      occurredAt,
      status: "confirmed",
    });
    const response = await signedWebhook(baseUrl, "tiktok", TIKTOK_SECRET, payloadBody, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deduped: boolean;
      conversion: { amount: string; commissionAmount: string; status: string; currency: string };
    };
    expect(body.deduped).toBe(false);
    expect(body.conversion.amount).toBe("250.50");
    expect(body.conversion.commissionAmount).toBe("25.05");
    expect(body.conversion.currency).toBe("THB");

    await typed.waitForIdle();
    const recorded = observedEvents.find(
      (event) =>
        event.type === "ConversionRecorded" &&
        event.orderId === "tt-order-77"
    ) as Extract<DomainEvent, { type: "ConversionRecorded" }> | undefined;
    expect(recorded).toBeDefined();
    expect(recorded?.amountCents).toBe(25050);
    expect(recorded?.currency).toBe("THB");
    expect(recorded?.orgId).toBe(orgAId);

    const audits = await listAuditEvents(db, orgAId);
    const audit = audits.find((event) => event.action === "conversion.webhook_recorded");
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain(TIKTOK_SECRET);
    expect(JSON.stringify(audit ?? {})).not.toContain(payloadBody);

    const replay = await signedWebhook(baseUrl, "tiktok", TIKTOK_SECRET, payloadBody, {});
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { deduped: boolean };
    expect(replayBody.deduped).toBe(true);

    const conversions = await listConversionsByOrg(db, orgAId, {});
    const matching = conversions.filter((c) => c.externalOrderId === "tt-order-77");
    expect(matching.length).toBe(1);
  });

  it("lists conversions with aggregate summary for admin+ only", async () => {
    const ok = await fetch(`${baseUrl}/orgs/${orgAId}/conversions`, {
      headers: { cookie: adminJar.cookie },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      conversions: { externalOrderId: string }[];
      summary: { status: string; count: number; totalCommission: string }[];
    };
    expect(body.conversions.some((c) => c.externalOrderId === "tt-order-77")).toBe(true);
    const pendingRow = body.summary.find((row) => row.status === "pending");
    expect(pendingRow?.count).toBeGreaterThan(0);
    expect(Number(pendingRow?.totalCommission)).toBeGreaterThan(0);

    const filtered = await fetch(
      `${baseUrl}/orgs/${orgAId}/conversions?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      { headers: { cookie: adminJar.cookie } }
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as { conversions: unknown[] };
    expect(filteredBody.conversions.length).toBe(0);

    const invalidFrom = await fetch(`${baseUrl}/orgs/${orgAId}/conversions?from=not-a-date`, {
      headers: { cookie: adminJar.cookie },
    });
    expect(invalidFrom.status).toBe(400);

    const memberDenied = await fetch(`${baseUrl}/orgs/${orgAId}/conversions`, {
      headers: { cookie: memberJar.cookie },
    });
    expect(memberDenied.status).toBe(403);

    const crossOrg = await fetch(`${baseUrl}/orgs/${orgAId}/conversions`, {
      headers: { cookie: ownerBJar.cookie },
    });
    expect(crossOrg.status).toBe(403);
  });
});

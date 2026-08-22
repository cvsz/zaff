import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import postgres from "postgres";
import { AuthService, hashPassword } from "@zaff/auth";
import {
  createAffiliateLink,
  createDb,
  createOffer,
  createProduct,
  createUser,
  migrateUp,
  upsertProvider,
} from "@zaff/db";
import { createTypedDomainEventBus, type DomainEvent } from "@zaff/events";
import { startServer } from "../src/server.js";

const TEST_URL =
  process.env.ZAFF_TEST_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff";

const TEST_SALT = "test-click-salt";
const FORWARDED_IP = "203.0.113.7";
const EXPECTED_IP_HASH = createHash("sha256")
  .update(`${FORWARDED_IP}${TEST_SALT}`)
  .digest("hex")
  .slice(0, 16);

let dbAvailable = true;
try {
  const probe = postgres(TEST_URL, { connect_timeout: 3, max: 1 });
  await probe`SELECT 1`;
  await probe.end();
} catch {
  dbAvailable = false;
}

const suite = describe.skipIf(!dbAvailable);

interface Jar {
  cookie?: string;
}

function csrfHeaders(): Record<string, string> {
  return { "x-requested-with": "zaff", "content-type": "application/json" };
}

async function waitFor<T>(
  poll: () => Promise<T | undefined>,
  timeoutMs = 3000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await poll();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite("apps/api link routes", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  const db = createDb(TEST_URL);
  const authService = new AuthService(db);
  const { typed } = createTypedDomainEventBus();
  const clickEvents: DomainEvent[] = [];
  typed.subscribe("ClickRecorded", (event) => {
    clickEvents.push(event);
  });

  let server: Server;
  let baseUrl: string;
  let orgId: string;
  let ownerJar: Jar;
  let viewerJar: Jar;
  let crossOrgJar: Jar;
  let activeSlug: string;
  let activeLinkId: string;

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS clicks, audit_log, sessions, users, organizations, schema_migrations CASCADE"
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);

    const owner = await authService.register({
      orgName: "Link Org A",
      email: "owner@links.test",
      password: "owner-pass-123",
    });
    orgId = owner.orgId;

    const viewerEmail = `viewer-${Date.now()}@links.test`;
    await createUser(db, {
      orgId,
      email: viewerEmail,
      role: "viewer",
      passwordHash: await hashPassword("viewer-pass-123"),
    });

    await authService.register({
      orgName: "Link Org B",
      email: "owner-b@links.test",
      password: "b-pass-123456",
    });

    await upsertProvider(db, {
      orgId,
      code: "shopee",
      name: "Shopee",
      capabilities: ["catalog.read", "links.create"],
    });
    const product = await createProduct(db, {
      orgId,
      title: "Test Gadget",
      priceAmount: 199.0,
    });
    const offer = await createOffer(db, {
      orgId,
      productId: product.id,
      url: "https://merchant.example/p/123",
      commissionType: "percentage",
      commissionValue: 5,
    });

    activeSlug = `active-${randomSuffix()}`;
    const activeLink = await createAffiliateLink(db, {
      orgId,
      campaignId: null,
      offerId: offer.id,
      slug: activeSlug,
      targetUrl: "https://merchant.example/p/123?ref=affiliate",
      utm: { utm_source: "tiktok", utm_campaign: "launch" },
    });
    activeLinkId = activeLink.id;

    await createAffiliateLink(db, {
      orgId,
      campaignId: null,
      offerId: null,
      slug: `expired-${randomSuffix()}`,
      targetUrl: "https://merchant.example/expired",
      expiresAt: new Date(Date.now() - 1000),
    });

    server = await startServer(0, {
      authService,
      linkRoutes: { db, authService, eventBus: typed, clickSalt: TEST_SALT },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    ownerJar = { cookie: await loginCookie("owner@links.test", "owner-pass-123") };
    viewerJar = { cookie: await loginCookie(viewerEmail, "viewer-pass-123") };
    crossOrgJar = { cookie: await loginCookie("owner-b@links.test", "b-pass-123456") };
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    typed.close();
    await typed.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
  });

  it("redirects a valid slug with merged UTM and records a hashed click without blocking", async () => {
    const response = await fetch(`${baseUrl}/go/${activeSlug}`, {
      redirect: "manual",
      headers: { "x-forwarded-for": `${FORWARDED_IP}, 10.0.0.1` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();

    const location = response.headers.get("location") ?? "";
    const target = new URL(location);
    expect(target.origin).toBe("https://merchant.example");
    expect(target.pathname).toBe("/p/123");
    expect(target.searchParams.get("ref")).toBe("affiliate");
    expect(target.searchParams.get("utm_source")).toBe("tiktok");
    expect(target.searchParams.get("utm_campaign")).toBe("launch");

    const row = await waitFor(async () => {
      const rows = await db`
        SELECT id, link_id AS "linkId", org_id AS "orgId", ip_hash AS "ipHash"
        FROM clicks WHERE link_id = ${activeLinkId}
      `;
      return rows[0] as Record<string, unknown> | undefined;
    });
    expect(row.linkId).toBe(activeLinkId);
    expect(row.orgId).toBe(orgId);
    expect(row.ipHash).toBe(EXPECTED_IP_HASH);
    expect(row.ipHash as string).toMatch(/^[0-9a-f]{16}$/);
    const rawRow = JSON.stringify(row);
    expect(rawRow).not.toContain(FORWARDED_IP);
    expect(rawRow).not.toContain("127.0.0.1");

    const observed = await waitFor(() =>
      clickEvents.find(
        (event) =>
          event.type === "ClickRecorded" &&
          event.linkId === activeLinkId &&
          event.orgId === orgId
      )
    );
    expect(observed.type).toBe("ClickRecorded");
  });

  it("returns 404 JSON for unknown and expired slugs", async () => {
    const unknown = await fetch(`${baseUrl}/go/nope-${randomSuffix()}`, {
      redirect: "manual",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    const body = (await unknown.json()) as { error: string };
    expect(body.error).toBe("not_found");

    const rows = await db`
      SELECT slug FROM affiliate_links WHERE org_id = ${orgId} AND expires_at IS NOT NULL
    `;
    const expiredSlug = (rows[0] as { slug: string }).slug;
    const expired = await fetch(`${baseUrl}/go/${expiredSlug}`, {
      redirect: "manual",
    });
    expect(expired.status).toBe(404);
  });

  it("requires session, member+ role, and matching org to list clicks", async () => {
    const unauth = await fetch(`${baseUrl}/orgs/${orgId}/links/${activeLinkId}/clicks`);
    expect(unauth.status).toBe(401);

    const crossOrg = await fetch(
      `${baseUrl}/orgs/${orgId}/links/${activeLinkId}/clicks`,
      { headers: { cookie: crossOrgJar.cookie ?? "" } }
    );
    expect(crossOrg.status).toBe(403);

    const viewer = await fetch(
      `${baseUrl}/orgs/${orgId}/links/${activeLinkId}/clicks`,
      { headers: { cookie: viewerJar.cookie ?? "" } }
    );
    expect(viewer.status).toBe(403);

    const owner = await fetch(
      `${baseUrl}/orgs/${orgId}/links/${activeLinkId}/clicks`,
      { headers: { cookie: ownerJar.cookie ?? "" } }
    );
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as { clicks: { id: string; linkId: string; clickedAt: string }[] };
    expect(body.clicks.length).toBeGreaterThanOrEqual(1);
    expect(body.clicks.every((click) => click.linkId === activeLinkId)).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(FORWARDED_IP);
    expect(serialized).not.toContain(EXPECTED_IP_HASH);
  });

  it("counts clicks per link through the repo", async () => {
    const { countClicksByLink } = await import("@zaff/db");
    const count = await countClicksByLink(db, orgId, activeLinkId);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("rate limits /go per ip hash returning 429", async () => {
    const limitedServer = await startServer(0, {
      authService,
      goRateLimit: { windowMs: 60_000, max: 2 },
      linkRoutes: { db, authService, eventBus: typed, clickSalt: TEST_SALT },
    });
    try {
      const address = limitedServer.address();
      if (!address || typeof address === "string") throw new Error("unexpected address");
      const url = `http://127.0.0.1:${address.port}`;
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await fetch(`${url}/go/${activeSlug}`, {
          redirect: "manual",
        });
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      expect(statuses.slice(0, 2)).toEqual([302, 302]);
      expect(statuses.slice(2)).toEqual([429, 429]);
    } finally {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    }
  });

  async function loginCookie(email: string, password: string): Promise<string> {
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
});

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  IllegalTransitionError,
  SlugTakenError,
  createAffiliateLink,
  createCampaign,
  createDb,
  createOffer,
  createOrganization,
  createProduct,
  activeOffersForProduct,
  aggregateCommissionByOrg,
  getProviderByCode,
  listConversionsByOrg,
  listProductsByOrg,
  migrateDown,
  migrateUp,
  OrgScopeError,
  recordConversion,
  resolveLinkBySlug,
  transitionCampaignStatus,
  updateConversionStatus,
  updateProductStatus,
  upsertProvider,
} from "../src/index.js";

const ADMIN_URL =
  process.env.ZAFF_TEST_ADMIN_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/postgres";
const BASE_URL =
  process.env.ZAFF_TEST_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff";

let dbAvailable = true;
try {
  const probe = postgres(ADMIN_URL, { connect_timeout: 3, max: 1 });
  await probe`SELECT 1`;
  await probe.end();
} catch {
  dbAvailable = false;
}

const suite = describe.skipIf(!dbAvailable);

const SCRATCH_DB = `zaff_aff_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
const SCRATCH_URL = BASE_URL.replace(/\/[^/]+$/, `/${SCRATCH_DB}`);

suite("packages/db affiliate repos (scratch db)", () => {
  const admin = createDb(ADMIN_URL);
  const db = createDb(SCRATCH_URL);

  beforeAll(async () => {
    if (!dbAvailable) return;
    await admin.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
    await migrateUp(db);
  }, 30_000);

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await admin.end();
  });

  it("runs the full provider→merchant→product→offer→link→conversion lifecycle", async () => {
    const org = await createOrganization(db, { name: "Affiliate Org" });

    const provider = await upsertProvider(db, {
      orgId: org.id,
      code: "tiktok",
      name: "TikTok Affiliate",
      capabilities: ["catalog.read", "links.create"],
    });
    expect(provider.id).toBeDefined();
    expect(provider.status).toBe("active");

    const updated = await upsertProvider(db, {
      orgId: org.id,
      code: "tiktok",
      name: "TikTok Shop",
      capabilities: ["catalog.read", "orders.read"],
    });
    expect(updated.id).toBe(provider.id);
    expect(updated.name).toBe("TikTok Shop");
    const fetched = await getProviderByCode(db, org.id, "tiktok");
    expect(fetched?.name).toBe("TikTok Shop");

    const product = await createProduct(db, {
      orgId: org.id,
      externalId: "tt-123",
      title: "Wireless Earbuds",
      priceAmount: 29.99,
      currency: "USD",
      metadata: { category: "audio" },
    });
    expect(product.status).toBe("discovered");
    expect(product.priceAmount).toBe("29.99");

    const evaluated = await updateProductStatus(db, org.id, product.id, "evaluated");
    expect(evaluated?.status).toBe("evaluated");
    const selected = await updateProductStatus(db, org.id, product.id, "selected");
    expect(selected?.status).toBe("selected");

    await createProduct(db, {
      orgId: org.id,
      title: "Phone Case",
      priceAmount: 9.99,
    });

    const allProducts = await listProductsByOrg(db, org.id, {});
    expect(allProducts).toHaveLength(2);
    const selectedOnly = await listProductsByOrg(db, org.id, { status: "selected" });
    expect(selectedOnly.map((p) => p.id)).toEqual([product.id]);
    const page = await listProductsByOrg(db, org.id, { limit: 1 });
    expect(page).toHaveLength(1);
    const rest = await listProductsByOrg(db, org.id, {
      limit: 10,
      cursor: { createdAt: page[0].createdAt, id: page[0].id },
    });
    expect(rest).toHaveLength(1);
    expect(rest[0].id).not.toBe(page[0].id);

    const offer = await createOffer(db, {
      orgId: org.id,
      productId: product.id,
      url: "https://example.com/offer/earbuds",
      commissionType: "percentage",
      commissionValue: 8.5,
    });
    expect(offer.active).toBe(true);

    const actives = await activeOffersForProduct(db, org.id, product.id);
    expect(actives.map((o) => o.id)).toEqual([offer.id]);

    const campaign = await createCampaign(db, {
      orgId: org.id,
      name: "Summer Audio",
      objective: "grow revenue",
      budgetLimit: 500,
    });
    expect(campaign.status).toBe("draft");
    const activated = await transitionCampaignStatus(
      db,
      org.id,
      campaign.id,
      "active"
    );
    expect(activated?.status).toBe("active");

    const link = await createAffiliateLink(db, {
      orgId: org.id,
      campaignId: campaign.id,
      offerId: offer.id,
      slug: "summer-earbuds",
      targetUrl: "https://shop.example.com/earbuds",
      utm: { source: "tiktok", medium: "video" },
    });
    expect(link.slug).toBe("summer-earbuds");

    const resolved = await resolveLinkBySlug(db, "summer-earbuds");
    expect(resolved?.id).toBe(link.id);
    expect(resolved?.utm).toEqual({ source: "tiktok", medium: "video" });

    const occurredAt = new Date("2026-08-01T12:00:00Z");
    const first = await recordConversion(db, {
      orgId: org.id,
      linkId: link.id,
      externalOrderId: "order-001",
      amount: 29.99,
      commissionAmount: 2.55,
      occurredAt,
    });
    expect(first.inserted).toBe(true);
    expect(first.conversion.status).toBe("pending");

    const duplicate = await recordConversion(db, {
      orgId: org.id,
      linkId: link.id,
      externalOrderId: "order-001",
      amount: 29.99,
      commissionAmount: 2.55,
      occurredAt,
    });
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.conversion.id).toBe(first.conversion.id);

    const second = await recordConversion(db, {
      orgId: org.id,
      linkId: link.id,
      externalOrderId: "order-002",
      amount: 50,
      commissionAmount: 5,
      occurredAt: new Date("2026-08-02T12:00:00Z"),
    });

    const conversions = await listConversionsByOrg(db, org.id, {});
    expect(conversions.map((c) => c.externalOrderId)).toEqual([
      "order-002",
      "order-001",
    ]);

    const aggregates = await aggregateCommissionByOrg(db, org.id, {});
    expect(aggregates).toEqual([{ status: "pending", count: 2, totalCommission: "7.55" }]);

    await updateConversionStatus(db, org.id, first.conversion.id, "refunded");
    const afterRefund = await aggregateCommissionByOrg(db, org.id, {});
    expect(afterRefund).toContainEqual({
      status: "refunded",
      count: 1,
      totalCommission: "2.55",
    });
    expect(afterRefund).toContainEqual({
      status: "pending",
      count: 1,
      totalCommission: "5.00",
    });
    expect(second.inserted).toBe(true);
  });

  it("rejects a duplicate slug with SlugTakenError", async () => {
    const org = await createOrganization(db, { name: "Slug Org" });
    await createAffiliateLink(db, {
      orgId: org.id,
      slug: "dup-slug",
      targetUrl: "https://example.com/a",
    });
    await expect(
      createAffiliateLink(db, {
        orgId: org.id,
        slug: "dup-slug",
        targetUrl: "https://example.com/b",
      })
    ).rejects.toThrow(SlugTakenError);
  });

  it("fails to resolve an expired link", async () => {
    const org = await createOrganization(db, { name: "Expiry Org" });
    await createAffiliateLink(db, {
      orgId: org.id,
      slug: "expired-deal",
      targetUrl: "https://example.com/expired",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await resolveLinkBySlug(db, "expired-deal")).toBeNull();
    const at = new Date("2025-12-31T23:59:59Z");
    expect((await resolveLinkBySlug(db, "expired-deal", at))?.slug).toBe(
      "expired-deal"
    );
  });

  it("isolates orgs: org B cannot read or mutate org A rows", async () => {
    const orgA = await createOrganization(db, { name: "Iso A" });
    const orgB = await createOrganization(db, { name: "Iso B" });

    const providerA = await upsertProvider(db, {
      orgId: orgA.id,
      code: "shopee",
      name: "Shopee A",
    });
    expect(providerA.orgId).toBe(orgA.id);
    expect(await getProviderByCode(db, orgB.id, "shopee")).toBeNull();

    const productA = await createProduct(db, {
      orgId: orgA.id,
      title: "Secret Gadget",
    });
    expect(
      await updateProductStatus(db, orgB.id, productA.id, "archived")
    ).toBeNull();
    expect(await listProductsByOrg(db, orgB.id, {})).toEqual([]);

    const offerA = await createOffer(db, {
      orgId: orgA.id,
      productId: productA.id,
      url: "https://example.com/iso",
      commissionType: "fixed",
      commissionValue: 3,
    });
    await expect(
      activeOffersForProduct(db, orgB.id, productA.id)
    ).rejects.toThrow(OrgScopeError);
    const campaignA = await createCampaign(db, { orgId: orgA.id, name: "Iso Campaign" });
    expect(
      await transitionCampaignStatus(db, orgB.id, campaignA.id, "active")
    ).toBeNull();
    const activated = await transitionCampaignStatus(
      db,
      orgA.id,
      campaignA.id,
      "active"
    );
    expect(activated?.status).toBe("active");

    const linkA = await createAffiliateLink(db, {
      orgId: orgA.id,
      offerId: offerA.id,
      slug: "iso-link",
      targetUrl: "https://example.com/iso-link",
    });
    await recordConversion(db, {
      orgId: orgA.id,
      linkId: linkA.id,
      externalOrderId: "order-iso-1",
      amount: 100,
      commissionAmount: 10,
      occurredAt: new Date("2026-08-03T00:00:00Z"),
    });

    expect(await listConversionsByOrg(db, orgB.id, {})).toEqual([]);
    expect(await aggregateCommissionByOrg(db, orgB.id, {})).toEqual([]);

    await expect(
      createAffiliateLink(db, {
        orgId: orgB.id,
        offerId: offerA.id,
        slug: "stolen-offer",
        targetUrl: "https://example.com/x",
      })
    ).rejects.toThrow(/does not belong to org/);
  });

  it("rejects illegal campaign transitions", async () => {
    const org = await createOrganization(db, { name: "Transition Org" });
    const campaign = await createCampaign(db, {
      orgId: org.id,
      name: "Lifecycle",
    });
    await transitionCampaignStatus(db, org.id, campaign.id, "active");
    await transitionCampaignStatus(db, org.id, campaign.id, "completed");
    await expect(
      transitionCampaignStatus(db, org.id, campaign.id, "active")
    ).rejects.toThrow(IllegalTransitionError);
    await expect(
      transitionCampaignStatus(db, org.id, crypto.randomUUID(), "active")
    ).resolves.toBeNull();
  });

  it("reverts and re-applies the affiliate migration cleanly", async () => {
    const reverted = await migrateDown(db, 1);
    expect(reverted).toEqual(["0006_affiliate.sql"]);
    const tables = (
      await db`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    ).map((r) => r.table_name as string);
    for (const t of [
      "conversions",
      "affiliate_links",
      "campaigns",
      "offers",
      "products",
      "merchants",
      "affiliate_providers",
    ]) {
      expect(tables).not.toContain(t);
    }
    await db.unsafe("DROP SCHEMA public CASCADE");
    await db.unsafe("CREATE SCHEMA public");
    expect(await migrateUp(db)).toContain("0006_affiliate.sql");
  });
});

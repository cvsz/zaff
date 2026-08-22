import { describe, expect, it } from "vitest";
import {
  AffiliateProviderSchema,
  AffiliateLinkSchema,
  CAMPAIGN_TRANSITIONS,
  CampaignSchema,
  canTransitionCampaign,
  ConversionSchema,
  CreateConversionInputSchema,
  MerchantSchema,
  OfferSchema,
  ProductSchema,
} from "./affiliate.js";

const uuid = "9b2f1a4e-3c5d-4e8f-9a0b-1c2d3e4f5a6b";
const uuid2 = "1c2d3e4f-5a6b-4c8d-9e0f-a1b2c3d4e5f6";
const now = new Date().toISOString();

describe("AffiliateProviderSchema", () => {
  it("parses a valid provider with capabilities", () => {
    const parsed = AffiliateProviderSchema.parse({
      id: uuid,
      orgId: uuid2,
      code: "tiktok",
      name: "TikTok Affiliate",
      capabilities: ["catalog.read", "links.create"],
      lastVerifiedAt: now,
      status: "active",
      createdAt: now,
    });
    expect(parsed.capabilities).toEqual(["catalog.read", "links.create"]);
  });

  it("allows null lastVerifiedAt", () => {
    const parsed = AffiliateProviderSchema.parse({
      id: uuid,
      orgId: uuid2,
      code: "shopee",
      name: "Shopee",
      capabilities: [],
      lastVerifiedAt: null,
      status: "disabled",
      createdAt: now,
    });
    expect(parsed.lastVerifiedAt).toBeNull();
  });

  it("rejects an unknown capability", () => {
    expect(() =>
      AffiliateProviderSchema.parse({
        id: uuid,
        orgId: uuid2,
        code: "tiktok",
        name: "TikTok",
        capabilities: ["orders.write"],
        lastVerifiedAt: null,
        status: "active",
        createdAt: now,
      })
    ).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() =>
      AffiliateProviderSchema.parse({
        id: uuid,
        orgId: uuid2,
        code: "tiktok",
        name: "TikTok",
        capabilities: [],
        lastVerifiedAt: null,
        status: "paused",
        createdAt: now,
      })
    ).toThrow();
  });
});

describe("MerchantSchema", () => {
  it("parses a valid merchant", () => {
    const parsed = MerchantSchema.parse({
      id: uuid,
      orgId: uuid2,
      providerId: uuid,
      externalId: "shop-123",
      name: "Acme Shop",
      createdAt: now,
    });
    expect(parsed.externalId).toBe("shop-123");
  });

  it("rejects an empty externalId", () => {
    expect(() =>
      MerchantSchema.parse({
        id: uuid,
        orgId: uuid2,
        providerId: uuid,
        externalId: "",
        name: "Acme Shop",
        createdAt: now,
      })
    ).toThrow();
  });
});

describe("ProductSchema", () => {
  const base = {
    id: uuid,
    orgId: uuid2,
    merchantId: null,
    externalId: null,
    title: "Wireless Earbuds",
    description: null,
    priceAmount: 29.99,
    currency: "USD",
    status: "discovered",
    metadata: {},
    createdAt: now,
  };

  it("parses a valid product", () => {
    expect(ProductSchema.parse(base).status).toBe("discovered");
  });

  it("rejects a negative price", () => {
    expect(() => ProductSchema.parse({ ...base, priceAmount: -1 })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      ProductSchema.parse({ ...base, status: "published" })
    ).toThrow();
  });

  it("rejects a currency that is not 3 chars", () => {
    expect(() => ProductSchema.parse({ ...base, currency: "USDT" })).toThrow();
  });
});

describe("OfferSchema", () => {
  const base = {
    id: uuid,
    productId: uuid2,
    url: "https://example.com/offer",
    commissionType: "percentage",
    commissionValue: 8.5,
    promotionLabel: null,
    startsAt: null,
    endsAt: null,
    active: true,
    createdAt: now,
  };

  it("parses a valid percentage offer", () => {
    expect(OfferSchema.parse(base).commissionValue).toBe(8.5);
  });

  it("accepts a percentage at exactly 100", () => {
    expect(() => OfferSchema.parse({ ...base, commissionValue: 100 })).not.toThrow();
  });

  it("rejects a percentage above 100", () => {
    expect(() => OfferSchema.parse({ ...base, commissionValue: 120 })).toThrow();
  });

  it("accepts a fixed commission above 100", () => {
    expect(() =>
      OfferSchema.parse({ ...base, commissionType: "fixed", commissionValue: 250 })
    ).not.toThrow();
  });

  it("rejects a negative commission", () => {
    expect(() => OfferSchema.parse({ ...base, commissionValue: -0.01 })).toThrow();
  });

  it("rejects an invalid url", () => {
    expect(() => OfferSchema.parse({ ...base, url: "not-a-url" })).toThrow();
  });
});

describe("CampaignSchema", () => {
  const base = {
    id: uuid,
    orgId: uuid2,
    name: "Summer Launch",
    status: "draft",
    objective: "grow revenue",
    budgetLimit: 500,
    createdAt: now,
  };

  it("parses a valid campaign", () => {
    expect(CampaignSchema.parse(base).status).toBe("draft");
  });

  it("rejects an unknown status", () => {
    expect(() => CampaignSchema.parse({ ...base, status: "archived" })).toThrow();
  });

  it("rejects a negative budget limit", () => {
    expect(() => CampaignSchema.parse({ ...base, budgetLimit: -5 })).toThrow();
  });
});

describe("campaign transitions", () => {
  it("allows legal transitions", () => {
    expect(canTransitionCampaign("draft", "active")).toBe(true);
    expect(canTransitionCampaign("active", "paused")).toBe(true);
    expect(canTransitionCampaign("paused", "completed")).toBe(true);
    expect(canTransitionCampaign("draft", "cancelled")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransitionCampaign("completed", "active")).toBe(false);
    expect(canTransitionCampaign("cancelled", "draft")).toBe(false);
    expect(canTransitionCampaign("draft", "completed")).toBe(false);
  });

  it("has no exits from terminal states", () => {
    expect(CAMPAIGN_TRANSITIONS.completed).toEqual([]);
    expect(CAMPAIGN_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe("AffiliateLinkSchema", () => {
  const base = {
    id: uuid,
    orgId: uuid2,
    campaignId: null,
    offerId: uuid,
    slug: "summer-deal-1",
    targetUrl: "https://track.example.com/go/abc",
    utm: { source: "tiktok", medium: "video" },
    expiresAt: null,
    createdAt: now,
  };

  it("parses a valid link", () => {
    expect(AffiliateLinkSchema.parse(base).slug).toBe("summer-deal-1");
  });

  it("rejects an uppercase or spaced slug", () => {
    expect(() => AffiliateLinkSchema.parse({ ...base, slug: "Bad Slug" })).toThrow();
  });

  it("rejects a non-string utm value", () => {
    expect(() =>
      AffiliateLinkSchema.parse({ ...base, utm: { source: 42 } })
    ).toThrow();
  });
});

describe("ConversionSchema / CreateConversionInputSchema", () => {
  const conversion = {
    id: uuid,
    orgId: uuid2,
    linkId: null,
    externalOrderId: "order-1",
    amount: 49.9,
    currency: "USD",
    commissionAmount: 4.99,
    status: "pending",
    occurredAt: now,
    recordedAt: now,
  };

  it("parses a valid conversion", () => {
    expect(ConversionSchema.parse(conversion).externalOrderId).toBe("order-1");
  });

  it("rejects negative amount on ConversionSchema", () => {
    expect(() => ConversionSchema.parse({ ...conversion, amount: -1 })).toThrow();
  });

  it("rejects negative commissionAmount on ConversionSchema", () => {
    expect(() =>
      ConversionSchema.parse({ ...conversion, commissionAmount: -0.5 })
    ).toThrow();
  });

  it("parses create-conversion input with defaults applied", () => {
    const parsed = CreateConversionInputSchema.parse({
      orgId: uuid2,
      linkId: null,
      externalOrderId: "order-1",
      amount: 10,
      occurredAt: now,
    });
    expect(parsed.currency).toBe("USD");
    expect(parsed.commissionAmount).toBe(0);
  });

  it("rejects negative amounts on create-conversion input", () => {
    expect(() =>
      CreateConversionInputSchema.parse({
        orgId: uuid2,
        linkId: null,
        externalOrderId: "order-1",
        amount: -10,
        occurredAt: now,
      })
    ).toThrow();
  });

  it("rejects an unknown conversion status", () => {
    expect(() => ConversionSchema.parse({ ...conversion, status: "shipped" })).toThrow();
  });
});

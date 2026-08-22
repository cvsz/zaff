import { describe, expect, it } from "vitest";
import {
  DOMAIN_EVENT_SCHEMAS,
  DOMAIN_EVENT_TYPES,
  DomainEventSchema,
} from "./domain.js";
import type { DomainEventType } from "./domain.js";

const uuid = "9b2f1a4e-3c5d-4e8f-9a0b-1c2d3e4f5a6b";
const uuid2 = "1c2d3e4f-5a6b-4c8d-9e0f-a1b2c3d4e5f6";
const now = new Date().toISOString();

const envelope = {
  id: uuid,
  orgId: uuid2,
  occurredAt: now,
  actor: uuid,
};

const SAMPLE_PAYLOADS: Record<DomainEventType, Record<string, unknown>> = {
  ProductDiscovered: { productId: uuid, source: "shopee-affiliate" },
  ProductRanked: { productId: uuid, opportunityScore: 0.82, rank: 1 },
  CampaignCreated: { campaignId: uuid, name: "Q4 Launch", productIds: [uuid] },
  CreativeRequested: { creativeId: uuid, campaignId: uuid2, format: "video" },
  CreativeGenerated: { creativeId: uuid, assetIds: [uuid2] },
  CreativeApproved: { creativeId: uuid, approverId: uuid2 },
  ContentScheduled: { contentId: uuid, channel: "tiktok-main", scheduledFor: now },
  ContentPublished: { contentId: uuid, channel: "tiktok-main", platform: "tiktok" },
  ContentFailed: { contentId: uuid, reason: "upload rejected", attempt: 2 },
  ClickRecorded: { linkId: uuid, platform: "tiktok" },
  ConversionRecorded: { conversionId: uuid, orderId: "SHOPEE-123456", amountCents: 159000, currency: "THB" },
  CommissionRecorded: { commissionId: uuid, conversionId: uuid2, amountCents: 23850, currency: "THB" },
  PerformanceWindowCompleted: {
    windowStart: now,
    windowEnd: now,
    metrics: { clicks: 120, conversions: 9 },
  },
  OptimizationRequested: {
    targetType: "campaign",
    targetId: uuid,
    reason: "cvr below threshold",
  },
};

describe("domain event schemas (AGENTS.md §20 contract)", () => {
  it("defines exactly the fourteen §20 event types", () => {
    expect(DOMAIN_EVENT_TYPES).toHaveLength(14);
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(14);
  });

  it("parses a valid sample of every §20 event type", () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      const sample = { type, ...envelope, ...SAMPLE_PAYLOADS[type] };
      const parsed = DOMAIN_EVENT_SCHEMAS[type].parse(sample);
      expect(parsed.type).toBe(type);
      expect(DomainEventSchema.parse(sample)).toEqual(parsed);
    }
  });

  it("accepts 'system' as the actor on every event type", () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      const sample = {
        type,
        ...envelope,
        actor: "system",
        ...SAMPLE_PAYLOADS[type],
      };
      expect(DomainEventSchema.safeParse(sample).success).toBe(true);
    }
  });

  it("rejects an unknown event type", () => {
    const result = DomainEventSchema.safeParse({
      type: "NotARealEvent",
      ...envelope,
    });
    expect(result.success).toBe(false);
  });

  it("rejects every event type when envelope fields are missing", () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      const sample = { type, ...SAMPLE_PAYLOADS[type] };
      expect(DomainEventSchema.safeParse(sample).success).toBe(false);
    }
  });

  it("rejects an invalid actor that is neither a userId nor 'system'", () => {
    const sample = {
      type: "ClickRecorded",
      ...envelope,
      actor: "anonymous",
      ...SAMPLE_PAYLOADS.ClickRecorded,
    };
    expect(DomainEventSchema.safeParse(sample).success).toBe(false);
  });
});

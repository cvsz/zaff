import { z } from "zod";
import { PlatformCapabilitySchema, UnknownProviderError } from "./types.js";

export const RateLimitRuleSchema = z.object({
  scope: z.string().min(1),
  maxPerWindow: z.number().int().positive(),
  windowSec: z.number().int().positive(),
});
export type RateLimitRule = z.infer<typeof RateLimitRuleSchema>;

/**
 * Versioned policy entry (AGENTS.md §25). `verifiedAgainst: 'docs-snapshot'`
 * marks every entry as derived from a documentation snapshot, not a live
 * conformance run; `lastVerifiedAt` records when that snapshot was taken.
 */
export const PolicyEntrySchema = z.object({
  capabilities: z.array(PlatformCapabilitySchema),
  restrictions: z.array(z.string()),
  requiredDisclosures: z.array(z.string()),
  rateLimits: z.array(RateLimitRuleSchema),
  contentConstraints: z.array(z.string()),
  lastVerifiedAt: z.string().datetime().nullable(),
  policyVersion: z.string().min(1),
  verifiedAgainst: z.literal("docs-snapshot"),
});
export type PolicyEntry = z.infer<typeof PolicyEntrySchema>;

export interface RegisteredPolicyEntry extends PolicyEntry {
  providerId: string;
}

export interface RegistryRecord {
  providerId: string;
  entry: PolicyEntry;
}

export class PlatformPolicyRegistry {
  private readonly entries = new Map<string, RegisteredPolicyEntry>();

  register(providerId: string, raw: unknown): RegisteredPolicyEntry {
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw new TypeError("providerId must be a non-empty string");
    }
    const entry: RegisteredPolicyEntry = {
      ...PolicyEntrySchema.parse(raw),
      providerId,
    };
    this.entries.set(providerId, entry);
    return entry;
  }

  get(providerId: string): RegisteredPolicyEntry {
    const entry = this.entries.get(providerId);
    if (!entry) {
      throw new UnknownProviderError(providerId);
    }
    return entry;
  }

  list(): RegistryRecord[] {
    return [...this.entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerId, entry]) => ({ providerId, entry }));
  }

  has(providerId: string): boolean {
    return this.entries.has(providerId);
  }
}

const SNAPSHOT_AT = "2026-06-30T00:00:00.000Z";
const POLICY_VERSION = "2026-06";

export function defaultPolicyRegistry(): PlatformPolicyRegistry {
  const registry = new PlatformPolicyRegistry();

  registry.register("tiktok-shop", {
    capabilities: [
      "catalog.read",
      "offers.read",
      "links.create",
      "orders.read",
      "commissions.read",
      "content.publish",
      "video.publish",
      "analytics.read",
      "webhooks",
    ],
    restrictions: [
      "affiliate features gated per region and shop authorization",
      "no engagement automation; publishing only via approved content APIs",
    ],
    requiredDisclosures: [
      "commission-earnings-disclosure",
      "sponsored-content-label",
    ],
    rateLimits: [
      { scope: "global", maxPerWindow: 20, windowSec: 1 },
      { scope: "video-publish", maxPerWindow: 6, windowSec: 60 },
    ],
    contentConstraints: [
      "commercial content must carry the platform commercial-content flag",
    ],
    lastVerifiedAt: SNAPSHOT_AT,
    policyVersion: POLICY_VERSION,
    verifiedAgainst: "docs-snapshot",
  });

  registry.register("shopee", {
    capabilities: ["catalog.read", "orders.read", "commissions.read"],
    restrictions: [
      "no content or video publishing API for affiliate partners",
      "affiliate conversions surface only through order/commission reads",
    ],
    requiredDisclosures: ["affiliate-link-disclosure"],
    rateLimits: [{ scope: "global", maxPerWindow: 10, windowSec: 1 }],
    contentConstraints: [],
    lastVerifiedAt: SNAPSHOT_AT,
    policyVersion: POLICY_VERSION,
    verifiedAgainst: "docs-snapshot",
  });

  registry.register("meta", {
    capabilities: [
      "content.publish",
      "image.publish",
      "analytics.read",
      "webhooks",
    ],
    restrictions: [
      "page-level publishing requires page access token with pages_manage_posts",
      "instagram publishing requires professional account and linked page",
      "token exchange requires server-side OAuth flow",
    ],
    requiredDisclosures: [
      "paid-partnership-label",
      "ai-generated-content-label",
    ],
    rateLimits: [
      { scope: "page-publish", maxPerWindow: 25, windowSec: 3600 },
      { scope: "graph-call", maxPerWindow: 4800, windowSec: 3600 },
    ],
    contentConstraints: [
      "political and regulated-goods content restricted",
    ],
    lastVerifiedAt: SNAPSHOT_AT,
    policyVersion: POLICY_VERSION,
    verifiedAgainst: "docs-snapshot",
  });

  registry.register("youtube", {
    capabilities: ["video.publish", "analytics.read"],
    restrictions: [
      "uploads charged against daily project quota (videos.insert = 1600 units)",
      "unverified API projects capped at private/unlisted uploads",
    ],
    requiredDisclosures: [
      "ai-generated-content-label",
      "paid-promotion-declaration",
    ],
    rateLimits: [{ scope: "project-quota", maxPerWindow: 10000, windowSec: 86400 }],
    contentConstraints: [
      "shorts require vertical aspect ratio up to 60 seconds",
    ],
    lastVerifiedAt: SNAPSHOT_AT,
    policyVersion: POLICY_VERSION,
    verifiedAgainst: "docs-snapshot",
  });

  return registry;
}

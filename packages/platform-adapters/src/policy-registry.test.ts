import { describe, expect, it } from "vitest";
import {
  defaultPolicyRegistry,
  PlatformPolicyRegistry,
} from "./policy-registry.js";
import { UnknownProviderError } from "./types.js";

const validEntry = {
  capabilities: ["catalog.read", "orders.read"],
  restrictions: [],
  requiredDisclosures: ["affiliate-link-disclosure"],
  rateLimits: [{ scope: "global", maxPerWindow: 10, windowSec: 1 }],
  contentConstraints: [],
  lastVerifiedAt: "2026-06-30T00:00:00.000Z",
  policyVersion: "2026-06",
  verifiedAgainst: "docs-snapshot" as const,
};

describe("PlatformPolicyRegistry", () => {
  it("round-trips disclosures and rate limits", () => {
    const registry = new PlatformPolicyRegistry();
    const entry = registry.register("acme", validEntry);
    expect(entry.requiredDisclosures).toEqual(["affiliate-link-disclosure"]);
    expect(entry.rateLimits).toEqual([
      { scope: "global", maxPerWindow: 10, windowSec: 1 },
    ]);
    expect(registry.get("acme")).toBe(entry);
  });

  it("rejects unknown capability strings", () => {
    const registry = new PlatformPolicyRegistry();
    expect(() =>
      registry.register("bad", {
        ...validEntry,
        capabilities: ["catalog.read", "catalog.write"],
      })
    ).toThrowError(/invalid/i);
  });

  it("rejects entries missing required policy fields", () => {
    const registry = new PlatformPolicyRegistry();
    const { verifiedAgainst: _va, ...incomplete } = validEntry;
    expect(() => registry.register("bad", incomplete)).toThrowError();
  });

  it("rejects invalid lastVerifiedAt", () => {
    const registry = new PlatformPolicyRegistry();
    expect(() =>
      registry.register("bad", { ...validEntry, lastVerifiedAt: "yesterday" })
    ).toThrowError();
  });

  it("throws UnknownProviderError for unknown providers", () => {
    const registry = new PlatformPolicyRegistry();
    expect(() => registry.get("nope")).toThrowError(UnknownProviderError);
    try {
      registry.get("nope");
    } catch (err) {
      expect((err as UnknownProviderError).code).toBe("UNKNOWN_PROVIDER");
    }
  });

  it("lists all providers sorted", () => {
    const registry = defaultPolicyRegistry();
    expect(registry.list().map((r) => r.providerId)).toEqual([
      "meta",
      "shopee",
      "tiktok-shop",
      "youtube",
    ]);
  });
});

describe("default provider policy entries", () => {
  const registry = defaultPolicyRegistry();

  it("declares no publishing capability for shopee", () => {
    const entry = registry.get("shopee");
    const caps = entry.capabilities.filter((c) => c.endsWith(".publish"));
    expect(caps).toEqual([]);
    expect(entry.capabilities).toEqual([
      "catalog.read",
      "orders.read",
      "commissions.read",
    ]);
  });

  it("marks every entry as a docs-snapshot with honest verification metadata", () => {
    for (const record of registry.list()) {
      expect(record.entry.verifiedAgainst).toBe("docs-snapshot");
      expect(record.entry.lastVerifiedAt).not.toBeNull();
      expect(record.entry.policyVersion).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it("requires disclosure fields on commercial providers", () => {
    expect(registry.get("tiktok-shop").requiredDisclosures.length).toBeGreaterThan(0);
    expect(registry.get("meta").requiredDisclosures).toContain(
      "paid-partnership-label"
    );
    expect(registry.get("youtube").requiredDisclosures).toContain(
      "ai-generated-content-label"
    );
  });
});

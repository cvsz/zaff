import { describe, expect, it } from "vitest";
import {
  AuditEventSchema,
  HealthResponseSchema,
  OrganizationSchema,
  PlatformCapabilitySchema,
  ProviderCapabilityMatrixSchema,
  RoleSchema,
  UserSchema,
} from "./index.js";

const uuid = "9b2f1a4e-3c5d-4e8f-9a0b-1c2d3e4f5a6b";
const uuid2 = "1c2d3e4f-5a6b-4c8d-9e0f-a1b2c3d4e5f6";
const now = new Date().toISOString();

describe("OrganizationSchema", () => {
  it("parses a valid organization", () => {
    const parsed = OrganizationSchema.parse({ id: uuid, name: "Acme", createdAt: now });
    expect(parsed.name).toBe("Acme");
  });

  it("rejects an invalid organization", () => {
    expect(() =>
      OrganizationSchema.parse({ id: "not-a-uuid", name: "", createdAt: now })
    ).toThrow();
  });
});

describe("UserSchema", () => {
  it("parses a valid user", () => {
    const parsed = UserSchema.parse({
      id: uuid,
      orgId: uuid2,
      email: "user@example.com",
      role: "owner",
      createdAt: now,
    });
    expect(parsed.role).toBe("owner");
  });

  it("rejects an unknown role", () => {
    expect(() =>
      UserSchema.parse({
        id: uuid,
        orgId: uuid2,
        email: "user@example.com",
        role: "superadmin",
        createdAt: now,
      })
    ).toThrow();
  });

  it("rejects an invalid email", () => {
    expect(() =>
      UserSchema.parse({
        id: uuid,
        orgId: uuid2,
        email: "not-an-email",
        role: "member",
        createdAt: now,
      })
    ).toThrow();
  });
});

describe("RoleSchema", () => {
  it("accepts every defined role", () => {
    for (const role of ["owner", "admin", "member", "viewer"] as const) {
      expect(RoleSchema.parse(role)).toBe(role);
    }
  });

  it("rejects undefined roles", () => {
    expect(() => RoleSchema.parse("root")).toThrow();
  });
});

describe("AuditEventSchema", () => {
  it("parses a valid audit event with actor and target", () => {
    const parsed = AuditEventSchema.parse({
      id: uuid,
      orgId: uuid2,
      actorUserId: uuid,
      action: "user.login",
      targetType: "session",
      targetId: uuid2,
      metadata: { ip: "127.0.0.1" },
      createdAt: now,
    });
    expect(parsed.action).toBe("user.login");
  });

  it("allows nullable actorUserId and targetId", () => {
    const parsed = AuditEventSchema.parse({
      id: uuid,
      orgId: uuid2,
      actorUserId: null,
      action: "system.tick",
      targetType: "system",
      targetId: null,
      metadata: {},
      createdAt: now,
    });
    expect(parsed.actorUserId).toBeNull();
    expect(parsed.targetId).toBeNull();
  });

  it("rejects missing metadata", () => {
    expect(() =>
      AuditEventSchema.parse({
        id: uuid,
        orgId: uuid2,
        actorUserId: null,
        action: "system.tick",
        targetType: "system",
        targetId: null,
        createdAt: now,
      })
    ).toThrow();
  });
});

describe("PlatformCapabilitySchema", () => {
  it("accepts all declared capabilities", () => {
    const capabilities = [
      "catalog.read",
      "offers.read",
      "links.create",
      "orders.read",
      "commissions.read",
      "content.publish",
      "video.publish",
      "image.publish",
      "analytics.read",
      "webhooks",
    ] as const;
    for (const capability of capabilities) {
      expect(PlatformCapabilitySchema.parse(capability)).toBe(capability);
    }
  });

  it("rejects undeclared capabilities", () => {
    expect(() => PlatformCapabilitySchema.parse("root.access")).toThrow();
  });
});

describe("HealthResponseSchema", () => {
  it("parses the ok health payload", () => {
    expect(HealthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects unexpected statuses", () => {
    expect(() => HealthResponseSchema.parse({ status: "degraded" })).toThrow();
  });
});

describe("ProviderCapabilityMatrixSchema", () => {
  it("parses a valid capability matrix entry", () => {
    const parsed = ProviderCapabilityMatrixSchema.parse({
      schemaVersion: "1",
      providerId: "tiktok",
      capabilities: ["catalog.read", "video.publish"],
      lastVerifiedAt: now,
    });
    expect(parsed.providerId).toBe("tiktok");
  });

  it("rejects an unsupported schema version", () => {
    expect(() =>
      ProviderCapabilityMatrixSchema.parse({
        schemaVersion: "999",
        providerId: "tiktok",
        capabilities: [],
        lastVerifiedAt: now,
      })
    ).toThrow();
  });

  it("rejects unknown capabilities inside the array", () => {
    expect(() =>
      ProviderCapabilityMatrixSchema.parse({
        schemaVersion: "1",
        providerId: "shopee",
        capabilities: ["orders.write"],
        lastVerifiedAt: now,
      })
    ).toThrow();
  });
});

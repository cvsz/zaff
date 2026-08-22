import { describe, expect, it } from "vitest";
import { can, ROLE_RANK, atLeast, type AuthAction } from "./rbac.js";

const ROLES = ["owner", "admin", "member", "viewer"] as const;
const ACTIONS: AuthAction[] = [
  "org:read",
  "org:write",
  "user:invite",
  "user:list",
  "audit:read",
  "org:admin",
];

const EXPECTED: Record<(typeof ROLES)[number], Record<AuthAction, boolean>> = {
  owner: {
    "org:read": true,
    "org:write": true,
    "user:invite": true,
    "user:list": true,
    "audit:read": true,
    "org:admin": true,
  },
  admin: {
    "org:read": true,
    "org:write": true,
    "user:invite": true,
    "user:list": true,
    "audit:read": true,
    "org:admin": false,
  },
  member: {
    "org:read": true,
    "org:write": false,
    "user:invite": false,
    "user:list": true,
    "audit:read": false,
    "org:admin": false,
  },
  viewer: {
    "org:read": true,
    "org:write": false,
    "user:invite": false,
    "user:list": false,
    "audit:read": false,
    "org:admin": false,
  },
};

describe("can()", () => {
  it("covers every role x action combination", () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(can(role, action), `${role} ${action}`).toBe(
          EXPECTED[role][action]
        );
      }
    }
  });

  it("returns false for unknown actions", () => {
    expect(can("owner", "nonexistent" as never)).toBe(false);
  });
});

describe("atLeast()", () => {
  it("enforces the role hierarchy viewer < member < admin < owner", () => {
    const order = ["viewer", "member", "admin", "owner"] as const;
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(atLeast(order[i]!, order[j]!)).toBe(i >= j);
      }
    }
  });

  it("ranks roles strictly increasing", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.member);
    expect(ROLE_RANK.member).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner);
  });
});

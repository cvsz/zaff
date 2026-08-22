import type { Role } from "@zaff/contracts";

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export type AuthAction =
  | "org:read"
  | "org:write"
  | "user:invite"
  | "user:list"
  | "audit:read"
  | "org:admin";

export const ACTION_MIN_ROLE: Record<AuthAction, Role> = {
  "org:read": "viewer",
  "org:write": "admin",
  "user:invite": "admin",
  "user:list": "member",
  "audit:read": "admin",
  "org:admin": "owner",
};

export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function can(role: Role, action: AuthAction): boolean {
  const minRole: Role | undefined = ACTION_MIN_ROLE[action];
  if (!minRole) return false;
  return atLeast(role, minRole);
}

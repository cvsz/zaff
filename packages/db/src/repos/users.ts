import type { Db } from "../client.js";
import { assertOrgScope, type OrgScopedQuery, type OrgScopedRow } from "../scope.js";

const ROLES = ["owner", "admin", "member", "viewer"] as const;

export type UserRole = (typeof ROLES)[number];

export type UserRow = OrgScopedRow & {
  id: string;
  email: string;
  role: UserRole;
  createdAt: Date;
};

export type CreateUserInput = OrgScopedQuery & {
  email: string;
  role: UserRole;
  passwordHash?: string;
};

function assertRole(role: string): asserts role is UserRole {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new Error(`invalid user role: '${role}'`);
  }
}

function mapUser(row: Record<string, unknown>): UserRow {
  const role = row.role as string;
  assertRole(role);
  return {
    id: row.id as string,
    orgId: row.orgId as string,
    email: row.email as string,
    role,
    createdAt: row.createdAt as Date,
  };
}

export async function createUser(db: Db, input: CreateUserInput): Promise<UserRow> {
  const rows = await db`
    INSERT INTO users (org_id, email, role, password_hash)
    VALUES (${input.orgId}, ${input.email}, ${input.role}, ${input.passwordHash ?? ""})
    RETURNING
      id,
      org_id AS "orgId",
      email,
      role,
      created_at AS "createdAt"
  `;
  return mapUser(rows[0] as Record<string, unknown>);
}

export async function getUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      email,
      role,
      created_at AS "createdAt"
    FROM users
    WHERE email = ${email}
  `;
  return rows[0] ? mapUser(rows[0] as Record<string, unknown>) : null;
}

export type UserCredentials = {
  id: string;
  orgId: string;
  email: string;
  role: UserRole;
  passwordHash: string;
};

export async function getUserCredentialsByEmail(
  db: Db,
  email: string
): Promise<UserCredentials | null> {
  const rows = await db`
    SELECT id, org_id AS "orgId", email, role, password_hash AS "passwordHash"
    FROM users
    WHERE email = ${email}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    orgId: row.orgId as string,
    email: row.email as string,
    role: row.role as UserRole,
    passwordHash: row.passwordHash as string,
  };
}

export async function getUserById(
  db: Db,
  orgId: string,
  id: string
): Promise<UserRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      email,
      role,
      created_at AS "createdAt"
    FROM users
    WHERE id = ${id} AND org_id = ${orgId}
  `;
  if (!rows[0]) return null;
  const user = mapUser(rows[0] as Record<string, unknown>);
  assertOrgScope(user, orgId);
  return user;
}

export async function listUsersByOrg(db: Db, orgId: string): Promise<UserRow[]> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      email,
      role,
      created_at AS "createdAt"
    FROM users
    WHERE org_id = ${orgId}
    ORDER BY created_at ASC
  `;
  return rows.map((row) => mapUser(row as Record<string, unknown>));
}

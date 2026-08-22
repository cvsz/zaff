import type { Db } from "../client.js";

export type OrganizationRow = {
  id: string;
  name: string;
  createdAt: Date;
};

export async function createOrganization(
  db: Db,
  input: { name: string }
): Promise<OrganizationRow> {
  const rows = await db<OrganizationRow[]>`
    INSERT INTO organizations (name)
    VALUES (${input.name})
    RETURNING
      id,
      name,
      created_at AS "createdAt"
  `;
  return rows[0] as OrganizationRow;
}

export async function getOrganization(
  db: Db,
  id: string
): Promise<OrganizationRow | null> {
  const rows = await db<OrganizationRow[]>`
    SELECT id, name, created_at AS "createdAt"
    FROM organizations
    WHERE id = ${id}
  `;
  return (rows[0] as OrganizationRow) ?? null;
}

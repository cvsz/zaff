import type { Db } from "../client.js";

export type UserIdentityRow = {
  id: string;
  userId: string;
  issuer: string;
  subject: string;
  createdAt: Date;
};

function mapIdentity(row: Record<string, unknown>): UserIdentityRow {
  return {
    id: row.id as string,
    userId: row.userId as string,
    issuer: row.issuer as string,
    subject: row.subject as string,
    createdAt: row.createdAt as Date,
  };
}

const COLUMNS = `
  id,
  user_id AS "userId",
  issuer,
  subject,
  created_at AS "createdAt"
`;

export async function getUserIdentity(
  db: Db,
  input: { issuer: string; subject: string }
): Promise<UserIdentityRow | null> {
  const rows = await db`
    SELECT ${db.unsafe(COLUMNS)}
    FROM user_identities
    WHERE issuer = ${input.issuer} AND subject = ${input.subject}
  `;
  return rows[0] ? mapIdentity(rows[0] as Record<string, unknown>) : null;
}

export async function createUserIdentity(
  db: Db,
  input: { userId: string; issuer: string; subject: string }
): Promise<UserIdentityRow> {
  const rows = await db`
    INSERT INTO user_identities (user_id, issuer, subject)
    VALUES (${input.userId}, ${input.issuer}, ${input.subject})
    RETURNING ${db.unsafe(COLUMNS)}
  `;
  return mapIdentity(rows[0] as Record<string, unknown>);
}

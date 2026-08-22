import type { Db } from "../client.js";

export type SessionRow = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
};

export type CreateSessionInput = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

function mapSession(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    userId: row.userId as string,
    tokenHash: row.tokenHash as string,
    expiresAt: row.expiresAt as Date,
    createdAt: row.createdAt as Date,
  };
}

export async function createSession(db: Db, input: CreateSessionInput): Promise<SessionRow> {
  const rows = await db`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${input.userId}, ${input.tokenHash}, ${input.expiresAt})
    RETURNING
      id,
      user_id AS "userId",
      token_hash AS "tokenHash",
      expires_at AS "expiresAt",
      created_at AS "createdAt"
  `;
  return mapSession(rows[0] as Record<string, unknown>);
}

export async function findSessionByTokenHash(
  db: Db,
  tokenHash: string
): Promise<SessionRow | null> {
  const rows = await db`
    SELECT
      id,
      user_id AS "userId",
      token_hash AS "tokenHash",
      expires_at AS "expiresAt",
      created_at AS "createdAt"
    FROM sessions
    WHERE token_hash = ${tokenHash} AND expires_at > now()
  `;
  return rows[0] ? mapSession(rows[0] as Record<string, unknown>) : null;
}

export async function deleteSessionByTokenHash(db: Db, tokenHash: string): Promise<boolean> {
  const rows = await db`
    DELETE FROM sessions
    WHERE token_hash = ${tokenHash}
    RETURNING id
  `;
  return rows.length > 0;
}

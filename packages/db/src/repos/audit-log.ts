import type postgres from "postgres";
import type { Db } from "../client.js";
import type { OrgScopedQuery } from "../scope.js";

export type AuditEventRow = {
  id: string;
  orgId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AppendAuditEventInput = OrgScopedQuery & {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ListAuditEventsOptions = {
  limit?: number;
  before?: Date;
};

export async function appendAuditEvent(
  db: Db,
  input: AppendAuditEventInput
): Promise<AuditEventRow> {
  const rows = await db`
    INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (
      ${input.orgId},
      ${input.actorUserId ?? null},
      ${input.action},
      ${input.targetType},
      ${input.targetId ?? null},
      ${db.json((input.metadata ?? {}) as postgres.JSONValue)}
    )
    RETURNING
      id,
      org_id AS "orgId",
      actor_user_id AS "actorUserId",
      action,
      target_type AS "targetType",
      target_id AS "targetId",
      metadata,
      created_at AS "createdAt"
  `;
  return rows[0] as unknown as AuditEventRow;
}

export async function listAuditEvents(
  db: Db,
  orgId: string,
  options: ListAuditEventsOptions = {}
): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const before = options.before ?? null;
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      actor_user_id AS "actorUserId",
      action,
      target_type AS "targetType",
      target_id AS "targetId",
      metadata,
      created_at AS "createdAt"
    FROM audit_log
    WHERE org_id = ${orgId}
      AND (${before}::timestamptz IS NULL OR created_at < ${before}::timestamptz)
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as AuditEventRow[];
}

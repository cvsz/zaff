import type { Db } from "../client.js";
import type { OrgScopedQuery } from "../scope.js";

const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "cancelled",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export class IllegalTransitionError extends Error {
  constructor(from: CampaignStatus, to: string) {
    super(`illegal campaign status transition: '${from}' -> '${to}'`);
    this.name = "IllegalTransitionError";
  }
}

export type CampaignRow = {
  id: string;
  orgId: string;
  name: string;
  status: CampaignStatus;
  objective: string | null;
  budgetLimit: string | null;
  createdAt: Date;
};

export type CreateCampaignInput = OrgScopedQuery & {
  name: string;
  objective?: string | null;
  budgetLimit?: number | null;
};

function assertCampaignStatus(
  status: string
): asserts status is CampaignStatus {
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid campaign status: '${status}'`);
  }
}

export async function createCampaign(
  db: Db,
  input: CreateCampaignInput
): Promise<CampaignRow> {
  const rows = await db`
    INSERT INTO campaigns (org_id, name, objective, budget_limit)
    VALUES (${input.orgId}, ${input.name}, ${input.objective ?? null}, ${input.budgetLimit ?? null})
    RETURNING
      id,
      org_id AS "orgId",
      name,
      status,
      objective,
      budget_limit AS "budgetLimit",
      created_at AS "createdAt"
  `;
  return rows[0] as unknown as CampaignRow;
}

export async function getCampaign(
  db: Db,
  orgId: string,
  id: string
): Promise<CampaignRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      name,
      status,
      objective,
      budget_limit AS "budgetLimit",
      created_at AS "createdAt"
    FROM campaigns
    WHERE id = ${id} AND org_id = ${orgId}
  `;
  return (rows[0] as unknown as CampaignRow) ?? null;
}

export async function listCampaignsByOrg(
  db: Db,
  orgId: string
): Promise<CampaignRow[]> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      name,
      status,
      objective,
      budget_limit AS "budgetLimit",
      created_at AS "createdAt"
    FROM campaigns
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
  `;
  return rows as unknown as CampaignRow[];
}

export async function transitionCampaignStatus(
  db: Db,
  orgId: string,
  id: string,
  to: CampaignStatus
): Promise<CampaignRow | null> {
  assertCampaignStatus(to);
  const current = await getCampaign(db, orgId, id);
  if (!current) return null;
  const rows = await db`
    UPDATE campaigns
    SET status = ${to}
    WHERE id = ${id} AND org_id = ${orgId}
      AND (
        CASE status
          WHEN 'draft' THEN ${to} IN ('active', 'cancelled')
          WHEN 'active' THEN ${to} IN ('paused', 'completed', 'cancelled')
          WHEN 'paused' THEN ${to} IN ('active', 'completed', 'cancelled')
          ELSE false
        END
      )
    RETURNING
      id,
      org_id AS "orgId",
      name,
      status,
      objective,
      budget_limit AS "budgetLimit",
      created_at AS "createdAt"
  `;
  if (!rows[0]) throw new IllegalTransitionError(current.status, to);
  return rows[0] as unknown as CampaignRow;
}

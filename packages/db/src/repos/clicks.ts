import type { Db } from "../client.js";
import { OrgScopeError, type OrgScopedQuery } from "../scope.js";

export type ClickRow = {
  id: string;
  linkId: string;
  orgId: string;
  clickedAt: Date;
  ipHash: string | null;
  userAgent: string | null;
  referer: string | null;
  countryHint: string | null;
};

export type RecordClickInput = OrgScopedQuery & {
  linkId: string;
  ipHash?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  countryHint?: string | null;
};

export type ListRecentClicksOptions = {
  linkId?: string;
  limit?: number;
};

const MAX_LIST_LIMIT = 500;

async function assertLinkInOrg(
  db: Db,
  orgId: string,
  linkId: string
): Promise<void> {
  const rows = await db`
    SELECT 1 FROM affiliate_links
    WHERE id = ${linkId} AND org_id = ${orgId}
  `;
  if (!rows[0]) {
    throw new OrgScopeError(
      `affiliate link '${linkId}' does not belong to org '${orgId}'`
    );
  }
}

export async function recordClick(
  db: Db,
  input: RecordClickInput
): Promise<ClickRow> {
  await assertLinkInOrg(db, input.orgId, input.linkId);
  const rows = await db`
    INSERT INTO clicks (org_id, link_id, ip_hash, user_agent, referer, country_hint)
    VALUES (
      ${input.orgId},
      ${input.linkId},
      ${input.ipHash ?? null},
      ${input.userAgent ?? null},
      ${input.referer ?? null},
      ${input.countryHint ?? null}
    )
    RETURNING
      id,
      link_id AS "linkId",
      org_id AS "orgId",
      clicked_at AS "clickedAt",
      ip_hash AS "ipHash",
      user_agent AS "userAgent",
      referer,
      country_hint AS "countryHint"
  `;
  return rows[0] as unknown as ClickRow;
}

export async function countClicksByLink(
  db: Db,
  orgId: string,
  linkId: string
): Promise<number> {
  const rows = await db`
    SELECT COUNT(*)::int AS count
    FROM clicks
    WHERE org_id = ${orgId} AND link_id = ${linkId}
  `;
  const row = rows[0] as { count: number } | undefined;
  return row?.count ?? 0;
}

export async function listRecentClicks(
  db: Db,
  orgId: string,
  options: ListRecentClicksOptions = {}
): Promise<ClickRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIST_LIMIT);
  const linkId = options.linkId ?? null;
  const rows = await db`
    SELECT
      id,
      link_id AS "linkId",
      org_id AS "orgId",
      clicked_at AS "clickedAt",
      ip_hash AS "ipHash",
      user_agent AS "userAgent",
      referer,
      country_hint AS "countryHint"
    FROM clicks
    WHERE org_id = ${orgId}
      AND (${linkId}::uuid IS NULL OR link_id = ${linkId}::uuid)
    ORDER BY clicked_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as ClickRow[];
}

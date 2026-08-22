import type postgres from "postgres";
import type { Db } from "../client.js";
import { OrgScopeError, type OrgScopedQuery } from "../scope.js";

export class SlugTakenError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`affiliate link slug already taken: '${slug}'`);
    this.name = "SlugTakenError";
    this.slug = slug;
  }
}

export type AffiliateLinkRow = {
  id: string;
  orgId: string;
  campaignId: string | null;
  offerId: string | null;
  slug: string;
  targetUrl: string;
  utm: Record<string, string>;
  expiresAt: Date | null;
  createdAt: Date;
};

export type CreateAffiliateLinkInput = OrgScopedQuery & {
  campaignId?: string | null;
  offerId?: string | null;
  slug: string;
  targetUrl: string;
  utm?: Record<string, string>;
  expiresAt?: Date | null;
};

async function assertOfferInOrg(
  db: Db,
  orgId: string,
  offerId: string
): Promise<void> {
  const rows = await db`
    SELECT 1
    FROM offers o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ${offerId} AND p.org_id = ${orgId}
  `;
  if (!rows[0]) {
    throw new OrgScopeError(
      `offer '${offerId}' does not belong to org '${orgId}'`
    );
  }
}

async function assertCampaignInOrg(
  db: Db,
  orgId: string,
  campaignId: string
): Promise<void> {
  const rows = await db`
    SELECT 1 FROM campaigns
    WHERE id = ${campaignId} AND org_id = ${orgId}
  `;
  if (!rows[0]) {
    throw new OrgScopeError(
      `campaign '${campaignId}' does not belong to org '${orgId}'`
    );
  }
}

export async function createAffiliateLink(
  db: Db,
  input: CreateAffiliateLinkInput
): Promise<AffiliateLinkRow> {
  if (input.offerId) await assertOfferInOrg(db, input.orgId, input.offerId);
  if (input.campaignId) {
    await assertCampaignInOrg(db, input.orgId, input.campaignId);
  }
  try {
    const rows = await db`
      INSERT INTO affiliate_links (org_id, campaign_id, offer_id, slug, target_url, utm, expires_at)
      VALUES (
        ${input.orgId},
        ${input.campaignId ?? null},
        ${input.offerId ?? null},
        ${input.slug},
        ${input.targetUrl},
        ${db.json((input.utm ?? {}) as postgres.JSONValue)},
        ${input.expiresAt ?? null}
      )
      RETURNING
        id,
        org_id AS "orgId",
        campaign_id AS "campaignId",
        offer_id AS "offerId",
        slug,
        target_url AS "targetUrl",
        utm,
        expires_at AS "expiresAt",
        created_at AS "createdAt"
    `;
    return rows[0] as unknown as AffiliateLinkRow;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as postgres.PostgresError).code === "23505"
    ) {
      throw new SlugTakenError(input.slug);
    }
    throw error;
  }
}

export async function resolveLinkBySlug(
  db: Db,
  slug: string,
  at: Date = new Date()
): Promise<AffiliateLinkRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      campaign_id AS "campaignId",
      offer_id AS "offerId",
      slug,
      target_url AS "targetUrl",
      utm,
      expires_at AS "expiresAt",
      created_at AS "createdAt"
    FROM affiliate_links
    WHERE slug = ${slug}
      AND (expires_at IS NULL OR expires_at > ${at}::timestamptz)
  `;
  return (rows[0] as unknown as AffiliateLinkRow) ?? null;
}

export async function getAffiliateLinkById(
  db: Db,
  orgId: string,
  id: string
): Promise<AffiliateLinkRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      campaign_id AS "campaignId",
      offer_id AS "offerId",
      slug,
      target_url AS "targetUrl",
      utm,
      expires_at AS "expiresAt",
      created_at AS "createdAt"
    FROM affiliate_links
    WHERE id = ${id} AND org_id = ${orgId}
  `;
  return (rows[0] as unknown as AffiliateLinkRow) ?? null;
}

export async function listAffiliateLinksByOrg(
  db: Db,
  orgId: string
): Promise<AffiliateLinkRow[]> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      campaign_id AS "campaignId",
      offer_id AS "offerId",
      slug,
      target_url AS "targetUrl",
      utm,
      expires_at AS "expiresAt",
      created_at AS "createdAt"
    FROM affiliate_links
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
  `;
  return rows as unknown as AffiliateLinkRow[];
}

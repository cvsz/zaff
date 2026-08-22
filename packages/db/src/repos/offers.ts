import type { Db } from "../client.js";
import { OrgScopeError } from "../scope.js";

const COMMISSION_TYPES = ["percentage", "fixed"] as const;

export type CommissionType = (typeof COMMISSION_TYPES)[number];

export type OfferRow = {
  id: string;
  productId: string;
  url: string;
  commissionType: CommissionType;
  commissionValue: string;
  promotionLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  createdAt: Date;
};

export type CreateOfferInput = {
  orgId: string;
  productId: string;
  url: string;
  commissionType: CommissionType;
  commissionValue: number;
  promotionLabel?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  active?: boolean;
};

function assertCommissionType(
  type: string
): asserts type is CommissionType {
  if (!(COMMISSION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`invalid commission type: '${type}'`);
  }
}

async function assertProductInOrg(
  db: Db,
  orgId: string,
  productId: string
): Promise<void> {
  const rows = await db`
    SELECT 1 FROM products
    WHERE id = ${productId} AND org_id = ${orgId}
  `;
  if (!rows[0]) {
    throw new OrgScopeError(
      `product '${productId}' does not belong to org '${orgId}'`
    );
  }
}

export async function createOffer(
  db: Db,
  input: CreateOfferInput
): Promise<OfferRow> {
  assertCommissionType(input.commissionType);
  await assertProductInOrg(db, input.orgId, input.productId);
  const rows = await db`
    INSERT INTO offers (product_id, url, commission_type, commission_value, promotion_label, starts_at, ends_at, active)
    VALUES (
      ${input.productId},
      ${input.url},
      ${input.commissionType},
      ${input.commissionValue},
      ${input.promotionLabel ?? null},
      ${input.startsAt ?? null},
      ${input.endsAt ?? null},
      ${input.active ?? true}
    )
    RETURNING
      id,
      product_id AS "productId",
      url,
      commission_type AS "commissionType",
      commission_value AS "commissionValue",
      promotion_label AS "promotionLabel",
      starts_at AS "startsAt",
      ends_at AS "endsAt",
      active,
      created_at AS "createdAt"
  `;
  return rows[0] as unknown as OfferRow;
}

export async function getOfferById(
  db: Db,
  orgId: string,
  id: string
): Promise<OfferRow | null> {
  const rows = await db`
    SELECT
      o.id,
      o.product_id AS "productId",
      o.url,
      o.commission_type AS "commissionType",
      o.commission_value AS "commissionValue",
      o.promotion_label AS "promotionLabel",
      o.starts_at AS "startsAt",
      o.ends_at AS "endsAt",
      o.active,
      o.created_at AS "createdAt"
    FROM offers o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ${id} AND p.org_id = ${orgId}
  `;
  return (rows[0] as unknown as OfferRow) ?? null;
}

export async function activeOffersForProduct(
  db: Db,
  orgId: string,
  productId: string
): Promise<OfferRow[]> {
  await assertProductInOrg(db, orgId, productId);
  const rows = await db`
    SELECT
      id,
      product_id AS "productId",
      url,
      commission_type AS "commissionType",
      commission_value AS "commissionValue",
      promotion_label AS "promotionLabel",
      starts_at AS "startsAt",
      ends_at AS "endsAt",
      active,
      created_at AS "createdAt"
    FROM offers
    WHERE product_id = ${productId} AND active = true
    ORDER BY created_at DESC
  `;
  return rows as unknown as OfferRow[];
}

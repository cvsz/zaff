import type postgres from "postgres";
import type { Db } from "../client.js";
import { assertOrgScope, type OrgScopedQuery } from "../scope.js";

const PRODUCT_STATUSES = ["discovered", "evaluated", "selected", "archived"] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export type ProductRow = {
  id: string;
  orgId: string;
  merchantId: string | null;
  externalId: string | null;
  title: string;
  description: string | null;
  priceAmount: string;
  currency: string;
  status: ProductStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type CreateProductInput = OrgScopedQuery & {
  merchantId?: string | null;
  externalId?: string | null;
  title: string;
  description?: string | null;
  priceAmount?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
};

export type ListProductsOptions = {
  status?: ProductStatus;
  limit?: number;
  cursor?: { createdAt: Date; id: string };
};

export function assertProductStatus(
  status: string
): asserts status is ProductStatus {
  if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid product status: '${status}'`);
  }
}

export async function createProduct(
  db: Db,
  input: CreateProductInput
): Promise<ProductRow> {
  const rows = await db`
    INSERT INTO products (org_id, merchant_id, external_id, title, description, price_amount, currency, metadata)
    VALUES (
      ${input.orgId},
      ${input.merchantId ?? null},
      ${input.externalId ?? null},
      ${input.title},
      ${input.description ?? null},
      ${input.priceAmount ?? 0},
      ${input.currency ?? "USD"},
      ${db.json((input.metadata ?? {}) as postgres.JSONValue)}
    )
    RETURNING
      id,
      org_id AS "orgId",
      merchant_id AS "merchantId",
      external_id AS "externalId",
      title,
      description,
      price_amount AS "priceAmount",
      currency,
      status,
      metadata,
      created_at AS "createdAt"
  `;
  return rows[0] as unknown as ProductRow;
}

export async function updateProductStatus(
  db: Db,
  orgId: string,
  id: string,
  status: ProductStatus
): Promise<ProductRow | null> {
  assertProductStatus(status);
  const rows = await db`
    UPDATE products
    SET status = ${status}
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING
      id,
      org_id AS "orgId",
      merchant_id AS "merchantId",
      external_id AS "externalId",
      title,
      description,
      price_amount AS "priceAmount",
      currency,
      status,
      metadata,
      created_at AS "createdAt"
  `;
  const row = rows[0] as unknown as ProductRow | undefined;
  if (!row) return null;
  assertOrgScope(row, orgId);
  return row;
}

export async function getProductById(
  db: Db,
  orgId: string,
  id: string
): Promise<ProductRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      merchant_id AS "merchantId",
      external_id AS "externalId",
      title,
      description,
      price_amount AS "priceAmount",
      currency,
      status,
      metadata,
      created_at AS "createdAt"
    FROM products
    WHERE id = ${id} AND org_id = ${orgId}
  `;
  return (rows[0] as unknown as ProductRow) ?? null;
}

export async function listProductsByOrg(
  db: Db,
  orgId: string,
  options: ListProductsOptions = {}
): Promise<ProductRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const status = options.status ?? null;
  const cursor = options.cursor ?? null;
  let rows;
  if (cursor) {
    rows = await db`
      SELECT
        id,
        org_id AS "orgId",
        merchant_id AS "merchantId",
        external_id AS "externalId",
        title,
        description,
        price_amount AS "priceAmount",
        currency,
        status,
        metadata,
        created_at AS "createdAt"
      FROM products
      WHERE org_id = ${orgId}
        AND (${status}::text IS NULL OR status = ${status})
        AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await db`
      SELECT
        id,
        org_id AS "orgId",
        merchant_id AS "merchantId",
        external_id AS "externalId",
        title,
        description,
        price_amount AS "priceAmount",
        currency,
        status,
        metadata,
        created_at AS "createdAt"
      FROM products
      WHERE org_id = ${orgId}
        AND (${status}::text IS NULL OR status = ${status})
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
  }
  return rows as unknown as ProductRow[];
}

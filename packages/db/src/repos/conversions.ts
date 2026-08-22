import type { Db } from "../client.js";
import { OrgScopeError, type OrgScopedQuery } from "../scope.js";

const CONVERSION_STATUSES = [
  "pending",
  "confirmed",
  "refunded",
  "rejected",
] as const;

export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

export type ConversionRow = {
  id: string;
  orgId: string;
  linkId: string | null;
  externalOrderId: string;
  amount: string;
  currency: string;
  commissionAmount: string;
  status: ConversionStatus;
  occurredAt: Date;
  recordedAt: Date;
};

export type RecordConversionInput = OrgScopedQuery & {
  linkId?: string | null;
  externalOrderId: string;
  amount: number;
  currency?: string;
  commissionAmount?: number;
  occurredAt: Date;
};

export type RecordConversionResult = {
  conversion: ConversionRow;
  inserted: boolean;
};

export type ListConversionsOptions = {
  from?: Date | null;
  to?: Date | null;
};

export interface ConversionAggregate {
  status: ConversionStatus;
  count: number;
  totalCommission: string;
}

function assertConversionStatus(
  status: string
): asserts status is ConversionStatus {
  if (!(CONVERSION_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid conversion status: '${status}'`);
  }
}

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

export async function recordConversion(
  db: Db,
  input: RecordConversionInput
): Promise<RecordConversionResult> {
  if (input.linkId) await assertLinkInOrg(db, input.orgId, input.linkId);
  const inserted = await db`
    INSERT INTO conversions (org_id, link_id, external_order_id, amount, currency, commission_amount, occurred_at)
    VALUES (
      ${input.orgId},
      ${input.linkId ?? null},
      ${input.externalOrderId},
      ${input.amount},
      ${input.currency ?? "USD"},
      ${input.commissionAmount ?? 0},
      ${input.occurredAt}
    )
    ON CONFLICT (link_id, external_order_id) WHERE link_id IS NOT NULL DO NOTHING
    RETURNING
      id,
      org_id AS "orgId",
      link_id AS "linkId",
      external_order_id AS "externalOrderId",
      amount,
      currency,
      commission_amount AS "commissionAmount",
      status,
      occurred_at AS "occurredAt",
      recorded_at AS "recordedAt"
  `;
  if (inserted[0]) {
    return { conversion: inserted[0] as unknown as ConversionRow, inserted: true };
  }
  const existing = await db`
    SELECT
      id,
      org_id AS "orgId",
      link_id AS "linkId",
      external_order_id AS "externalOrderId",
      amount,
      currency,
      commission_amount AS "commissionAmount",
      status,
      occurred_at AS "occurredAt",
      recorded_at AS "recordedAt"
    FROM conversions
    WHERE link_id IS NOT DISTINCT FROM ${input.linkId ?? null}
      AND external_order_id = ${input.externalOrderId}
  `;
  const row = existing[0] as unknown as ConversionRow | undefined;
  if (!row) {
    throw new Error(
      `conversion ingest failed for order '${input.externalOrderId}': insert conflicted but no existing row found`
    );
  }
  return { conversion: row, inserted: false };
}

export async function getConversionById(
  db: Db,
  orgId: string,
  id: string
): Promise<ConversionRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      link_id AS "linkId",
      external_order_id AS "externalOrderId",
      amount,
      currency,
      commission_amount AS "commissionAmount",
      status,
      occurred_at AS "occurredAt",
      recorded_at AS "recordedAt"
    FROM conversions
    WHERE id = ${id} AND org_id = ${orgId}
  `;
  return (rows[0] as unknown as ConversionRow) ?? null;
}

export async function updateConversionStatus(
  db: Db,
  orgId: string,
  id: string,
  status: ConversionStatus
): Promise<ConversionRow | null> {
  assertConversionStatus(status);
  const rows = await db`
    UPDATE conversions
    SET status = ${status}
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING
      id,
      org_id AS "orgId",
      link_id AS "linkId",
      external_order_id AS "externalOrderId",
      amount,
      currency,
      commission_amount AS "commissionAmount",
      status,
      occurred_at AS "occurredAt",
      recorded_at AS "recordedAt"
  `;
  return (rows[0] as unknown as ConversionRow) ?? null;
}

export async function listConversionsByOrg(
  db: Db,
  orgId: string,
  options: ListConversionsOptions = {}
): Promise<ConversionRow[]> {
  const from = options.from ?? null;
  const to = options.to ?? null;
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      link_id AS "linkId",
      external_order_id AS "externalOrderId",
      amount,
      currency,
      commission_amount AS "commissionAmount",
      status,
      occurred_at AS "occurredAt",
      recorded_at AS "recordedAt"
    FROM conversions
    WHERE org_id = ${orgId}
      AND (${from}::timestamptz IS NULL OR occurred_at >= ${from}::timestamptz)
      AND (${to}::timestamptz IS NULL OR occurred_at <= ${to}::timestamptz)
    ORDER BY occurred_at DESC
  `;
  return rows as unknown as ConversionRow[];
}

export async function aggregateCommissionByOrg(
  db: Db,
  orgId: string,
  options: ListConversionsOptions = {}
): Promise<ConversionAggregate[]> {
  const from = options.from ?? null;
  const to = options.to ?? null;
  const rows = await db`
    SELECT
      status,
      COUNT(*)::int AS count,
      COALESCE(SUM(commission_amount), 0)::text AS "totalCommission"
    FROM conversions
    WHERE org_id = ${orgId}
      AND (${from}::timestamptz IS NULL OR occurred_at >= ${from}::timestamptz)
      AND (${to}::timestamptz IS NULL OR occurred_at <= ${to}::timestamptz)
    GROUP BY status
  `;
  return rows.map((row) => {
    const aggregate = row as unknown as ConversionAggregate;
    assertConversionStatus(aggregate.status);
    return aggregate;
  });
}

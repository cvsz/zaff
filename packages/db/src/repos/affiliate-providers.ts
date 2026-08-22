import type postgres from "postgres";
import type { Db } from "../client.js";
import type { OrgScopedQuery } from "../scope.js";

export type ProviderStatus = "active" | "disabled";

export type AffiliateProviderRow = {
  id: string;
  orgId: string;
  code: string;
  name: string;
  capabilities: string[];
  lastVerifiedAt: Date | null;
  status: ProviderStatus;
  createdAt: Date;
};

export type UpsertProviderInput = OrgScopedQuery & {
  code: string;
  name: string;
  capabilities?: string[];
  lastVerifiedAt?: Date | null;
};

export async function upsertProvider(
  db: Db,
  input: UpsertProviderInput
): Promise<AffiliateProviderRow> {
  const rows = await db`
    INSERT INTO affiliate_providers (org_id, code, name, capabilities, last_verified_at)
    VALUES (
      ${input.orgId},
      ${input.code},
      ${input.name},
      ${db.json((input.capabilities ?? []) as postgres.JSONValue)},
      ${input.lastVerifiedAt ?? null}
    )
    ON CONFLICT (org_id, code) DO UPDATE
    SET name = EXCLUDED.name,
        capabilities = EXCLUDED.capabilities,
        last_verified_at = COALESCE(EXCLUDED.last_verified_at, affiliate_providers.last_verified_at)
    RETURNING
      id,
      org_id AS "orgId",
      code,
      name,
      capabilities,
      last_verified_at AS "lastVerifiedAt",
      status,
      created_at AS "createdAt"
  `;
  return rows[0] as unknown as AffiliateProviderRow;
}

export async function getProviderByCode(
  db: Db,
  orgId: string,
  code: string
): Promise<AffiliateProviderRow | null> {
  const rows = await db`
    SELECT
      id,
      org_id AS "orgId",
      code,
      name,
      capabilities,
      last_verified_at AS "lastVerifiedAt",
      status,
      created_at AS "createdAt"
    FROM affiliate_providers
    WHERE org_id = ${orgId} AND code = ${code}
  `;
  return (rows[0] as unknown as AffiliateProviderRow) ?? null;
}

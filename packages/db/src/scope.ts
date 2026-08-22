export class OrgScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgScopeError";
  }
}

export interface OrgScopedRow {
  orgId: string;
}

export interface OrgScopedQuery {
  orgId: string;
}

export function assertOrgScope(row: OrgScopedRow, orgId: string): void {
  if (row.orgId !== orgId) {
    throw new OrgScopeError(
      `row org '${row.orgId}' does not belong to requested org '${orgId}'`
    );
  }
}

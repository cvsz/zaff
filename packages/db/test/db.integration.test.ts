import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  appendAuditEvent,
  assertOrgScope,
  createDb,
  createOrganization,
  createUser,
  getOrganization,
  getUserByEmail,
  getUserById,
  listAuditEvents,
  listUsersByOrg,
  migrateDown,
  migrateUp,
  OrgScopeError,
} from "../src/index.js";

const TEST_URL =
  process.env.ZAFF_TEST_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff";

let dbAvailable = true;
try {
  const probe = postgres(TEST_URL, { connect_timeout: 3, max: 1 });
  await probe`SELECT 1`;
  await probe.end();
} catch {
  dbAvailable = false;
}

const suite = describe.skipIf(!dbAvailable);

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

suite("packages/db integration", () => {
  const db = createDb(TEST_URL);

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS clicks, audit_log, sessions, users, organizations, schema_migrations CASCADE"
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
  });

  afterAll(async () => {
    if (dbAvailable) await db.end();
  });

  it("applies migrations up, idempotently", async () => {
    const first = await migrateUp(db);
    expect(first).toContain("0001_init.sql");
    const second = await migrateUp(db);
    expect(second).toEqual([]);
    const tables = (
      await db`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    ).map((r) => r.table_name as string);
    for (const t of ["organizations", "users", "audit_log", "schema_migrations"]) {
      expect(tables).toContain(t);
    }
  });

  it("supports organization CRUD", async () => {
    const org = await createOrganization(db, { name: "Acme Affiliate" });
    expect(org.id).toBeDefined();
    const fetched = await getOrganization(db, org.id);
    expect(fetched?.name).toBe("Acme Affiliate");
    expect(await getOrganization(db, crypto.randomUUID())).toBeNull();
  });

  it("supports user CRUD and email lookup", async () => {
    const org = await createOrganization(db, { name: "User Org" });
    const user = await createUser(db, {
      orgId: org.id,
      email: "owner@user-org.test",
      role: "owner",
    });
    expect(user.orgId).toBe(org.id);
    expect(user.role).toBe("owner");
    const byEmail = await getUserByEmail(db, "owner@user-org.test");
    expect(byEmail?.id).toBe(user.id);
    const byId = await getUserById(db, org.id, user.id);
    expect(byId?.email).toBe("owner@user-org.test");
    await expect(
      createUser(db, { orgId: org.id, email: "owner@user-org.test", role: "member" })
    ).rejects.toThrow();
    await expect(
      createUser(db, { orgId: org.id, email: "bad-role@x.test", role: "superadmin" as never })
    ).rejects.toThrow();
  });

  it("filters users by org (tenant isolation)", async () => {
    const orgA = await createOrganization(db, { name: "Org A" });
    const orgB = await createOrganization(db, { name: "Org B" });
    const userA = await createUser(db, { orgId: orgA.id, email: "a@org-a.test", role: "admin" });
    const userB = await createUser(db, { orgId: orgB.id, email: "b@org-b.test", role: "member" });
    const usersA = await listUsersByOrg(db, orgA.id);
    expect(usersA.map((u) => u.email)).toEqual(["a@org-a.test"]);
    const usersB = await listUsersByOrg(db, orgB.id);
    expect(usersB.map((u) => u.email)).toEqual(["b@org-b.test"]);
    expect(await getUserById(db, orgA.id, usersB[0].id)).toBeNull();
    expect(usersA[0].id).toBe(userA.id);
    expect(usersB[0].id).toBe(userB.id);
  });

  it("appends and lists audit events scoped by org with pagination", async () => {
    const org = await createOrganization(db, { name: "Audit Org" });
    const other = await createOrganization(db, { name: "Other Org" });
    const user = await createUser(db, { orgId: org.id, email: "audit@audit-org.test", role: "member" });
    for (let i = 0; i < 5; i++) {
      await appendAuditEvent(db, {
        orgId: org.id,
        actorUserId: user.id,
        action: "test.action",
        targetType: "organization",
        targetId: org.id,
        metadata: { seq: i },
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    await appendAuditEvent(db, {
      orgId: other.id,
      action: "other.action",
      targetType: "organization",
      targetId: other.id,
    });

    const all = await listAuditEvents(db, org.id, {});
    expect(all).toHaveLength(5);
    expect(all.every((e) => e.orgId === org.id)).toBe(true);

    const page = await listAuditEvents(db, org.id, { limit: 2 });
    expect(page).toHaveLength(2);

    const cursor = page[page.length - 1].createdAt;
    const older = await listAuditEvents(db, org.id, { before: cursor });
    expect(older).toHaveLength(3);
    expect(older.every((e) => e.createdAt < cursor)).toBe(true);
    const seenIds = new Set([...page, ...older].map((e) => e.id));
    expect(seenIds.size).toBe(5);
  });

  it("assertOrgScope throws on mismatched org", () => {
    expect(() => assertOrgScope({ orgId: "org-1" }, "org-2")).toThrow(OrgScopeError);
    expect(() => assertOrgScope({ orgId: "org-1" }, "org-1")).not.toThrow();
  });

  it("migrates down cleanly then back up", async () => {
    const reverted = await migrateDown(db, 10);
    expect(reverted).toContain("0001_init.sql");
    const tables = (
      await db`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    ).map((r) => r.table_name as string);
    for (const t of ["organizations", "users", "audit_log"]) {
      expect(tables).not.toContain(t);
    }
    const reApplied = await migrateUp(db);
    expect(reApplied).toContain("0001_init.sql");
    const org = await createOrganization(db, { name: "Post-down Org" });
    const fetched = await getOrganization(db, org.id);
    expect(fetched?.name).toBe("Post-down Org");
  });
});

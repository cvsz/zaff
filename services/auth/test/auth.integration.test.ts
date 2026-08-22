import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  AuthService,
  AuthError,
  can,
  hashPassword,
  hashToken,
  requireRole,
} from "../src/index.js";
import {
  createDb,
  createUser,
  findSessionByTokenHash,
  getUserByEmail,
  listAuditEvents,
  listUsersByOrg,
  migrateUp,
} from "@zaff/db";

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

suite("services/auth integration", () => {
  const db = createDb(TEST_URL);
  const auth = new AuthService(db);

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS audit_log, sessions, users, organizations, schema_migrations CASCADE"
    );
  }

  async function expectAuthError(promise: Promise<unknown>, status: number, code: string) {
    try {
      await promise;
      throw new Error(`expected AuthError ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      const authError = error as AuthError;
      expect(authError.status).toBe(status);
      expect(authError.code).toBe(code);
    }
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);
  });

  afterAll(async () => {
    if (dbAvailable) await db.end();
  });

  it("registers an org with an owner user and audits it", async () => {
    const user = await auth.register({
      orgName: "Alpha Co",
      email: "owner@alpha.test",
      password: "super-secret-123",
    });
    expect(user.role).toBe("owner");
    expect(user.orgId).toBeDefined();
    const events = await listAuditEvents(db, user.orgId);
    expect(events.some((e) => e.action === "user.registered")).toBe(true);
  });

  it("rejects duplicate registration email without leaking details", async () => {
    await expectAuthError(
      auth.register({ orgName: "Beta Co", email: "owner@alpha.test", password: "password-456" }),
      409,
      "email_taken"
    );
  });

  it("logs in, stores only the token hash, and exposes the session user", async () => {
    const session = await auth.login("owner@alpha.test", "super-secret-123");
    expect(session.token.length).toBeGreaterThanOrEqual(42);
    expect(session.user.email).toBe("owner@alpha.test");
    const stored = await db`
      SELECT token_hash FROM sessions WHERE user_id = ${session.user.id}
    `;
    expect(stored[0]?.token_hash).toBe(hashToken(session.token));
    const fetched = await auth.getSessionUser(session.token);
    expect(fetched?.id).toBe(session.user.id);
    expect(fetched?.role).toBe("owner");
  });

  it("returns null for expired sessions", async () => {
    await db`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (
        (SELECT id FROM users WHERE email = 'owner@alpha.test'),
        ${hashToken("expired-token")},
        now() - interval '1 hour'
      )
    `;
    expect(await auth.getSessionUser("expired-token")).toBeNull();
  });

  it("gives a generic error for bad passwords and unknown emails and audits failures", async () => {
    await expectAuthError(auth.login("owner@alpha.test", "wrong-password"), 401, "invalid_credentials");
    await expectAuthError(auth.login("nobody@alpha.test", "whatever-pass"), 401, "invalid_credentials");
    const owner = await getUserByEmail(db, "owner@alpha.test");
    expect(owner).not.toBeNull();
    const events = await listAuditEvents(db, owner!.orgId);
    const failures = events.filter((e) => e.action === "auth.login_failed");
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("wrong-password");
  });

  it("logs out and invalidates the session", async () => {
    const session = await auth.login("owner@alpha.test", "super-secret-123");
    expect(await auth.getSessionUser(session.token)).not.toBeNull();
    await auth.logout(session.token);
    expect(await auth.getSessionUser(session.token)).toBeNull();
    expect(await findSessionByTokenHash(db, hashToken(session.token))).toBeNull();
    const events = await listAuditEvents(db, session.user.orgId);
    expect(events.some((e) => e.action === "auth.logout")).toBe(true);
  });

  it("enforces RBAC for viewer-created members", async () => {
    const ownerSession = await auth.login("owner@alpha.test", "super-secret-123");
    const orgId = ownerSession.user.orgId;
    const viewer = await createUser(db, {
      orgId,
      email: `viewer-${Date.now()}@alpha.test`,
      role: "viewer",
      passwordHash: await hashPassword("viewer-password-123"),
    });
    expect(can(viewer.role, "org:write")).toBe(false);
    expect(() => requireRole(viewer, "org:write")).toThrow(AuthError);
    const member = await createUser(db, {
      orgId,
      email: `member-${Date.now()}@alpha.test`,
      role: "member",
      passwordHash: await hashPassword("member-password-123"),
    });
    expect(can(member.role, "org:read")).toBe(true);
    expect(can(member.role, "audit:read")).toBe(false);
    const admin = await createUser(db, {
      orgId,
      email: `admin-${Date.now()}@alpha.test`,
      role: "admin",
      passwordHash: await hashPassword("admin-password-123"),
    });
    expect(can(admin.role, "audit:read")).toBe(true);
    expect(can(admin.role, "org:admin")).toBe(false);
    await auth.login(admin.email, "admin-password-123");
    const events = await auth.listOrgAuditEvents(orgId, { limit: 100 });
    expect(events.every((e) => e.orgId === orgId)).toBe(true);
  });

  it("isolates cross-org access at the service level", async () => {
    await auth.register({
      orgName: "Gamma Co",
      email: "owner@gamma.test",
      password: "gamma-secret-789",
    });
    const gammaSession = await auth.login("owner@gamma.test", "gamma-secret-789");
    const alphaUsers = await listUsersByOrg(db, gammaSession.user.orgId);
    expect(alphaUsers.map((u) => u.email)).toEqual(["owner@gamma.test"]);
    const alphaEvents = await auth.listOrgAuditEvents(gammaSession.user.orgId);
    expect(alphaEvents.every((e) => e.orgId === gammaSession.user.orgId)).toBe(true);
  });
});

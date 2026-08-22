import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  AuthService,
  AuthError,
  confirmEmailVerification,
  hashToken,
  RecoveryRateError,
  RecoveryTokenError,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  type EmailSender,
} from "../src/index.js";
import { createDb, listAuditEvents, migrateUp } from "@zaff/db";

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

class CapturingSender implements EmailSender {
  readonly verificationTokens: Array<{ email: string; token: string }> = [];
  readonly resetTokens: Array<{ email: string; token: string }> = [];

  async sendEmailVerification(email: string, rawToken: string): Promise<void> {
    this.verificationTokens.push({ email, token: rawToken });
  }

  async sendPasswordReset(email: string, rawToken: string): Promise<void> {
    this.resetTokens.push({ email, token: rawToken });
  }
}

function lastVerification(sender: CapturingSender): { email: string; token: string } {
  const entry = sender.verificationTokens.at(-1);
  expect(entry).toBeDefined();
  return entry!;
}

suite("services/auth account-recovery integration", () => {
  const db = createDb(TEST_URL);
  const auth = new AuthService(db);

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS clicks, recovery_tokens, audit_log, sessions, user_identities, users, organizations, schema_migrations CASCADE"
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);
  });

  afterAll(async () => {
    if (dbAvailable) await db.end();
  });

  it("completes the email verification flow and rejects token replay", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    const user = await auth.register({
      orgName: "Recover Co",
      email: "owner@recover.test",
      password: "original-pass-123",
    });

    async function emailVerified(userId: string): Promise<boolean> {
      const rows = await db`
        SELECT email_verified AS "emailVerified" FROM users WHERE id = ${userId}
      `;
      return rows[0]?.emailVerified === true;
    }

    expect(await emailVerified(user.id)).toBe(false);

    await requestEmailVerification(deps, user.id);
    const mailed = lastVerification(sender);
    expect(mailed.email).toBe(user.email);
    expect(mailed.token).not.toContain("="); // base64url raw token, not a hash
    // Only the SHA-256 hash is stored, never the raw token.
    const stored = await db`
      SELECT token_hash FROM recovery_tokens WHERE purpose = 'email_verify'
    `;
    expect(stored.map((r) => r.token_hash)).toContain(hashToken(mailed.token));
    expect(JSON.stringify(stored)).not.toContain(mailed.token);

    let events = await listAuditEvents(db, user.orgId);
    expect(events.some((e) => e.action === "account.email_verify_requested")).toBe(true);

    const confirmed = await confirmEmailVerification(deps, mailed.token);
    expect(confirmed.userId).toBe(user.id);
    expect(await emailVerified(user.id)).toBe(true);
    events = await listAuditEvents(db, user.orgId);
    expect(events.some((e) => e.action === "account.email_verified")).toBe(true);

    await expect(confirmEmailVerification(deps, mailed.token)).rejects.toBeInstanceOf(
      RecoveryTokenError
    );
  });

  it("rejects an expired verification token", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    const session = await auth.login("owner@recover.test", "original-pass-123");
    await requestEmailVerification(deps, session.user.id);
    const mailed = lastVerification(sender);
    await db`
      UPDATE recovery_tokens
      SET expires_at = now() - interval '1 minute'
      WHERE purpose = 'email_verify' AND used_at IS NULL
    `;
    await expect(confirmEmailVerification(deps, mailed.token)).rejects.toBeInstanceOf(
      RecoveryTokenError
    );
    // Expired-token failure must not have consumed the token.
    const rows = await db`
      SELECT used_at FROM recovery_tokens WHERE token_hash = ${hashToken(mailed.token)}
    `;
    expect(rows[0].used_at).toBeNull();
  });

  it("rejects a wrong-purpose token without consuming it", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    await requestPasswordReset(deps, "owner@recover.test");
    const mailed = sender.resetTokens.at(-1)!;

    await expect(confirmEmailVerification(deps, mailed.token)).rejects.toBeInstanceOf(
      RecoveryTokenError
    );
    const rows = await db`
      SELECT used_at FROM recovery_tokens WHERE token_hash = ${hashToken(mailed.token)}
    `;
    expect(rows[0].used_at).toBeNull();
  });

  it("handles reset for existing and nonexistent emails identically and resets the password", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };

    // Two live sessions that must both die after the reset.
    const s1 = await auth.login("owner@recover.test", "original-pass-123");
    const s2 = await auth.login("owner@recover.test", "original-pass-123");

    const totalBefore = await db`SELECT count(*) AS n FROM recovery_tokens`;
    const auditsBefore = (await listAuditEvents(db, s1.user.orgId)).filter(
      (e) => e.action === "account.password_reset_requested"
    ).length;

    // Existing address resolves...
    await requestPasswordReset(deps, "owner@recover.test");
    // ...and a nonexistent address resolves identically with zero side effects.
    await requestPasswordReset(deps, "ghost-does-not-exist@nowhere.test");

    const totalAfter = await db`SELECT count(*) AS n FROM recovery_tokens`;
    // Exactly one new row: only the existing account got a token.
    expect(Number(totalAfter[0].n)).toBe(Number(totalBefore[0].n) + 1);
    // No audit event may leak the nonexistent address.
    const events = await listAuditEvents(db, s1.user.orgId);
    expect(events.filter((e) => e.action === "account.password_reset_requested")).toHaveLength(
      auditsBefore + 1
    );
    expect(JSON.stringify(events)).not.toContain("ghost-does-not-exist");
    expect(sender.resetTokens.filter((t) => t.email === "owner@recover.test")).toHaveLength(1);

    const mailed = sender.resetTokens.at(-1)!;
    const result = await resetPassword(deps, mailed.token, "brand-new-pass-456");
    expect(result.userId).toBe(s1.user.id);

    // Old password fails, new one works.
    await expect(auth.login("owner@recover.test", "original-pass-123")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    const relogin = await auth.login("owner@recover.test", "brand-new-pass-456");
    expect(relogin.user.id).toBe(s1.user.id);

    // Every prior session was invalidated.
    expect(await auth.getSessionUser(s1.token)).toBeNull();
    expect(await auth.getSessionUser(s2.token)).toBeNull();

    // Token is single-use.
    await expect(resetPassword(deps, mailed.token, "another-pass-789")).rejects.toBeInstanceOf(
      RecoveryTokenError
    );

    const completed = (await listAuditEvents(db, s1.user.orgId)).filter(
      (e) => e.action === "account.password_reset_completed"
    );
    expect(completed).toHaveLength(1);
  });

  it("rate-limits unknown emails identically to known ones (no 429 existence signal)", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    const ghost = "ghost-ratelimit@nowhere.test";

    // First three requests resolve silently (uniform behavior).
    await requestPasswordReset(deps, ghost);
    await requestPasswordReset(deps, ghost);
    await requestPasswordReset(deps, ghost);
    // Nothing was mailed or persisted for the ghost address.
    expect(sender.resetTokens.filter((t) => t.email === ghost)).toHaveLength(0);

    // 4th rapid request hits the SAME rate bucket shape as a real account.
    await expect(requestPasswordReset(deps, ghost)).rejects.toBeInstanceOf(
      RecoveryRateError
    );
    // And it stays rejected (bucket not reset by the rejection).
    await expect(requestPasswordReset(deps, ghost)).rejects.toBeInstanceOf(
      RecoveryRateError
    );
  });

  it("rate-limits rapid verification requests with RecoveryRateError", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    const user = await auth.register({
      orgName: "Rate Co",
      email: "owner@rate.test",
      password: "rate-limit-pass",
    });
    await requestEmailVerification(deps, user.id);
    await requestEmailVerification(deps, user.id);
    await requestEmailVerification(deps, user.id);
    // 4th rapid request hits the 3-outstanding-tokens guard.
    await expect(requestEmailVerification(deps, user.id)).rejects.toBeInstanceOf(
      RecoveryRateError
    );
  });

  it("lets exactly one of two concurrent confirms win on the same token", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    // Fresh org so the earlier rate-limit test's outstanding tokens don't interfere.
    const user = await auth.register({
      orgName: "Concurrent Co",
      email: "owner@concurrent.test",
      password: "concurrent-pass-1",
    });
    await requestEmailVerification(deps, user.id);
    const mailed = lastVerification(sender);

    const results = await Promise.allSettled([
      confirmEmailVerification(deps, mailed.token),
      confirmEmailVerification(deps, mailed.token),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RecoveryTokenError);
  });

  it("lets exactly one of two concurrent resets win on the same token", async () => {
    const sender = new CapturingSender();
    const deps = { db, sender };
    const user = await auth.register({
      orgName: "Race Co",
      email: "owner@race.test",
      password: "race-original-123",
    });
    await auth.login(user.email, "race-original-123"); // a session to be invalidated
    await requestPasswordReset(deps, user.email);
    const mailed = sender.resetTokens.at(-1)!;

    const results = await Promise.allSettled([
      resetPassword(deps, mailed.token, "race-new-pass-999"),
      resetPassword(deps, mailed.token, "race-new-pass-999"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RecoveryTokenError);

    await expect(auth.login(user.email, "race-original-123")).rejects.toBeInstanceOf(AuthError);
    await auth.login(user.email, "race-new-pass-999");
    const events = await listAuditEvents(db, user.orgId);
    expect(events.filter((e) => e.action === "account.password_reset_completed")).toHaveLength(1);
  });
});

import { randomBytes } from "node:crypto";
import type { Db } from "@zaff/db";
import { appendAuditEvent } from "@zaff/db";
import { AuthError } from "../service.js";
import { hashPassword } from "../passwords.js";
import { hashToken } from "../tokens.js";

/** Raw recovery token: 32 random bytes, base64url-encoded; only its SHA-256 hash is stored. */
function generateRecoveryToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * TTLs and rate-limit window for recovery flows. The 10-minute request
 * window is a deliberately simple policy: at most one outstanding unused
 * token per user+purpose per window (see requestEmailVerification).
 */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const RECOVERY_RATE_WINDOW_MS = 10 * 60 * 1000;

/** Raised when a raw token is unknown, already used, expired, or has the wrong purpose. */
export class RecoveryTokenError extends AuthError {
  constructor() {
    // One generic message for all failure modes: never reveal which one.
    super(400, "invalid_recovery_token", "this link is invalid or has expired");
    this.name = "RecoveryTokenError";
  }
}

/** Raised when too many recovery requests are made within the rate window. */
export class RecoveryRateError extends AuthError {
  constructor() {
    super(429, "recovery_rate_limited", "too many requests; try again later");
    this.name = "RecoveryRateError";
  }
}

export interface EmailSender {
  sendEmailVerification(email: string, rawToken: string): Promise<void>;
  sendPasswordReset(email: string, rawToken: string): Promise<void>;
}

/**
 * Default sender used when no real delivery integration is wired up.
 * Logs via an injected logger fn only; raw tokens are NEVER logged —
 * the message contains just the recipient address and flow name.
 */
export class NoopEmailSender implements EmailSender {
  private readonly log: (message: string) => void;

  constructor(logger?: (message: string) => void) {
    this.log = logger ?? (() => {});
  }

  async sendEmailVerification(email: string, _rawToken: string): Promise<void> {
    this.log(`[noop-email] email verification mail queued for ${email}`);
  }

  async sendPasswordReset(email: string, _rawToken: string): Promise<void> {
    this.log(`[noop-email] password reset mail queued for ${email}`);
  }
}

export interface AccountRecoveryDeps {
  db: Db;
  /** Defaults to NoopEmailSender when omitted. */
  sender?: EmailSender;
}

type RecoveryPurpose = "email_verify" | "password_reset";

interface ClaimedToken {
  id: string;
  userId: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

async function findUserSummary(
  db: Db,
  userId: string
): Promise<{ id: string; orgId: string; email: string; emailVerified: boolean } | null> {
  const rows = await db`
    SELECT id, org_id AS "orgId", email, email_verified AS "emailVerified"
    FROM users
    WHERE id = ${userId}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    orgId: row.orgId as string,
    email: row.email as string,
    emailVerified: row.emailVerified as boolean,
  };
}

/**
 * Race-safe single-use consumption of a recovery token. The conditional
 * UPDATE claims the row atomically: concurrent callers see used_at set by
 * the winner and get zero rows back.
 */
async function claimRecoveryToken(
  tx: Db,
  rawToken: string,
  purpose: RecoveryPurpose
): Promise<ClaimedToken> {
  const rows = await tx`
    UPDATE recovery_tokens
    SET used_at = now()
    WHERE token_hash = ${hashToken(rawToken)}
      AND purpose = ${purpose}
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING id, user_id AS "userId"
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new RecoveryTokenError();
  return { id: row.id as string, userId: row.userId as string };
}

/**
 * Create (and hand to the sender) a single-use email verification token.
 *
 * Rate guard: at most 3 outstanding unused tokens per user+purpose may be
 * created within the rate window; further requests are rejected with
 * RecoveryRateError until tokens are consumed or age out of the window.
 * This is a deliberate eviction-free policy: tokens expire on their own TTL,
 * so nothing needs active cleanup.
 */
export async function requestEmailVerification(
  deps: AccountRecoveryDeps,
  userId: string
): Promise<{ expiresAt: Date }> {
  const user = await findUserSummary(deps.db, userId);
  if (!user) {
    throw new AuthError(404, "user_not_found", "user not found");
  }
  const cutoff = new Date(Date.now() - RECOVERY_RATE_WINDOW_MS);
  const recent = await deps.db`
    SELECT count(*) AS n FROM recovery_tokens
    WHERE user_id = ${userId}
      AND purpose = 'email_verify'
      AND used_at IS NULL
      AND expires_at > now()
      AND created_at > ${cutoff}
  `;
  if (Number((recent[0] as { n: unknown } | undefined)?.n ?? 0) >= 3) {
    throw new RecoveryRateError();
  }

  const rawToken = generateRecoveryToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS);
  await deps.db.begin(async (tx) => {
    const t = tx as unknown as Db;
    try {
      await t`
        INSERT INTO recovery_tokens (user_id, purpose, token_hash, expires_at)
        VALUES (${userId}, 'email_verify', ${hashToken(rawToken)}, ${expiresAt})
      `;
    } catch (error) {
      // Unique collision can only be a random-token collision (2^-256);
      // surface it rather than retry-looping.
      if (isUniqueViolation(error)) {
        throw new AuthError(500, "internal", "token generation conflict");
      }
      throw error;
    }
    await appendAuditEvent(t, {
      orgId: user.orgId,
      actorUserId: userId,
      action: "account.email_verify_requested",
      targetType: "user",
      targetId: userId,
      metadata: {},
    });
  });
  // Send only after commit so recipients never receive tokens from rolled-back transactions.
  await (deps.sender ?? new NoopEmailSender()).sendEmailVerification(user.email, rawToken);
  return { expiresAt };
}

/**
 * Consume an email-verification token: marks the token used, sets
 * users.email_verified = true, and audits the completion.
 */
export async function confirmEmailVerification(
  deps: AccountRecoveryDeps,
  rawToken: string
): Promise<{ userId: string }> {
  if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > 512) {
    throw new RecoveryTokenError();
  }
  return deps.db.begin(async (tx) => {
    const t = tx as unknown as Db;
    const claimed = await claimRecoveryToken(t, rawToken, "email_verify");
    const updated = await t`
      UPDATE users
      SET email_verified = true
      WHERE id = ${claimed.userId} AND NOT email_verified
      RETURNING org_id AS "orgId"
    `;
    const row = updated[0] as Record<string, unknown> | undefined;
    if (row) {
      await appendAuditEvent(t, {
        orgId: row.orgId as string,
        actorUserId: claimed.userId,
        action: "account.email_verified",
        targetType: "user",
        targetId: claimed.userId,
        metadata: {},
      });
    }
    return { userId: claimed.userId };
  });
}

/**
 * In-process rate buckets keyed by sha256(normalized email + purpose).
 *
 * Deliberate choice: nothing about non-existent requesters is persisted —
 * no DB row, no audit event — so the database never stores identifying
 * traces of addresses that do not belong to real accounts. The cost is that
 * this bucket is per-process and resets on restart; acceptable for the
 * current single-process auth service.
 */
const resetRequestBuckets = new Map<string, number[]>();

function emailBucketKey(email: string): string {
  return `${hashToken(email.trim().toLowerCase())}:password_reset`;
}

function hitRateBucket(key: string, now: number): boolean {
  const windowStart = now - RECOVERY_RATE_WINDOW_MS;
  const hits = (resetRequestBuckets.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= 3) {
    resetRequestBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  resetRequestBuckets.set(key, hits);
  return true;
}

/**
 * Request a password reset. Anti-enumeration contract: resolves identically
 * whether or not the email belongs to an account. A token is created (and
 * mailed) only for existing accounts; for unknown emails nothing is stored
 * and no audit event is written, so neither the caller response nor the
 * database reveals account existence.
 *
 * The in-memory rate bucket is charged BEFORE account lookup, so unknown
 * emails occupy the same bucket shape as known ones: after the threshold,
 * both paths throw RecoveryRateError identically, closing the 429-asymmetry
 * existence signal. Bucket state is still per-process and never persisted.
 */
export async function requestPasswordReset(
  deps: AccountRecoveryDeps,
  email: string
): Promise<void> {
  if (typeof email !== "string" || email.length === 0 || email.length > 320) return;
  const normalized = email.trim().toLowerCase();
  if (!hitRateBucket(emailBucketKey(normalized), Date.now())) {
    // Same rejection for known and unknown addresses: no existence signal.
    throw new RecoveryRateError();
  }

  const userRows = await deps.db`
    SELECT id, org_id AS "orgId", email
    FROM users
    WHERE email = ${normalized}
  `;
  const user = userRows[0] as Record<string, unknown> | undefined;
  if (!user) {
    // Uniform caller-visible behavior: same resolution path, no storage, no audit.
    return;
  }

  const rawToken = generateRecoveryToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  const userId = user.id as string;
  const orgId = user.orgId as string;
  const userEmail = user.email as string;
  await deps.db.begin(async (tx) => {
    const t = tx as unknown as Db;
    await t`
      INSERT INTO recovery_tokens (user_id, purpose, token_hash, expires_at)
      VALUES (${userId}, 'password_reset', ${hashToken(rawToken)}, ${expiresAt})
    `;
    // Success-side audit only; metadata carries no presence signal.
    await appendAuditEvent(t, {
      orgId,
      actorUserId: null,
      action: "account.password_reset_requested",
      targetType: "user",
      targetId: userId,
      metadata: {},
    });
  });
  await (deps.sender ?? new NoopEmailSender()).sendPasswordReset(userEmail, rawToken);
}

const MIN_RESET_PASSWORD_LENGTH = 8;

/**
 * Consume a password-reset token: rewrites the argon2id password hash,
 * invalidates every session for the user (defense against session theft
 * after credential compromise), marks the token used, and audits it.
 */
export async function resetPassword(
  deps: AccountRecoveryDeps,
  rawToken: string,
  newPassword: string
): Promise<{ userId: string }> {
  if (typeof rawToken !== "string" || rawToken.length === 0 || rawToken.length > 512) {
    throw new RecoveryTokenError();
  }
  if (
    typeof newPassword !== "string" ||
    newPassword.length < MIN_RESET_PASSWORD_LENGTH ||
    newPassword.length > 1024
  ) {
    throw new AuthError(
      400,
      "weak_password",
      `password must be between ${MIN_RESET_PASSWORD_LENGTH} and 1024 characters`
    );
  }
  const passwordHash = await hashPassword(newPassword);
  return deps.db.begin(async (tx) => {
    const t = tx as unknown as Db;
    const claimed = await claimRecoveryToken(t, rawToken, "password_reset");
    const ownerRows = await t`
      SELECT org_id AS "orgId" FROM users WHERE id = ${claimed.userId}
    `;
    const owner = ownerRows[0] as Record<string, unknown> | undefined;
    if (!owner) {
      // User deleted between request and confirm (FK cascade removes tokens,
      // so this is near-impossible, but fail closed inside the transaction).
      throw new RecoveryTokenError();
    }
    await t`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE id = ${claimed.userId}
    `;
    await t`
      DELETE FROM sessions
      WHERE user_id = ${claimed.userId}
    `;
    await appendAuditEvent(t, {
      orgId: owner.orgId as string,
      actorUserId: claimed.userId,
      action: "account.password_reset_completed",
      targetType: "user",
      targetId: claimed.userId,
      metadata: {},
    });
    return { userId: claimed.userId };
  });
}

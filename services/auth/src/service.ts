import type { Role } from "@zaff/contracts";
import {
  appendAuditEvent,
  createOrganization,
  createSession,
  createUser,
  createUserIdentity,
  deleteSessionByTokenHash,
  getUserIdentity,
  getUserByEmail,
  getUserCredentialsByEmail,
  listAuditEvents,
  listUsersByOrg,
  type AuditEventRow,
  type Db,
  type UserRow,
} from "@zaff/db";
import { hashPassword, verifyPassword } from "./passwords.js";
import { can, type AuthAction } from "./rbac.js";
import { generateSessionToken, hashToken } from "./tokens.js";

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionWithToken {
  token: string;
  expiresAt: Date;
}

let dummyHashPromise: Promise<string> | null = null;

async function dummyVerify(password: string): Promise<boolean> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("zaff-dummy-password-for-timing-equalization");
  }
  const dummyHash = await dummyHashPromise;
  return verifyPassword(dummyHash, password);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

interface SessionContext {
  sessionId: string;
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  expiresAt: Date;
  createdAt: Date;
}

export class AuthService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async register(input: {
    orgName: string;
    email: string;
    password: string;
  }): Promise<UserRow> {
    const role: Role = "owner";
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.begin(async (tx): Promise<UserRow> => {
        const t = tx as unknown as Db;
        const org = await createOrganization(t, { name: input.orgName });
        const user = await createUser(t, {
          orgId: org.id,
          email: input.email,
          role,
          passwordHash,
        });
        await appendAuditEvent(t, {
          orgId: org.id,
          actorUserId: user.id,
          action: "user.registered",
          targetType: "user",
          targetId: user.id,
          metadata: {},
        });
        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthError(
          409,
          "email_taken",
          "unable to register with the provided details"
        );
      }
      throw error;
    }
  }

  async login(
    email: string,
    password: string
  ): Promise<SessionWithToken & { user: UserRow }> {
    const credentials = await getUserCredentialsByEmail(this.db, email);
    let passwordOk: boolean;
    let actor: { id: string; orgId: string } | null = null;
    if (!credentials) {
      passwordOk = await dummyVerify(password);
    } else {
      passwordOk = await verifyPassword(credentials.passwordHash, password);
      actor = credentials;
    }
    if (!actor || !passwordOk) {
      if (actor) {
        await appendAuditEvent(this.db, {
          orgId: actor.orgId,
          actorUserId: actor.id,
          action: "auth.login_failed",
          targetType: "user",
          targetId: actor.id,
          metadata: {},
        });
      }
      throw new AuthError(401, "invalid_credentials", "invalid email or password");
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await createSession(this.db, {
      userId: actor.id,
      tokenHash: hashToken(token),
      expiresAt,
    });
    await appendAuditEvent(this.db, {
      orgId: actor.orgId,
      actorUserId: actor.id,
      action: "auth.login",
      targetType: "session",
      targetId: session.id,
      metadata: {},
    });
    const user = await getUserByEmail(this.db, email);
    if (!user) {
      throw new AuthError(500, "internal", "user disappeared during login");
    }
    return { token, expiresAt, user };
  }

  /**
   * Find-or-link an OIDC identity and issue a session identical to a local
   * login. New identities are linked to an existing local user only when the
   * provider asserts the email as verified; otherwise a fresh personal org +
   * user is created (never silently taking over an existing account).
   */
  async loginWithOidc(input: {
    issuer: string;
    subject: string;
    email: string;
    emailVerified?: boolean;
  }): Promise<SessionWithToken & { user: UserRow }> {
    const existing = await getUserIdentity(this.db, {
      issuer: input.issuer,
      subject: input.subject,
    });
    if (!existing) {
      await this.registerOidcIdentity(input);
    }
    const identity = await getUserIdentity(this.db, {
      issuer: input.issuer,
      subject: input.subject,
    });
    if (!identity) {
      throw new AuthError(500, "internal", "oidc identity disappeared during login");
    }
    const user = await this.getUserByIdAcrossOrgs(identity.userId);
    if (!user) {
      throw new AuthError(500, "internal", "oidc identity points at a missing user");
    }
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await createSession(this.db, {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    });
    await appendAuditEvent(this.db, {
      orgId: user.orgId,
      actorUserId: user.id,
      action: "auth.login",
      targetType: "session",
      targetId: session.id,
      metadata: { via: "oidc", issuer: input.issuer },
    });
    return { token, expiresAt, user };
  }

  private async registerOidcIdentity(input: {
    issuer: string;
    subject: string;
    email: string;
    emailVerified?: boolean;
  }): Promise<void> {
    try {
      await this.db.begin(async (tx) => {
        const t = tx as unknown as Db;
        const localUser = await getUserByEmail(t, input.email);
        let userId: string;
        let orgId: string;
        if (localUser && input.emailVerified === true) {
          userId = localUser.id;
          orgId = localUser.orgId;
        } else if (localUser) {
          throw new AuthError(
            409,
            "email_taken",
            "an account with this email already exists; sign in locally to link it"
          );
        } else {
          const org = await createOrganization(t, { name: "personal" });
          const user = await createUser(t, {
            orgId: org.id,
            email: input.email,
            role: "owner",
            passwordHash: "",
          });
          userId = user.id;
          orgId = org.id;
        }
        await appendAuditEvent(t, {
          orgId,
          actorUserId: userId,
          action: localUser ? "user.oauth_linked" : "user.oauth_registered",
          targetType: "user",
          targetId: userId,
          metadata: { issuer: input.issuer, subject: input.subject },
        });
        await createUserIdentity(t, {
          userId,
          issuer: input.issuer,
          subject: input.subject,
        });
      });
    } catch (error) {
      // Concurrent first login with the same identity: the unique constraint
      // on (issuer, subject) means the other transaction won — proceed.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  private async getUserByIdAcrossOrgs(id: string): Promise<UserRow | null> {
    const rows = await this.db`
      SELECT
        id,
        org_id AS "orgId",
        email,
        role,
        created_at AS "createdAt"
      FROM users
      WHERE id = ${id}
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      orgId: row.orgId as string,
      email: row.email as string,
      role: row.role as UserRow["role"],
      createdAt: row.createdAt as Date,
    };
  }

  async getSessionUser(token: string | undefined): Promise<UserRow | null> {
    if (!token || token.length === 0 || token.length > 512) return null;
    const context = await this.findSessionContext(token);
    if (!context) return null;
    return {
      id: context.userId,
      orgId: context.orgId,
      email: context.email,
      role: context.role,
      createdAt: context.createdAt,
    };
  }

  private async findSessionContext(token: string): Promise<SessionContext | null> {
    const rows = await this.db`
      SELECT
        s.id AS "sessionId",
        s.expires_at AS "expiresAt",
        u.id AS "userId",
        u.org_id AS "orgId",
        u.email,
        u.role,
        u.created_at AS "createdAt"
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: row.sessionId as string,
      userId: row.userId as string,
      orgId: row.orgId as string,
      email: row.email as string,
      role: row.role as Role,
      expiresAt: row.expiresAt as Date,
      createdAt: row.createdAt as Date,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token || token.length === 0 || token.length > 512) return;
    const context = await this.findSessionContext(token);
    const deleted = await deleteSessionByTokenHash(this.db, hashToken(token));
    if (!context || !deleted) return;
    await appendAuditEvent(this.db, {
      orgId: context.orgId,
      actorUserId: context.userId,
      action: "auth.logout",
      targetType: "session",
      targetId: context.sessionId,
      metadata: {},
    });
  }

  async listOrgUsers(orgId: string): Promise<UserRow[]> {
    return listUsersByOrg(this.db, orgId);
  }

  async listOrgAuditEvents(
    orgId: string,
    options: { limit?: number } = {}
  ): Promise<AuditEventRow[]> {
    return listAuditEvents(this.db, orgId, options);
  }
}

export function requireUser(user: UserRow | null): UserRow {
  if (!user) {
    throw new AuthError(401, "unauthenticated", "authentication required");
  }
  return user;
}

export function requireRole(user: UserRow, action: AuthAction): void {
  if (!can(user.role, action)) {
    throw new AuthError(
      403,
      "forbidden",
      `role '${user.role}' is not permitted to perform '${action}'`
    );
  }
}

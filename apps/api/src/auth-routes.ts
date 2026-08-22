import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthError,
  AuthService,
  requireRole,
  requireUser,
} from "@zaff/auth";
import type { OAuthRouteOptions } from "./oauth-routes.js";
import {
  AuthLoginRequestSchema,
  AuthRegisterRequestSchema,
} from "@zaff/contracts";

export const SESSION_COOKIE_NAME = "zaff_session";
const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALUE = "zaff";
const MAX_BODY_BYTES = 16 * 1024;

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  allow(key: string): boolean;
  size(): number;
}

export const RATE_LIMITER_MAX_BUCKETS = 10_000;

export function createFixedWindowRateLimiter(
  options: RateLimitOptions,
  now: () => number = Date.now
): RateLimiter {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  let nextSweepAt = Math.floor(options.windowMs / 2);

  function evictExpired(current: number): void {
    for (const [key, bucket] of buckets) {
      if (current - bucket.windowStart >= options.windowMs) buckets.delete(key);
    }
  }

  function evictOldest(keepCount: number): void {
    const excess = buckets.size - keepCount;
    if (excess <= 0) return;
    let deleted = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++deleted >= excess) break;
    }
  }

  return {
    allow(key: string): boolean {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current - bucket.windowStart >= options.windowMs) {
        if (current >= nextSweepAt || buckets.size >= RATE_LIMITER_MAX_BUCKETS) {
          evictExpired(current);
          nextSweepAt = current + Math.floor(options.windowMs / 2);
          if (buckets.size >= RATE_LIMITER_MAX_BUCKETS) {
            evictOldest(RATE_LIMITER_MAX_BUCKETS - 1);
          }
        }
        buckets.set(key, { count: 1, windowStart: current });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= options.max;
    },
    size(): number {
      return buckets.size;
    },
  };
}

export function buildSessionCookie(
  token: string,
  expiresAt: Date,
  secure: boolean
): string {
  const flags = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new AuthError(413, "payload_too_large", "request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError(400, "invalid_json", "request body must be valid JSON");
  }
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export interface AuthRouteDeps {
  authService?: AuthService;
  secureCookies?: boolean;
  oauth?: OAuthRouteOptions;
}

export interface AuthRouteResult {
  handled: boolean;
}

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: AuthRouteDeps,
  loginLimiter: RateLimiter
): Promise<AuthRouteResult> {
  const method = req.method ?? "";
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const isAuthRoute =
    pathname.startsWith("/auth/") || pathname.startsWith("/orgs/") || pathname === "/audit";
  if (!isAuthRoute) return { handled: false };

  const authService = deps.authService;
  if (!authService) {
    if (pathname.startsWith("/auth/") || pathname === "/audit" || pathname.startsWith("/orgs/")) {
      if (method !== "OPTIONS") {
        sendJson(res, 503, { error: "service_unavailable", message: "auth service not configured" });
        return { handled: true };
      }
    }
    return { handled: false };
  }

  try {
    if (mutating && !isCsrfOk(req)) {
      throw new AuthError(403, "csrf_required", `missing header ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`);
    }

    if (pathname === "/auth/register" && method === "POST") {
      const body = AuthRegisterRequestSchema.parse(await readJsonBody(req));
      const user = await authService.register(body);
      sendJson(res, 201, { user: serializeUser(user) });
      return { handled: true };
    }

    if (pathname === "/auth/login" && method === "POST") {
      const key = `${clientIp(req)}:/auth/login`;
      if (!loginLimiter.allow(key)) {
        sendJson(res, 429, { error: "rate_limited", message: "too many login attempts" });
        return { handled: true };
      }
      const body = AuthLoginRequestSchema.parse(await readJsonBody(req));
      const session = await authService.login(body.email, body.password);
      sendJson(res, 200, {
        user: serializeUser(session.user),
        expiresAt: session.expiresAt.toISOString(),
      }, {
        "set-cookie": buildSessionCookie(session.token, session.expiresAt, deps.secureCookies ?? false),
      });
      return { handled: true };
    }

    if (pathname === "/auth/logout" && method === "POST") {
      await authService.logout(getCookie(req, SESSION_COOKIE_NAME));
      sendJson(res, 200, { ok: true }, { "set-cookie": buildSessionClearCookie() });
      return { handled: true };
    }

    if (pathname === "/auth/me" && method === "GET") {
      const token = getCookie(req, SESSION_COOKIE_NAME);
      const user = await authService.getSessionUser(token);
      if (!user) {
        throw new AuthError(401, "unauthenticated", "authentication required");
      }
      sendJson(res, 200, { user: serializeUser(user) });
      return { handled: true };
    }

    const usersMatch = /^\/orgs\/([0-9a-fA-F-]{36})\/users$/.exec(pathname);
    if (usersMatch && method === "GET") {
      const requester = requireUser(await authService.getSessionUser(getCookie(req, SESSION_COOKIE_NAME)));
      const orgId = usersMatch[1] as string;
      if (requester.orgId !== orgId) {
        throw new AuthError(403, "forbidden", "cross-org access denied");
      }
      requireRole(requester, "user:list");
      const users = await authService.listOrgUsers(orgId);
      sendJson(res, 200, { users: users.map(serializeUser) });
      return { handled: true };
    }

    if (pathname === "/audit" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://localhost");
      const orgId = url.searchParams.get("orgId") ?? "";
      const requester = requireUser(await authService.getSessionUser(getCookie(req, SESSION_COOKIE_NAME)));
      if (!orgId || requester.orgId !== orgId) {
        throw new AuthError(403, "forbidden", "cross-org access denied");
      }
      requireRole(requester, "audit:read");
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const events = await authService.listOrgAuditEvents(orgId, {
        limit: Number.isFinite(limitParam) ? limitParam : undefined,
      });
      sendJson(res, 200, {
        events: events.map((e) => ({
          id: e.id,
          orgId: e.orgId,
          actorUserId: e.actorUserId,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          metadata: e.metadata,
          createdAt: e.createdAt.toISOString(),
        })),
      });
      return { handled: true };
    }

    if (pathname.startsWith("/auth/") || pathname === "/audit" || pathname.startsWith("/orgs/")) {
      throw new AuthError(404, "not_found", "route not found");
    }
    return { handled: false };
  } catch (error) {
    if (error instanceof AuthError) {
      sendJson(res, error.status, { error: error.code, message: error.message });
      return { handled: true };
    }
    if (error && typeof error === "object" && "issues" in error) {
      sendJson(res, 400, { error: "invalid_request", message: "request validation failed" });
      return { handled: true };
    }
    sendJson(res, 500, { error: "internal", message: "unexpected error" });
    return { handled: true };
  }
}

function isCsrfOk(req: IncomingMessage): boolean {
  return req.headers[CSRF_HEADER] === CSRF_HEADER_VALUE;
}

function serializeUser(user: {
  id: string;
  orgId: string;
  email: string;
  role: string;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: user.id,
    orgId: user.orgId,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

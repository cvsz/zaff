import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthError,
  requireRole,
  requireUser,
  type AuthService,
} from "@zaff/auth";
import { listRecentClicks, recordClick, resolveLinkBySlug, type Db } from "@zaff/db";
import type { Logger } from "@zaff/observability";
import type { RateLimiter } from "./auth-routes.js";

export const DEFAULT_CLICK_SALT = "zaff_dev_click_salt_change_me";
export const MAX_LIST_LIMIT = 500;
const MAX_HEADER_LENGTH = 512;

export type ClickRecordedEvent = {
  type: "ClickRecorded";
  id: string;
  orgId: string;
  occurredAt: string;
  actor: "system" | string;
  linkId: string;
  platform: string;
};

export interface ClickEventBus {
  publish(event: ClickRecordedEvent): Promise<void>;
}

export interface LinkRouteDeps {
  db: Db;
  authService?: AuthService;
  eventBus?: ClickEventBus;
  clickSalt?: string;
  goRateLimiter?: RateLimiter;
  logger?: Logger;
}

export interface LinkRouteResult {
  handled: boolean;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof first === "string" && first.trim() !== "") {
    return first.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${ip}${salt}`).digest("hex").slice(0, 16);
}

export function mergeUtmIntoTarget(
  targetUrl: string,
  utm: Record<string, string>
): string {
  try {
    const url = new URL(targetUrl);
    for (const [key, value] of Object.entries(utm)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return targetUrl;
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== "string" || single === "") return null;
  return single.slice(0, MAX_HEADER_LENGTH);
}

function platformFromReferer(referer: string | null): string {
  if (!referer) return "direct";
  try {
    return new URL(referer).hostname || "direct";
  } catch {
    return "direct";
  }
}

async function recordClickAndPublish(
  deps: LinkRouteDeps,
  input: {
    orgId: string;
    linkId: string;
    ipHash: string;
    userAgent: string | null;
    referer: string | null;
    countryHint: string | null;
  }
): Promise<void> {
  await recordClick(deps.db, input);
  if (deps.eventBus) {
    await deps.eventBus.publish({
      type: "ClickRecorded",
      id: randomUUID(),
      orgId: input.orgId,
      occurredAt: new Date().toISOString(),
      actor: "system",
      linkId: input.linkId,
      platform: platformFromReferer(input.referer),
    });
  }
}

export async function handleLinkRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: LinkRouteDeps
): Promise<LinkRouteResult> {
  const method = req.method ?? "";

  const goMatch = /^\/go\/([^/]+)$/.exec(pathname);
  if (goMatch && method === "GET") {
    let slug: string;
    try {
      slug = decodeURIComponent(goMatch[1]!);
    } catch {
      sendJson(res, 404, { error: "not_found", message: "unknown or expired link" });
      return { handled: true };
    }

    const ip = extractClientIp(req);
    const salt = deps.clickSalt ?? DEFAULT_CLICK_SALT;
    const ipHash = hashIp(ip, salt);

    if (deps.goRateLimiter && !deps.goRateLimiter.allow(`${ipHash}:/go`)) {
      sendJson(res, 429, { error: "rate_limited", message: "too many requests" });
      return { handled: true };
    }

    const link = await resolveLinkBySlug(deps.db, slug);
    if (!link) {
      sendJson(res, 404, { error: "not_found", message: "unknown or expired link" });
      return { handled: true };
    }

    void recordClickAndPublish(deps, {
      orgId: link.orgId,
      linkId: link.id,
      ipHash,
      userAgent: headerValue(req, "user-agent"),
      referer: headerValue(req, "referer"),
      countryHint: headerValue(req, "cf-ipcountry"),
    }).catch((error: unknown) => {
      deps.logger?.warn({ err: error }, "click attribution failed");
    });

    const target = mergeUtmIntoTarget(link.targetUrl, link.utm);
    res.writeHead(302, { location: target, "cache-control": "no-store" });
    res.end();
    return { handled: true };
  }

  const clicksMatch = /^\/orgs\/([0-9a-fA-F-]{36})\/links\/([0-9a-fA-F-]{36})\/clicks$/.exec(
    pathname
  );
  if (clicksMatch && method === "GET") {
    const authService = deps.authService;
    if (!authService) {
      sendJson(res, 503, { error: "service_unavailable", message: "auth service not configured" });
      return { handled: true };
    }
    try {
      const cookie = req.headers.cookie ?? "";
      const token = sessionTokenFromCookie(cookie);
      const requester = requireUser(await authService.getSessionUser(token));
      const orgId = clicksMatch[1]!;
      const linkId = clicksMatch[2]!;
      if (requester.orgId !== orgId) {
        throw new AuthError(403, "forbidden", "cross-org access denied");
      }
      requireRole(requester, "user:list");
      const url = new URL(req.url ?? "/", "http://localhost");
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(limitParam) ? limitParam : undefined;
      const clicks = await listRecentClicks(deps.db, orgId, { linkId, limit });
      sendJson(res, 200, {
        clicks: clicks.map((click) => ({
          id: click.id,
          linkId: click.linkId,
          clickedAt: click.clickedAt.toISOString(),
          userAgent: click.userAgent,
          referer: click.referer,
          countryHint: click.countryHint,
        })),
      });
      return { handled: true };
    } catch (error) {
      if (error instanceof AuthError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return { handled: true };
      }
      sendJson(res, 500, { error: "internal", message: "unexpected error" });
      return { handled: true };
    }
  }

  return { handled: false };
}

function sessionTokenFromCookie(header: string): string | undefined {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "zaff_session") {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

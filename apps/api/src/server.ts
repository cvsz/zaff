import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { HealthResponseSchema } from "@zaff/contracts";
import { logRequest, type Logger } from "@zaff/observability";
import {
  createFixedWindowRateLimiter,
  handleAuthRoute,
  type AuthRouteDeps,
  type RateLimiter,
} from "./auth-routes.js";
import { handleOAuthRoute } from "./oauth-routes.js";

export interface ServerOptions extends AuthRouteDeps {
  loginRateLimit?: { windowMs: number; max: number };
  logger?: Logger;
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  loginLimiter: RateLimiter
): void {
  void handleRequest(req, res, options, loginLimiter);
}

function requestHeaderValue(req: IncomingMessage, header: string): string | undefined {
  const value = req.headers[header];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  loginLimiter: RateLimiter
): Promise<void> {
  const startedAt = performance.now();
  const requestId = requestHeaderValue(req, "x-request-id") ?? randomUUID();

  if (options.logger) {
    res.on("finish", () => {
      logRequest(options.logger!, {
        method: req.method ?? "-",
        url: req.url ?? "/",
        status: res.statusCode,
        durationMs: performance.now() - startedAt,
        requestId,
      });
    });
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/health") {
    const body = JSON.stringify(HealthResponseSchema.parse({ status: "ok" }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  if (!options.authService && pathname !== "/health") {
    const body = JSON.stringify({ error: "not_found", path: req.url ?? null });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  if (options.authService) {
    const oauthHandled = await handleOAuthRoute(req, res, pathname, url.searchParams, {
      authService: options.authService,
      oauth: options.oauth,
    });
    if (oauthHandled) return;
  }

  const handled = await handleAuthRoute(req, res, pathname, options, loginLimiter);
  if (handled) return;

  const body = JSON.stringify({ error: "not_found", path: req.url ?? null });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(body);
}

export function createServerInstance(options: ServerOptions = {}): Server {
  const limiter = createFixedWindowRateLimiter(
    options.loginRateLimit ?? { windowMs: 60_000, max: 10 }
  );
  return createServer((req, res) => route(req, res, options, limiter));
}

export function startServer(port: number, options: ServerOptions = {}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServerInstance(options);
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthError,
  type AuthService,
  type FetchLike,
  OidcClient,
  createState,
  createPkcePair,
  type StatePayload,
  verifyIdToken,
  verifyState,
} from "@zaff/auth";

export const OAUTH_STATE_MAX_AGE_SEC = 600;

// DEV-ONLY default; set OAUTH_STATE_SECRET in any real deployment.
const DEV_STATE_SECRET = "zaff_dev_state_secret_change_me";

const SESSION_COOKIE_NAME = "zaff_session";

export interface OAuthProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

export interface OAuthRouteOptions {
  /** Overrides/extends the built-in provider registry (used by tests). */
  providers?: Record<string, OAuthProviderConfig>;
  fetchImpl?: FetchLike;
  stateSecret?: string;
  now?: () => number;
  /** Explicit app origin for callback URLs; overrides APP_BASE_URL env. */
  appBaseUrl?: string;
}

// DEV-ONLY default allowlist; set OAUTH_ALLOWED_REDIRECT_HOSTS in any real
// deployment (comma-separated hostnames). Requests whose Host header is not on
// this list are rejected so redirect_uri can never be attacker-influenced.
const DEV_ALLOWED_REDIRECT_HOSTS = ["localhost", "127.0.0.1"];

// DEV-ONLY default; set APP_BASE_URL in any real deployment.
const DEV_APP_BASE_URL = "http://localhost:3000";

/** Non-routable reserved TLD for synthetic OIDC identity emails (RFC 2606/6761). */
export const SYNTHETIC_EMAIL_DOMAIN = "oidc.invalid";

interface PendingFlow {
  provider: string;
  verifier: string;
  nonce: string;
  redirectTo: string;
  expiresAtMs: number;
}

/**
 * Single-process, in-memory pending-flow store. Flows are lost on restart and
 * invisible to other replicas — multi-instance deployments need a shared
 * store (tracked for production hardening).
 */
const pendingFlows = new Map<string, PendingFlow>();

function flowKey(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function pruneFlows(nowMs: number): void {
  for (const [key, flow] of pendingFlows) {
    if (flow.expiresAtMs <= nowMs) pendingFlows.delete(key);
  }
}

const DEFAULT_SCOPES = ["openid", "email", "profile"];

function resolveProvider(
  provider: string,
  options: OAuthRouteOptions,
  env: NodeJS.ProcessEnv
): OAuthProviderConfig | null | undefined {
  const override = options.providers?.[provider];
  if (override) return override;
  // Built-in registry: only google is preconfigured.
  if (provider !== "google") return undefined;
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null; // registered but unconfigured
  return {
    issuer: "https://accounts.google.com",
    clientId,
    clientSecret,
    scopes: DEFAULT_SCOPES,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function appBaseUrl(options: OAuthRouteOptions, env: NodeJS.ProcessEnv): string {
  const base = options.appBaseUrl ?? env.APP_BASE_URL ?? DEV_APP_BASE_URL;
  return base.replace(/\/+$/, "");
}

function allowedRedirectHosts(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.OAUTH_ALLOWED_REDIRECT_HOSTS;
  const hosts = raw
    ? raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
    : DEV_ALLOWED_REDIRECT_HOSTS;
  return new Set(hosts);
}

function requestHostname(req: IncomingMessage): string | null {
  const header = req.headers.host;
  if (!header) return null;
  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Throws unless the request Host is on the configured redirect-host allowlist. */
function assertTrustedHost(req: IncomingMessage): void {
  const hostname = requestHostname(req);
  const allowed = allowedRedirectHosts(process.env);
  if (!hostname || !allowed.has(hostname)) {
    throw new AuthError(400, "untrusted_host", "request host is not an allowed oauth redirect host");
  }
}

function callbackUriFor(
  req: IncomingMessage,
  provider: string,
  options: OAuthRouteOptions
): string {
  const base = appBaseUrl(options, process.env);
  if ((options.appBaseUrl ?? process.env.APP_BASE_URL) !== undefined) {
    return `${base}/auth/oauth/${provider}/callback`;
  }
  // No explicit base URL configured: fall back to the request Host, which is
  // safe only because assertTrustedHost has already allowlisted it.
  const host = req.headers.host!;
  return `http://${host}/auth/oauth/${provider}/callback`;
}

/**
 * Deterministic sentinel email for identities whose provider did not supply a
 * verified address. Hashing issuer|sub keeps distinct identities collision-free,
 * and the reserved `.invalid` TLD can never match a real routable mailbox.
 */
export function syntheticIdentityEmail(issuer: string, subject: string): string {
  const tag = createHash("sha256").update(`${issuer}|${subject}`, "utf8").digest("hex").slice(0, 24);
  return `oidc-${tag}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

function buildClient(config: OAuthProviderConfig, redirectUri: string, fetchImpl?: FetchLike): OidcClient {
  return new OidcClient(
    {
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri,
      scopes: config.scopes ?? DEFAULT_SCOPES,
    },
    fetchImpl
  );
}

function buildSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
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

export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  deps: { authService: AuthService; oauth?: OAuthRouteOptions }
): Promise<boolean> {
  const match = /^\/auth\/oauth\/([a-z0-9_-]+)\/(authorize|callback)$/.exec(pathname);
  if (!match || (req.method ?? "") !== "GET") return false;

  const provider = match[1] as string;
  const action = match[2] as "authorize" | "callback";
  const options = deps.oauth ?? {};
  const now = options.now ?? (() => Date.now());
  const env = process.env;
  const secret = options.stateSecret ?? env.OAUTH_STATE_SECRET ?? DEV_STATE_SECRET;

  try {
    const config = resolveProvider(provider, options, env);
    if (config === undefined) {
      throw new AuthError(404, "not_found", "unknown oauth provider");
    }
    if (config === null) {
      sendJson(res, 503, {
        error: "oauth_not_configured",
        message: "oauth provider is not configured",
      });
      return true;
    }

    // Never trust the request Host for redirect_uri construction unless it is
    // explicitly allowlisted.
    assertTrustedHost(req);

    if (action === "authorize") {
      const { verifier, challenge } = createPkcePair();
      const nonce = randomBytes(16).toString("base64url");
      const redirectTo = "/";
      const state = createState(
        { nonce, issuedAt: Math.floor(now() / 1000), redirectTo },
        secret
      );
      const client = buildClient(config, callbackUriFor(req, provider, options), options.fetchImpl);
      const authorizeUrl = await client.buildAuthorizeUrl({ state, codeChallenge: challenge, nonce });
      if (pendingFlows.size > 10_000) pruneFlows(now());
      pendingFlows.set(flowKey(state), {
        provider,
        verifier,
        nonce,
        redirectTo,
        expiresAtMs: now() + OAUTH_STATE_MAX_AGE_SEC * 1000,
      });
      redirect(res, authorizeUrl);
      return true;
    }

    // action === "callback"
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    if (!code || !state) {
      throw new AuthError(400, "invalid_request", "missing code or state");
    }
    const payload: StatePayload | null = verifyState(state, secret, { now: now() });
    if (!payload) {
      throw new AuthError(400, "invalid_state", "state failed validation");
    }
    const flow = pendingFlows.get(flowKey(state));
    pendingFlows.delete(flowKey(state)); // single-use: replays are rejected
    if (!flow || flow.provider !== provider || flow.expiresAtMs <= now()) {
      throw new AuthError(400, "unknown_state", "no pending oauth flow for this state");
    }

    const client = buildClient(config, callbackUriFor(req, provider, options), options.fetchImpl);
    const tokens = await client.exchangeCode({ code, verifier: flow.verifier });
    if (!tokens.id_token) {
      throw new AuthError(502, "oidc_token_error", "provider did not return an id_token");
    }
    const jwks = await client.fetchJwks();
    let claims;
    try {
      claims = verifyIdToken(tokens.id_token, {
        jwks,
        issuer: config.issuer,
        clientId: config.clientId,
        nonce: flow.nonce,
        now: now(),
      });
    } catch {
      throw new AuthError(401, "invalid_id_token", "id_token failed verification");
    }

    const session = await deps.authService.loginWithOidc({
      issuer: config.issuer,
      subject: claims.sub,
      email:
        typeof claims.email === "string" && claims.email.includes("@")
          ? claims.email
          : syntheticIdentityEmail(config.issuer, claims.sub),
      emailVerified: claims.email_verified === true,
    });
    redirect(res, payload.redirectTo, {
      "set-cookie": buildSessionCookie(session.token, session.expiresAt, env.NODE_ENV === "production"),
    });
    return true;
  } catch (error) {
    if (error instanceof AuthError) {
      sendJson(res, error.status, { error: error.code, message: error.message });
      return true;
    }
    sendJson(res, 502, { error: "oauth_upstream_failure", message: "oauth flow failed upstream" });
    return true;
  }
}

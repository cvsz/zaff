import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import postgres from "postgres";
import { AuthService } from "@zaff/auth";
import { createDb, migrateUp } from "@zaff/db";
import { startServer } from "../src/server.js";

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

const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-client-secret";
const KID = "mock-key-1";
const SUBJECT = "oidc-subject-42";
const EMAIL = "oidc-user@test.example";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const PUBLIC_JWK = {
  ...publicKey.export({ format: "jwk" }),
  kid: KID,
  alg: "RS256",
  use: "sig",
};

function b64url(value: object | string): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(raw, "utf8").toString("base64url");
}

function signIdToken(claims: Record<string, unknown>): string {
  const input = `${b64url({ alg: "RS256", kid: KID })}.${b64url(claims)}`;
  const signature = createSign("RSA-SHA256")
    .update(input, "ascii")
    .sign(privateKey, "base64url");
  return `${input}.${signature}`;
}

interface IssuedCode {
  challenge: string;
  nonce: string;
}

function startMockProvider(): Promise<{
  server: Server;
  url: string;
  setAudienceOverride: (audience: string | null) => void;
}> {
  const codes = new Map<string, IssuedCode>();
  let audienceOverride: string | null = null;
  let httpServer: Server | null = null;

  async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of req) chunks.push((chunk as Buffer).toString("utf8"));
    return chunks.join("");
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handleMock(
    req: import("node:http").IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (!httpServer) throw new Error("mock provider not started");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("unexpected mock address");
    const base = `http://127.0.0.1:${address.port}`;
    const url = new URL(req.url ?? "/", base);

    if (url.pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks.json`,
      });
      return;
    }

    if (url.pathname === "/authorize") {
      // Simulated browser consent: immediately bounce back with a code.
      const code = randomUUID();
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
      });
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = encodeURIComponent(url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${state}` });
      res.end();
      return;
    }

    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      const issued = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (
        form.get("grant_type") !== "authorization_code" ||
        !issued ||
        form.get("client_id") !== CLIENT_ID ||
        form.get("client_secret") !== CLIENT_SECRET ||
        createHash("sha256").update(form.get("code_verifier") ?? "", "ascii").digest("base64url") !==
          issued.challenge
      ) {
        sendJson(res, 400, { error: "invalid_grant" });
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        access_token: "mock-access-token",
        token_type: "Bearer",
        id_token: signIdToken({
          iss: base,
          sub: SUBJECT,
          aud: audienceOverride ?? CLIENT_ID,
          exp: nowSec + 300,
          iat: nowSec,
          nonce: issued.nonce,
          email: EMAIL,
          email_verified: true,
        }),
      });
      return;
    }

    if (url.pathname === "/jwks.json") {
      sendJson(res, 200, { keys: [PUBLIC_JWK] });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  const started = new Promise<Server>((resolve, reject) => {
    void import("node:http")
      .then(({ createServer }) => {
        httpServer = createServer((req, res) => {
          void handleMock(req, res).catch(() => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "mock_failure" }));
          });
        });
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", () => resolve(httpServer!));
      })
      .catch(reject);
  });

  return started.then((s) => {
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("unexpected mock address");
    return {
      server: s,
      url: `http://127.0.0.1:${address.port}`,
      setAudienceOverride: (audience: string | null) => {
        audienceOverride = audience;
      },
    };
  });
}

suite("apps/api oauth http (mock oidc provider)", () => {
  const db = createDb(TEST_URL);
  const authService = new AuthService(db);

  const clock = { nowMs: Date.now() };

  let apiServer: Server;
  let baseUrl: string;
  let mockProvider: { server: Server; url: string } | null = null;

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS audit_log, sessions, user_identities, users, organizations, schema_migrations CASCADE"
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);
    mockProvider = await startMockProvider();
    apiServer = await startServer(0, {
      authService,
      oauth: {
        providers: {
          google: {
            issuer: mockProvider.url,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
          },
        },
        now: () => clock.nowMs,
      },
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    if (mockProvider) {
      await new Promise<void>((resolve) => mockProvider!.server.close(() => resolve()));
    }
    await db.end();
  });

  /** Drives authorize → provider → callback up to the callback URL. */
  async function runBrowserFlowToCallbackUrl(): Promise<string> {
    const authorizeHop = await fetch(`${baseUrl}/auth/oauth/google/authorize`, {
      redirect: "manual",
    });
    expect(authorizeHop.status).toBe(302);
    const providerUrl = authorizeHop.headers.get("location") ?? "";
    expect(providerUrl.startsWith(mockProvider!.url + "/authorize")).toBe(true);
    const providerParams = new URL(providerUrl).searchParams;
    expect(providerParams.get("response_type")).toBe("code");
    expect(providerParams.get("client_id")).toBe(CLIENT_ID);
    expect(providerParams.get("code_challenge_method")).toBe("S256");
    expect(providerParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const providerHop = await fetch(providerUrl, { redirect: "manual" });
    expect(providerHop.status).toBe(302);
    return providerHop.headers.get("location") ?? "";
  }

  it("runs the full browser flow and issues a linked session", async () => {
    const callbackUrl = await runBrowserFlowToCallbackUrl();
    expect(callbackUrl.startsWith(`${baseUrl}/auth/oauth/google/callback`)).toBe(true);

    const callback = await fetch(callbackUrl, { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    const setCookie = callback.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("zaff_session=");
    expect(setCookie).toContain("HttpOnly");

    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: setCookie.split(";")[0]! },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; role: string } };
    expect(body.user.email).toBe(EMAIL);
    expect(body.user.role).toBe("owner");

    const identities = await db`
      SELECT user_id AS "userId" FROM user_identities
      WHERE issuer = ${mockProvider!.url} AND subject = ${SUBJECT}
    `;
    expect(identities).toHaveLength(1);
  }, 20_000);

  it("links a second login to the SAME identity and user (no duplicates)", async () => {
    const firstMe = await sessionUserEmailFromFlow();
    const secondCallback = await runBrowserFlowToCallbackUrl();
    const secondResponse = await fetch(secondCallback, { redirect: "manual" });
    expect(secondResponse.status).toBe(302);
    const secondEmail = await sessionUserEmailFromCookie(
      (secondResponse.headers.get("set-cookie") ?? "").split(";")[0]!
    );
    expect(secondEmail.email).toBe(firstMe.email);
    expect(secondEmail.id).toBe(firstMe.id);

    const identities = await db`
      SELECT id FROM user_identities WHERE subject = ${SUBJECT}
    `;
    expect(identities).toHaveLength(1);

    const auditRows = await db`
      SELECT action FROM audit_log WHERE action LIKE 'user.oauth%'
    `;
    const actions = auditRows.map((r) => r.action as string);
    expect(actions.filter((a) => a === "user.oauth_registered")).toHaveLength(1);
    expect(actions).toContain("user.oauth_registered");
  }, 20_000);

  it("rejects replaying a consumed callback (nonce/state single-use)", async () => {
    const callbackUrl = await runBrowserFlowToCallbackUrl();
    const first = await fetch(callbackUrl, { redirect: "manual" });
    expect(first.status).toBe(302);
    const replay = await fetch(callbackUrl, { redirect: "manual" });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "unknown_state" });
  }, 20_000);

  it("rejects a tampered state parameter", async () => {
    const callbackUrl = await runBrowserFlowToCallbackUrl();
    const tampered = callbackUrl.replace(/state=.{10}/, "state=AAAAAAAAAA");
    const response = await fetch(tampered, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_state" });
  }, 20_000);

  it("rejects an expired state (older than 10 minutes)", async () => {
    const callbackUrl = await runBrowserFlowToCallbackUrl();
    clock.nowMs += 11 * 60 * 1000;
    try {
      const response = await fetch(callbackUrl, { redirect: "manual" });
      expect([400]).toContain(response.status);
      const body = (await response.json()) as { error: string };
      expect(["invalid_state", "unknown_state"]).toContain(body.error);
    } finally {
      clock.nowMs = Date.now();
    }
  }, 20_000);

  it("rejects an id_token with the wrong audience", async () => {
    mockProvider!.setAudienceOverride("someone-else");
    try {
      const callbackUrl = await runBrowserFlowToCallbackUrl();
      const response = await fetch(callbackUrl, { redirect: "manual" });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_id_token" });
      const identities = await db`
        SELECT id FROM user_identities WHERE subject = ${SUBJECT} AND issuer = ${mockProvider!.url}
      `;
      expect(identities.length).toBeLessThanOrEqual(1);
    } finally {
      mockProvider!.setAudienceOverride(null);
    }
  }, 20_000);

  it("returns 404 for an unregistered provider and 503 for unconfigured google", async () => {
    const unknown = await fetch(`${baseUrl}/auth/oauth/github/authorize`, {
      redirect: "manual",
    });
    expect(unknown.status).toBe(404);

    const savedId = process.env.GOOGLE_CLIENT_ID;
    const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      const bareServer = await startServer(0, { authService });
      try {
        const address = bareServer.address();
        if (!address || typeof address === "string") throw new Error("unexpected address");
        const unconfigured = await fetch(
          `http://127.0.0.1:${address.port}/auth/oauth/google/authorize`,
          { redirect: "manual" }
        );
        expect(unconfigured.status).toBe(503);
        expect(await unconfigured.json()).toMatchObject({ error: "oauth_not_configured" });
      } finally {
        await new Promise<void>((resolve) => bareServer.close(() => resolve()));
      }
    } finally {
      if (savedId !== undefined) process.env.GOOGLE_CLIENT_ID = savedId;
      if (savedSecret !== undefined) process.env.GOOGLE_CLIENT_SECRET = savedSecret;
    }
  });

  async function sessionUserEmailFromFlow(): Promise<{ email: string; id: string }> {
    const callbackUrl = await runBrowserFlowToCallbackUrl();
    const response = await fetch(callbackUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    return sessionUserEmailFromCookie(
      (response.headers.get("set-cookie") ?? "").split(";")[0]!
    );
  }

  async function sessionUserEmailFromCookie(
    cookie: string
  ): Promise<{ email: string; id: string }> {
    const me = await fetch(`${baseUrl}/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string; id: string } };
    return body.user;
  }
});

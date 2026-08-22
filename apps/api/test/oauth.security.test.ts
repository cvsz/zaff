import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { handleOAuthRoute, syntheticIdentityEmail, type OAuthRouteOptions } from "../src/oauth-routes.js";

const ISSUER = "https://mock-oidc.example";

function stubRes(): { res: ServerResponse; status: () => number | undefined; headers: () => Record<string, string | string[] | undefined>; body: () => string } {
  let statusCode: number | undefined;
  let written = "";
  const headers: Record<string, string | string[] | undefined> = {};
  const res = {
    writeHead(status: number, hdrs?: Record<string, string | string[] | undefined>) {
      statusCode = status;
      Object.assign(headers, hdrs ?? {});
      return res as unknown as ServerResponse;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") written += chunk;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    headers: () => headers,
    body: () => written,
  };
}

function stubReq(host: string | undefined): { method?: string; headers: { host?: string } } {
  return { method: "GET", headers: host === undefined ? {} : { host } };
}

function discoveryFetch(): OAuthRouteOptions["fetchImpl"] {
  return async () =>
    new Response(
      JSON.stringify({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks.json`,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
}

function oauthDeps(overrides: Partial<OAuthRouteOptions> = {}): {
  authService: never;
  oauth: OAuthRouteOptions;
} {
  return {
    authService: null as never,
    oauth: {
      providers: {
        google: {
          issuer: ISSUER,
          clientId: "cid",
          clientSecret: "secret",
        },
      },
      fetchImpl: discoveryFetch(),
      ...overrides,
    },
  };
}

async function authorize(host: string, overrides: Partial<OAuthRouteOptions> = {}) {
  const r = stubRes();
  await handleOAuthRoute(
    stubReq(host) as never,
    r.res,
    "/auth/oauth/google/authorize",
    new URLSearchParams(),
    oauthDeps(overrides)
  );
  return r;
}

describe("oauth redirect-host allowlist", () => {
  it("rejects an attacker-controlled Host header with 400 and no redirect", async () => {
    const r = await authorize("evil.example");
    expect(r.status()).toBe(400);
    expect(JSON.parse(r.body())).toMatchObject({ error: "untrusted_host" });
    expect(r.headers().location).toBeUndefined();
  });

  it("rejects requests with no Host header", async () => {
    const r = await authorize(undefined);
    expect(r.status()).toBe(400);
    expect(JSON.parse(r.body())).toMatchObject({ error: "untrusted_host" });
  });

  it("allows the dev-only default hosts (localhost, 127.0.0.1)", async () => {
    for (const host of ["localhost:3000", "127.0.0.1:4123"]) {
      const r = await authorize(host);
      expect(r.status()).toBe(302);
      const location = r.headers().location as string;
      expect(new URL(location).searchParams.get("redirect_uri")).toBe(
        `http://${host}/auth/oauth/google/callback`
      );
    }
  });

  it("honours OAUTH_ALLOWED_REDIRECT_HOSTS", async () => {
    process.env.OAUTH_ALLOWED_REDIRECT_HOSTS = "api.example.com";
    try {
      const bad = await authorize("evil.example");
      expect(bad.status()).toBe(400);

      const good = await authorize("API.example.com:8443");
      expect(good.status()).toBe(302);
      expect(new URL(good.headers().location as string).searchParams.get("redirect_uri")).toBe(
        "http://API.example.com:8443/auth/oauth/google/callback"
      );
    } finally {
      delete process.env.OAUTH_ALLOWED_REDIRECT_HOSTS;
    }
  });

  it("builds redirect_uri ONLY from APP_BASE_URL when configured (never from Host)", async () => {
    const r = await authorize("localhost:9999", { appBaseUrl: "https://app.example" });
    expect(r.status()).toBe(302);
    expect(new URL(r.headers().location as string).searchParams.get("redirect_uri")).toBe(
      "https://app.example/auth/oauth/google/callback"
    );
  });
});

describe("synthetic oidc identity emails", () => {
  it("always use the reserved non-routable .invalid domain", () => {
    const email = syntheticIdentityEmail(ISSUER, "sub-1");
    expect(email.endsWith("@oidc.invalid")).toBe(true);
    expect(email).toMatch(/^oidc-[0-9a-f]{24}@oidc\.invalid$/);
  });

  it("never collide across different providers or subjects", () => {
    const emails = [
      syntheticIdentityEmail(ISSUER, "sub-1"),
      syntheticIdentityEmail("https://other-oidc.example", "sub-1"),
      syntheticIdentityEmail(ISSUER, "sub-2"),
      syntheticIdentityEmail("https://accounts.google.com", "sub-1"),
    ];
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("are deterministic for the same identity", () => {
    expect(syntheticIdentityEmail(ISSUER, "sub-1")).toBe(syntheticIdentityEmail(ISSUER, "sub-1"));
  });
});

describe("oauth state single-use", () => {
  it("consumes the pending flow on first callback use; replays are rejected", async () => {
    const opts = oauthDeps();
    const start = stubRes();
    await handleOAuthRoute(
      stubReq("127.0.0.1:3000") as never,
      start.res,
      "/auth/oauth/google/authorize",
      new URLSearchParams(),
      opts
    );
    expect(start.status()).toBe(302);
    const state = new URL(start.headers().location as string).searchParams.get("state")!;
    expect(state).toBeTruthy();

    // First use: flow exists and is consumed; the bogus code then fails
    // upstream (mock provider has no real token endpoint here).
    const first = stubRes();
    await handleOAuthRoute(
      stubReq("127.0.0.1:3000") as never,
      first.res,
      "/auth/oauth/google/callback",
      new URLSearchParams({ code: "bogus-code", state }),
      opts
    );
    expect(first.status()).toBe(502);

    // Replay of the same state must be rejected before any upstream work.
    const replay = stubRes();
    await handleOAuthRoute(
      stubReq("127.0.0.1:3000") as never,
      replay.res,
      "/auth/oauth/google/callback",
      new URLSearchParams({ code: "bogus-code", state }),
      opts
    );
    expect(replay.status()).toBe(400);
    expect(JSON.parse(replay.body())).toMatchObject({ error: "unknown_state" });
  });
});

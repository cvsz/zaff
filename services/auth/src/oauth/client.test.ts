import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { OidcClient, discoveryUrl, type FetchLike } from "./client.js";

const ISSUER = "https://issuer.test";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("discoveryUrl", () => {
  it("appends the well-known path", () => {
    expect(discoveryUrl(ISSUER)).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(discoveryUrl(`${ISSUER}/`)).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });
});

describe("OidcClient with injected fetch", () => {
  const config = {
    issuer: ISSUER,
    clientId: "client-123",
    clientSecret: "secret",
    redirectUri: "https://app.test/callback",
    scopes: ["openid", "email"],
  };

  const discovery = {
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks.json`,
  };

  const tokenRequests: { url: string; init?: RequestInit }[] = [];
  let jwksHits = 0;

  const fetchImpl: FetchLike = (input, init) => {
    const url = input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Promise.resolve(jsonResponse(discovery));
    }
    if (url === discovery.jwks_uri) {
      jwksHits += 1;
      return Promise.resolve(
        jsonResponse({
          keys: [{ kty: "RSA", kid: "k1", n: "abc", e: "AQAB" }],
        })
      );
    }
    if (url === discovery.token_endpoint) {
      tokenRequests.push({ url, init });
      return Promise.resolve(
        jsonResponse({ access_token: "at", id_token: `h.${Buffer.from(JSON.stringify({ sub: "s" }), "utf8").toString("base64url")}.sig` })
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  it("builds an authorize URL from discovered endpoints with S256 PKCE", async () => {
    const client = new OidcClient(config, fetchImpl);
    expect(client.discoveryUrl()).toContain("/.well-known/openid-configuration");
    const url = new URL(
      await client.buildAuthorizeUrl({
        state: "st0",
        codeChallenge: createHash("sha256").update("v").digest("base64url"),
        nonce: "n0",
      })
    );
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("state")).toBe("st0");
    expect(url.searchParams.get("nonce")).toBe("n0");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("exchanges the code via form POST including code_verifier", async () => {
    const client = new OidcClient(config, fetchImpl);
    const tokens = await client.exchangeCode({ code: "the-code", verifier: "the-verifier" });
    expect(tokens.id_token).toBeDefined();
    expect(tokenRequests).toHaveLength(1);
    const body = new URLSearchParams(String(tokenRequests[0]!.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    const contentType = String(new Headers(tokenRequests[0]!.init?.headers).get("content-type"));
    expect(contentType).toContain("application/x-www-form-urlencoded");
  });

  it("decodes the id_token payload without verifying the signature", async () => {
    const client = new OidcClient(config, fetchImpl);
    const tokens = await client.exchangeCode({ code: "x", verifier: "y" });
    const payload = client.decodeIdTokenPayload(tokens.id_token!);
    expect(payload).toEqual({ sub: "s" });
    // garbage / tampered input never throws — verification is the caller's job
    expect(client.decodeIdTokenPayload("garbage")).toBeNull();
    expect(client.decodeIdTokenPayload("a.b.c")).toBeNull();
  });

  it("caches JWKS by kid", async () => {
    const client = new OidcClient(config, fetchImpl);
    const first = await client.fetchJwks();
    const second = await client.fetchJwks();
    expect(jwksHits).toBe(1);
    expect(first).toBe(second);
    expect(first.get("k1")).toMatchObject({ kty: "RSA", n: "abc" });
  });

  it("throws on failed discovery", async () => {
    const failing: FetchLike = () => Promise.resolve(new Response("nope", { status: 500 }));
    const client = new OidcClient(config, failing);
    await expect(client.discover()).rejects.toThrow(/discovery/);
  });
});

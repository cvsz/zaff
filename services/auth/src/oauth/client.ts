import type { Jwk } from "./jwk.js";

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

function requireDiscovery(doc: Partial<DiscoveryDocument> | null): asserts doc is DiscoveryDocument {
  if (
    !doc ||
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  ) {
    throw new Error("oidc discovery document is missing required endpoints");
  }
}

interface JwkSet {
  keys?: Record<string, unknown>[];
}

export class OidcClient {
  private readonly fetchImpl: FetchLike;

  private discovery: DiscoveryDocument | null = null;

  private jwksByKid: Map<string, Jwk> | null = null;

  constructor(
    readonly config: OidcClientConfig,
    fetchImpl: FetchLike = ((input, init) => globalThis.fetch(input, init)) as FetchLike
  ) {
    this.fetchImpl = fetchImpl;
  }

  discoveryUrl(): string {
    return discoveryUrl(this.config.issuer);
  }

  async discover(force = false): Promise<DiscoveryDocument> {
    if (this.discovery && !force) return this.discovery;
    const response = await this.fetchImpl(this.discoveryUrl(), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`oidc discovery failed with status ${response.status}`);
    }
    const doc = (await response.json()) as Partial<DiscoveryDocument>;
    requireDiscovery(doc);
    this.discovery = doc;
    return doc;
  }

  async buildAuthorizeUrl(input: {
    state: string;
    codeChallenge: string;
    nonce: string;
  }): Promise<string> {
    const { authorization_endpoint: endpoint } = await this.discover();
    const url = new URL(endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: { code: string; verifier: string }): Promise<TokenResponse> {
    const { token_endpoint: endpoint } = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: input.verifier,
    });
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`oidc token exchange failed with status ${response.status}`);
    }
    return (await response.json()) as TokenResponse;
  }

  async fetchJwks(force = false): Promise<Map<string, Jwk>> {
    if (this.jwksByKid && !force) return this.jwksByKid;
    const { jwks_uri: uri } = await this.discover();
    const response = await this.fetchImpl(uri, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`jwks fetch failed with status ${response.status}`);
    }
    const set = (await response.json()) as JwkSet;
    const map = new Map<string, Jwk>();
    for (const key of set.keys ?? []) {
      if (typeof key.kid === "string") map.set(key.kid, key as Jwk);
    }
    this.jwksByKid = map;
    return map;
  }

  decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
    // NO signature verification here — callers must verifyIdToken via JWKS first.
    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

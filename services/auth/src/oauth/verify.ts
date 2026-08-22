import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { Jwk } from "./jwk.js";

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
}

export interface VerifyIdTokenOptions {
  jwks: Map<string, Jwk>;
  issuer: string;
  clientId: string;
  nonce?: string;
  maxAgeSec?: number;
  now?: number;
  clockSkewSec?: number;
}

const SUPPORTED_ALGS = new Set(["RS256", "HS256"]);

function b64urlToBuffer(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function audienceIncludes(aud: IdTokenClaims["aud"], clientId: string): boolean {
  if (Array.isArray(aud)) return aud.some((entry) => timingSafeStringEqual(entry, clientId));
  return typeof aud === "string" && timingSafeStringEqual(aud, clientId);
}

function verifyRs256(signingInput: string, signature: Buffer, jwk: Jwk): boolean {
  try {
    const key = createPublicKey({ key: jwk as unknown as { kty: "RSA"; n: string; e: string }, format: "jwk" });
    return cryptoVerify("rsa-sha256", Buffer.from(signingInput, "ascii"), key, signature);
  } catch {
    return false;
  }
}

function verifyHs256(signingInput: string, signature: Buffer, secret: Buffer): boolean {
  const expected = createHmac("sha256", secret).update(signingInput, "ascii").digest();
  return expected.length === signature.length && timingSafeEqual(expected, signature);
}

export function verifyIdToken(
  idToken: string,
  options: VerifyIdTokenOptions
): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("id_token is not a well-formed JWS");
  }
  let header: Record<string, unknown>;
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as IdTokenClaims;
  } catch {
    throw new Error("id_token header/payload is not valid JSON");
  }

  const alg = header.alg;
  if (typeof alg !== "string" || !SUPPORTED_ALGS.has(alg) || alg === "none") {
    throw new Error(`unsupported id_token alg '${String(alg)}'`);
  }
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (!kid) throw new Error("id_token header is missing kid");

  const jwk = options.jwks.get(kid);
  if (!jwk) throw new Error(`no JWKS key for kid '${kid}'`);

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = b64urlToBuffer(parts[2] ?? "");
  let signatureOk = false;
  if (alg === "RS256" && jwk.kty === "RSA") {
    signatureOk = verifyRs256(signingInput, signature, jwk);
  } else if (alg === "HS256" && jwk.kty === "oct" && typeof jwk.k === "string") {
    signatureOk = verifyHs256(signingInput, signature, b64urlToBuffer(jwk.k));
  } else {
    throw new Error(`alg '${alg}' does not match JWKS key type '${String(jwk.kty)}'`);
  }
  if (!signatureOk) throw new Error("id_token signature verification failed");

  const skew = options.clockSkewSec ?? 60;
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);

  if (!timingSafeStringEqual(claims.iss, options.issuer)) {
    throw new Error("id_token issuer mismatch");
  }
  if (!audienceIncludes(claims.aud, options.clientId)) {
    throw new Error("id_token audience mismatch");
  }
  if (typeof claims.exp !== "number" || nowSec - skew >= claims.exp) {
    throw new Error("id_token expired");
  }
  if (
    options.maxAgeSec !== undefined &&
    typeof claims.iat === "number" &&
    nowSec + skew < claims.iat
  ) {
    throw new Error("id_token issued in the future");
  }
  if (
    options.maxAgeSec !== undefined &&
    typeof claims.iat === "number" &&
    nowSec - claims.iat > options.maxAgeSec
  ) {
    throw new Error("id_token too old");
  }
  if (options.nonce !== undefined) {
    if (typeof claims.nonce !== "string" || !timingSafeStringEqual(claims.nonce, options.nonce)) {
      throw new Error("id_token nonce mismatch");
    }
  }
  return claims;
}

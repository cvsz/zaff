import { describe, expect, it } from "vitest";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { verifyIdToken, type IdTokenClaims } from "./verify.js";

const ISSUER = "https://issuer.test";
const CLIENT_ID = "client-123";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key" } as JsonWebKey;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signToken(header: object, claims: object): string {
  const input = `${b64url(header)}.${b64url(claims)}`;
  const signature = createSign("RSA-SHA256").update(input, "ascii").sign(privateKey, "base64url");
  return `${input}.${signature}`;
}

function validClaims(nowSec: number): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "subject-abc",
    aud: CLIENT_ID,
    exp: nowSec + 300,
    iat: nowSec,
    nonce: "expected-nonce",
    email: "user@test.example",
  };
}

function jwks(): Map<string, JsonWebKey> {
  return new Map([[JWK.kid as string, JWK]]);
}

describe("verifyIdToken", () => {
  const nowMs = 1_700_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);

  it("verifies a valid RS256 token and returns the payload", () => {
    const token = signToken({ alg: "RS256", kid: "test-key" }, validClaims(nowSec));
    const claims = verifyIdToken(token, {
      jwks: jwks(),
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: "expected-nonce",
      now: nowMs,
    });
    expect(claims.sub).toBe("subject-abc");
    expect((claims as IdTokenClaims).email).toBe("user@test.example");
  });

  it("accepts an array audience containing the client id", () => {
    const claimsIn = { ...validClaims(nowSec), aud: ["other", CLIENT_ID] };
    const token = signToken({ alg: "RS256", kid: "test-key" }, claimsIn);
    expect(() =>
      verifyIdToken(token, {
        jwks: jwks(),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        now: nowMs,
      })
    ).not.toThrow();
  });

  it("rejects a wrong audience", () => {
    const token = signToken(
      { alg: "RS256", kid: "test-key" },
      { ...validClaims(nowSec), aud: "someone-else" }
    );
    expect(() =>
      verifyIdToken(token, { jwks: jwks(), issuer: ISSUER, clientId: CLIENT_ID, now: nowMs })
    ).toThrow(/audience/);
  });

  it("rejects a wrong issuer", () => {
    const token = signToken(
      { alg: "RS256", kid: "test-key" },
      { ...validClaims(nowSec), iss: "https://evil.test" }
    );
    expect(() =>
      verifyIdToken(token, { jwks: jwks(), issuer: ISSUER, clientId: CLIENT_ID, now: nowMs })
    ).toThrow(/issuer/);
  });

  it("rejects an expired token", () => {
    const token = signToken(
      { alg: "RS256", kid: "test-key" },
      { ...validClaims(nowSec), exp: nowSec - 120 }
    );
    expect(() =>
      verifyIdToken(token, { jwks: jwks(), issuer: ISSUER, clientId: CLIENT_ID, now: nowMs })
    ).toThrow(/expired/);
  });

  it("rejects a nonce mismatch", () => {
    const token = signToken({ alg: "RS256", kid: "test-key" }, validClaims(nowSec));
    expect(() =>
      verifyIdToken(token, {
        jwks: jwks(),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonce: "different",
        now: nowMs,
      })
    ).toThrow(/nonce/);
  });

  it("rejects tokens older than maxAgeSec", () => {
    const oldIat = nowSec - 1200;
    const token = signToken(
      { alg: "RS256", kid: "test-key" },
      { ...validClaims(nowSec), iat: oldIat }
    );
    expect(() =>
      verifyIdToken(token, {
        jwks: jwks(),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        maxAgeSec: 600,
        now: nowMs,
      })
    ).toThrow(/too old/);
  });

  it("rejects a tampered payload (signature failure)", () => {
    const token = signToken({ alg: "RS256", kid: "test-key" }, validClaims(nowSec));
    const [header] = token.split(".");
    const forgedPayload = b64url({ ...validClaims(nowSec), sub: "attacker" });
    const tampered = `${header}.${forgedPayload}.${token.split(".")[2]}`;
    expect(() =>
      verifyIdToken(tampered, { jwks: jwks(), issuer: ISSUER, clientId: CLIENT_ID, now: nowMs })
    ).toThrow(/signature|JSON/);
  });

  it("rejects alg=none", () => {
    const token = `${b64url({ alg: "none" })}.${b64url(validClaims(nowSec))}.`;
    expect(() =>
      verifyIdToken(token, { jwks: jwks(), issuer: ISSUER, clientId: CLIENT_ID, now: nowMs })
    ).toThrow(/alg/);
  });

  it("rejects unknown kid", () => {
    const token = signToken({ alg: "RS256", kid: "rotated-away" }, validClaims(nowSec));
    expect(() =>
      verifyIdToken(token, { jwks: jwks(), issuer: ISSUER, clientId: CLIENT_ID, now: nowMs })
    ).toThrow(/kid/);
  });

  it("verifies HS256 when the JWKS carries an oct key", () => {
    const secret = Buffer.from("shared-secret-material", "utf8");
    const input = `${b64url({ alg: "HS256", kid: "hs" })}.${b64url(validClaims(nowSec))}`;
    const sig = createHmac("sha256", secret).update(input, "ascii").digest("base64url");
    const token = `${input}.${sig}`;
    const claims = verifyIdToken(token, {
      jwks: new Map([["hs", { kty: "oct", k: secret.toString("base64url") } as JsonWebKey]]),
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonce: "expected-nonce",
      now: nowMs,
    });
    expect(claims.sub).toBe("subject-abc");
  });

  it("rejects an RS256-signed token presented against an oct key", () => {
    const token = signToken({ alg: "RS256", kid: "hs" }, validClaims(nowSec));
    expect(() =>
      verifyIdToken(token, {
        jwks: new Map([["hs", { kty: "oct", k: "AAAA" } as JsonWebKey]]),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        now: nowMs,
      })
    ).toThrow(/does not match|kid/);
  });
});

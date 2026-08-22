import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createPkcePair, pkceS256 } from "./pkce.js";

describe("pkce", () => {
  it("creates a challenge equal to base64url(sha256(verifier))", () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("roundtrips through pkceS256", () => {
    const { verifier, challenge } = createPkcePair();
    expect(pkceS256(verifier)).toBe(challenge);
  });

  it("produces RFC 7636-compliant verifier length and entropy", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

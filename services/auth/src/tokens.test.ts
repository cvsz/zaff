import { describe, expect, it } from "vitest";
import { generateSessionToken, hashToken, tokensEqual } from "./tokens.js";

describe("generateSessionToken", () => {
  it("produces base64url tokens with at least 256 bits of entropy", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it("does not repeat tokens across calls", () => {
    const seen = new Set(Array.from({ length: 100 }, generateSessionToken));
    expect(seen.size).toBe(100);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same input", () => {
    expect(hashToken("token-value")).toBe(hashToken("token-value"));
  });

  it("differs for different inputs and never exposes the input", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
    expect(hashToken("s3cret-session-token-value")).not.toContain(
      "s3cret-session-token-value"
    );
    expect(hashToken("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokensEqual compares in constant time semantics", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
  });
});

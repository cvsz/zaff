import { describe, expect, it } from "vitest";
import { createState, OAUTH_STATE_MAX_AGE_SEC, verifyState } from "./state.js";

const SECRET = "unit-test-secret";

function payloadAt(issuedAtSec: number) {
  return { nonce: "nonce-123", issuedAt: issuedAtSec, redirectTo: "/" };
}

describe("oauth state", () => {
  it("roundtrips a signed state", () => {
    const now = 1_000_000;
    const state = createState(payloadAt(now), SECRET);
    const verified = verifyState(state, SECRET, { now: now * 1000 });
    expect(verified).toEqual(payloadAt(now));
  });

  it("rejects a tampered payload", () => {
    const now = 1_000_000;
    const state = createState(payloadAt(now), SECRET);
    const [body] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ nonce: "evil", issuedAt: now, redirectTo: "/" }),
      "utf8"
    ).toString("base64url");
    const tampered = state.replace(body!, forgedBody);
    expect(verifyState(tampered, SECRET, { now: now * 1000 })).toBeNull();
  });

  it("rejects an invalid signature", () => {
    const now = 1_000_000;
    const state = createState(payloadAt(now), SECRET);
    const tampered = `${state.slice(0, -4)}AAAA`;
    expect(verifyState(tampered, SECRET, { now: now * 1000 })).toBeNull();
  });

  it("rejects states older than the max age", () => {
    const now = 1_000_000;
    const state = createState(payloadAt(now), SECRET);
    const laterMs = (now + OAUTH_STATE_MAX_AGE_SEC + 1) * 1000;
    expect(verifyState(state, SECRET, { now: laterMs })).toBeNull();
  });

  it("accepts states within the max age", () => {
    const now = 1_000_000;
    const state = createState(payloadAt(now), SECRET);
    const laterMs = (now + OAUTH_STATE_MAX_AGE_SEC - 10) * 1000;
    expect(verifyState(state, SECRET, { now: laterMs })).not.toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("garbage", SECRET)).toBeNull();
    expect(verifyState(".sig-only", SECRET)).toBeNull();
    expect(verifyState("body.", SECRET)).toBeNull();
    const badJson = `${Buffer.from("not json", "utf8").toString("base64url")}.c2ln`;
    expect(verifyState(badJson, SECRET)).toBeNull();
  });

  it("uses the dev-default secret symmetrically (dev only)", () => {
    const now = Date.now() / 1000;
    const state = createState({ nonce: "n", issuedAt: Math.floor(now), redirectTo: "/" });
    expect(verifyState(state)).not.toBeNull();
  });
});

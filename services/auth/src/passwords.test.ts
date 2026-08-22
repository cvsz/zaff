import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("hashPassword/verifyPassword", () => {
  it("roundtrips a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("secret-password");
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("produces unique salts per call", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    expect(a).not.toBe(b);
  });

  it("returns false for malformed hashes instead of throwing", async () => {
    await expect(verifyPassword("not-a-hash", "x")).resolves.toBe(false);
  });
});

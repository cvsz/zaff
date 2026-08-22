import { describe, expect, it } from "vitest";
import { MAX_KEY_LENGTH, validateKey } from "./keys.js";
import { StorageError } from "./types.js";

function expectInvalid(key: string): void {
  expect(() => validateKey(key)).toThrowError(StorageError);
}

describe("validateKey", () => {
  it("accepts ordinary nested keys", () => {
    expect(validateKey("images/2026/product-01.png")).toBe(
      "images/2026/product-01.png",
    );
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(validateKey("a\\b\\c.txt")).toBe("a/b/c.txt");
  });

  it("rejects empty keys", () => {
    expectInvalid("");
  });

  it.each([
    "../../etc/passwd",
    "safe/../../etc/passwd",
    "..\\..\\windows\\system32",
    "a/../b",
    "../",
    "..",
    "foo/..",
  ])("rejects traversal: %s", (key) => {
    expectInvalid(key);
  });

  it.each(["/etc/passwd", "\\server\\share", "/"])(
    "rejects absolute keys: %s",
    (key) => {
      expectInvalid(key);
    },
  );

  it("rejects drive-letter absolute paths", () => {
    expectInvalid("C:/Windows/system32/config");
  });

  it.each(["..%2f..%2fetc%2fpasswd", "a%2fb", "%5c..%5c.."])(
    "rejects percent-encoded separators: %s",
    (key) => {
      expectInvalid(key);
    },
  );

  it("rejects NUL bytes and embedded NUL tricks", () => {
    expectInvalid("foo\0/bar");
    expectInvalid("passwd\0.png");
  });

  it.each(["a//b", "a/", "./x", "‥/evil", "café.png", "a b.png", "key?query"])(
    "rejects unsafe or ambiguous keys: %s",
    (key) => {
      expectInvalid(key);
    },
  );

  it("rejects overlong keys", () => {
    expectInvalid("k".repeat(MAX_KEY_LENGTH + 1));
    expect(validateKey("k".repeat(MAX_KEY_LENGTH))).toBe(
      "k".repeat(MAX_KEY_LENGTH),
    );
  });

  it("carries error code INVALID_KEY", () => {
    try {
      validateKey("../escape");
      expect.unreachable();
    } catch (err) {
      expect((err as StorageError).code).toBe("INVALID_KEY");
    }
  });
});

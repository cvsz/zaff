import { describe, expect, it } from "vitest";
import { sniffContentType, verifyMime } from "./mime.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF = Uint8Array.from(
  Array.from("%PDF-1.7\n%", (c) => c.charCodeAt(0)),
);
const GIF = Uint8Array.from(Array.from("GIF89a", (c) => c.charCodeAt(0)));
const RIFF_WEBP = Uint8Array.from([
  ...Array.from("RIFF", (c) => c.charCodeAt(0)),
  0x00,
  0x00,
  0x00,
  0x00,
  ...Array.from("WEBP", (c) => c.charCodeAt(0)),
]);
const JSON_DOC = Uint8Array.from(
  Array.from('{"hello":"world"}', (c) => c.charCodeAt(0)),
);
const TEXT = Uint8Array.from(Array.from("plain ascii text\n", (c) => c.charCodeAt(0)));
const BINARY_UNKNOWN = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe]);

describe("sniffContentType", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", RIFF_WEBP],
    ["application/pdf", PDF],
    ["application/json", JSON_DOC],
    ["text/plain", TEXT],
    ["application/octet-stream", BINARY_UNKNOWN],
  ])("sniffs %s", (expected, bytes) => {
    expect(sniffContentType(bytes)).toBe(expected);
  });

  it("does not confuse webp with generic RIFF", () => {
    const riffOnly = Uint8Array.from([
      ...Array.from("RIFF", (c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
      0x01,
      0x02,
      0x03,
      0x04,
    ]);
    expect(sniffContentType(riffOnly)).toBe("application/octet-stream");
  });
});

describe("verifyMime", () => {
  it("passes when declaration matches sniffed bytes", () => {
    const verdict = verifyMime(PNG, "image/png");
    expect(verdict.mismatch).toBe(false);
    expect(verdict.resolved).toBe("image/png");
  });

  it.each([
    ["image/png", PDF],
    ["application/pdf", PNG],
    ["image/jpeg", PDF],
  ])("hard-rejects binary mismatch %s vs %s", (declared, bytes) => {
    expect(() => verifyMime(bytes, declared)).toThrowError(/mismatch/);
  });

  it("records mismatch without rejecting for non-binary declarations", () => {
    const verdict = verifyMime(PNG, "application/octet-stream");
    expect(verdict.mismatch).toBe(true);
    expect(verdict.sniffed).toBe("image/png");
    expect(verdict.resolved).toBe("application/octet-stream");
  });

  it("resolves to the sniffed type when nothing is declared", () => {
    expect(verifyMime(JPEG).resolved).toBe("image/jpeg");
    expect(verifyMime(TEXT).resolved).toBe("text/plain");
  });

  it("is case-insensitive on declared binary types", () => {
    expect(() => verifyMime(PDF, "APPLICATION/PDF")).not.toThrow();
  });
});

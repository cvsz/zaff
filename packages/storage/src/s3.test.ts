import { describe, expect, it, vi } from "vitest";
import { S3CompatibleStorageAdapter } from "./s3.js";
import { StorageError } from "./types.js";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function fakeClient() {
  const objects = new Map<string, Uint8Array>();
  return {
    putObject: vi.fn(async (input: { Key: string; Body: Uint8Array }) => {
      objects.set(input.Key, input.Body);
      return {};
    }),
    getObject: vi.fn(async (input: { Key: string }) => {
      const body = objects.get(input.Key);
      if (!body) {
        const err = new Error("NotFound") as Error & { name: string };
        err.name = "NotFound";
        throw err;
      }
      return { Body: body };
    }),
    deleteObject: vi.fn(async () => ({})),
    headObject: vi.fn(async (input: { Key: string }) => {
      const body = objects.get(input.Key);
      if (!body) {
        const err = new Error("NotFound") as Error & { name: string };
        err.name = "NotFound";
        throw err;
      }
      return {
        ContentLength: body.byteLength,
        LastModified: new Date(),
        ContentType: "image/png",
      };
    }),
  };
}

describe("S3CompatibleStorageAdapter", () => {
  it("roundtrips through the injected client", async () => {
    const client = fakeClient();
    const adapter = new S3CompatibleStorageAdapter({ client });
    await adapter.put("a/b.png", PNG_BYTES, { declaredContentType: "image/png" });
    expect(client.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "a/b.png", ContentType: "image/png" }),
    );
    expect(Buffer.compare(await adapter.get("a/b.png"), Buffer.from(PNG_BYTES))).toBe(0);
    expect(await adapter.exists("a/b.png")).toBe(true);
    await adapter.delete("a/b.png");
  });

  it("validates keys and enforces maxBytes before touching the client", async () => {
    const client = fakeClient();
    const adapter = new S3CompatibleStorageAdapter({
      client,
      maxBytes: 4,
    });
    await expect(adapter.put("../evil", PNG_BYTES)).rejects.toMatchObject({
      code: "INVALID_KEY",
    });
    await expect(adapter.put("big.bin", PNG_BYTES)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(client.putObject).not.toHaveBeenCalled();
  });

  it("rejects binary MIME mismatch and maps NotFound to NOT_FOUND", async () => {
    const client = fakeClient();
    const adapter = new S3CompatibleStorageAdapter({ client });
    await expect(
      adapter.put("x.pdf", PNG_BYTES, { declaredContentType: "application/pdf" }),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(adapter.get("missing.png")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await adapter.exists("missing.png")).toBe(false);
  });
});

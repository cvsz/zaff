import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFsStorageAdapter } from "./local.js";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef,
]);

describe("LocalFsStorageAdapter (integration)", () => {
  let rootDir: string;
  let adapter: LocalFsStorageAdapter;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "zaff-storage-"));
    adapter = new LocalFsStorageAdapter({ rootDir });
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("roundtrips bytes byte-identical", async () => {
    const body = Uint8Array.from({ length: 4088 }, (_, i) => i % 251);
    const payload = Uint8Array.from([...PNG_BYTES, ...body]);
    const key = "campaigns/c1/creatives/banner.png";
    await adapter.put(key, payload, { declaredContentType: "image/png" });
    const fetched = await adapter.get(key);
    expect(Buffer.compare(fetched, Buffer.from(payload))).toBe(0);
    expect(await adapter.exists(key)).toBe(true);
  });

  it("stat returns correct size, contentType and updatedAt", async () => {
    const key = "docs/readme.txt";
    await adapter.put(key, Uint8Array.from(Array.from("hello", (c) => c.charCodeAt(0))));
    const info = await adapter.stat(key);
    expect(info.size).toBe(5);
    expect(info.contentType).toBe("text/plain");
    expect(info.updatedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(info.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("delete removes the object; get then fails and exists is false", async () => {
    const key = "tmp/doomed.bin";
    await adapter.put(key, PNG_BYTES);
    await adapter.delete(key);
    expect(await adapter.exists(key)).toBe(false);
    await expect(adapter.get(key)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("delete is idempotent", async () => {
    await adapter.delete("never/existed.txt");
  });

  it("rejects oversize payloads with a clear error", async () => {
    const tiny = new LocalFsStorageAdapter({ rootDir, maxBytes: 8 });
    await expect(tiny.put("big/blob.bin", Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(await tiny.exists("big/blob.bin")).toBe(false);
  });

  it("rejects declared image content type over non-image bytes", async () => {
    const pdfBytes = Uint8Array.from(
      Array.from("%PDF-1.4 fake", (c) => c.charCodeAt(0)),
    );
    await expect(
      adapter.put("smuggle/pic.png", pdfBytes, {
        declaredContentType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_TYPE_MISMATCH" });
    expect(await adapter.exists("smuggle/pic.png")).toBe(false);
  });

  it("prevents path traversal for adversarial keys", async () => {
    const hostile = new LocalFsStorageAdapter({ rootDir });
    for (const key of [
      "../../etc/passwd",
      "a/../../escape.txt",
      "..\\..\\escape.txt",
      "/absolute/escape",
    ]) {
      await expect(hostile.put(key, PNG_BYTES)).rejects.toMatchObject({
        code: "INVALID_KEY",
      });
      await expect(hostile.get(key)).rejects.toMatchObject({
        code: "INVALID_KEY",
      });
      await expect(hostile.exists(key)).rejects.toMatchObject({
        code: "INVALID_KEY",
      });
    }
    const marker = join(rootDir, "canary.txt");
    await readFile(marker, "utf8").catch(() => undefined);
    expect(await adapter.exists("etc/passwd")).toBe(false);
  });

  it("handles concurrent puts of distinct keys", async () => {
    const keys = Array.from({ length: 16 }, (_, i) => `parallel/${i}.png`);
    await Promise.all(keys.map((k, i) => adapter.put(k, Uint8Array.from([i]))));
    for (const [i, key] of keys.entries()) {
      expect([...(await adapter.get(key))]).toEqual([i]);
    }
  });

  it("concurrent puts to the same key leave a consistent object", async () => {
    const key = "racy/one.txt";
    await Promise.all(
      ["aaaa", "bbbb", "cccc"].map((s) =>
        adapter.put(key, Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)))),
      ),
    );
    const data = (await adapter.get(key)).toString("utf8");
    expect(["aaaa", "bbbb", "cccc"]).toContain(data);
  });

  it("content is unreadable through the API after delete", async () => {
    const key = "lifecycle/gone.png";
    await adapter.put(key, PNG_BYTES);
    await adapter.delete(key);
    await expect(adapter.get(key)).rejects.toThrowError(/not found/i);
    await expect(adapter.stat(key)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes files non-world-readable", async () => {
    const key = "perms/private.txt";
    await adapter.put(key, Uint8Array.from([0x61]));
    const blob = await readFile(join(rootDir, "objects", key));
    expect(blob.mode & 0o077).toBe(0);
  });
});

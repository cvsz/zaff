import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LocalFsStorageAdapter } from "./local.js";
import { S3CompatibleStorageAdapter } from "./s3.js";
import {
  DEFAULT_SIGNING_TTL_SECONDS,
  DEV_SIGNING_SECRET,
  computeSignature,
  resolveSigningSecret,
  verifySignedRequest,
} from "./signing.js";
import { StorageError } from "./types.js";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const FROZEN_NOW_SEC = 1750000000;
const SECRET = "unit-test-signing-secret";

function expectedSignature(key: string, expires: number): string {
  return createHmac("sha256", SECRET)
    .update(`${key}\n${expires}`)
    .digest("hex");
}

describe("signed URLs (unit)", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.STORAGE_SIGNING_SECRET;
  });

  it("produces a deterministic signature for fixed inputs (injected secret + frozen clock)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_SEC * 1000);
    const adapter = new LocalFsStorageAdapter({
      rootDir: "/unused",
      signingSecret: SECRET,
    });
    const first = adapter.signedUrl("creatives/a.png");
    const second = adapter.signedUrl("creatives/a.png");
    return Promise.all([first, second]).then(([a, b]) => {
      expect(a.url).toBe(b.url);
      const expires = FROZEN_NOW_SEC + DEFAULT_SIGNING_TTL_SECONDS;
      expect(a.url).toBe(
        `/storage/creatives/a.png?expires=${expires}&signature=${expectedSignature("creatives/a.png", expires)}`,
      );
      expect(a.expiresAt.toISOString()).toBe(
        new Date(expires * 1000).toISOString(),
      );
    });
  });

  it("defaults TTL to 300 seconds and honors overrides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_SEC * 1000);
    const adapter = new LocalFsStorageAdapter({
      rootDir: "/unused",
      signingSecret: SECRET,
    });
    const def = await adapter.signedUrl("a.txt");
    expect(def.expiresAt.getTime() / 1000).toBe(FROZEN_NOW_SEC + 300);
    const custom = await adapter.signedUrl("a.txt", { ttlSeconds: 60 });
    expect(custom.expiresAt.getTime() / 1000).toBe(FROZEN_NOW_SEC + 60);
    expect(verifySignedRequest("a.txt", FROZEN_NOW_SEC + 60,
      expectedSignature("a.txt", FROZEN_NOW_SEC + 60),
      { nowSec: FROZEN_NOW_SEC, secret: SECRET }),
    ).toBe(true);
  });

  it("rejects a validly signed URL once expired (expiry checked before compare)", () => {
    const key = "creatives/a.png";
    const expires = FROZEN_NOW_SEC + 10;
    const sig = computeSignature(SECRET, key, expires);
    expect(
      verifySignedRequest(key, expires, sig, {
        nowSec: expires - 1,
        secret: SECRET,
      }),
    ).toBe(true);
    expect(
      verifySignedRequest(key, expires, sig, {
        nowSec: expires,
        secret: SECRET,
      }),
    ).toBe(true);
    expect(
      verifySignedRequest(key, expires, sig, {
        nowSec: expires + 1,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects tampered key, signature, and expires values", () => {
    const key = "creatives/a.png";
    const expires = FROZEN_NOW_SEC + 60;
    const sig = computeSignature(SECRET, key, expires);
    const opts = { nowSec: FROZEN_NOW_SEC, secret: SECRET };
    // tampered key
    expect(verifySignedRequest("creatives/b.png", expires, sig, opts)).toBe(false);
    // tampered signature
    const flipped = sig.startsWith("0") ? `1${sig.slice(1)}` : `0${sig.slice(1)}`;
    expect(verifySignedRequest(key, expires, flipped, opts)).toBe(false);
    // tampered expires (signature no longer matches)
    expect(verifySignedRequest(key, expires + 1, sig, opts)).toBe(false);
    // malformed signatures rejected without invoking timingSafeEqual
    expect(verifySignedRequest(key, expires, "deadbeef", opts)).toBe(false);
    expect(verifySignedRequest(key, expires, `${"a".repeat(64)}extra`, opts)).toBe(false);
    expect(verifySignedRequest(key, expires, "", opts)).toBe(false);
    // Note: constant-time comparison is enforced via crypto.timingSafeEqual in
    // signing.ts; these functional tests cover the tamper cases.
  });

  it("fails closed on unsafe keys even with a valid-looking signature", () => {
    const expires = FROZEN_NOW_SEC + 60;
    const sig = computeSignature(SECRET, "../evil.txt", expires);
    expect(verifySignedRequest("../evil.txt", expires, sig, { nowSec: FROZEN_NOW_SEC, secret: SECRET })).toBe(false);
  });

  it("an unknown key fails verification even when another key's signature is valid", () => {
    const known = "known/object.png";
    const unknown = "unknown/object.png";
    const expires = FROZEN_NOW_SEC + 60;
    const opts = { nowSec: FROZEN_NOW_SEC, secret: SECRET };
    expect(verifySignedRequest(known, expires, computeSignature(SECRET, known, expires), opts)).toBe(true);
    expect(verifySignedRequest(unknown, expires, computeSignature(SECRET, known, expires), opts)).toBe(false);
  });

  it("resolves secret: explicit config > STORAGE_SIGNING_SECRET env > dev-only default", () => {
    process.env.STORAGE_SIGNING_SECRET = "from-env-secret-value";
    expect(resolveSigningSecret("explicit")).toBe("explicit");
    expect(resolveSigningSecret()).toBe("from-env-secret-value");
    delete process.env.STORAGE_SIGNING_SECRET;
    expect(resolveSigningSecret()).toBe(DEV_SIGNING_SECRET);
  });

  it("adapter without injected secret signs with env secret; verifier agrees", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW_SEC * 1000);
    process.env.STORAGE_SIGNING_SECRET = "env-roundtrip-secret";
    const adapter = new LocalFsStorageAdapter({ rootDir: "/unused" });
    const { url } = await adapter.signedUrl("roundtrip.bin");
    const params = new URLSearchParams(url.slice(url.indexOf("?")));
    const expires = Number(params.get("expires"));
    expect(
      verifySignedRequest("roundtrip.bin", expires, String(params.get("signature")), {
        nowSec: FROZEN_NOW_SEC,
      }),
    ).toBe(true);
    // dev-default secret (no env, no config): a fresh adapter re-resolves
    // (the existing one caches its secret at construction)
    delete process.env.STORAGE_SIGNING_SECRET;
    const devAdapter = new LocalFsStorageAdapter({ rootDir: "/unused" });
    const { url: devUrl } = await devAdapter.signedUrl("roundtrip.bin");
    const devParams = new URLSearchParams(devUrl.slice(devUrl.indexOf("?")));
    expect(
      verifySignedRequest("roundtrip.bin", Number(devParams.get("expires")), String(devParams.get("signature")), {
        nowSec: FROZEN_NOW_SEC,
      }),
    ).toBe(true);
    // a mismatched secret must fail
    expect(verifySignedRequest("roundtrip.bin", expires, String(params.get("signature")), {
      nowSec: FROZEN_NOW_SEC,
      secret: "other-secret",
    })).toBe(false);
  });

  it("rejects non-GET methods with UNSUPPORTED_METHOD", async () => {
    const adapter = new LocalFsStorageAdapter({
      rootDir: "/unused",
      signingSecret: SECRET,
    });
    await expect(
      adapter.signedUrl("a.txt", { method: "PUT" as "GET" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_METHOD" });
  });
});

describe("LocalFsStorageAdapter signed URLs (integration)", () => {
  let rootDir: string;
  let adapter: LocalFsStorageAdapter;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "zaff-storage-signed-"));
    adapter = new LocalFsStorageAdapter({ rootDir, signingSecret: SECRET });
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("put → signedUrl → verify happy path, bytes retrievable", async () => {
    const key = "campaigns/c9/thumb.png";
    await adapter.put(key, PNG_BYTES, { declaredContentType: "image/png" });
    const { url, expiresAt } = await adapter.signedUrl(key);
    expect(url).toMatch(/^\/storage\/campaigns\/c9\/thumb\.png\?expires=\d+&signature=[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const parsed = new URLSearchParams(url.slice(url.indexOf("?")));
    expect(
      verifySignedRequest(key, Number(parsed.get("expires")), String(parsed.get("signature")), { secret: SECRET }),
    ).toBe(true);
    expect(await adapter.get(key)).toEqual(Buffer.from(PNG_BYTES));
  });

  it("verification fails after the TTL elapses", async () => {
    const key = "ttl/expiring.png";
    await adapter.put(key, PNG_BYTES);
    const { url } = await adapter.signedUrl(key, { ttlSeconds: 30 });
    const parsed = new URLSearchParams(url.slice(url.indexOf("?")));
    const expires = Number(parsed.get("expires"));
    expect(verifySignedRequest(key, expires, String(parsed.get("signature")), { nowSec: expires - 1, secret: SECRET })).toBe(true);
    expect(verifySignedRequest(key, expires, String(parsed.get("signature")), { nowSec: expires + 1, secret: SECRET })).toBe(false);
  });

  it("a deleted object's URL verifies cryptographically but get() surfaces NOT_FOUND (route responsibility)", async () => {
    const key = "lifecycle/vanishing.png";
    await adapter.put(key, PNG_BYTES);
    await adapter.delete(key);
    const { url } = await adapter.signedUrl(key);
    const parsed = new URLSearchParams(url.slice(url.indexOf("?")));
    expect(verifySignedRequest(key, Number(parsed.get("expires")), String(parsed.get("signature")), { secret: SECRET })).toBe(true);
    await expect(adapter.get(key)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("S3CompatibleStorageAdapter signed URLs", () => {
  it("delegates to a client exposing presign()", async () => {
    const presign = vi.fn(() => `https://bucket.s3.example/obj.png?X-Amz-Signature=abc`);
    const client = {
      ...fakeBaseClient(),
      presign,
    };
    const adapter = new S3CompatibleStorageAdapter({ client });
    const result = await adapter.signedUrl("obj.png", { ttlSeconds: 120 });
    expect(presign).toHaveBeenCalledWith({ Key: "obj.png", ttlSeconds: 120 });
    expect(result.url).toContain("X-Amz-Signature=abc");
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 119_000);
  });

  it("throws SIGNED_URLS_UNSUPPORTED when the client lacks presign", async () => {
    const adapter = new S3CompatibleStorageAdapter({ client: fakeBaseClient() });
    await expect(adapter.signedUrl("obj.png")).rejects.toSatisfy((err: unknown) => {
      return err instanceof StorageError && err.code === "SIGNED_URLS_UNSUPPORTED";
    });
  });

  function fakeBaseClient() {
    return {
      putObject: async () => ({}),
      getObject: async () => ({ Body: PNG_BYTES }),
      deleteObject: async () => ({}),
      headObject: async () => ({
        ContentLength: PNG_BYTES.byteLength,
        LastModified: new Date(),
        ContentType: "image/png",
      }),
    };
  }
});

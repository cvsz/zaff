import { verifyMime } from "./mime.js";
import { validateKey } from "./keys.js";
import { DEFAULT_SIGNING_TTL_SECONDS } from "./signing.js";
import {
  ObjectStat,
  PutOptions,
  SignedUrl,
  SignedUrlOptions,
  StorageAdapter,
  StorageError,
} from "./types.js";

/**
 * Minimal S3-compatible client shape. In production, inject
 * `@aws-sdk/client-s3` wrapped to this interface (e.g. a thin object with
 * putObject/getObject/deleteObject/headObject delegating to Send commands);
 * this package intentionally does not depend on the AWS SDK.
 */
export interface S3ObjectClient {
  putObject(input: {
    Key: string;
    Body: Uint8Array;
    ContentType?: string | undefined;
  }): Promise<unknown>;
  /** Body must resolve to the full object bytes (Buffer/Uint8Array). */
  getObject(input: { Key: string }): Promise<{ Body: Uint8Array }>;
  deleteObject(input: { Key: string }): Promise<unknown>;
  headObject(input: {
    Key: string;
  }): Promise<{
    ContentLength: number;
    LastModified: Date;
    ContentType?: string | undefined;
  }>;
  /**
   * Optional native presigning (e.g. getSignedUrl wrapped to this shape).
   * When absent, signedUrl() throws SIGNED_URLS_UNSUPPORTED instead of
   * silently degrading (capability-style per AGENTS.md §3).
   */
  presign?(input: {
    Key: string;
    ttlSeconds: number;
  }): string | Promise<string>;
}

export interface S3StorageConfig {
  client: S3ObjectClient;
  maxBytes?: number | undefined;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function notFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "NotFound"
  );
}

/**
 * Thin adapter over an injected S3-compatible client. Reuses shared key
 * validation and MIME verification so behavior matches LocalFsStorageAdapter.
 * Note: mismatch rejection happens before upload; stat reads remote metadata,
 * so mismatch flags from legacy objects are not replayed here.
 */
export class S3CompatibleStorageAdapter implements StorageAdapter {
  private readonly client: S3ObjectClient;
  private readonly maxBytes: number;

  constructor(config: S3StorageConfig) {
    this.client = config.client;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    const safeKey = validateKey(key);
    if (data.byteLength > this.maxBytes) {
      throw new StorageError(
        "PAYLOAD_TOO_LARGE",
        `payload is ${data.byteLength} bytes; limit is ${this.maxBytes}`,
      );
    }
    const verdict = verifyMime(data, options?.declaredContentType);
    await this.client.putObject({
      Key: safeKey,
      Body: data,
      ...(verdict.resolved !== undefined
        ? { ContentType: verdict.resolved }
        : {}),
    });
  }

  async get(key: string): Promise<Buffer> {
    const safeKey = validateKey(key);
    try {
      const res = await this.client.getObject({ Key: safeKey });
      return Buffer.from(res.Body);
    } catch (err) {
      if (notFound(err)) {
        throw new StorageError("NOT_FOUND", `object not found: ${safeKey}`);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const safeKey = validateKey(key);
    await this.client.deleteObject({ Key: safeKey });
  }

  async stat(key: string): Promise<ObjectStat> {
    const safeKey = validateKey(key);
    try {
      const head = await this.client.headObject({ Key: safeKey });
      return {
        size: head.ContentLength,
        contentType: head.ContentType ?? "application/octet-stream",
        updatedAt: new Date(head.LastModified),
      };
    } catch (err) {
      if (notFound(err)) {
        throw new StorageError("NOT_FOUND", `object not found: ${safeKey}`);
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.stat(key);
      return true;
    } catch (err) {
      if (err instanceof StorageError && err.code === "NOT_FOUND") return false;
      throw err;
    }
  }

  async signedUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<SignedUrl> {
    if (options?.method !== undefined && options.method !== "GET") {
      throw new StorageError("UNSUPPORTED_METHOD", String(options.method));
    }
    const safeKey = validateKey(key);
    const presign = this.client.presign;
    if (typeof presign !== "function") {
      throw new StorageError(
        "SIGNED_URLS_UNSUPPORTED",
        "injected S3 client does not expose presign(); wrap the provider's native presigned-URL API to enable signed URLs",
      );
    }
    const ttlSeconds = options?.ttlSeconds ?? DEFAULT_SIGNING_TTL_SECONDS;
    const url = await presign.call(this.client, {
      Key: safeKey,
      ttlSeconds,
    });
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }
}

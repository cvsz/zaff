import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyMime } from "./mime.js";
import { validateKey } from "./keys.js";
import {
  DEFAULT_SIGNING_TTL_SECONDS,
  buildSignedUrl,
  resolveSigningSecret,
} from "./signing.js";
import {
  ObjectStat,
  PutOptions,
  SignedUrl,
  SignedUrlOptions,
  StorageAdapter,
  StorageError,
} from "./types.js";

interface StoredMeta {
  size: number;
  contentType: string;
  sniffedContentType: string;
  mismatch: boolean;
  declaredContentType?: string;
  updatedAt: string;
}

export interface LocalFsStorageConfig {
  /** Root directory; created on first use if missing. */
  rootDir: string;
  /** Hard cap per object. Default 50 MiB. */
  maxBytes?: number | undefined;
  /**
   * HMAC secret for signed URLs. Falls back to STORAGE_SIGNING_SECRET,
   * then to a dev-only default (see signing.ts). Production MUST inject
   * via a secret manager; the verifier must use the same secret.
   */
  signingSecret?: string | undefined;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Filesystem-backed adapter. Blobs live under `<rootDir>/objects/<key>`,
 * metadata sidecars under `<rootDir>/meta/<key>.json`, so a sidecar can
 * never collide with an object blob and traversal-safe keys translate
 * directly to nested paths.
 */
export class LocalFsStorageAdapter implements StorageAdapter {
  private readonly rootDir: string;
  private readonly objectsDir: string;
  private readonly metaDir: string;
  private readonly maxBytes: number;
  private readonly signingSecret: string;

  constructor(config: LocalFsStorageConfig) {
    this.rootDir = resolve(config.rootDir);
    this.objectsDir = join(this.rootDir, "objects");
    this.metaDir = join(this.rootDir, "meta");
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    this.signingSecret = resolveSigningSecret(config.signingSecret);
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
    const objectPath = join(this.objectsDir, safeKey);
    const metaPath = join(this.metaDir, `${safeKey}.json`);
    await mkdir(dirname(objectPath), { recursive: true });
    await mkdir(dirname(metaPath), { recursive: true });
    const meta: StoredMeta = {
      size: data.byteLength,
      contentType: verdict.resolved,
      sniffedContentType: verdict.sniffed,
      mismatch: verdict.mismatch,
      ...(verdict.declared !== undefined
        ? { declaredContentType: verdict.declared }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(objectPath, data, { mode: 0o600 });
    await writeFile(metaPath, JSON.stringify(meta), { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    const safeKey = validateKey(key);
    try {
      return await readFile(join(this.objectsDir, safeKey));
    } catch {
      throw new StorageError("NOT_FOUND", `object not found: ${safeKey}`);
    }
  }

  async delete(key: string): Promise<void> {
    const safeKey = validateKey(key);
    await rm(join(this.objectsDir, safeKey), { force: true });
    await rm(join(this.metaDir, `${safeKey}.json`), { force: true });
  }

  async stat(key: string): Promise<ObjectStat> {
    const safeKey = validateKey(key);
    let raw: string;
    try {
      raw = await readFile(join(this.metaDir, `${safeKey}.json`), "utf8");
    } catch {
      throw new StorageError("NOT_FOUND", `object not found: ${safeKey}`);
    }
    const meta = JSON.parse(raw) as StoredMeta;
    return {
      size: meta.size,
      contentType: meta.contentType,
      updatedAt: new Date(meta.updatedAt),
    };
  }

  async exists(key: string): Promise<boolean> {
    const safeKey = validateKey(key);
    try {
      await stat(join(this.objectsDir, safeKey));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mints `/storage/{key}?expires={unixSec}&signature={hex hmac-sha256}`.
   * This package ships no HTTP route: apps must wire one that calls
   * `verifySignedRequest` (with the same secret) before streaming bytes.
   */
  async signedUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<SignedUrl> {
    if (options?.method !== undefined && options.method !== "GET") {
      throw new StorageError("UNSUPPORTED_METHOD", String(options.method));
    }
    const safeKey = validateKey(key);
    const ttl = options?.ttlSeconds ?? DEFAULT_SIGNING_TTL_SECONDS;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    return buildSignedUrl(this.signingSecret, safeKey, expires);
  }
}

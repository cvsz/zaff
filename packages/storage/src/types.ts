export interface ObjectStat {
  size: number;
  contentType: string;
  updatedAt: Date;
}

export interface PutOptions {
  /** Content type as declared by the caller; verified against sniffed bytes. */
  declaredContentType?: string | undefined;
}

export interface SignedUrlOptions {
  /** Time-to-live in seconds. Default 300. */
  ttlSeconds?: number | undefined;
  /** Only GET is supported across all adapters. */
  method?: "GET" | undefined;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/**
 * Transport-agnostic object-storage port (FND-5). Implementations must:
 * - reject path-traversing or otherwise unsafe keys,
 * - enforce a configured maxBytes cap on put,
 * - sniff magic bytes and refuse mismatched binary declarations
 *   (image/* and application/pdf are hard-rejected on mismatch),
 * - treat delete as idempotent.
 * - treat delete as idempotent,
 * - support signedUrl; adapters that cannot mint signed URLs throw
 *   SIGNED_URLS_UNSUPPORTED (capability-style, per AGENTS.md §3).
 */
export interface StorageAdapter {
  put(key: string, data: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<ObjectStat>;
  exists(key: string): Promise<boolean>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<SignedUrl>;
}

export class StorageError extends Error {
  readonly code:
    | "INVALID_KEY"
    | "PAYLOAD_TOO_LARGE"
    | "CONTENT_TYPE_MISMATCH"
    | "NOT_FOUND"
    | "UNSUPPORTED_METHOD"
    | "SIGNED_URLS_UNSUPPORTED";

  constructor(
    code:
      | "INVALID_KEY"
      | "PAYLOAD_TOO_LARGE"
      | "CONTENT_TYPE_MISMATCH"
      | "NOT_FOUND"
      | "UNSUPPORTED_METHOD"
      | "SIGNED_URLS_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

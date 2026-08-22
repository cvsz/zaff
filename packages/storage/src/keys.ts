import { StorageError } from "./types.js";

export const MAX_KEY_LENGTH = 512;

const SAFE_KEY_CHARS = /^[A-Za-z0-9._/-]+$/;

/**
 * Validates a logical object key and returns its normalized form.
 *
 * Rules (aggressive by design):
 * - backslashes are normalized to forward slashes before validation,
 * - empty keys, NUL bytes, absolute paths, drive-letter paths, `.`/`..`
 *   segments, percent-encoded traversal fragments (`%2f`/`%5c`), and any
 *   character outside [A-Za-z0-9._/-] are rejected — this also defeats
 *   unicode look-alike dot tricks, since non-ASCII is never allowed,
 * - keys are capped at MAX_KEY_LENGTH characters.
 */
export function validateKey(key: string): string {
  if (key.length === 0) {
    throw new StorageError("INVALID_KEY", "key must not be empty");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new StorageError(
      "INVALID_KEY",
      `key exceeds maximum length of ${MAX_KEY_LENGTH}`,
    );
  }
  if (key.includes("\0")) {
    throw new StorageError("INVALID_KEY", "key must not contain NUL bytes");
  }
  const normalized = key.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new StorageError("INVALID_KEY", "absolute keys are not allowed");
  }
  if (/%2f|%5c/i.test(normalized)) {
    throw new StorageError(
      "INVALID_KEY",
      "percent-encoded path separators are not allowed",
    );
  }
  if (!SAFE_KEY_CHARS.test(normalized)) {
    throw new StorageError(
      "INVALID_KEY",
      "key may only contain [A-Za-z0-9._/-]",
    );
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new StorageError("INVALID_KEY", "empty path segment in key");
    }
    if (segment === "." || segment === "..") {
      throw new StorageError("INVALID_KEY", "relative path segments are not allowed");
    }
  }
  return normalized;
}

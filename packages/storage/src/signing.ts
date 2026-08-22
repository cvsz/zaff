import { createHmac, timingSafeEqual } from "node:crypto";
import { validateKey } from "./keys.js";
import { SignedUrl, StorageError } from "./types.js";

export const DEFAULT_SIGNING_TTL_SECONDS = 300;

/**
 * DEV-ONLY fallback secret. Production deployments MUST inject the real
 * secret via LocalFsStorageConfig.signingSecret or the
 * STORAGE_SIGNING_SECRET environment variable sourced from a secret
 * manager (AGENTS.md §24). Never rely on this value outside development.
 */
export const DEV_SIGNING_SECRET = "zaff_dev_signing_secret_change_me";

export function resolveSigningSecret(configured?: string): string {
  const secret =
    configured ?? process.env.STORAGE_SIGNING_SECRET ?? DEV_SIGNING_SECRET;
  if (secret.length === 0) {
    throw new StorageError(
      "SIGNED_URLS_UNSUPPORTED",
      "signing secret must not be empty",
    );
  }
  return secret;
}

/** hex hmac-sha256(secret, key + "\n" + expires) */
export function computeSignature(
  secret: string,
  key: string,
  expires: number,
): string {
  return createHmac("sha256", secret)
    .update(`${key}\n${expires}`)
    .digest("hex");
}

export function buildSignedUrl(
  secret: string,
  key: string,
  expires: number,
): SignedUrl {
  const signature = computeSignature(secret, key, expires);
  return {
    url: `/storage/${key}?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000),
  };
}

export interface VerifySignedRequestOptions {
  /** Clock override (unix seconds) for tests; defaults to Date.now(). */
  nowSec?: number | undefined;
  /**
   * Signing secret. Defaults to STORAGE_SIGNING_SECRET / dev fallback —
   * pass explicitly when the adapter was constructed with an injected
   * secret so verifier and signer always agree.
   */
  secret?: string | undefined;
}

/**
 * Verifies `/storage/{key}?expires=..&signature=..` query parameters before
 * an app route streams bytes. Returns false (never throws) for tampered,
 * malformed, or expired requests so handlers can uniformly respond 403.
 *
 * Signature comparison is constant-time via crypto.timingSafeEqual; the
 * length check before comparison only leaks the (public) hash length.
 *
 * This package ships no HTTP route: apps MUST wire a route that calls this
 * function and only then streams `adapter.get(key)` on success.
 */
export function verifySignedRequest(
  key: string,
  expires: number,
  signature: string,
  options?: VerifySignedRequestOptions,
): boolean {
  let safeKey: string;
  try {
    safeKey = validateKey(key);
  } catch {
    return false;
  }
  if (!Number.isInteger(expires) || expires <= 0) return false;
  const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
  if (expires < nowSec) return false;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  const secret = resolveSigningSecret(options?.secret);
  const expected = Buffer.from(computeSignature(secret, safeKey, expires), "hex");
  const provided = Buffer.from(signature, "hex");
  // timingSafeEqual throws on length mismatch; the regex above pins both to 32 bytes.
  return timingSafeEqual(expected, provided);
}

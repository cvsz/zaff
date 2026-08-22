import { StorageError } from "./types.js";

export type SniffedContentType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "application/pdf"
  | "application/json"
  | "text/plain"
  | "application/octet-stream";

function isBinaryDeclared(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /^(image\/|application\/pdf\b)/i.test(contentType.trim());
}

/**
 * Minimal magic-byte sniffer for the content types this platform writes.
 * Returns application/octet-stream for unknown binary shapes and
 * text/plain for data composed entirely of printable ASCII / whitespace.
 */
export function sniffContentType(data: Uint8Array): SniffedContentType {
  const head = data.subarray(0, 16);
  const startsWith = (sig: number[], offset = 0): boolean =>
    sig.every((byte, i) => head[offset + i] === byte);

  if (
    startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    startsWith([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  const trimmedHead = Buffer.from(head).toString("utf8").trimStart();
  if (/^[{[]/.test(trimmedHead)) {
    try {
      JSON.parse(Buffer.from(data).toString("utf8"));
      return "application/json";
    } catch {
      // fall through
    }
  }
  if (
    Array.from(data).every(
      (b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e),
    )
  ) {
    return "text/plain";
  }
  return "application/octet-stream";
}

export interface MimeVerdict {
  declared: string | undefined;
  sniffed: SniffedContentType;
  mismatch: boolean;
  /** Final contentType recorded in object metadata. */
  resolved: string;
}

/**
 * Compares declared vs sniffed type. Policy: a declared binary type
 * (image/*, application/pdf) that does not match the sniffed bytes is a
 * hard reject — callers must not be able to smuggle mislabeled binaries.
 * For non-binary declarations, both values are recorded with a flag.
 */
export function verifyMime(
  data: Uint8Array,
  declaredContentType: string | undefined,
): MimeVerdict {
  const sniffed = sniffContentType(data);
  const declaredNormalized = declaredContentType?.trim().toLowerCase();
  if (
    declaredContentType &&
    isBinaryDeclared(declaredContentType) &&
    sniffed !== declaredNormalized
  ) {
    throw new StorageError(
      "CONTENT_TYPE_MISMATCH",
      `content-type mismatch: declared ${declaredContentType} but bytes look like ${sniffed}`,
    );
  }
  return {
    declared: declaredContentType,
    sniffed,
    mismatch:
      Boolean(declaredNormalized) && declaredNormalized !== sniffed,
    resolved: declaredContentType ?? sniffed,
  };
}

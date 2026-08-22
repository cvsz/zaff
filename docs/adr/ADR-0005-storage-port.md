# ADR-0005: Object storage behind a port with a local-filesystem adapter first

- **Status:** Accepted
- **Date:** 2026-08-22

## Context

FND-5 requires an object-storage capability for generated media assets
(images, video renders, templates). The platform must remain zero-new-
dependency and self-hostable on a single node today (§21 separates media
from OLTP), while anticipating S3-compatible object stores later. Media is
untrusted-adjacent input: keys arrive from user/LLM-influenced workflows and
bytes may come from AI providers, so path traversal and content-type
confusion are real threat-model entries.

## Decision

Define a `StorageAdapter` port (`put/get/delete/stat/exists`) in
`packages/storage` with two implementations:

1. **`LocalFsStorageAdapter`** — the default. Blobs live under
   `<rootDir>/objects/<key>` and metadata sidecars under
   `<rootDir>/meta/<key>.json`. The sidecar split means metadata files can
   never collide with object blobs. Files are written mode `0600`
   (non-world-readable).
2. **`S3CompatibleStorageAdapter`** — a thin class over an injected client
   exposing only `putObject/getObject/deleteObject/headObject`. Production
   injects `@aws-sdk/client-s3` wrapped to that interface; this package does
   not depend on the AWS SDK.

Shared hardening applied by both adapters:

- **Key validation (`validateKey`)** — aggressive allowlist
   `[A-Za-z0-9._/-]`: backslashes normalized to `/`, then absolute paths,
   drive letters, `.`/`..` segments, empty segments, NUL bytes,
   percent-encoded separators (`%2f`, `%5c`), any non-ASCII (defeats unicode
   dot look-alikes such as U+2025), and keys over 512 chars are rejected.
- **Size cap** — per-object `maxBytes` (default 50 MiB) enforced before any
   write.
- **MIME sniffing** — magic-byte inspection (no dependencies) for
   png/jpeg/gif/webp/pdf/json/text. Policy: a *declared binary* type
   (`image/*`, `application/pdf`) that mismatches sniffed bytes is a hard
   reject (`CONTENT_TYPE_MISMATCH`); non-binary mismatches are recorded with
   a `mismatch` flag instead of rejected.
- **Errors** — typed `StorageError` with stable codes
   (`INVALID_KEY | PAYLOAD_TOO_LARGE | CONTENT_TYPE_MISMATCH | NOT_FOUND |
   UNSUPPORTED_METHOD | SIGNED_URLS_UNSUPPORTED`);
   `delete` is idempotent; missing reads map to `NOT_FOUND`.

## Decision (BK-3): Signed URLs

The port gains `signedUrl(key, {ttlSeconds?, method?}) → {url, expiresAt}`
(default TTL **300 s**; only `GET` is supported — anything else raises
`UNSUPPORTED_METHOD`).

1. **`LocalFsStorageAdapter`** mints
   `/storage/{key}?expires={unixSec}&signature={hex}` where
   `signature = HMAC-SHA256(secret, key + "\n" + expires)` via `node:crypto`
   (zero new dependencies). The companion exported function
   **`verifySignedRequest(key, expires, signature, {nowSec?, secret?})`**
   validates the key allowlist, checks expiry, pins the signature to exactly
   64 lowercase hex chars, then compares in constant time with
   `crypto.timingSafeEqual` (length is pinned before comparison, so
   `timingSafeEqual` cannot throw and no secret-dependent length leaks).
   It fails closed (returns `false`, never throws) so route handlers can
   uniformly answer 403.
2. **`S3CompatibleStorageAdapter`** delegates to an *optional*
   `presign({Key, ttlSeconds})` method on the injected client (native AWS
   SigV4 presigned URLs). If the client does not expose `presign`,
   `signedUrl` throws **`SIGNED_URLS_UNSUPPORTED`** instead of silently
   degrading — capability-style per AGENTS.md §3.

### Secret management

Resolution order for the local adapter's HMAC secret:
explicit `LocalFsStorageConfig.signingSecret` →
`STORAGE_SIGNING_SECRET` env var → dev-only default
(`zaff_dev_signing_secret_change_me`). The secret is resolved **once at
construction**; verifiers must use the same secret. Production MUST inject
the secret from a secret manager (AGENTS.md §24); the dev default must never
be relied upon outside development.

### Boundary of responsibility

This package ships **no HTTP route**. Applications MUST wire a route that:

1. parses `expires`/`signature` query params,
2. calls `verifySignedRequest` and rejects non-`true` results,
3. only then streams `adapter.get(key)` (surfacing `NOT_FOUND` as 404 — a
   cryptographically valid URL for a deleted object verifies fine by design;
   existence is checked at streaming time, not signature time).

### Consequences

- Signed URLs are deterministic for `(secret, key, expires)`, enabling
  cache-friendly minting and replay protection purely through short TTLs.
- Expiry uses coarse unix-second granularity (`expires < nowSec` fails), so a
  URL is valid through the end of its final second.
- Swapping local disk for S3 later changes only which signer mints URLs;
  consumers keep calling `signedUrl`. Apps that verify locally-minted URLs
  must switch verification when switching adapters (S3 URLs are verified by
  the object store itself).

## Consequences

- Swapping local disk for MinIO/S3/R2 later requires no core changes;
  adapters declare semantics, callers stay idempotent and treat `NOT_FOUND`
  as recoverable.
- Sidecar metadata is eventually-consistent relative to blobs only if an
  implementation writes them out of order — both bundled adapters write
  blob then sidecar within `put`, so a torn write surfaces as a stat miss,
  not stale metadata.
- S3 adapter trusts remote `ContentType` for `stat`; mismatch flags are only
  computed at put time. Re-sniffing on read is deliberately not done for cost
  reasons; revisit if user-uploaded (vs system-generated) media lands in the
  same bucket.
- The key allowlist is intentionally narrower than S3's; keys minted for one
  adapter are valid for all.

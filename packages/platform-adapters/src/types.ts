import { z } from "zod";

/**
 * Local copy of the contracts capability enum (ADT-1).
 *
 * Deliberately duplicated instead of imported via a workspace dependency so
 * this package stays dependency-free. `capability-parity.test.ts` asserts
 * string-set equality against packages/contracts on every test run.
 */
export const PLATFORM_CAPABILITIES = [
  "catalog.read",
  "offers.read",
  "links.create",
  "orders.read",
  "commissions.read",
  "content.publish",
  "video.publish",
  "image.publish",
  "analytics.read",
  "webhooks",
] as const;

export const PlatformCapabilitySchema = z.enum(PLATFORM_CAPABILITIES);
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export interface AdapterHttpDeps {
  fetch: typeof fetch;
  baseUrl?: string;
  getSecret(name: string): string | undefined;
}

export interface CallOptions {
  /** Explicit unix-seconds clock for deterministic signing in tests. */
  now?: number;
}

export interface CatalogItem {
  externalId: string;
  title: string;
  priceAmount: number;
  currency: string;
}

export interface CatalogSearchResult {
  items: CatalogItem[];
  cursor: string | null;
}

export interface OrderPage {
  orders: Array<{
    externalId: string;
    status: string;
    amount: number;
    currency: string;
  }>;
  cursor: string | null;
}

export interface PublishResult {
  externalId: string;
}

export interface PlatformAdapter {
  readonly id: string;
  readonly policyVersion: string;
  capabilities(): PlatformCapability[];
  has(capability: PlatformCapability): boolean;
  assertCapability(capability: PlatformCapability): void;
}

export type AdapterErrorCode =
  | "MISSING_CAPABILITY"
  | "CAPABILITY_NOT_IMPLEMENTED"
  | "NOT_IMPLEMENTED"
  | "UNKNOWN_PROVIDER"
  | "QUOTA_EXCEEDED"
  | "HTTP_ERROR";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class MissingCapabilityError extends AdapterError {
  readonly providerId: string;
  readonly capability: PlatformCapability;

  constructor(providerId: string, capability: PlatformCapability) {
    super(
      "MISSING_CAPABILITY",
      `provider "${providerId}" does not declare capability "${capability}"`
    );
    this.providerId = providerId;
    this.capability = capability;
  }
}

export class CapabilityNotImplementedError extends AdapterError {
  readonly providerId: string;
  readonly capability: PlatformCapability;

  constructor(
    providerId: string,
    capability: PlatformCapability,
    reason: string
  ) {
    super(
      "CAPABILITY_NOT_IMPLEMENTED",
      `provider "${providerId}" declares "${capability}" but the adapter does not implement it yet: ${reason}`
    );
    this.providerId = providerId;
    this.capability = capability;
  }
}

export class NotImplementedError extends AdapterError {
  constructor(providerId: string, operation: string, reason: string) {
    super(
      "NOT_IMPLEMENTED",
      `operation "${operation}" on provider "${providerId}" is not implemented: ${reason}`
    );
  }
}

export class UnknownProviderError extends AdapterError {
  constructor(providerId: string) {
    super("UNKNOWN_PROVIDER", `no policy registry entry for "${providerId}"`);
  }
}

export class QuotaExceededError extends AdapterError {
  constructor(providerId: string, cost: number, used: number, limit: number) {
    super(
      "QUOTA_EXCEEDED",
      `provider "${providerId}" quota exceeded: need ${cost}, window used ${used}/${limit}`
    );
  }
}

export class AdapterHttpError extends AdapterError {
  readonly status: number;
  readonly url: string;
  readonly bodySnippet: string;

  constructor(status: number, url: string, bodySnippet: string) {
    super(
      "HTTP_ERROR",
      `request to ${url} failed with status ${status}: ${bodySnippet.slice(0, 200)}`
    );
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet.slice(0, 500);
  }
}

import { createHmac } from "node:crypto";
import type {
  AdapterHttpDeps,
  CallOptions,
  PlatformAdapter,
  PlatformCapability,
} from "./types.js";
import { AdapterHttpError, MissingCapabilityError } from "./types.js";
import type {
  RegisteredPolicyEntry,
} from "./policy-registry.js";

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  readonly id: string;
  readonly policyVersion: string;
  protected readonly http: AdapterHttpDeps;
  private readonly entry: RegisteredPolicyEntry;

  constructor(entry: RegisteredPolicyEntry, http: AdapterHttpDeps) {
    this.entry = entry;
    this.id = entry.providerId;
    this.policyVersion = entry.policyVersion;
    this.http = http;
  }

  capabilities(): PlatformCapability[] {
    return [...this.entry.capabilities];
  }

  has(capability: PlatformCapability): boolean {
    return this.entry.capabilities.includes(capability);
  }

  assertCapability(capability: PlatformCapability): void {
    if (!this.has(capability)) {
      throw new MissingCapabilityError(this.id, capability);
    }
  }

  protected defaultBaseUrl(): string {
    return "";
  }

  protected baseUrl(): string {
    return (this.http.baseUrl ?? this.defaultBaseUrl()).replace(/\/+$/, "");
  }

  protected nowSeconds(options?: CallOptions): number {
    return options?.now ?? Math.floor(Date.now() / 1000);
  }

  protected secret(name: string): string | undefined {
    return this.http.getSecret(name);
  }

  protected buildUrl(
    path: string,
    params: Record<string, string>
  ): string {
    const qs = new URLSearchParams(params).toString();
    return `${this.baseUrl()}${path}${qs ? `?${qs}` : ""}`;
  }

  protected async request(
    url: string,
    init: RequestInit
  ): Promise<{ status: number; headers: globalThis.Headers; body: unknown }> {
    const res = await this.http.fetch(url, init);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new AdapterHttpError(
        res.status,
        url,
        typeof body === "string" ? body : JSON.stringify(body)
      );
    }
    return { status: res.status, headers: res.headers, body };
  }

  protected async requestJson(url: string, init: RequestInit): Promise<unknown> {
    const { body } = await this.request(url, init);
    return body;
  }
}

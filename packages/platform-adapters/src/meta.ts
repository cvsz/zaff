import { BasePlatformAdapter } from "./core.js";
import type {
  AdapterHttpDeps,
  CallOptions,
  PublishResult,
} from "./types.js";
import { NotImplementedError } from "./types.js";
import type { RegisteredPolicyEntry } from "./policy-registry.js";

const DEFAULT_BASE_URL = "https://graph.facebook.com/v21.0";

export interface MetaInsightsResult {
  metrics: Record<string, number>;
}

/**
 * Meta Graph API skeleton (ADT-1). Access tokens are resolved per call via
 * getSecret and sent as Authorization bearer headers so they never appear in
 * logged URLs. Token exchange is intentionally unimplemented until the OAuth
 * wiring (services/auth) exists.
 */
export class MetaAdapter extends BasePlatformAdapter {
  constructor(entry: RegisteredPolicyEntry, http: AdapterHttpDeps) {
    super(entry, http);
  }

  protected override defaultBaseUrl(): string {
    return DEFAULT_BASE_URL;
  }

  private authHeaders(): Record<string, string> {
    const token = this.secret("META_PAGE_ACCESS_TOKEN");
    if (!token) {
      throw new Error("missing required secret: META_PAGE_ACCESS_TOKEN");
    }
    return { Authorization: `Bearer ${token}` };
  }

  async publishPost(
    pageId: string,
    message: string,
    _options?: CallOptions
  ): Promise<PublishResult> {
    this.assertCapability("content.publish");
    const url = this.buildUrl(`/${pageId}/feed`, {});
    const body = await this.requestJson(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    const data = body as { id?: string };
    return { externalId: data.id ?? "" };
  }

  async publishPhoto(
    pageId: string,
    photoUrl: string,
    caption: string,
    _options?: CallOptions
  ): Promise<PublishResult> {
    this.assertCapability("image.publish");
    const url = this.buildUrl(`/${pageId}/photos`, {});
    const body = await this.requestJson(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: photoUrl, caption }),
    });
    const data = body as { id?: string; post_id?: string };
    return { externalId: data.post_id ?? data.id ?? "" };
  }

  async getInsights(
    objectId: string,
    metric: string,
    _options?: CallOptions
  ): Promise<MetaInsightsResult> {
    this.assertCapability("analytics.read");
    const url = this.buildUrl(`/${objectId}/insights`, { metric });
    const body = await this.requestJson(url, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const data = body as {
      data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
    };
    const metrics: Record<string, number> = {};
    for (const row of data.data ?? []) {
      if (typeof row.name === "string") {
        metrics[row.name] = row.values?.[0]?.value ?? 0;
      }
    }
    return { metrics };
  }

  async exchangeLongLivedToken(_input: {
    shortLivedToken: string;
  }): Promise<never> {
    throw new NotImplementedError(
      this.id,
      "exchange_long_lived_token",
      "requires OAuth wiring in services/auth before token flows are enabled"
    );
  }

  async publishVideo(_input: {
    videoUrl: string;
    description: string;
  }): Promise<never> {
    this.assertCapability("video.publish");
    throw new NotImplementedError(
      this.id,
      "publish_video",
      "video publishing requires resumable Graph upload support"
    );
  }
}

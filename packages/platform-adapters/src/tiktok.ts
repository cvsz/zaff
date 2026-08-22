import { BasePlatformAdapter, hmacSha256Hex } from "./core.js";
import type {
  AdapterHttpDeps,
  CatalogSearchResult,
  CatalogItem,
  CallOptions,
  OrderPage,
} from "./types.js";
import {
  CapabilityNotImplementedError,
} from "./types.js";
import type { RegisteredPolicyEntry } from "./policy-registry.js";

const DEFAULT_BASE_URL = "https://open-api.tiktokglobalshop.com";

interface TikTokEnvelope {
  code: number;
  message: string;
  data?: unknown;
}

export interface TikTokSearchOptions extends CallOptions {
  page?: number;
  pageSize?: number;
}

/**
 * TikTok Shop Partner API skeleton (ADT-1). Request shaping follows the
 * documented signed-request conventions; all I/O goes through injected
 * fetch. Signing secrets are resolved per call via getSecret and never
 * retained on the instance.
 */
export class TikTokShopAdapter extends BasePlatformAdapter {
  constructor(entry: RegisteredPolicyEntry, http: AdapterHttpDeps) {
    super(entry, http);
  }

  protected override defaultBaseUrl(): string {
    return DEFAULT_BASE_URL;
  }

  private requireSecret(name: string): string {
    const value = this.secret(name);
    if (!value) {
      throw new Error(`missing required secret: ${name}`);
    }
    return value;
  }

  /**
   * TikTok Shop signing: HMAC-SHA256 over `${path}${sortedParams}` using the
   * app secret. The access token travels as a plain param and is excluded
   * from the signature input.
   */
  private signedParams(
    path: string,
    business: Record<string, string>,
    nowSeconds: number
  ): Record<string, string> {
    const appKey = this.requireSecret("TIKTOK_APP_KEY");
    const accessToken = this.requireSecret("TIKTOK_ACCESS_TOKEN");
    const params: Record<string, string> = {
      app_key: appKey,
      access_token: accessToken,
      timestamp: String(nowSeconds),
      ...business,
    };
    const sorted = Object.keys(params)
      .filter((k) => k !== "access_token" && k !== "sign")
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("");
    const sign = hmacSha256Hex(
      this.requireSecret("TIKTOK_APP_SECRET"),
      `${path}${sorted}`
    );
    return { ...params, sign };
  }

  private assertEnvelope(body: unknown): Record<string, unknown> {
    const env = body as TikTokEnvelope;
    if (typeof env?.code === "number" && env.code !== 0) {
      throw new Error(`tiktok shop api error ${env.code}: ${env.message}`);
    }
    return (env.data ?? {}) as Record<string, unknown>;
  }

  async searchCatalog(
    query: string,
    options?: TikTokSearchOptions
  ): Promise<CatalogSearchResult> {
    this.assertCapability("catalog.read");
    const now = this.nowSeconds(options);
    const path = "/product/search";
    const params = this.signedParams(
      path,
      {
        query,
        page_size: String(options?.pageSize ?? 20),
        page: String(options?.page ?? 1),
      },
      now
    );
    const url = this.buildUrl(path, params);
    const body = await this.requestJson(url, { method: "GET" });
    const data = this.assertEnvelope(body);
    const products = Array.isArray(data.products) ? data.products : [];
    const items: CatalogItem[] = products.map((raw) => {
      const p = raw as {
        product_id?: string;
        product_name?: string;
        price?: { amount?: number; currency?: string };
      };
      return {
        externalId: p.product_id ?? "",
        title: p.product_name ?? "",
        priceAmount: p.price?.amount ?? 0,
        currency: p.price?.currency ?? "USD",
      };
    });
    return {
      items,
      cursor:
        typeof data.cursor === "string"
          ? data.cursor
          : typeof data.next_page_token === "string"
            ? data.next_page_token
            : null,
    };
  }

  async listOrders(options?: CallOptions & { pageSize?: number }): Promise<OrderPage> {
    this.assertCapability("orders.read");
    const now = this.nowSeconds(options);
    const path = "/order/search";
    const params = this.signedParams(
      path,
      { page_size: String(options?.pageSize ?? 20) },
      now
    );
    const url = this.buildUrl(path, params);
    const body = await this.requestJson(url, { method: "GET" });
    const data = this.assertEnvelope(body);
    const orders = Array.isArray(data.order_list) ? data.order_list : [];
    return {
      orders: orders.map((raw) => {
        const o = raw as {
          order_id?: string;
          order_status?: string;
          payment?: { total_amount?: number; currency?: string };
        };
        return {
          externalId: o.order_id ?? "",
          status: o.order_status ?? "",
          amount: o.payment?.total_amount ?? 0,
          currency: o.payment?.currency ?? "USD",
        };
      }),
      cursor: typeof data.more_next_token === "string" ? data.more_next_token : null,
    };
  }

  async getCommissions(options?: CallOptions): Promise<{
    settlements: Array<{ orderId: string; commissionAmount: number; currency: string }>;
    cursor: string | null;
  }> {
    this.assertCapability("commissions.read");
    const now = this.nowSeconds(options);
    const path = "/finance/affiliate_order_settlements";
    const params = this.signedParams(path, { page_size: "50" }, now);
    const url = this.buildUrl(path, params);
    const body = await this.requestJson(url, { method: "GET" });
    const data = this.assertEnvelope(body);
    const rows = Array.isArray(data.settlements) ? data.settlements : [];
    return {
      settlements: rows.map((raw) => {
        const s = raw as {
          order_id?: string;
          commission?: { amount?: number; currency?: string };
        };
        return {
          orderId: s.order_id ?? "",
          commissionAmount: s.commission?.amount ?? 0,
          currency: s.commission?.currency ?? "USD",
        };
      }),
      cursor: typeof data.cursor === "string" ? data.cursor : null,
    };
  }

  async publishImage(_input: {
    imageUrl: string;
  }): Promise<never> {
    this.assertCapability("image.publish");
    throw new CapabilityNotImplementedError(
      this.id,
      "image.publish",
      "no image publishing surface documented in TikTok Shop Partner API"
    );
  }

  async createAffiliateLink(_input: {
    productId: string;
  }): Promise<never> {
    this.assertCapability("links.create");
    throw new CapabilityNotImplementedError(
      this.id,
      "links.create",
      "requires the affiliate authorization flow (seller/creator consent)"
    );
  }
}

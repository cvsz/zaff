import { BasePlatformAdapter, hmacSha256Hex } from "./core.js";
import type {
  AdapterHttpDeps,
  CatalogItem,
  CatalogSearchResult,
  CallOptions,
  OrderPage,
} from "./types.js";
import { CapabilityNotImplementedError } from "./types.js";
import type { RegisteredPolicyEntry } from "./policy-registry.js";

const DEFAULT_BASE_URL = "https://partner.shopeemobile.com";

/**
 * Shopee OpenPlatform skeleton (ADT-1). Signed GET convention:
 * sign = HMAC_SHA256(partner_id + path + timestamp) keyed by partner key.
 * The registry declares no publishing capabilities for Shopee affiliate
 * partners, so publish attempts must fail as MISSING_CAPABILITY before any
 * network I/O.
 */
export class ShopeeAdapter extends BasePlatformAdapter {
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

  private signedParams(
    path: string,
    business: Record<string, string>,
    nowSeconds: number
  ): Record<string, string> {
    const partnerId = this.requireSecret("SHOPEE_PARTNER_ID");
    const partnerKey = this.requireSecret("SHOPEE_PARTNER_KEY");
    const base = `${partnerId}${path}${nowSeconds}`;
    const sign = hmacSha256Hex(partnerKey, base);
    return {
      partner_id: partnerId,
      timestamp: String(nowSeconds),
      sign,
      ...business,
    };
  }

  private assertEnvelope(body: unknown): Record<string, unknown> {
    const env = body as { error?: number | string; msg?: string; response?: unknown };
    const failed =
      (typeof env?.error === "number" && env.error !== 0) ||
      (typeof env?.error === "string" && env.error.length > 0);
    if (failed) {
      throw new Error(`shopee api error ${String(env.error)}: ${env.msg ?? ""}`);
    }
    return (env.response ?? {}) as Record<string, unknown>;
  }

  async searchCatalog(
    query: string,
    options?: CallOptions & { pageSize?: number }
  ): Promise<CatalogSearchResult> {
    this.assertCapability("catalog.read");
    const now = this.nowSeconds(options);
    const path = "/api/v2/product/search_items";
    const params = this.signedParams(
      path,
      {
        item_name: query,
        page_size: String(options?.pageSize ?? 20),
      },
      now
    );
    const url = this.buildUrl(path, params);
    const body = await this.requestJson(url, { method: "GET" });
    const data = this.assertEnvelope(body);
    const itemsRaw = Array.isArray(data.items) ? data.items : [];
    const items: CatalogItem[] = itemsRaw.map((raw) => {
      const it = raw as {
        item_id?: number | string;
        item_name?: string;
        price_min?: number;
        currency?: string;
      };
      return {
        externalId: String(it.item_id ?? ""),
        title: it.item_name ?? "",
        priceAmount: (it.price_min ?? 0) / 100000,
        currency: it.currency ?? "THB",
      };
    });
    return {
      items,
      cursor: typeof data.more === "boolean" ? String(data.more) : null,
    };
  }

  async listOrders(options?: CallOptions & { pageSize?: number }): Promise<OrderPage> {
    this.assertCapability("orders.read");
    const now = this.nowSeconds(options);
    const path = "/api/v2/order/get_order_list";
    const params = this.signedParams(
      path,
      { page_size: String(options?.pageSize ?? 20) },
      now
    );
    const url = this.buildUrl(path, params);
    const body = await this.requestJson(url, { method: "GET" });
    const data = this.assertEnvelope(body);
    const list = Array.isArray(data.order_list) ? data.order_list : [];
    return {
      orders: list.map((raw) => {
        const o = raw as {
          order_sn?: string;
          order_status?: string;
          total_amount?: number;
          currency?: string;
        };
        return {
          externalId: o.order_sn ?? "",
          status: o.order_status ?? "",
          amount: o.total_amount ?? 0,
          currency: o.currency ?? "THB",
        };
      }),
      cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    };
  }

  async getCommissions(options?: CallOptions): Promise<{
    rows: Array<{ orderId: string; commissionAmount: number; currency: string }>;
    cursor: string | null;
  }> {
    this.assertCapability("commissions.read");
    const now = this.nowSeconds(options);
    const path = "/api/v2/affiliate/commission_settlements";
    const params = this.signedParams(path, { page_size: "50" }, now);
    const url = this.buildUrl(path, params);
    const body = await this.requestJson(url, { method: "GET" });
    const data = this.assertEnvelope(body);
    const rowsRaw = Array.isArray(data.settlements) ? data.settlements : [];
    return {
      rows: rowsRaw.map((raw) => {
        const s = raw as {
          order_sn?: string;
          commission_amount?: number;
          currency?: string;
        };
        return {
          orderId: s.order_sn ?? "",
          commissionAmount: s.commission_amount ?? 0,
          currency: s.currency ?? "THB",
        };
      }),
      cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    };
  }

  async publishPost(_input: {
    text: string;
  }): Promise<never> {
    this.assertCapability("content.publish");
    throw new CapabilityNotImplementedError(
      this.id,
      "content.publish",
      "Shopee affiliate exposes no content publishing API"
    );
  }
}

import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { defaultPolicyRegistry } from "./policy-registry.js";
import { ShopeeAdapter } from "./shopee.js";
import { MissingCapabilityError } from "./types.js";

const SECRETS: Record<string, string> = {
  SHOPEE_PARTNER_ID: "1001234",
  SHOPEE_PARTNER_KEY: "super-secret-shopee-key",
};

const CANNED_SEARCH = {
  error: 0,
  msg: "ok",
  response: {
    items: [
      { item_id: 9001, item_name: "Silk Pillowcase", price_min: 29900000, currency: "THB" },
      { item_id: 9002, item_name: "LED Strip", price_min: 15000000, currency: "THB" },
    ],
    more: true,
  },
};

function mockFetch(body: unknown) {
  const impl = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return vi.fn(impl) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function makeAdapter(fetchFn: typeof fetch): ShopeeAdapter {
  return new ShopeeAdapter(defaultPolicyRegistry().get("shopee"), {
    fetch: fetchFn,
    getSecret: (name) => SECRETS[name],
  });
}

describe("ShopeeAdapter", () => {
  it("signs catalog search per partner conventions and parses results", async () => {
    const fetchFn = mockFetch(CANNED_SEARCH);
    const adapter = makeAdapter(fetchFn);
    const result = await adapter.searchCatalog("pillowcase", { now: 1750000000 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toContain(
      "https://partner.shopeemobile.com/api/v2/product/search_items?"
    );
    const params = new URL(url).searchParams;
    expect(params.get("partner_id")).toBe("1001234");
    expect(params.get("timestamp")).toBe("1750000000");
    const expectedSign = createHmac("sha256", SECRETS["SHOPEE_PARTNER_KEY"])
      .update(`1001234/api/v2/product/search_items1750000000`)
      .digest("hex");
    expect(params.get("sign")).toBe(expectedSign);

    expect(result.items).toEqual([
      { externalId: "9001", title: "Silk Pillowcase", priceAmount: 299, currency: "THB" },
      { externalId: "9002", title: "LED Strip", priceAmount: 150, currency: "THB" },
    ]);
    expect(result.cursor).toBe("true");
  });

  it("keeps signatures deterministic for a fixed clock", async () => {
    const fetchFn = mockFetch(CANNED_SEARCH);
    const adapter = makeAdapter(fetchFn);
    await adapter.listOrders({ now: 42 });
    await adapter.listOrders({ now: 42 });
    const [u1, u2] = fetchFn.mock.calls as Array<[string]>;
    expect(new URL(u1[0]).searchParams.get("sign")).toBe(
      new URL(u2[0]).searchParams.get("sign")
    );
  });

  it("surfaces non-zero envelope errors on HTTP 200", async () => {
    const fetchFn = mockFetch({ error: "error_param", msg: "bad param" });
    const adapter = makeAdapter(fetchFn);
    await expect(adapter.listOrders({ now: 1 })).rejects.toThrowError(
      /error_param/
    );
  });

  it("refuses publishing with MISSING_CAPABILITY and zero network I/O", async () => {
    const fetchFn = mockFetch({});
    const adapter = makeAdapter(fetchFn);
    const err = await adapter.publishPost({ text: "buy stuff" }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MissingCapabilityError);
    expect((err as MissingCapabilityError).code).toBe("MISSING_CAPABILITY");
    expect((err as MissingCapabilityError).capability).toBe("content.publish");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never leaks the partner key into outbound request arguments", async () => {
    const fetchFn = mockFetch(CANNED_SEARCH);
    const adapter = makeAdapter(fetchFn);
    await adapter.searchCatalog("x", { now: 1750000000 });
    const serialized = JSON.stringify(fetchFn.mock.calls);
    expect(serialized).not.toContain(SECRETS["SHOPEE_PARTNER_KEY"]);
  });
});

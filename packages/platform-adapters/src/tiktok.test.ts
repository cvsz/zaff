import { describe, expect, it, vi } from "vitest";
import { defaultPolicyRegistry } from "./policy-registry.js";
import { TikTokShopAdapter } from "./tiktok.js";
import {
  CapabilityNotImplementedError,
  MissingCapabilityError,
} from "./types.js";

const SECRETS: Record<string, string> = {
  TIKTOK_APP_KEY: "test-app-key",
  TIKTOK_APP_SECRET: "super-secret-app-secret-value",
  TIKTOK_ACCESS_TOKEN: "test-access-token",
};

const CANNED_SEARCH = {
  code: 0,
  message: "success",
  data: {
    products: [
      {
        product_id: "p1",
        product_name: "Wireless Earbuds",
        price: { amount: 1299, currency: "THB" },
      },
      {
        product_id: "p2",
        product_name: "Phone Case",
        price: { amount: 199, currency: "THB" },
      },
    ],
    cursor: "next-1",
  },
};

function mockFetch(
  body: unknown,
  opts?: { status?: number; headers?: Record<string, string> }
) {
  const impl = async () =>
    new Response(JSON.stringify(body), {
      status: opts?.status ?? 200,
      headers: { "content-type": "application/json", ...opts?.headers },
    });
  return vi.fn(impl) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function makeAdapter(fetchFn: typeof fetch): TikTokShopAdapter {
  return new TikTokShopAdapter(defaultPolicyRegistry().get("tiktok-shop"), {
    fetch: fetchFn,
    getSecret: (name) => SECRETS[name],
  });
}

describe("TikTokShopAdapter", () => {
  it("shapes signed catalog search requests and parses results", async () => {
    const fetchFn = mockFetch(CANNED_SEARCH);
    const adapter = makeAdapter(fetchFn);
    const result = await adapter.searchCatalog("earbuds", { now: 1750000000 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toContain("https://open-api.tiktokglobalshop.com/product/search?");
    const params = new URL(url).searchParams;
    expect(params.get("app_key")).toBe("test-app-key");
    expect(params.get("timestamp")).toBe("1750000000");
    expect(params.get("query")).toBe("earbuds");
    expect(params.get("sign")).toMatch(/^[0-9a-f]{64}$/);

    expect(result.items).toEqual([
      { externalId: "p1", title: "Wireless Earbuds", priceAmount: 1299, currency: "THB" },
      { externalId: "p2", title: "Phone Case", priceAmount: 199, currency: "THB" },
    ]);
    expect(result.cursor).toBe("next-1");
  });

  it("produces deterministic signatures for a fixed clock", async () => {
    const fetchFn = mockFetch(CANNED_SEARCH);
    const adapter = makeAdapter(fetchFn);
    await adapter.searchCatalog("x", { now: 1750000000 });
    await adapter.searchCatalog("x", { now: 1750000000 });
    await adapter.searchCatalog("x", { now: 1750000060 });

    const [u1, u2, u3] = fetchFn.mock.calls as Array<[string]>;
    const s1 = new URL(u1[0]).searchParams.get("sign");
    const s2 = new URL(u2[0]).searchParams.get("sign");
    const s3 = new URL(u3[0]).searchParams.get("sign");
    expect(s1).toBe(s2);
    expect(s3).not.toBe(s1);
  });

  it("surfaces non-zero API envelope codes even on HTTP 200", async () => {
    const fetchFn = mockFetch({ code: 105, message: "signature mismatch" });
    const adapter = makeAdapter(fetchFn);
    await expect(adapter.searchCatalog("x", { now: 1 })).rejects.toThrowError(
      /tiktok shop api error 105/
    );
  });

  it("gates undeclared capabilities before any network I/O", async () => {
    const fetchFn = mockFetch({});
    const adapter = makeAdapter(fetchFn);
    await expect(adapter.publishImage({ imageUrl: "https://x/y.png" })).rejects.toMatchObject({
      code: "MISSING_CAPABILITY",
      capability: "image.publish",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports links.create as declared-but-not-implemented without fetching", async () => {
    const fetchFn = mockFetch({});
    const adapter = makeAdapter(fetchFn);
    const err = await adapter.createAffiliateLink({ productId: "p1" }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CapabilityNotImplementedError);
    expect((err as CapabilityNotImplementedError).code).toBe(
      "CAPABILITY_NOT_IMPLEMENTED"
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never leaks the signing secret into any outbound request argument", async () => {
    const fetchFn = mockFetch(CANNED_SEARCH);
    const adapter = makeAdapter(fetchFn);
    await adapter.searchCatalog("x", { now: 1750000000 });
    const serialized = JSON.stringify(fetchFn.mock.calls);
    expect(serialized).not.toContain(SECRETS["TIKTOK_APP_SECRET"]);
  });
});

describe("capability error types", () => {
  it("distinguishes missing vs not-implemented errors", () => {
    expect(new MissingCapabilityError("p", "webhooks")).toBeInstanceOf(Error);
    expect(new MissingCapabilityError("p", "webhooks").code).toBe(
      "MISSING_CAPABILITY"
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { defaultPolicyRegistry } from "./policy-registry.js";
import { MetaAdapter } from "./meta.js";
import {
  MissingCapabilityError,
  NotImplementedError,
} from "./types.js";

const TOKEN = "test-page-access-token";

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

function makeAdapter(fetchFn: typeof fetch): MetaAdapter {
  return new MetaAdapter(defaultPolicyRegistry().get("meta"), {
    fetch: fetchFn,
    getSecret: (name) => (name === "META_PAGE_ACCESS_TOKEN" ? TOKEN : undefined),
  });
}

describe("MetaAdapter", () => {
  it("publishes page posts via the Graph API with bearer auth", async () => {
    const fetchFn = mockFetch({ id: "post_1" });
    const adapter = makeAdapter(fetchFn);
    const result = await adapter.publishPost("page-1", "New drop!", {
      now: 1750000000,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/page-1/feed");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ message: "New drop!" });
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({ externalId: "post_1" });
  });

  it("keeps the access token out of request URLs", async () => {
    const fetchFn = mockFetch({ id: "photo_1", post_id: "post_9" });
    const adapter = makeAdapter(fetchFn);
    const result = await adapter.publishPhoto("page-1", "https://cdn/x.png", "cap");

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(TOKEN);
    expect(url).toContain("/page-1/photos");
    expect(result.externalId).toBe("post_9");
  });

  it("parses insights into a flat metric record", async () => {
    const fetchFn = mockFetch({
      data: [
        { name: "impressions", values: [{ value: 1200 }] },
        { name: "clicks", values: [{ value: 34 }] },
      ],
    });
    const adapter = makeAdapter(fetchFn);
    const result = await adapter.getInsights("post_1", "impressions,clicks");
    expect(result.metrics).toEqual({ impressions: 1200, clicks: 34 });
  });

  it("maps HTTP failures to AdapterHttpError", async () => {
    const fetchFn = mockFetch({ error: { message: "boom" } }, { status: 500 });
    const adapter = makeAdapter(fetchFn);
    await expect(adapter.publishPost("page-1", "x")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 500,
    });
  });

  it("throws typed NOT_IMPLEMENTED for token exchange without any fetch", async () => {
    const fetchFn = mockFetch({});
    const adapter = makeAdapter(fetchFn);
    const err = await adapter
      .exchangeLongLivedToken({ shortLivedToken: "short" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotImplementedError);
    expect((err as NotImplementedError).code).toBe("NOT_IMPLEMENTED");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("gates video publishing (undeclared for meta) before any fetch", async () => {
    const fetchFn = mockFetch({});
    const adapter = makeAdapter(fetchFn);
    const err = await adapter
      .publishVideo({ videoUrl: "https://x/v.mp4", description: "d" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingCapabilityError);
    expect((err as MissingCapabilityError).capability).toBe("video.publish");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails fast when the page token secret is absent", async () => {
    const fetchFn = mockFetch({});
    const adapter = new MetaAdapter(defaultPolicyRegistry().get("meta"), {
      fetch: fetchFn,
      getSecret: () => undefined,
    });
    await expect(adapter.publishPost("page-1", "x")).rejects.toThrowError(
      /missing required secret/
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("MetaAdapter capability surface", () => {
  it("declares exactly the registry capabilities", () => {
    const adapter = makeAdapter(mockFetch({}));
    expect(adapter.capabilities()).toEqual([
      "content.publish",
      "image.publish",
      "analytics.read",
      "webhooks",
    ]);
    expect(adapter.policyVersion).toBe("2026-06");
  });
});

import { describe, expect, it, vi } from "vitest";
import { defaultPolicyRegistry } from "./policy-registry.js";
import { YouTubeAdapter } from "./youtube.js";
import { QuotaExceededError } from "./types.js";

const TOKEN = "test-youtube-token";

function makeAdapter(
  fetchFn: typeof fetch,
  quotaLimit?: number
): YouTubeAdapter {
  const adapter = new YouTubeAdapter(defaultPolicyRegistry().get("youtube"), {
    fetch: fetchFn,
    getSecret: (name) => (name === "YOUTUBE_ACCESS_TOKEN" ? TOKEN : undefined),
  });
  if (quotaLimit !== undefined) {
    adapter.quotaLimit = quotaLimit;
  }
  return adapter;
}

describe("YouTubeAdapter", () => {
  it("initiates a resumable upload with documented shape and returns the session URL", async () => {
    const sessionUrl = "https://www.googleapis.com/upload/session/abc";
    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { location: sessionUrl },
        })
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const adapter = makeAdapter(fetchFn);

    const bytes = new Uint8Array(2048);
    const session = await adapter.initiateVideoUpload(
      { title: "Demo", description: "d", privacyStatus: "private" },
      bytes.byteLength,
      { quotaPeriodKey: 1 }
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/upload/youtube/v3/videos");
    expect(url).toContain("uploadType=resumable");
    expect(url).toContain("part=snippet%2Cstatus");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Upload-Content-Length"]).toBe("2048");
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    const payload = JSON.parse(String(init.body));
    expect(payload.snippet.title).toBe("Demo");
    expect(payload.status).toEqual({ privacyStatus: "private" });
    expect(session.uploadUrl).toBe(sessionUrl);
    expect(adapter.quotaConsumed()).toBe(1600);
  });

  it("completes the upload with PUT bytes and parses the video id", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "vid_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const adapter = makeAdapter(fetchFn);
    const result = await adapter.uploadBytes(
      "https://www.googleapis.com/upload/session/abc",
      new Uint8Array(10)
    );
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(result).toEqual({ externalId: "vid_123" });
  });

  it("enforces the daily quota window and resets on a new period key", async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { location: "https://x/session" },
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const adapter = makeAdapter(fetchFn, 3200);

    await adapter.initiateVideoUpload(
      { title: "a", description: "" },
      100,
      { quotaPeriodKey: 1 }
    );
    await adapter.initiateVideoUpload(
      { title: "b", description: "" },
      100,
      { quotaPeriodKey: 1 }
    );
    await expect(
      adapter.initiateVideoUpload({ title: "c", description: "" }, 100, {
        quotaPeriodKey: 1,
      })
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    const err = await adapter
      .initiateVideoUpload({ title: "c", description: "" }, 100, {
        quotaPeriodKey: 2,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeNull();
    expect(adapter.quotaConsumed()).toBe(1600);

    expect(new QuotaExceededError("youtube", 1600, 0, 1600).code).toBe(
      "QUOTA_EXCEEDED"
    );
  });

  it("parses channel statistics from string-encoded numbers", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "UC123",
                statistics: {
                  subscriberCount: "1500",
                  viewCount: "98765",
                  videoCount: "42",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const adapter = makeAdapter(fetchFn);
    const stats = await adapter.fetchChannelStatistics({ quotaPeriodKey: 7 });
    expect(stats).toEqual({
      channelId: "UC123",
      subscriberCount: 1500,
      viewCount: 98765,
      videoCount: 42,
    });
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toContain("/youtube/v3/channels");
    expect(url).toContain("part=statistics");
    expect(adapter.quotaConsumed()).toBe(1);
  });

  it("never leaks the access token into request URLs", async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { location: "https://x/s" },
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const adapter = makeAdapter(fetchFn);
    await adapter.initiateVideoUpload(
      { title: "t", description: "" },
      5,
      { quotaPeriodKey: 3 }
    );
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).not.toContain(TOKEN);
  });
});

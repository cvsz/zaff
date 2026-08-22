import { BasePlatformAdapter } from "./core.js";
import type {
  AdapterHttpDeps,
  CallOptions,
  PublishResult,
} from "./types.js";
import { QuotaExceededError, NotImplementedError } from "./types.js";
import type { RegisteredPolicyEntry } from "./policy-registry.js";

const DEFAULT_BASE_URL = "https://www.googleapis.com";

const QUOTA_COST_PER_UNIT: Record<string, number> = {
  "videos.insert": 1600,
  "videos.list": 1,
  "channels.list": 1,
};

export interface YouTubeVideoMetadata {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: "private" | "unlisted" | "public";
}

export interface ResumableSession {
  uploadUrl: string;
}

export interface ChannelStatistics {
  channelId: string;
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
}

/**
 * YouTube Data API v3 skeleton (ADT-1). Video publishing follows the
 * resumable-upload shape (initiate → PUT bytes). Quota accounting is
 * in-instance against a caller-supplied period key (e.g. Pacific-midnight
 * epoch day) so tests can drive resets deterministically without fake timers.
 */
export class YouTubeAdapter extends BasePlatformAdapter {
  quotaLimit = 10000;

  private quotaPeriodKey: number | null = null;
  private quotaUsed = 0;

  constructor(entry: RegisteredPolicyEntry, http: AdapterHttpDeps) {
    super(entry, http);
  }

  protected override defaultBaseUrl(): string {
    return DEFAULT_BASE_URL;
  }

  private authHeaders(): Record<string, string> {
    const token = this.secret("YOUTUBE_ACCESS_TOKEN");
    if (!token) {
      throw new Error("missing required secret: YOUTUBE_ACCESS_TOKEN");
    }
    return { Authorization: `Bearer ${token}` };
  }

  checkQuota(operation: keyof typeof QUOTA_COST_PER_UNIT | string, periodKey: number): void {
    if (periodKey !== this.quotaPeriodKey) {
      this.quotaPeriodKey = periodKey;
      this.quotaUsed = 0;
    }
    const cost = QUOTA_COST_PER_UNIT[operation] ?? 1;
    if (this.quotaUsed + cost > this.quotaLimit) {
      throw new QuotaExceededError(
        this.id,
        cost,
        this.quotaUsed,
        this.quotaLimit
      );
    }
    this.quotaUsed += cost;
  }

  quotaConsumed(): number {
    return this.quotaUsed;
  }

  async initiateVideoUpload(
    metadata: YouTubeVideoMetadata,
    byteLength: number,
    options?: CallOptions & { contentType?: string; quotaPeriodKey?: number }
  ): Promise<ResumableSession> {
    this.assertCapability("video.publish");
    this.checkQuota("videos.insert", options?.quotaPeriodKey ?? 0);
    const url = this.buildUrl("/upload/youtube/v3/videos", {
      uploadType: "resumable",
      part: "snippet,status",
    });
    const res = await this.request(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(byteLength),
        "X-Upload-Content-Type": options?.contentType ?? "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags ?? [],
        },
        status: { privacyStatus: metadata.privacyStatus ?? "private" },
      }),
    });
    const uploadUrl = res.headers.get("location");
    if (!uploadUrl) {
      throw new NotImplementedError(
        this.id,
        "initiate_video_upload",
        "resumable session response missing Location header"
      );
    }
    return { uploadUrl };
  }

  async uploadBytes(
    uploadUrl: string,
    bytes: Uint8Array,
    options?: CallOptions & { contentType?: string }
  ): Promise<PublishResult> {
    this.assertCapability("video.publish");
    const body = await this.requestJson(uploadUrl, {
      method: "PUT",
      headers: {
        ...this.authHeaders(),
        "Content-Type": options?.contentType ?? "video/mp4",
        "Content-Length": String(bytes.byteLength),
      },
      body: bytes as unknown as RequestInit["body"],
    });
    const data = body as { id?: string };
    return { externalId: data.id ?? "" };
  }

  async fetchChannelStatistics(
    options?: CallOptions & { quotaPeriodKey?: number }
  ): Promise<ChannelStatistics> {
    this.assertCapability("analytics.read");
    this.checkQuota("channels.list", options?.quotaPeriodKey ?? 0);
    const url = this.buildUrl("/youtube/v3/channels", {
      part: "statistics",
      mine: "true",
    });
    const body = await this.requestJson(url, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const data = body as {
      items?: Array<{
        id?: string;
        statistics?: {
          subscriberCount?: string;
          viewCount?: string;
          videoCount?: string;
        };
      }>;
    };
    const item = data.items?.[0];
    return {
      channelId: item?.id ?? "",
      subscriberCount: Number(item?.statistics?.subscriberCount ?? 0),
      viewCount: Number(item?.statistics?.viewCount ?? 0),
      videoCount: Number(item?.statistics?.videoCount ?? 0),
    };
  }
}

import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { logRequest, pathnameOnly, requestLogMiddleware } from "./request-log.js";

class MemorySink {
  lines: string[] = [];
  write(chunk: string): void {
    this.lines.push(chunk.toString());
  }
}

function sinkLogger() {
  const sink = new MemorySink();
  return { logger: createLogger({ name: "req-test", level: "info", stream: sink }), sink };
}

describe("pathnameOnly", () => {
  it("strips query strings", () => {
    expect(pathnameOnly("/health")).toBe("/health");
    expect(pathnameOnly("/go/abc?token=secret")).toBe("/go/abc");
    expect(pathnameOnly("/a/b?x=1&y=2")).toBe("/a/b");
  });
});

describe("logRequest", () => {
  it("emits parseable JSON with required fields", () => {
    const { logger, sink } = sinkLogger();
    const requestId = logRequest(logger, {
      method: "GET",
      url: "/health",
      status: 200,
      durationMs: 1.2345,
    });
    expect(sink.lines).toHaveLength(1);
    const entry = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(entry["msg"]).toBe("request");
    expect(entry["method"]).toBe("GET");
    expect(entry["url"]).toBe("/health");
    expect(entry["status"]).toBe(200);
    expect(typeof entry["durationMs"]).toBe("number");
    expect(entry["requestId"]).toBe(requestId);
  });

  it("passes through an existing requestId", () => {
    const { logger, sink } = sinkLogger();
    logRequest(logger, {
      method: "POST",
      url: "/auth/login",
      status: 401,
      durationMs: 12,
      requestId: "req-fixed-123",
    });
    const entry = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(entry["requestId"]).toBe("req-fixed-123");
  });

  it("generates a unique requestId when absent", () => {
    const { logger } = sinkLogger();
    const idA = logRequest(logger, { method: "GET", url: "/a", status: 200, durationMs: 1 });
    const idB = logRequest(logger, { method: "GET", url: "/b", status: 200, durationMs: 1 });
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never logs query strings", () => {
    const { logger, sink } = sinkLogger();
    logRequest(logger, {
      method: "GET",
      url: "/go/x?sessionToken=super-secret",
      status: 302,
      durationMs: 2,
    });
    const rawLine = sink.lines[0]!;
    expect(rawLine).not.toContain("super-secret");
    expect(rawLine).not.toContain("sessionToken=");
    const entry = JSON.parse(rawLine) as Record<string, unknown>;
    expect(entry["url"]).toBe("/go/x");
  });
});

describe("requestLogMiddleware", () => {
  it("returns a function that logs requests against the bound logger", () => {
    const { logger, sink } = sinkLogger();
    const middleware = requestLogMiddleware(logger);
    middleware({ method: "PUT", url: "/x", status: 204, durationMs: 3 });
    const entry = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(entry["method"]).toBe("PUT");
    expect(entry["status"]).toBe(204);
  });
});

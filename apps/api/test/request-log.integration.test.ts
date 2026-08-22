import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createLogger } from "@zaff/observability";
import { startServer } from "../src/server.js";

class MemorySink {
  lines: string[] = [];
  write(chunk: string): void {
    this.lines.push(chunk.toString());
  }
}

let server: Server;
let baseUrl: string;
let sink: MemorySink;

beforeAll(async () => {
  sink = new MemorySink();
  const logger = createLogger({ name: "api-test", level: "info", stream: sink });
  server = await startServer(0, { logger });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unexpected server address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function parseEntries(): Array<Record<string, unknown>> {
  return sink.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["msg"] === "request");
}

describe("request logging", () => {
  it("logs one structured entry per request without query strings", async () => {
    const response = await fetch(`${baseUrl}/health?secret=hunter2`);
    expect(response.status).toBe(200);

    const entries = parseEntries().filter((entry) => entry["url"] === "/health");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0]!;
    expect(entry["method"]).toBe("GET");
    expect(entry["status"]).toBe(200);
    expect(typeof entry["durationMs"]).toBe("number");
    expect(entry["requestId"]).toMatch(/^[0-9a-f-]{36}$/);

    const raw = JSON.stringify(entries);
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("secret=");
  });

  it("propagates an inbound x-request-id", async () => {
    await fetch(`${baseUrl}/nope`, { headers: { "x-request-id": "req-abc-42" } });
    const entries = parseEntries().filter((entry) => entry["url"] === "/nope");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!["requestId"]).toBe("req-abc-42");
    expect(entries[0]!["status"]).toBe(404);
  });
});

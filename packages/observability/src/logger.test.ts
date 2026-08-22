import { describe, expect, it } from "vitest";
import { createLogger, REDACTED, REDACTION_PATHS } from "./logger.js";

class MemorySink {
  lines: string[] = [];
  write(chunk: string): void {
    this.lines.push(chunk.toString());
  }
}

function sinkLogger(name = "test") {
  const sink = new MemorySink();
  const logger = createLogger({ name, level: "info", stream: sink });
  return { logger, sink };
}

describe("createLogger", () => {
  it("emits parseable JSON lines with name and level", () => {
    const { logger, sink } = sinkLogger("unit");
    logger.info("hello");
    expect(sink.lines).toHaveLength(1);
    const entry = JSON.parse(sink.lines[0]!) as { level: number; name: string; msg: string };
    expect(entry.name).toBe("unit");
    expect(entry.msg).toBe("hello");
    expect(entry.level).toBe(30);
  });

  it("redacts sensitive top-level fields", () => {
    const { logger, sink } = sinkLogger();
    logger.info({
      password: "hunter2",
      token: "tok_123",
      sessionToken: "sess_456",
      cookie: "a=b",
      authorization: "Bearer xyz",
      "set-cookie": "sid=1",
      safe: "visible",
    });
    const entry = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(entry["password"]).toBe(REDACTED);
    expect(entry["token"]).toBe(REDACTED);
    expect(entry["sessionToken"]).toBe(REDACTED);
    expect(entry["cookie"]).toBe(REDACTED);
    expect(entry["authorization"]).toBe(REDACTED);
    expect(entry["set-cookie"]).toBe(REDACTED);
    expect(entry["safe"]).toBe("visible");
  });

  it("redacts nested fields up to three levels deep", () => {
    const { logger, sink } = sinkLogger();
    logger.info({
      user: { password: "pw", profile: { token: "deep-tok" } },
      req: { headers: { authorization: "Bearer zzz" } },
    });
    const entry = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    const user = entry["user"] as Record<string, unknown>;
    const deep = user["profile"] as Record<string, unknown>;
    const headers = (entry["req"] as Record<string, Record<string, unknown>>)["headers"];
    expect(user["password"]).toBe(REDACTED);
    expect(deep["token"]).toBe(REDACTED);
    expect(headers["authorization"]).toBe(REDACTED);
  });

  it("declares the required redaction paths", () => {
    for (const field of ["password", "token", "sessionToken", "cookie", "authorization", "set-cookie"]) {
      expect(REDACTION_PATHS).toContain(field);
    }
  });
});

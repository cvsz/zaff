import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import postgres from "postgres";
import { createDb } from "@zaff/db";
import { resolveAuthService } from "../src/bootstrap.js";
import { startServer } from "../src/server.js";

const DEV_DB_URL =
  process.env.ZAFF_TEST_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff";

let dbAvailable = true;
try {
  const probe = postgres(DEV_DB_URL, { connect_timeout: 3, max: 1 });
  await probe`SELECT 1`;
  await probe.end();
} catch {
  dbAvailable = false;
}

describe("api production wiring (index.ts parity)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const authService = resolveAuthService({ DATABASE_URL: DEV_DB_URL });
    const db = createDb(DEV_DB_URL);
    server = await startServer(0, {
      logger: undefined,
      authService,
      linkRoutes: { db, authService, clickSalt: "prod-wiring-test-salt" },
      campaignRoutes: { db, authService },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!dbAvailable)(
    "clicks endpoint requires auth (401), not service_unavailable (503)",
    async () => {
      const response = await fetch(
        `${baseUrl}/orgs/${randomUUID()}/links/${randomUUID()}/clicks`
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).not.toBe("service_unavailable");
    }
  );

  it.skipIf(!dbAvailable)("health endpoint responds", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import postgres from "postgres";
import { AuthService } from "@zaff/auth";
import {
  DevSecretError,
  assertNoDevSecrets,
  findDevSecretViolations,
  resolveAuthService,
} from "../src/bootstrap.js";
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

describe("findDevSecretViolations", () => {
  it("flags unset and dev-default secrets in production", () => {
    const violations = findDevSecretViolations(
      {
        NODE_ENV: "production",
      },
      "production"
    );
    expect(violations.some((v) => v.startsWith("OAUTH_STATE_SECRET"))).toBe(true);
    expect(violations.some((v) => v.startsWith("STORAGE_SIGNING_SECRET"))).toBe(true);
  });

  it("flags dev-default values explicitly set in production", () => {
    const violations = findDevSecretViolations(
      {
        NODE_ENV: "production",
        OAUTH_STATE_SECRET: "zaff_dev_state_secret_change_me",
        STORAGE_SIGNING_SECRET: "zaff_dev_signing_secret_change_me",
      },
      "production"
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.includes("dev-default"))).toBe(true);
  });

  it("passes in production with real secrets", () => {
    expect(
      findDevSecretViolations(
        {
          NODE_ENV: "production",
          OAUTH_STATE_SECRET: "a-real-64-byte-secret-value",
          STORAGE_SIGNING_SECRET: "another-real-secret-value",
        },
        "production"
      )
    ).toEqual([]);
  });

  it("does not flag dev secrets outside production", () => {
    expect(
      findDevSecretViolations(
        { NODE_ENV: "development", OAUTH_STATE_SECRET: "zaff_dev_state_secret_change_me" },
        "development"
      )
    ).toEqual([]);
    expect(findDevSecretViolations({}, undefined)).toEqual([]);
  });
});

describe("assertNoDevSecrets", () => {
  it("throws DevSecretError listing violations in production", () => {
    try {
      assertNoDevSecrets({ NODE_ENV: "production" }, "production");
      expect.unreachable("expected DevSecretError");
    } catch (error) {
      expect(error).toBeInstanceOf(DevSecretError);
      expect((error as DevSecretError).violations.length).toBeGreaterThan(0);
      expect((error as Error).message).toContain("OAUTH_STATE_SECRET");
    }
  });

  it("does not throw in development with dev defaults", () => {
    expect(() =>
      assertNoDevSecrets(
        { NODE_ENV: "development", OAUTH_STATE_SECRET: "zaff_dev_state_secret_change_me" },
        "development"
      )
    ).not.toThrow();
  });
});

describe("resolveAuthService", () => {
  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => resolveAuthService({})).toThrow(/DATABASE_URL/);
  });

  it.skipIf(!dbAvailable)("builds an AuthService from DATABASE_URL", () => {
    const authService = resolveAuthService({ DATABASE_URL: DEV_DB_URL });
    expect(authService).toBeInstanceOf(AuthService);
  });
});

describe("api prod wiring smoke", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const authService = resolveAuthService({ DATABASE_URL: DEV_DB_URL });
    server = await startServer(0, { authService });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!dbAvailable)(
    "registers auth routes on a bare wired server (not 404/503)",
    async () => {
      const noCsrf = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgName: "X", email: "x@x.test", password: "password-123" }),
      });
      expect(noCsrf.status).toBe(403);

      const badBody = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "x-requested-with": "zaff", "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      });
      expect(badBody.status).toBe(400);

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
    }
  );
});

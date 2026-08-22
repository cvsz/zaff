import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import postgres from "postgres";
import { AuthService, hashPassword } from "@zaff/auth";
import { createDb, createUser, listAuditEvents, migrateUp } from "@zaff/db";
import { startServer } from "../src/server.js";

const TEST_URL =
  process.env.ZAFF_TEST_DATABASE_URL ??
  "postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff";

let dbAvailable = true;
try {
  const probe = postgres(TEST_URL, { connect_timeout: 3, max: 1 });
  await probe`SELECT 1`;
  await probe.end();
} catch {
  dbAvailable = false;
}

const suite = describe.skipIf(!dbAvailable);

function csrfHeaders(): Record<string, string> {
  return { "x-requested-with": "zaff", "content-type": "application/json" };
}

interface Jar {
  cookie?: string;
}

suite("apps/api auth http", () => {
  const db = createDb(TEST_URL);
  const authService = new AuthService(db);

  let server: Server;
  let baseUrl: string;

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS clicks, audit_log, sessions, users, organizations, schema_migrations CASCADE"
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);
    server = await startServer(0, { authService });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
  });

  it("rejects register without the CSRF header", async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgName: "X", email: "x@x.test", password: "password-123" }),
    });
    expect(response.status).toBe(403);
  });

  it("registers an org and owner", async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ orgName: "HTTP Org A", email: "owner@a.test", password: "owner-pass-123" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { user: { role: string; email: string } };
    expect(body.user.role).toBe("owner");
    expect(JSON.stringify(body)).not.toContain("owner-pass-123");
  });

  it("logs in, sets an httpOnly session cookie, and serves /auth/me", async () => {
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email: "owner@a.test", password: "owner-pass-123" }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    const jar: Jar = { cookie: setCookie.split(";")[0] };

    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: jar.cookie ?? "" },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string } };
    expect(body.user.email).toBe("owner@a.test");

    const noCookie = await fetch(`${baseUrl}/auth/me`);
    expect(noCookie.status).toBe(401);
  });

  it("lists org users for member+ of the same org only", async () => {
    const orgId = await getOrgIdByEmail("owner@a.test");
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email: "owner@a.test", password: "owner-pass-123" }),
    });
    const jar: Jar = { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };

    const ok = await fetch(`${baseUrl}/orgs/${orgId}/users`, {
      headers: { cookie: jar.cookie ?? "" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { users: { email: string }[] };
    expect(body.users.some((u) => u.email === "owner@a.test")).toBe(true);

    const viewerEmail = `viewer-${Date.now()}@a.test`;
    await createUser(db, {
      orgId,
      email: viewerEmail,
      role: "viewer",
      passwordHash: await hashPassword("viewer-pass-123"),
    });
    const viewerLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email: viewerEmail, password: "viewer-pass-123" }),
    });
    expect(viewerLogin.status).toBe(200);
    const viewerJar: Jar = { cookie: (viewerLogin.headers.get("set-cookie") ?? "").split(";")[0] };
    const forbidden = await fetch(`${baseUrl}/orgs/${orgId}/users`, {
      headers: { cookie: viewerJar.cookie ?? "" },
    });
    expect(forbidden.status).toBe(403);

    const auditDenied = await fetch(`${baseUrl}/audit?orgId=${orgId}`, {
      headers: { cookie: viewerJar.cookie ?? "" },
    });
    expect(auditDenied.status).toBe(403);
  });

  it("denies cross-org access to users and audit", async () => {
    await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ orgName: "HTTP Org B", email: "owner@b.test", password: "b-pass-12345" }),
    });
    const loginB = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email: "owner@b.test", password: "b-pass-12345" }),
    });
    const jarB: Jar = { cookie: (loginB.headers.get("set-cookie") ?? "").split(";")[0] };
    const orgA = await getOrgIdByEmail("owner@a.test");

    const users = await fetch(`${baseUrl}/orgs/${orgA}/users`, {
      headers: { cookie: jarB.cookie ?? "" },
    });
    expect(users.status).toBe(403);

    const audit = await fetch(`${baseUrl}/audit?orgId=${orgA}`, {
      headers: { cookie: jarB.cookie ?? "" },
    });
    expect(audit.status).toBe(403);
  });

  it("allows admin+ to read audit with recorded auth events", async () => {
    const orgA = await getOrgIdByEmail("owner@a.test");
    const failedLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email: "owner@a.test", password: "definitely-wrong" }),
    });
    expect(failedLogin.status).toBe(401);
    expect(await failedLogin.text()).toContain("invalid email or password");

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ email: "owner@a.test", password: "owner-pass-123" }),
    });
    const jar: Jar = { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
    const response = await fetch(`${baseUrl}/audit?orgId=${orgA}`, {
      headers: { cookie: jar.cookie ?? "" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: { action: string }[] };
    const actions = body.events.map((e) => e.action);
    for (const expected of ["user.registered", "auth.login", "auth.login_failed"]) {
      expect(actions).toContain(expected);
    }
    expect(JSON.stringify(body)).not.toContain("definitely-wrong");
    expect(JSON.stringify(body)).not.toContain("owner-pass-123");

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { ...csrfHeaders(), cookie: jar.cookie ?? "" },
    });
    expect(logout.status).toBe(200);
    const meAfter = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: jar.cookie ?? "" },
    });
    expect(meAfter.status).toBe(401);
    const events = await listAuditEvents(db, orgA);
    expect(events.some((e) => e.action === "auth.logout")).toBe(true);
  });

  it("rate limits /auth/login per ip returning 429", async () => {
    const limitedServer = await startServer(0, {
      authService,
      loginRateLimit: { windowMs: 60_000, max: 3 },
    });
    try {
      const address = limitedServer.address();
      if (!address || typeof address === "string") throw new Error("unexpected address");
      const url = `http://127.0.0.1:${address.port}`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${url}/auth/login`, {
          method: "POST",
          headers: csrfHeaders(),
          body: JSON.stringify({ email: "owner@a.test", password: "wrong-on-purpose" }),
        });
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    }
  });

  it("health endpoint still works alongside auth routes", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  async function getOrgIdByEmail(email: string): Promise<string> {
    const rows = await db`SELECT org_id AS "orgId" FROM users WHERE email = ${email}`;
    return (rows[0] as { orgId: string }).orgId;
  }
});

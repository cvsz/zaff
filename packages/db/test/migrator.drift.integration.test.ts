import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  MigrationDriftError,
  createDb,
  migrateUp,
} from "../src/index.js";

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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

suite("packages/db migration drift detection", () => {
  const db = createDb(TEST_URL);

  async function resetSchema(): Promise<void> {
    await db.unsafe(
      "DROP TABLE IF EXISTS clicks, audit_log, sessions, users, organizations, user_identities, schema_migrations CASCADE"
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await resetSchema();
    await migrateUp(db);
    await db.end();
  });

  it("applies migrations and passes drift check on a matching shape", async () => {
    const first = await migrateUp(db);
    expect(first.length).toBeGreaterThan(0);
    const second = await migrateUp(db);
    expect(second).toEqual([]);
  });

  it("records the applied schema shape", async () => {
    const rows = await db`
      SELECT schema_shape FROM schema_migrations WHERE schema_shape IS NOT NULL LIMIT 1
    `;
    const shape = (rows[0] as { schema_shape: string }).schema_shape;
    expect(shape).toContain("organizations\tname\ttext");
    expect(shape).toContain("users\temail\ttext");
  });

  it("throws MigrationDriftError when a column is manually dropped", async () => {
    await db.unsafe("ALTER TABLE organizations DROP COLUMN name");
    let divergences: string[] = [];
    try {
      await migrateUp(db);
      expect.unreachable("expected MigrationDriftError");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationDriftError);
      divergences = (error as MigrationDriftError).divergences;
    }
    expect(divergences).toContain("column missing: organizations.name");
  });

  it("recovers once the divergence is repaired", async () => {
    await db.unsafe("ALTER TABLE organizations ADD COLUMN name text");
    const applied = await migrateUp(db);
    expect(applied).toEqual([]);
  });
});

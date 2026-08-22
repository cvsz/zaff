import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

export interface ParsedMigration {
  up: string;
  down: string;
}

export interface Migration extends ParsedMigration {
  name: string;
}

const UP_MARKER = /--\s*migrate:up[^\n]*\n/i;
const DOWN_MARKER = /--\s*migrate:down[^\n]*\n/i;

export function parseMigration(source: string): ParsedMigration {
  const upMatch = UP_MARKER.exec(source);
  if (!upMatch) {
    throw new Error("migration is missing a '-- migrate:up' section");
  }
  const downMatch = DOWN_MARKER.exec(source);
  const upEnd = downMatch ? downMatch.index : source.length;
  const up = source.slice(upMatch.index + upMatch[0].length, upEnd).trim();
  let down = "";
  if (downMatch) {
    down = source
      .slice(downMatch.index + downMatch[0].length)
      .trim();
  }
  return { up, down };
}

export function loadMigrationsFromDir(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((name) => ({
    name,
    ...parseMigration(readFileSync(`${dir}/${name}`, "utf8")),
  }));
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

export interface SchemaShape {
  [table: string]: { [column: string]: string };
}

export class MigrationDriftError extends Error {
  readonly divergences: string[];

  constructor(divergences: string[]) {
    super(
      `schema drift detected (${divergences.length} divergence(s)):\n- ${divergences.join("\n- ")}`
    );
    this.name = "MigrationDriftError";
    this.divergences = divergences;
  }
}

export function canonicalShape(shape: SchemaShape): string {
  const lines: string[] = [];
  for (const table of Object.keys(shape).sort()) {
    const columns = shape[table];
    if (!columns) continue;
    for (const column of Object.keys(columns).sort()) {
      lines.push(`${table}\t${column}\t${columns[column]}`);
    }
  }
  return lines.join("\n");
}

export function diffShapes(current: SchemaShape, expected: SchemaShape): string[] {
  const divergences: string[] = [];
  for (const table of Object.keys(expected).sort()) {
    const currentColumns = current[table];
    const expectedColumns = expected[table];
    if (!currentColumns) {
      divergences.push(`table missing: ${table}`);
      continue;
    }
    if (!expectedColumns) continue;
    for (const column of Object.keys(expectedColumns).sort()) {
      const expectedType = expectedColumns[column];
      if (!(column in currentColumns)) {
        divergences.push(`column missing: ${table}.${column}`);
      } else if (currentColumns[column] !== expectedType) {
        divergences.push(
          `type mismatch: ${table}.${column} expected ${expectedType}, found ${currentColumns[column]}`
        );
      }
    }
  }
  for (const table of Object.keys(current).sort()) {
    if (!expected[table]) divergences.push(`unexpected table: ${table}`);
  }
  return divergences.sort();
}

export async function loadSchemaShape(db: Db): Promise<SchemaShape> {
  const rows = await db`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;
  const shape: SchemaShape = {};
  for (const row of rows) {
    const table = row.table_name as string;
    const column = row.column_name as string;
    (shape[table] ??= {})[column] = row.data_type as string;
  }
  return shape;
}

export async function migrateUp(db: Db, dir?: string): Promise<string[]> {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await db`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS schema_shape text`;
  const applied = new Set(
    (await db`SELECT name FROM schema_migrations`).map((r) => r.name as string)
  );
  const recordedRows = await db`
    SELECT schema_shape FROM schema_migrations WHERE schema_shape IS NOT NULL LIMIT 1
  `;
  const recordedShape = recordedRows[0]?.schema_shape as string | undefined;
  if (recordedShape !== undefined && applied.size > 0) {
    const divergences = diffShapes(await loadSchemaShape(db), parseShape(recordedShape));
    if (divergences.length > 0) throw new MigrationDriftError(divergences);
  }
  const migrations = loadMigrationsFromDir(dir ?? defaultMigrationsDir());
  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await db.begin(async (tx) => {
      await tx.unsafe(migration.up);
      await tx`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
    });
    newlyApplied.push(migration.name);
  }
  const shapeText = canonicalShape(await loadSchemaShape(db));
  await db`UPDATE schema_migrations SET schema_shape = ${shapeText}`;
  return newlyApplied;
}

function parseShape(text: string): SchemaShape {
  const shape: SchemaShape = {};
  if (text === "") return shape;
  for (const line of text.split("\n")) {
    const [table, column, type] = line.split("\t");
    (shape[table!] ??= {})[column!] = type ?? "";
  }
  return shape;
}

export async function migrateDown(db: Db, steps: number, dir?: string): Promise<string[]> {
  const migrations = loadMigrationsFromDir(dir ?? defaultMigrationsDir());
  const byName = new Map(migrations.map((m) => [m.name, m]));
  const appliedRows = (
    await db`SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC`
  ).map((r) => r.name as string);
  const reverted: string[] = [];
  for (const name of appliedRows.slice(0, Math.max(0, steps))) {
    const migration = byName.get(name);
    if (!migration || !migration.down) continue;
    await db.begin(async (tx) => {
      await tx.unsafe(migration.down);
      await tx`DELETE FROM schema_migrations WHERE name = ${name}`;
    });
    reverted.push(name);
  }
  return reverted;
}

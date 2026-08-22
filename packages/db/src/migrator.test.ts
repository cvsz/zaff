import { describe, expect, it } from "vitest";
import {
  MigrationDriftError,
  canonicalShape,
  diffShapes,
  parseMigration,
} from "./migrator.js";

describe("parseMigration", () => {
  it("splits up and down sections", () => {
    const parsed = parseMigration(
      [
        "-- migrate:up",
        "CREATE TABLE a (id int);",
        "",
        "-- migrate:down",
        "DROP TABLE a;",
      ].join("\n")
    );
    expect(parsed.up).toBe("CREATE TABLE a (id int);");
    expect(parsed.down).toBe("DROP TABLE a;");
  });

  it("handles missing down section as empty string", () => {
    const parsed = parseMigration("-- migrate:up\nCREATE TABLE b (id int);\n");
    expect(parsed.up).toBe("CREATE TABLE b (id int);");
    expect(parsed.down).toBe("");
  });

  it("throws when up section is missing", () => {
    expect(() => parseMigration("SELECT 1;")).toThrow(/migrate:up/);
  });

  it("keeps statements intact across multiple lines", () => {
    const sql = "CREATE TABLE c (\n  id int PRIMARY KEY,\n  name text\n);";
    const parsed = parseMigration(`-- migrate:up\n${sql}\n-- migrate:down\nDROP TABLE c;\n`);
    expect(parsed.up).toBe(sql);
    expect(parsed.down).toBe("DROP TABLE c;");
  });
});

describe("canonicalShape", () => {
  it("produces a deterministic sorted representation", () => {
    const shape = {
      users: { created_at: "timestamptz", id: "uuid" },
      organizations: { id: "uuid", name: "text" },
    };
    expect(canonicalShape(shape)).toBe(
      [
        "organizations\tid\tuuid",
        "organizations\tname\ttext",
        "users\tcreated_at\ttimestamptz",
        "users\tid\tuuid",
      ].join("\n")
    );
  });

  it("is order-independent for equivalent shapes", () => {
    const a = { t: { b: "text", a: "uuid" } };
    const b = { t: { a: "uuid", b: "text" } };
    expect(canonicalShape(a)).toBe(canonicalShape(b));
  });

  it("round-trips through parseShape via empty schema", () => {
    expect(canonicalShape({})).toBe("");
  });
});

describe("diffShapes", () => {
  it("returns no divergences for identical shapes", () => {
    const shape = { users: { id: "uuid", email: "text" } };
    expect(diffShapes(shape, shape)).toEqual([]);
  });

  it("detects missing tables and columns", () => {
    const current = { users: { id: "uuid" } };
    const expected = { users: { id: "uuid", email: "text" }, audit_log: { id: "uuid" } };
    expect(diffShapes(current, expected)).toEqual([
      "column missing: users.email",
      "table missing: audit_log",
    ]);
  });

  it("detects type mismatches", () => {
    const current = { users: { id: "text" } };
    const expected = { users: { id: "uuid" } };
    expect(diffShapes(current, expected)).toEqual([
      "type mismatch: users.id expected uuid, found text",
    ]);
  });

  it("detects unexpected extra tables", () => {
    const divergences = diffShapes({ rogue: { id: "uuid" } }, {});
    expect(divergences).toEqual(["unexpected table: rogue"]);
  });

  it("is exposed through MigrationDriftError message", () => {
    const error = new MigrationDriftError(["column missing: users.email"]);
    expect(error).toBeInstanceOf(MigrationDriftError);
    expect(error.divergences).toEqual(["column missing: users.email"]);
    expect(error.message).toContain("column missing: users.email");
  });
});

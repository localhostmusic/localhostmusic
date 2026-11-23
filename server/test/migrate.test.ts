import { test, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb } from "../src/db/index.js";
import { runMigrations, LATEST_VERSION, MIGRATIONS } from "../src/db/migrate.js";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/db/schema.sql"),
  "utf8"
);

const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const columns = (db: Database.Database, table: string) =>
  (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

test("migration versions are unique, sorted, and start at 1", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  expect(versions[0]).toBe(1);
  expect(new Set(versions).size).toBe(versions.length);
  expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  expect(LATEST_VERSION).toBe(versions[versions.length - 1]);
});

test("a fresh database lands at LATEST_VERSION with the full schema", () => {
  const db = openDb(":memory:");
  expect(version(db)).toBe(LATEST_VERSION);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name);
  for (const t of ["artists", "albums", "tracks", "users", "playlists", "track_lyrics"]) {
    expect(tables).toContain(t);
  }
  // Columns that arrived via ALTER before the migration system existed.
  expect(columns(db, "tracks")).toContain("loudness");
  expect(columns(db, "track_lyrics")).toContain("published_at");
  expect(columns(db, "playlists")).toContain("rules");
  db.close();
});

test("running migrations again is a no-op", () => {
  const db = openDb(":memory:");
  const again = runMigrations(db, SCHEMA);
  expect(again.applied).toEqual([]);
  expect(again.from).toBe(LATEST_VERSION);
  expect(version(db)).toBe(LATEST_VERSION);
  db.close();
});

test("a pre-migration database gets its missing columns and is stamped", () => {
  // Simulate a database from before the freeze: full schema, minus the two columns
  // that were still being added by ALTER, and with no user_version ever set.
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.exec("ALTER TABLE tracks DROP COLUMN loudness");
  db.exec("ALTER TABLE track_lyrics DROP COLUMN published_at");
  db.pragma("user_version = 0");
  expect(columns(db, "tracks")).not.toContain("loudness");

  const result = runMigrations(db, SCHEMA);

  expect(result.from).toBe(0);
  expect(result.to).toBe(LATEST_VERSION);
  expect(result.applied).toContain("1:baseline");
  expect(columns(db, "tracks")).toContain("loudness");
  expect(columns(db, "track_lyrics")).toContain("published_at");
  expect(version(db)).toBe(LATEST_VERSION);
  db.close();
});

test("an already-stamped database does not re-run the baseline", () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.pragma("user_version = 1");
  // `applied` tells the caller what actually ran.
  const result = runMigrations(db, SCHEMA);
  expect(result.applied.filter((a) => a.startsWith("1:"))).toEqual([]);
  db.close();
});

test("a database newer than the build refuses to open", () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.pragma(`user_version = ${LATEST_VERSION + 1}`);
  expect(() => runMigrations(db, SCHEMA)).toThrow(/newer than this build/);
  db.close();
});

test("a failing migration rolls back and leaves the previous version intact", () => {
  const db = new Database(":memory:");
  db.pragma("user_version = 0");
  const boom: typeof MIGRATIONS = [
    { version: 1, name: "baseline", up: (d, s) => d.exec(s) },
    {
      version: 2,
      name: "explodes",
      up: (d) => {
        d.exec("CREATE TABLE canary (id INTEGER)");
        throw new Error("boom");
      },
    },
  ];
  // Exercise the same loop the real runner uses, with a migration that throws.
  const run = () => {
    for (const m of boom) {
      const cur = db.pragma("user_version", { simple: true }) as number;
      if (m.version <= cur) continue;
      const tx = db.transaction(() => { m.up(db, SCHEMA); db.pragma(`user_version = ${m.version}`); });
      tx();
    }
  };
  expect(run).toThrow(/boom/);
  // v1 committed, v2 rolled back entirely: no canary table, version still 1.
  expect(version(db)).toBe(1);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name);
  expect(tables).not.toContain("canary");
  expect(tables).toContain("tracks");
  db.close();
});

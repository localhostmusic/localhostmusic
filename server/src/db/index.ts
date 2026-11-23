import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMigrations } from "./migrate.js";

const here = dirname(fileURLToPath(import.meta.url));

// The project used to be called Sonora. Carry an existing library over to the new
// file name. The -wal file moves first: it can hold changes not yet in the main file.
export function adoptOldDb(dataDir: string): void {
  const now = join(dataDir, "lhm.db"), old = join(dataDir, "sonora.db");
  if (existsSync(now) || !existsSync(old)) return;
  for (const suffix of ["-wal", "-shm", ""]) {
    if (existsSync(old + suffix)) renameSync(old + suffix, now + suffix);
  }
}

export function openDb(path: string): Database.Database {
  // A fresh instance has no data directory yet.
  if (path !== ":memory:") { try { mkdirSync(dirname(path), { recursive: true }); } catch { /* exists */ } }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The Go scanner sidecar writes to this file from another process. Wait out
  // its batch commits instead of throwing SQLITE_BUSY.
  db.pragma("busy_timeout = 10000");

  // schema.sql is the frozen v1 baseline. Later changes live in migrate.ts.
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  runMigrations(db, schema);
  return db;
}

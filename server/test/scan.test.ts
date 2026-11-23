import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const fixtures = join(import.meta.dirname, "fixtures");

test("scans library into db and records issues", async () => {
  const db = openDb(":memory:");
  const data = mkdtempSync(join(tmpdir(), "lhm-"));
  const res = await scanLibrary(db, fixtures, data);
  expect(res.added).toBe(2);          // 2 valid mp3s
  expect(res.issues).toBe(1);         // corrupt.mp3
  const tracks = db.prepare("SELECT COUNT(*) c FROM tracks").get() as any;
  expect(tracks.c).toBe(2);
  const artists = db.prepare("SELECT COUNT(*) c FROM artists").get() as any;
  expect(artists.c).toBe(1);          // Artist X deduped
  const fts = db.prepare("SELECT COUNT(*) c FROM search_fts").get() as any;
  expect(fts.c).toBeGreaterThan(0);
  db.close();
});

test("rescan is incremental (no duplicates)", async () => {
  const db = openDb(":memory:");
  const data = mkdtempSync(join(tmpdir(), "lhm-"));
  await scanLibrary(db, fixtures, data);
  const res2 = await scanLibrary(db, fixtures, data);
  expect(res2.added).toBe(0);
  const tracks = db.prepare("SELECT COUNT(*) c FROM tracks").get() as any;
  expect(tracks.c).toBe(2);
  db.close();
});

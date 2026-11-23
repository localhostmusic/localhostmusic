import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { join } from "node:path";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";

const fixtures = join(import.meta.dirname, "fixtures-year");
const album = () => "SELECT year FROM albums WHERE title='Year Album'";

// An album row is created from whichever track is scanned first. If that track
// has no DATE tag, later dated tracks must fill in the year.
test("backfills an album year from a later track when the row has none", async () => {
  const db = openDb(":memory:");
  const data = mkdtempSync(join(tmpdir(), "lhm-"));
  const music = mkdtempSync(join(tmpdir(), "lhm-music-"));

  copyFileSync(join(fixtures, "no-year.mp3"), join(music, "no-year.mp3"));
  await scanLibrary(db, music, data);
  expect((db.prepare(album()).get() as any).year).toBeNull();

  copyFileSync(join(fixtures, "dated.mp3"), join(music, "dated.mp3"));
  await scanLibrary(db, music, data);
  expect((db.prepare(album()).get() as any).year).toBe(1979);
  db.close();
});

// Backfill fills a gap. It must not rewrite a year already known.
test("does not overwrite a year the album already has", async () => {
  const db = openDb(":memory:");
  const data = mkdtempSync(join(tmpdir(), "lhm-"));
  const music = mkdtempSync(join(tmpdir(), "lhm-music-"));

  copyFileSync(join(fixtures, "dated.mp3"), join(music, "dated.mp3"));
  await scanLibrary(db, music, data);
  db.prepare("UPDATE albums SET year=1975 WHERE title='Year Album'").run();

  copyFileSync(join(fixtures, "no-year.mp3"), join(music, "no-year.mp3"));
  await scanLibrary(db, music, data);
  expect((db.prepare(album()).get() as any).year).toBe(1975);
  db.close();
});

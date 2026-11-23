import { test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openDb } from "../src/db/index.js";
import { albumColors, backfillArtColors, resetArtColorCache } from "../src/lib/artColor.js";

const solid = (path: string, r: number, g: number, b: number) =>
  sharp({ create: { width: 200, height: 200, channels: 3, background: { r, g, b } } }).jpeg().toFile(path);

beforeEach(() => resetArtColorCache());

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lhm-artcolor-"));
  const db = openDb(":memory:");
  const album = (title: string, cover: string | null) =>
    Number(db.prepare("INSERT INTO albums(title, cover_path) VALUES(?, ?)").run(title, cover).lastInsertRowid);
  return { dir, db, album };
}

test("maps each album to its cover's colour and persists the cache", async () => {
  const { dir, db, album } = fixture();
  await solid(join(dir, "red.jpg"), 220, 20, 30);
  await solid(join(dir, "blue.jpg"), 20, 40, 200);
  const red = album("Red", join(dir, "red.jpg"));
  const blue = album("Blue", join(dir, "blue.jpg"));
  const none = album("No cover", null);

  expect(await backfillArtColors(db, dir)).toBe(2);
  const colors = albumColors(db, dir);
  expect(Object.keys(colors).map(Number).sort()).toEqual([red, blue].sort());
  const [r, g, b] = [1, 3, 5].map(i => parseInt(colors[red].slice(i, i + 2), 16));
  expect(r).toBeGreaterThan(180); expect(g).toBeLessThan(60); expect(b).toBeLessThan(70);
  expect(colors[none]).toBeUndefined();
  expect(existsSync(join(dir, "art-colors.json"))).toBe(true);

  // A second pass over unchanged covers does no work, even after a restart.
  resetArtColorCache();
  expect(await backfillArtColors(db, dir)).toBe(0);
});

test("a replaced cover is recoloured", async () => {
  const { dir, db, album } = fixture();
  const path = join(dir, "cover.jpg");
  await solid(path, 220, 20, 30);
  const id = album("A", path);
  await backfillArtColors(db, dir);
  const before = albumColors(db, dir)[id];

  await solid(path, 20, 200, 40);
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  expect(await backfillArtColors(db, dir)).toBe(1);
  expect(albumColors(db, dir)[id]).not.toBe(before);
});

test("an unreadable cover is skipped, not retried forever", async () => {
  const { dir, db, album } = fixture();
  const path = join(dir, "broken.jpg");
  writeFileSync(path, "not an image");
  const id = album("Broken", path);
  expect(await backfillArtColors(db, dir)).toBe(1);
  expect(albumColors(db, dir)[id]).toBeUndefined();
  expect(await backfillArtColors(db, dir)).toBe(0);
});

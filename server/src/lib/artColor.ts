import sharp from "sharp";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { stat, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

// One representative colour per album cover, so a grid can paint each tile in
// its cover's colour before the thumbnail loads.
// A pure cache of the cover file, kept out of the database: keyed by cover path,
// invalidated by mtime+size, persisted to DATA_DIR/art-colors.json.

type Entry = { k: string; c: string | null };
let cache: Record<string, Entry> | null = null;
let file = "";
let running = false;
let lastRun = 0;

function load(dataDir: string) {
  if (cache) return cache;
  file = join(dataDir, "art-colors.json");
  try { cache = JSON.parse(readFileSync(file, "utf8")); } catch { cache = {}; }
  return cache!;
}

async function persist() {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(cache));
  await rename(tmp, file);
}

const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");

// Dominant colour of a small downscale. A plain average muddies to brown.
export async function coverColor(path: string): Promise<string | null> {
  try {
    const small = await sharp(path, { failOn: "none" }).resize(64, 64, { fit: "cover" }).toBuffer();
    const { dominant: d } = await sharp(small).stats();
    return `#${hex(d.r)}${hex(d.g)}${hex(d.b)}`;
  } catch {
    return null; // unreadable cover: remembered as null so it isn't retried every pass
  }
}

// albumId to "#rrggbb" for every album whose colour is known. Starts a background
// refresh when the last one is stale, never waits for it.
export function albumColors(db: Database.Database, dataDir: string): Record<number, string> {
  const c = load(dataDir);
  if (Date.now() - lastRun > 10 * 60_000) void backfillArtColors(db, dataDir);
  const out: Record<number, string> = {};
  const rows = db.prepare("SELECT id, cover_path FROM albums WHERE cover_path IS NOT NULL").all() as { id: number; cover_path: string }[];
  for (const r of rows) {
    const color = c[r.cover_path]?.c;
    if (color) out[r.id] = color;
  }
  return out;
}

// Compute colours for covers that are new or changed since the last pass. One
// cover at a time, yielding between them, so a large first run never blocks
// requests. Guarded against overlapping runs.
export async function backfillArtColors(db: Database.Database, dataDir: string): Promise<number> {
  if (running) return 0;
  running = true;
  lastRun = Date.now();
  const c = load(dataDir);
  let done = 0;
  try {
    const paths = db.prepare("SELECT DISTINCT cover_path FROM albums WHERE cover_path IS NOT NULL").all() as { cover_path: string }[];
    for (const { cover_path: p } of paths) {
      let k: string;
      try { const st = await stat(p); k = `${st.mtimeMs}:${st.size}`; } catch { continue; }
      if (c[p]?.k === k) continue;
      c[p] = { k, c: await coverColor(p) };
      if (++done % 200 === 0) await persist();
      await new Promise(r => setImmediate(r));
    }
    if (done) await persist();
  } finally {
    running = false;
  }
  return done;
}

// Tests only.
export function resetArtColorCache() { cache = null; lastRun = 0; }

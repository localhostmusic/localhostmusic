import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { scanLibrary, type ScanResult } from "../scanner/scan.js";
import { classifyAudiobooks } from "./audiobooks.js";
import { getSettings } from "./settings.js";
import { pruneMissing } from "./prune.js";
import { seedGenresFromTags } from "./genres.js";

// Full library scan across every configured root: the music library, then the
// optional audiobooks root (skipped when unset, missing, or the same as the music
// dir). Classification runs last so audiobooks-root content is flagged whichever
// scanner (JS or Go sidecar) ran. Returns combined counts and how many albums flipped.
let active = 0;
export const isScanning = () => active > 0;

export async function scanAll(
  db: Database.Database, dataDir: string
): Promise<ScanResult & { books: number; removed: number }> {
  active++;
  try { return await runScan(db, dataDir); }
  finally { active--; }
}

async function runScan(
  db: Database.Database, dataDir: string
): Promise<ScanResult & { books: number; removed: number }> {
  const s = getSettings(db);
  const roots = [s.musicDir];
  let { added, issues, recredited } = await scanLibrary(db, s.musicDir, dataDir);
  if (s.audiobookDir && s.audiobookDir !== s.musicDir && existsSync(s.audiobookDir)) {
    const r = await scanLibrary(db, s.audiobookDir, dataDir);
    added += r.added; issues += r.issues; recredited += r.recredited;
    roots.push(s.audiobookDir);
  }
  // Neither scanner removes anything, so drop rows whose file no longer exists.
  // Otherwise a moved file's new path scans in as a duplicate.
  const missing = pruneMissing(db, roots);
  for (const why of missing.skipped) console.warn(`[lhm] skipped missing-file prune for ${why}`);
  const books = classifyAudiobooks(db, s.audiobookDir);
  // After classification, so audiobook "genres" stay out of the music index.
  try { seedGenresFromTags(db); } catch (e) { console.warn("[lhm] genre seeding failed", e); }
  return { added, issues, recredited, books, removed: missing.tracks };
}

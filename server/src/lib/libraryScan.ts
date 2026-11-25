import type Database from "better-sqlite3";
import { pruneEmpty } from "./prune.js";
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

// When the last scan finished, whoever started it. 0 until the first one ends.
let lastScanEnd = 0;
export const lastScanAt = () => lastScanEnd;

// How soon after a scan a regular user may ask for another.
export const USER_RESCAN_GAP_MS = 5 * 60_000;

// A scan plus what follows it: drop emptied albums and artists. Used by the
// automatic scan and by a user's request, where nobody is waiting on the result.
export async function scanAndTidy(db: Database.Database, dataDir: string) {
  const r = await scanAll(db, dataDir);
  const pruned = pruneEmpty(db);
  if (r.added || r.removed || pruned.albums || pruned.artists)
    console.log(`Scan: +${r.added} tracks, -${r.removed} gone, ${r.issues} issues; pruned ${pruned.albums} albums, ${pruned.artists} artists`);
  return r;
}

// Scans on a schedule so new files show up without anyone pressing a button.
// The interval is an admin setting in minutes, read each tick so changes apply at once.
export function startAutoScan(db: Database.Database, dataDir: string, after?: () => void) {
  setInterval(() => {
    const every = getSettings(db).autoScanMinutes;
    if (!every || isScanning() || !lastScanEnd) return; // off, busy, or the boot scan is still running
    if (Date.now() - lastScanEnd < every * 60_000) return;
    scanAndTidy(db, dataDir).then(r => { if (r.added) after?.(); }).catch(e => console.error("Automatic scan failed", e));
  }, 60_000).unref();
}

export async function scanAll(
  db: Database.Database, dataDir: string
): Promise<ScanResult & { books: number; removed: number }> {
  active++;
  try { return await runScan(db, dataDir); }
  finally { active--; lastScanEnd = Date.now(); }
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

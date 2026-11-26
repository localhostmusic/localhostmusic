import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { readTags } from "./tags.js";
import { cacheCover } from "../lib/covers.js";
import { CREDITS_VERSION } from "../db/migrate.js";

const AUDIO = new Set([".mp3", ".flac", ".m4a", ".m4b", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".ape", ".wv"]);

export interface ScanResult { added: number; issues: number; recredited: number; }

// scanLibrary runs the Go scanner sidecar when LHM_SCANNER_BIN points at a
// built `lhm-scan` binary, otherwise (or if the sidecar fails) the in-process JS
// scanner below. Both share the same skip logic, so the JS fallback can finish a
// partial sidecar run without duplicating rows.
export async function scanLibrary(
  db: Database.Database, musicDir: string, dataDir: string
): Promise<ScanResult> {
  const bin = process.env.LHM_SCANNER_BIN;
  if (bin && existsSync(bin)) {
    try {
      return await scanWithSidecar(bin, musicDir, dataDir);
    } catch (e) {
      console.warn(`[lhm] Go scanner failed, falling back to JS scanner: ${(e as Error)?.message ?? e}`);
    }
  }
  return scanWithJs(db, musicDir, dataDir);
}

function scanWithSidecar(bin: string, musicDir: string, dataDir: string): Promise<ScanResult> {
  const dbPath = join(dataDir, "lhm.db");
  return new Promise((resolve, reject) => {
    // Library can be huge, so no timeout. stdout is just the final JSON line.
    execFile(bin, ["--music", musicDir, "--data", dataDir, "--db", dbPath],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        try {
          const out = JSON.parse(stdout.trim().split("\n").pop() || "{}");
          resolve({
            added: Number(out.added) || 0,
            issues: Number(out.issues) || 0,
            recredited: Number(out.recredited) || 0,
          });
        } catch {
          reject(new Error(`unparseable scanner output: ${stdout.slice(0, 200)}`));
        }
      });
  });
}

// Asynchronous on purpose: a blocking walk of a library on a sleeping or slow drive
// would freeze the server until the drive answered.
async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (AUDIO.has(extname(e.name).toLowerCase())) yield p;
  }
}

async function scanWithJs(db: Database.Database, musicDir: string, dataDir: string): Promise<ScanResult> {
  const getArtist = db.prepare("SELECT id FROM artists WHERE name=?");
  const insArtist = db.prepare("INSERT INTO artists(name) VALUES(?)");
  const getAlbum = db.prepare("SELECT id,year FROM albums WHERE title=? AND artist_id=?");
  const setAlbumYear = db.prepare("UPDATE albums SET year=? WHERE id=?");
  const insAlbum = db.prepare("INSERT INTO albums(title,artist_id,year) VALUES(?,?,?)");
  const setCover = db.prepare("UPDATE albums SET cover_path=? WHERE id=?");
  const getTrack = db.prepare("SELECT id,mtime,size,credits_v FROM tracks WHERE path=?");
  const insTrack = db.prepare(
    "INSERT INTO tracks(path,title,album_id,artist_id,track_no,disc_no,duration,genre,mtime,size,added_at,credits_v) VALUES(@path,@title,@album_id,@artist_id,@track_no,@disc_no,@duration,@genre,@mtime,@size,@added_at,@credits_v)"
  );
  const updateTrack = db.prepare(`UPDATE tracks SET title=@title,album_id=@album_id,artist_id=@artist_id,
    track_no=@track_no,disc_no=@disc_no,duration=@duration,genre=@genre,mtime=@mtime,size=@size,
    credits_v=@credits_v,loudness=NULL WHERE path=@path`);
  const insFts = db.prepare("INSERT INTO search_fts(kind,ref_id,name) VALUES(?,?,?)");
  const insIssue = db.prepare("INSERT INTO scan_issues(path,error,at) VALUES(?,?,?)");
  const insCredit = db.prepare(
    "INSERT OR IGNORE INTO track_artists(track_id,artist_id,role,position) VALUES(?,?,?,?)"
  );
  const clearCredits = db.prepare("DELETE FROM track_artists WHERE track_id=?");
  const markCredited = db.prepare("UPDATE tracks SET credits_v=? WHERE id=?");

  const artistId = (name: string): number => {
    const row = getArtist.get(name) as any;
    if (row) return row.id;
    const id = insArtist.run(name).lastInsertRowid as number;
    insFts.run("artist", id, name);
    return id;
  };
  const albumId = (title: string, aId: number, year?: number): number => {
    const row = getAlbum.get(title, aId) as any;
    if (row) {
      // Backfill a missing album year from the first track that has one. Never
      // overwrite a year already recorded.
      if (row.year == null && year != null) setAlbumYear.run(year, row.id);
      return row.id;
    }
    const id = insAlbum.run(title, aId, year ?? null).lastInsertRowid as number;
    insFts.run("album", id, title);
    return id;
  };

  // Frame 0 is the lead artist, the rest are guests (tagger convention).
  const writeCredits = (trackId: number, names: string[]) => {
    names.forEach((name, i) =>
      insCredit.run(trackId, artistId(name), i === 0 ? "primary" : "featured", i));
  };

  let added = 0, issues = 0, recredited = 0;

  // One cover write per album, not per track. Seeded from the DB so rescans don't
  // rewrite existing covers.
  const covered = new Set<number>(
    (db.prepare("SELECT id FROM albums WHERE cover_path IS NOT NULL").all() as any[]).map(r => r.id)
  );

  // Batch track inserts in transactions to avoid a commit (fsync) per statement.
  // Credits are written in the same transaction, after the insert: they need the
  // track id, and better-sqlite3 rejects named parameters the statement doesn't declare.
  type Row = Record<string, unknown> & { title: string };
  type Item = { row: Row; artists: string[]; updateId?: number };
  const pending: Item[] = [];
  const flush = db.transaction((items: Item[]) => {
    for (const { row, artists, updateId } of items) {
      const id = updateId ?? Number(insTrack.run(row).lastInsertRowid);
      if (updateId) {
        const { added_at: _addedAt, ...updated } = row;
        updateTrack.run(updated);
        clearCredits.run(id);
        db.prepare("DELETE FROM search_fts WHERE kind='track' AND ref_id=?").run(id);
        db.prepare("DELETE FROM track_chapters WHERE track_id=?").run(id);
      }
      insFts.run("track", id, row.title);
      writeCredits(id, artists);
      if (!updateId) added++;
    }
  });

  // An unchanged file still needs revisiting if its credits predate track_artists.
  // Batched like the insert path.
  const recredit = db.transaction((items: { id: number; artists: string[] }[]) => {
    for (const { id, artists } of items) {
      clearCredits.run(id);
      writeCredits(id, artists);
      markCredited.run(CREDITS_VERSION, id);
      recredited++;
    }
  });
  const pendingCredits: { id: number; artists: string[] }[] = [];

  for await (const path of walk(musicDir)) {
    try {
      const st = await stat(path);
      const existing = getTrack.get(path) as any;
      if (existing && existing.mtime === Math.floor(st.mtimeMs) && existing.size === st.size) {
        if (existing.credits_v < CREDITS_VERSION) {
          const t = await readTags(path);
          pendingCredits.push({ id: existing.id, artists: t.artists });
          if (pendingCredits.length >= 200) recredit(pendingCredits.splice(0));
        }
        continue;
      }
      const t = await readTags(path);
      const aId = artistId(t.albumArtist ?? t.artist);
      const alId = albumId(t.album, aId, t.year);
      if (t.picture && (!covered.has(alId) || existing)) {
        setCover.run(cacheCover(dataDir, alId, t.picture), alId);
        covered.add(alId);
      }
      pending.push({
        updateId: existing?.id,
        row: {
          path, title: t.title, album_id: alId, artist_id: artistId(t.artist),
          track_no: t.trackNo ?? null, disc_no: t.discNo ?? null,
          duration: t.duration ?? null, genre: t.genre ?? null,
          mtime: Math.floor(st.mtimeMs), size: st.size, added_at: Date.now(),
          credits_v: CREDITS_VERSION,
        },
        artists: t.artists,
      });
      if (pending.length >= 200) flush(pending.splice(0));
    } catch (err: any) {
      insIssue.run(path, String(err?.message ?? err), Date.now());
      issues++;
    }
  }
  if (pending.length) flush(pending.splice(0));
  if (pendingCredits.length) recredit(pendingCredits.splice(0));
  return { added, issues, recredited };
}

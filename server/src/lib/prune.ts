import type Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";

// A scan that finds more than this share of a root's tracks missing treats the
// root as broken (e.g. an unmounted share) and prunes nothing.
const MAX_MISSING_SHARE = 0.5;

export interface MissingPrune { tracks: number; skipped: string[]; }

// Remove track rows whose file is gone from disk. The scanner is additive-only, so
// a moved or deleted file otherwise leaves a ghost row, plus a duplicate at the new
// path. Only tracks under `roots` are considered. A missing or empty root is
// skipped, so a scan while the library is unmounted can't wipe the DB.
export function pruneMissing(db: Database.Database, roots: string[]): MissingPrune {
  const skipped: string[] = [];
  let removed = 0;

  for (const raw of roots) {
    if (!raw) continue;
    const root = resolve(raw);
    // An unmounted mountpoint still exists and reads as empty. Trust neither.
    if (!existsSync(root)) { skipped.push(`${root} (missing)`); continue; }
    let empty = true;
    try { empty = readdirSync(root).length === 0; } catch { skipped.push(`${root} (unreadable)`); continue; }
    if (empty) { skipped.push(`${root} (empty)`); continue; }

    const under = db.prepare("SELECT id,path FROM tracks WHERE path LIKE ? ESCAPE '\\'")
      .all(likePrefix(root + sep)) as { id: number; path: string }[];
    if (!under.length) continue;

    const gone = under.filter(t => !existsSync(t.path));
    if (!gone.length) continue;
    if (gone.length / under.length > MAX_MISSING_SHARE) {
      skipped.push(`${root} (${gone.length}/${under.length} missing, looks unmounted, not deleted)`);
      continue;
    }

    // favorites and playlist_tracks reference tracks without ON DELETE CASCADE, so
    // they go first. The rest (track_artists, track_chapters, bookmarks, track_lyrics,
    // play_counts) cascade.
    const delFav = db.prepare("DELETE FROM favorites WHERE track_id=?");
    const delPl = db.prepare("DELETE FROM playlist_tracks WHERE track_id=?");
    const delFts = db.prepare("DELETE FROM search_fts WHERE kind='track' AND ref_id=?");
    const delTrack = db.prepare("DELETE FROM tracks WHERE id=?");
    db.transaction(() => {
      for (const t of gone) {
        delFav.run(t.id);
        delPl.run(t.id);
        delFts.run(t.id);
        delTrack.run(t.id);
      }
    })();
    removed += gone.length;
  }

  return { tracks: removed, skipped };
}

// LIKE treats _ and % as wildcards, and paths legitimately contain both.
function likePrefix(p: string): string {
  return p.replace(/[\\%_]/g, m => "\\" + m) + "%";
}

// Remove albums and artists that have no tracks (e.g. after a track is deleted or
// re-tagged to a different album/artist), plus their search-index + image rows.
export function pruneEmpty(db: Database.Database): { albums: number; artists: number } {
  const emptyAlbums = db.prepare(
    "SELECT id FROM albums WHERE id NOT IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL)"
  ).all() as any[];
  for (const a of emptyAlbums) {
    db.prepare("DELETE FROM search_fts WHERE kind='album' AND ref_id=?").run(a.id);
    db.prepare("DELETE FROM albums WHERE id=?").run(a.id);
  }

  // A featured artist is referenced only from track_artists. Without this clause
  // prune would delete every guest artist.
  const emptyArtists = db.prepare(
    `SELECT id FROM artists
     WHERE id NOT IN (SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL)
       AND id NOT IN (SELECT artist_id FROM albums WHERE artist_id IS NOT NULL)
       AND id NOT IN (SELECT artist_id FROM track_artists)`
  ).all() as any[];
  for (const a of emptyArtists) {
    db.prepare("DELETE FROM search_fts WHERE kind='artist' AND ref_id=?").run(a.id);
    db.prepare("DELETE FROM artist_images WHERE artist_id=?").run(a.id);
    db.prepare("DELETE FROM artists WHERE id=?").run(a.id);
  }

  return { albums: emptyAlbums.length, artists: emptyArtists.length };
}

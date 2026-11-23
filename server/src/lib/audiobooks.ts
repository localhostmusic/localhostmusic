import type Database from "better-sqlite3";

// Classify albums as audiobooks after a scan. An album is flagged when any of its
// tracks looks spoken-word: a .m4b file, a path under the audiobooks root or an
// "audiobook(s)" folder, or an audiobook-ish genre tag. The flag is only ever set,
// never cleared. Returns how many albums flipped.
export function classifyAudiobooks(db: Database.Database, audiobookDir?: string): number {
  const dir = (audiobookDir ?? "").replace(/\/+$/, "").toLowerCase();
  const rootClause = dir ? "OR LOWER(t.path) LIKE ?" : "";
  const params = dir ? [dir + "/%"] : [];
  const res = db.prepare(
    `UPDATE albums SET is_audiobook = 1
     WHERE COALESCE(is_audiobook, 0) = 0
       AND id IN (
         SELECT DISTINCT t.album_id FROM tracks t
         WHERE t.album_id IS NOT NULL AND (
           LOWER(t.path) LIKE '%.m4b'
           OR LOWER(t.path) LIKE '%/audiobooks/%'
           OR LOWER(t.path) LIKE '%/audiobook/%'
           OR LOWER(COALESCE(t.genre, '')) LIKE '%audiobook%'
           OR LOWER(COALESCE(t.genre, '')) LIKE '%spoken%'
           OR LOWER(COALESCE(t.genre, '')) LIKE '%audio drama%'
           ${rootClause}
         )
       )`
  ).run(...params);
  return res.changes;
}

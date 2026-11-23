import { lfmArtistInfo } from "./recommend.js";
import { getSettings } from "./settings.js";
import { isAlbumArtist } from "./credits.js";

// Genre browsing is powered by per-artist tags, mirrored into the artist_genres
// index that the browse endpoints query. They come from the files' own genre
// tags when there are any (seedGenresFromTags), otherwise from artist_info
// (MusicBrainz/Last.fm).

// "indie rock, EMO" becomes ["Indie Rock", "Emo"]: trimmed, title-cased, deduped, capped.
export function parseGenres(str: string | null | undefined): string[] {
  if (!str) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let g of str.split(",")) {
    g = g.trim().replace(/\s+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    if (!g) continue;
    const key = g.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
    if (out.length >= 5) break;
  }
  return out;
}

// Replace an artist's rows in the genre index to match a genre string.
export function syncArtistGenres(db: any, artistId: number, genresStr: string | null) {
  db.prepare("DELETE FROM artist_genres WHERE artist_id=?").run(artistId);
  const ins = db.prepare("INSERT OR IGNORE INTO artist_genres(artist_id,genre) VALUES(?,?)");
  for (const g of parseGenres(genresStr)) ins.run(artistId, g);
}

// Give every album artist with no genres the most common genre tags of their own
// tracks, so the Genres page works without online lookups. Returns how many
// artists were seeded.
export function seedGenresFromTags(db: any): number {
  const rows = db.prepare(
    `SELECT al.artist_id AS id, t.genre AS genre, COUNT(*) AS n
     FROM tracks t JOIN albums al ON al.id = t.album_id
     WHERE t.genre IS NOT NULL AND TRIM(t.genre) <> '' AND al.artist_id IS NOT NULL
       AND COALESCE(al.is_audiobook, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM artist_genres ag WHERE ag.artist_id = al.artist_id)
     GROUP BY al.artist_id, t.genre`
  ).all() as { id: number; genre: string; n: number }[];
  const tally = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const m = tally.get(r.id) ?? new Map<string, number>();
    // One tag can hold several genres ("Rock; Indie"). "/" is left alone: "R&B/Soul".
    for (const g of parseGenres(r.genre.replace(/;/g, ","))) m.set(g, (m.get(g) ?? 0) + r.n);
    tally.set(r.id, m);
  }
  db.transaction(() => {
    for (const [id, m] of tally) {
      const top = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(e => e[0]);
      syncArtistGenres(db, id, top.join(","));
    }
  })();
  return tally.size;
}

let running = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Populate the genre index for the whole library: first from genres already in
// artist_info, then (if web enrichment is on) by fetching Last.fm tags for the
// rest. Rate-limited + guarded so it runs once at a time in the background.
export async function backfillArtistGenres(db: any) {
  if (running) return;
  running = true;
  try {
    seedGenresFromTags(db);
    // Index artists that already have genres cached but aren't in the index yet.
    const cached = db.prepare(
      `SELECT ai.artist_id AS id, ai.genres FROM artist_info ai
       WHERE ai.genres IS NOT NULL AND ai.genres <> ''
         AND NOT EXISTS (SELECT 1 FROM artist_genres ag WHERE ag.artist_id = ai.artist_id)`
    ).all() as any[];
    for (const r of cached) syncArtistGenres(db, r.id, r.genres);

    if (!getSettings(db).onlineArtistMeta) return;
    // Fetch tags for artists with no genres at all.
    const missing = db.prepare(
      `SELECT a.id, a.name FROM artists a
       WHERE ${isAlbumArtist("a.id")}
         AND NOT EXISTS (SELECT 1 FROM artist_genres ag WHERE ag.artist_id = a.id)`
    ).all() as any[];
    for (const a of missing) {
      const lf = await lfmArtistInfo(a.name);
      if (lf.genres) {
        syncArtistGenres(db, a.id, lf.genres);
        db.prepare(
          `INSERT INTO artist_info(artist_id,genres,fetched_at) VALUES(?,?,?)
           ON CONFLICT(artist_id) DO UPDATE SET genres = excluded.genres`
        ).run(a.id, lf.genres, Date.now());
      }
      await sleep(350); // Last.fm is lenient, but stay polite
    }
  } finally { running = false; }
}

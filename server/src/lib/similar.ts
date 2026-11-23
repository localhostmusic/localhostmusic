import type Database from "better-sqlite3";
import { lastfmKeyed, lfmSimilarArtists, lfmSimilarTracks } from "./recommend.js";

// Radio / Auto-DJ track selection. Two independent axes:
//   mode: similar-artists | similar-songs | favorites | random
//   unit: songs | albums   (albums queues whole records, in order)
// Last.fm has artist.getSimilar and track.getSimilar but no album.getSimilar, so
// album radio means whole albums by similar artists.

const TRACK_SELECT = `
  SELECT t.id, t.title, t.duration, t.album_id AS albumId, t.artist_id AS artistId,
         ar.name AS artist, al.title AS album,
         (LOWER(t.path) LIKE '%.flac' OR LOWER(t.path) LIKE '%.wav' OR LOWER(t.path) LIKE '%.aiff'
          OR LOWER(t.path) LIKE '%.aif' OR LOWER(t.path) LIKE '%.ape' OR LOWER(t.path) LIKE '%.wv') AS lossless
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums al ON al.id = t.album_id`;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}

// Similar-artist ids present in the library, in Last.fm similarity rank order.
async function similarArtistIds(db: Database.Database, seedArtist: string): Promise<number[]> {
  if (!lastfmKeyed() || !seedArtist) return [];
  const names = await withTimeout(lfmSimilarArtists(seedArtist, 60), 4000, [] as string[]).catch(() => []);
  if (!names.length) return [];
  const lower = names.map(n => n.toLowerCase());
  const rank = new Map(lower.map((n, i) => [n, i]));
  const inLib = db.prepare(
    `SELECT id, name FROM artists WHERE LOWER(name) IN (${lower.map(() => "?").join(",")})`
  ).all(...lower) as any[];
  return inLib
    .sort((a, b) => (rank.get(a.name.toLowerCase()) ?? 1e9) - (rank.get(b.name.toLowerCase()) ?? 1e9))
    .map(a => a.id);
}

// Weave same-artist tracks through similar-artist tracks so the seed artist is
// sprinkled, not clumped at the end.
function weave(sim: any[], seedArtist: any[]): any[] {
  const out: any[] = [];
  let si = 0, ai = 0;
  while (si < sim.length || ai < seedArtist.length) {
    if (out.length >= 3 && out.length % 4 === 3 && ai < seedArtist.length) out.push(seedArtist[ai++]);
    else if (si < sim.length) out.push(sim[si++]);
    else if (ai < seedArtist.length) out.push(seedArtist[ai++]);
    else break;
  }
  return out;
}

// mode=similar-artists, unit=songs (also the Subsonic getSimilarSongs path).
export async function similarTracks(db: Database.Database, seedTrackId: number, limit: number): Promise<any[]> {
  const seed = db.prepare(
    "SELECT t.artist_id, t.genre, ar.name AS artist FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id WHERE t.id = ?"
  ).get(seedTrackId) as any;
  if (!seed) return [];
  const seen = new Set<number>([seedTrackId]);
  const uniq = (rows: any[]) => rows.filter(r => r && !seen.has(r.id) && (seen.add(r.id), true));

  const matchedIds = await similarArtistIds(db, seed.artist);
  const sim: any[] = [];
  if (matchedIds.length) {
    const perArtist = db.prepare(`${TRACK_SELECT} WHERE t.artist_id = ? AND t.id <> ? ORDER BY RANDOM() LIMIT 6`);
    const lists = matchedIds.map(aid => perArtist.all(aid, seedTrackId) as any[]);
    const maxLen = Math.max(0, ...lists.map(l => l.length));
    for (let round = 0; round < maxLen && sim.length < limit; round++)
      for (const list of lists) { if (sim.length >= limit) break; if (list[round]) sim.push(...uniq([list[round]])); }
  }
  const cap = matchedIds.length ? Math.max(1, Math.ceil(limit * 0.35)) : limit;
  const seedArtist = seed.artist_id != null
    ? uniq(db.prepare(`${TRACK_SELECT} WHERE t.artist_id = ? AND t.id <> ? ORDER BY RANDOM() LIMIT ?`).all(seed.artist_id, seedTrackId, cap) as any[])
    : [];
  const picked = weave(sim, seedArtist);

  if (picked.length < limit && seed.genre)
    picked.push(...uniq(db.prepare(`${TRACK_SELECT} WHERE t.genre = ? COLLATE NOCASE AND t.id <> ? ORDER BY RANDOM() LIMIT ?`).all(seed.genre, seedTrackId, limit) as any[]));
  if (picked.length < Math.min(limit, 10))
    picked.push(...uniq(db.prepare(`${TRACK_SELECT} WHERE t.id <> ? ORDER BY RANDOM() LIMIT ?`).all(seedTrackId, limit) as any[]));
  return picked.slice(0, limit);
}

// mode=similar-songs (track.getSimilar): the matching library tracks, filled out
// with the artist-based station when there aren't enough exact matches.
async function similarSongTracks(db: Database.Database, seedTrackId: number, limit: number): Promise<any[]> {
  const seed = db.prepare("SELECT t.title, ar.name AS artist FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id WHERE t.id = ?").get(seedTrackId) as any;
  if (!seed) return [];
  const seen = new Set<number>([seedTrackId]);
  const uniq = (rows: any[]) => rows.filter(r => r && !seen.has(r.id) && (seen.add(r.id), true));
  const picked: any[] = [];
  if (lastfmKeyed() && seed.artist && seed.title) {
    const sims = await withTimeout(lfmSimilarTracks(seed.artist, seed.title, 100), 4000, [] as any[]).catch(() => []);
    const match = db.prepare(`${TRACK_SELECT} WHERE LOWER(t.title) = LOWER(?) AND LOWER(ar.name) = LOWER(?) LIMIT 1`);
    for (const s of sims) {
      if (picked.length >= limit) break;
      const row = match.get(s.title, s.artist) as any;
      if (row) picked.push(...uniq([row]));
    }
  }
  if (picked.length < limit) picked.push(...uniq(await similarTracks(db, seedTrackId, limit - picked.length)));
  return picked.slice(0, limit);
}

// favorites = songs rated 4+ or hearted; random = anywhere.
function poolTracks(db: Database.Database, userId: number, mode: string, limit: number): any[] {
  if (mode === "favorites")
    return db.prepare(
      `${TRACK_SELECT} WHERE t.id IN (
         SELECT ref_id FROM subsonic_ratings WHERE user_id = ? AND kind = 'track' AND rating >= 4
         UNION SELECT track_id FROM favorites WHERE user_id = ?)
       ORDER BY RANDOM() LIMIT ?`).all(userId, userId, limit) as any[];
  return db.prepare(`${TRACK_SELECT} ORDER BY RANDOM() LIMIT ?`).all(limit) as any[];
}

// Album ids to queue whole, per mode. `count` = number of albums.
async function candidateAlbums(db: Database.Database, seedTrackId: number | null, userId: number, mode: string, count: number): Promise<number[]> {
  if (mode === "favorites")
    return (db.prepare(
      `SELECT DISTINCT t.album_id AS id FROM tracks t WHERE t.album_id IS NOT NULL AND t.id IN (
         SELECT ref_id FROM subsonic_ratings WHERE user_id = ? AND kind = 'track' AND rating >= 4
         UNION SELECT track_id FROM favorites WHERE user_id = ?) ORDER BY RANDOM() LIMIT ?`
    ).all(userId, userId, count) as any[]).map(r => r.id);
  if (mode === "random")
    return (db.prepare(`SELECT id FROM albums al WHERE EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id) ORDER BY RANDOM() LIMIT ?`).all(count) as any[]).map(r => r.id);

  // similar (artists or songs both resolve to albums by similar artists)
  const seed = seedTrackId != null
    ? db.prepare("SELECT t.artist_id, ar.name AS artist FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id WHERE t.id = ?").get(seedTrackId) as any
    : null;
  const out: number[] = [];
  const seen = new Set<number>();
  const artistIds = seed ? await similarArtistIds(db, seed.artist) : [];
  const byArtist = db.prepare(`SELECT id FROM albums al WHERE al.artist_id = ? AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id) ORDER BY RANDOM() LIMIT 2`);
  const lists = artistIds.map(aid => (byArtist.all(aid) as any[]).map(r => r.id));
  for (let round = 0; round < 2 && out.length < count; round++)
    for (const l of lists) { if (out.length >= count) break; if (l[round] != null && !seen.has(l[round])) { seen.add(l[round]); out.push(l[round]); } }
  // Fallbacks: the seed artist's albums, then random albums.
  if (out.length < count && seed?.artist_id != null)
    for (const r of db.prepare(`SELECT id FROM albums al WHERE al.artist_id = ? AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id) ORDER BY RANDOM() LIMIT ?`).all(seed.artist_id, count) as any[])
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r.id); }
  if (out.length < Math.min(count, 3))
    for (const r of db.prepare(`SELECT id FROM albums al WHERE EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id) ORDER BY RANDOM() LIMIT ?`).all(count) as any[])
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r.id); }
  return out.slice(0, count);
}

// Unified Auto-DJ pool. `limit` is songs (unit=songs) or albums (unit=albums).
export async function autoDJPool(
  db: Database.Database,
  opts: { seedTrackId: number | null; userId: number; mode: string; unit: string; limit: number }
): Promise<any[]> {
  const { seedTrackId, userId, mode, unit, limit } = opts;
  if (unit === "albums") {
    const albumIds = await candidateAlbums(db, seedTrackId, userId, mode, Math.max(1, Math.min(20, limit)));
    const q = db.prepare(`${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.disc_no, t.track_no, t.title COLLATE NOCASE`);
    const out: any[] = [];
    for (const alId of albumIds) out.push(...(q.all(alId) as any[]));
    return out;
  }
  if (mode === "favorites" || mode === "random") return poolTracks(db, userId, mode, limit);
  if (mode === "similar-songs" && seedTrackId != null) return await similarSongTracks(db, seedTrackId, limit);
  if (seedTrackId != null) return await similarTracks(db, seedTrackId, limit); // similar-artists
  return poolTracks(db, userId, "random", limit); // no seed for a similar mode, keep it playing
}

// Resolve a seed track for any Subsonic id kind (a song is itself, an album or
// artist gives a representative track), so getSimilarSongs works for all three.
export function seedTrackFor(db: Database.Database, kind: "track" | "album" | "artist", num: number): number | null {
  if (kind === "track") return num;
  const col = kind === "album" ? "album_id" : "artist_id";
  const row = db.prepare(`SELECT id FROM tracks WHERE ${col} = ? ORDER BY RANDOM() LIMIT 1`).get(num) as any;
  return row?.id ?? null;
}

import type { FastifyInstance } from "fastify";
import * as rec from "../lib/recommend.js";
import { isAlbumArtist } from "../lib/credits.js";

// Last.fm period to ListenBrainz range.
const LB_RANGE: Record<string, string> = {
  "7day": "week", "1month": "month", "3month": "quarter",
  "6month": "half_yearly", "12month": "year", "overall": "all_time",
};

// Listening insights from play_counts. All-time only: just aggregate counts and
// last_played are stored.
export async function statsRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };

  // Time-ranged tops from the connected scrobble service. {connected:false} when
  // not connected.
  app.get("/api/stats/scrobbles", guard, async (req: any) => {
    const range = String(req.query.range || "1month");
    const accounts = app.db.prepare(
      "SELECT provider, username FROM scrobble_accounts WHERE user_id=?"
    ).all(req.user.id) as any[];
    const lfm = accounts.find(a => a.provider === "lastfm");
    const lb = accounts.find(a => a.provider === "listenbrainz");
    if (lfm?.username) {
      const [topArtists, topTracks, total] = await Promise.all([
        rec.lfmTopArtistsDetailed(lfm.username, range),
        rec.lfmTopTracksDetailed(lfm.username, range),
        rec.lfmUserPlaycount(lfm.username),
      ]);
      return { connected: true, provider: "lastfm", range, total, topArtists, topTracks };
    }
    if (lb?.username) {
      const r = LB_RANGE[range] || "month";
      const [topArtists, topTracks, total] = await Promise.all([
        rec.lbTopArtistsDetailed(lb.username, r),
        rec.lbTopTracksDetailed(lb.username, r),
        rec.lbListenCount(lb.username),
      ]);
      return { connected: true, provider: "listenbrainz", range, total, topArtists, topTracks };
    }
    return { connected: false };
  });

  app.get("/api/stats", guard, async () => {
    const db = app.db;
    const one = (sql: string) => (db.prepare(sql).get() as any) ?? {};

    const totals = {
      plays: one("SELECT COALESCE(SUM(count),0) AS v FROM play_counts").v,
      seconds: one("SELECT COALESCE(SUM(pc.count * t.duration),0) AS v FROM play_counts pc JOIN tracks t ON t.id = pc.track_id").v,
      tracks: one("SELECT COUNT(*) AS v FROM tracks").v,
      albums: one("SELECT COUNT(*) AS v FROM albums WHERE EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)").v,
      artists: one(`SELECT COUNT(*) AS v FROM artists WHERE ${isAlbumArtist("artists.id")}`).v,
    };

    const topArtists = db.prepare(
      `SELECT ar.id, ar.name, SUM(pc.count) AS plays
       FROM play_counts pc JOIN tracks t ON t.id = pc.track_id JOIN artists ar ON ar.id = t.artist_id
       GROUP BY ar.id HAVING plays > 0 ORDER BY plays DESC, ar.name LIMIT 12`
    ).all();

    const topAlbums = db.prepare(
      `SELECT al.id, al.title, ar.name AS artist, SUM(pc.count) AS plays
       FROM play_counts pc JOIN tracks t ON t.id = pc.track_id JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists ar ON ar.id = al.artist_id
       GROUP BY al.id HAVING plays > 0 ORDER BY plays DESC LIMIT 12`
    ).all();

    const topTracks = db.prepare(
      `SELECT t.id, t.title, t.album_id AS albumId, t.artist_id AS artistId, t.duration, ar.name AS artist, al.title AS album, pc.count AS plays
       FROM play_counts pc JOIN tracks t ON t.id = pc.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
       WHERE pc.count > 0 ORDER BY pc.count DESC LIMIT 20`
    ).all();

    const recent = db.prepare(
      `SELECT t.id, t.title, t.album_id AS albumId, t.artist_id AS artistId, t.duration, ar.name AS artist, al.title AS album, pc.last_played AS playedAt
       FROM play_counts pc JOIN tracks t ON t.id = pc.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
       WHERE pc.last_played IS NOT NULL ORDER BY pc.last_played DESC LIMIT 20`
    ).all();

    // Top genres by play count, via the genre index (weighted by plays of each
    // artist tagged with the genre).
    const topGenres = db.prepare(
      `SELECT ag.genre, SUM(pc.count) AS plays
       FROM artist_genres ag
       JOIN tracks t ON t.artist_id = ag.artist_id
       JOIN play_counts pc ON pc.track_id = t.id
       GROUP BY ag.genre HAVING plays > 0 ORDER BY plays DESC, ag.genre LIMIT 10`
    ).all();

    return { totals, topArtists, topAlbums, topTracks, topGenres, recent };
  });
}

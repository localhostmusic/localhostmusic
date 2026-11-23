import type { FastifyInstance } from "fastify";
import { isAlbumArtist } from "../lib/credits.js";

// Browse the library by genre, using the artist_genres index.
export async function genreRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };

  const albumLossless =
    "COALESCE((SELECT MIN(" +
    "(LOWER(path) LIKE '%.flac' OR LOWER(path) LIKE '%.wav' OR LOWER(path) LIKE '%.aiff' OR LOWER(path) LIKE '%.aif' OR LOWER(path) LIKE '%.ape' OR LOWER(path) LIKE '%.wv')" +
    ") FROM tracks WHERE tracks.album_id = al.id), 0) AS lossless";

  // All genres present in the library, with counts (most-represented first).
  app.get("/api/genres", guard, async () =>
    app.db.prepare(
      `SELECT ag.genre,
              COUNT(DISTINCT ag.artist_id) AS artists,
              COUNT(DISTINCT al.id)        AS albums
       FROM artist_genres ag
       JOIN artists a ON a.id = ag.artist_id
       LEFT JOIN albums al ON al.artist_id = ag.artist_id
            AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)
       WHERE ${isAlbumArtist("ag.artist_id")}
       GROUP BY ag.genre
       ORDER BY artists DESC, ag.genre`
    ).all());

  // One genre: its artists, albums, and tracks (tracks drive play / save-as-playlist).
  app.get("/api/genres/:genre", guard, async (req: any) => {
    const genre = decodeURIComponent(req.params.genre);
    const artists = app.db.prepare(
      `SELECT a.id, a.name FROM artist_genres ag JOIN artists a ON a.id = ag.artist_id
       WHERE ag.genre = ? AND ${isAlbumArtist("a.id")}
       ORDER BY a.name`
    ).all(genre);
    const albums = app.db.prepare(
      `SELECT al.id, al.title, al.year, al.artist_id, ar.name AS artist, ${albumLossless}
       FROM albums al JOIN artist_genres ag ON ag.artist_id = al.artist_id
       LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE ag.genre = ? AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)
       ORDER BY ar.name, al.year, al.title`
    ).all(genre);
    const tracks = app.db.prepare(
      `SELECT t.id, t.title, t.album_id AS albumId, t.artist_id AS artistId, t.duration,
              ar.name AS artist, alb.title AS album,
              (LOWER(t.path) LIKE '%.flac' OR LOWER(t.path) LIKE '%.wav' OR LOWER(t.path) LIKE '%.aiff' OR LOWER(t.path) LIKE '%.aif' OR LOWER(t.path) LIKE '%.ape' OR LOWER(t.path) LIKE '%.wv') AS lossless
       FROM tracks t
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums alb ON alb.id = t.album_id
       WHERE EXISTS (SELECT 1 FROM track_artists ta JOIN artist_genres ag ON ag.artist_id = ta.artist_id
                     WHERE ta.track_id = t.id AND ag.genre = ?)
       ORDER BY ar.name, alb.year, t.disc_no, t.track_no
       LIMIT 500`
    ).all(genre);
    return { genre, artists, albums, tracks };
  });
}

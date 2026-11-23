import type { FastifyInstance } from "fastify";

export async function favoriteRoutes(app: FastifyInstance) {
  const g = { preHandler: app.authRequired };

  app.get("/api/favorites", g, async (req: any) =>
    app.db.prepare(
      `SELECT t.id, t.title, t.duration, t.album_id AS albumId, t.artist_id AS artistId, ar.name AS artist, al.title AS album,
              (LOWER(t.path) LIKE '%.flac' OR LOWER(t.path) LIKE '%.wav' OR LOWER(t.path) LIKE '%.aiff' OR LOWER(t.path) LIKE '%.aif' OR LOWER(t.path) LIKE '%.ape' OR LOWER(t.path) LIKE '%.wv') AS lossless
       FROM favorites f
       JOIN tracks t ON t.id = f.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE f.user_id = ? ORDER BY t.title`
    ).all(req.user.id));

  app.post("/api/favorites/:trackId", g, async (req: any, reply) => {
    if (!app.db.prepare("SELECT 1 FROM tracks WHERE id=?").get(req.params.trackId))
      return reply.code(404).send({ error: "track not found" });
    app.db.prepare("INSERT OR IGNORE INTO favorites(user_id,track_id) VALUES(?,?)").run(req.user.id, req.params.trackId);
    return { ok: true };
  });

  app.delete("/api/favorites/:trackId", g, async (req: any) => {
    app.db.prepare("DELETE FROM favorites WHERE user_id=? AND track_id=?").run(req.user.id, req.params.trackId);
    return { ok: true };
  });

  // Ratings (0 to 5) and album/artist stars. Per-user, stored in the same
  // subsonic_ratings / subsonic_stars tables the Subsonic API uses.

  // One-shot load of the current user's rating/star state (like /api/favorites).
  app.get("/api/me/library-state", g, async (req: any) => {
    const uid = req.user.id;
    const ratings = app.db.prepare("SELECT ref_id, rating FROM subsonic_ratings WHERE user_id=? AND kind='track'").all(uid) as any[];
    const albums = app.db.prepare("SELECT ref_id FROM subsonic_stars WHERE user_id=? AND kind='album'").all(uid) as any[];
    const artists = app.db.prepare("SELECT ref_id FROM subsonic_stars WHERE user_id=? AND kind='artist'").all(uid) as any[];
    return {
      ratings: Object.fromEntries(ratings.map(r => [r.ref_id, r.rating])),
      starredAlbums: albums.map(r => r.ref_id),
      starredArtists: artists.map(r => r.ref_id),
    };
  });

  // Starred albums / artists, shaped for AlbumCard / the artist grid. Most
  // recently starred first.
  const ALBUM_LOSSLESS =
    `COALESCE((SELECT MIN(LOWER(path) LIKE '%.flac' OR LOWER(path) LIKE '%.wav' OR LOWER(path) LIKE '%.aiff'` +
    ` OR LOWER(path) LIKE '%.aif' OR LOWER(path) LIKE '%.ape' OR LOWER(path) LIKE '%.wv') FROM tracks WHERE tracks.album_id = al.id), 0)`;
  app.get("/api/me/starred-albums", g, async (req: any) =>
    app.db.prepare(
      `SELECT al.id, al.title, al.year, ar.name AS artist, ${ALBUM_LOSSLESS} AS lossless
       FROM subsonic_stars s JOIN albums al ON al.id = s.ref_id
       LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE s.user_id = ? AND s.kind = 'album' ORDER BY s.created_at DESC`
    ).all(req.user.id));

  app.get("/api/me/starred-artists", g, async (req: any) =>
    app.db.prepare(
      `SELECT ar.id, ar.name FROM subsonic_stars s JOIN artists ar ON ar.id = s.ref_id
       WHERE s.user_id = ? AND s.kind = 'artist' ORDER BY s.created_at DESC`
    ).all(req.user.id));

  // Ratings insights: distribution (1 to 5 stars), total, average, and the
  // highest-rated artists (at least 2 rated tracks).
  app.get("/api/me/rating-insights", g, async (req: any) => {
    const uid = req.user.id;
    const dist = app.db.prepare(
      "SELECT rating, COUNT(*) AS n FROM subsonic_ratings WHERE user_id=? AND kind='track' GROUP BY rating"
    ).all(uid) as any[];
    const counts = [0, 0, 0, 0, 0]; // index 0 = 1 star, index 4 = 5 stars
    let total = 0, sum = 0;
    for (const r of dist) { if (r.rating >= 1 && r.rating <= 5) { counts[r.rating - 1] = r.n; total += r.n; sum += r.rating * r.n; } }
    const topArtists = app.db.prepare(
      `SELECT ar.id, ar.name, COUNT(*) AS rated, ROUND(AVG(rt.rating), 1) AS avg
       FROM subsonic_ratings rt JOIN tracks t ON t.id = rt.ref_id JOIN artists ar ON ar.id = t.artist_id
       WHERE rt.user_id = ? AND rt.kind = 'track'
       GROUP BY ar.id HAVING rated >= 2 ORDER BY avg DESC, rated DESC LIMIT 5`
    ).all(uid);
    return { total, average: total ? Math.round((sum / total) * 10) / 10 : 0, counts, topArtists };
  });

  // Rated tracks for the ratings filter: ?rating=N returns exactly N stars,
  // otherwise every rated track (1 to 5), highest first. Same shape as /api/favorites.
  app.get("/api/me/rated", g, async (req: any) => {
    const exact = Number(req.query?.rating);
    const hasExact = Number.isFinite(exact) && exact >= 1 && exact <= 5;
    return app.db.prepare(
      `SELECT t.id, t.title, t.duration, t.album_id AS albumId, t.artist_id AS artistId, ar.name AS artist, al.title AS album, r.rating,
              (LOWER(t.path) LIKE '%.flac' OR LOWER(t.path) LIKE '%.wav' OR LOWER(t.path) LIKE '%.aiff' OR LOWER(t.path) LIKE '%.aif' OR LOWER(t.path) LIKE '%.ape' OR LOWER(t.path) LIKE '%.wv') AS lossless
       FROM subsonic_ratings r
       JOIN tracks t ON t.id = r.ref_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE r.user_id = ? AND r.kind = 'track' ${hasExact ? "AND r.rating = ?" : ""}
       ORDER BY r.rating DESC, t.title COLLATE NOCASE`
    ).all(...(hasExact ? [req.user.id, exact] : [req.user.id]));
  });

  app.put("/api/tracks/:id/rating", g, async (req: any, reply) => {
    const id = Number(req.params.id);
    const rating = Number(req.body?.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5)
      return reply.code(400).send({ error: "rating must be 0-5" });
    if (!app.db.prepare("SELECT 1 FROM tracks WHERE id=?").get(id))
      return reply.code(404).send({ error: "track not found" });
    if (rating === 0)
      app.db.prepare("DELETE FROM subsonic_ratings WHERE user_id=? AND kind='track' AND ref_id=?").run(req.user.id, id);
    else
      app.db.prepare("INSERT OR REPLACE INTO subsonic_ratings(user_id,kind,ref_id,rating) VALUES(?,'track',?,?)").run(req.user.id, id, rating);
    return { ok: true, rating };
  });

  // Album/artist star toggles (POST to star, DELETE to unstar).
  for (const [kind, table] of [["album", "albums"], ["artist", "artists"]] as const) {
    app.post(`/api/${kind}s/:id/star`, g, async (req: any, reply) => {
      const id = Number(req.params.id);
      if (!app.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id))
        return reply.code(404).send({ error: `${kind} not found` });
      app.db.prepare("INSERT OR IGNORE INTO subsonic_stars(user_id,kind,ref_id,created_at) VALUES(?,?,?,?)").run(req.user.id, kind, id, Date.now());
      return { ok: true, starred: true };
    });
    app.delete(`/api/${kind}s/:id/star`, g, async (req: any) => {
      app.db.prepare("DELETE FROM subsonic_stars WHERE user_id=? AND kind=? AND ref_id=?").run(req.user.id, kind, Number(req.params.id));
      return { ok: true, starred: false };
    });
  }
}

import type { FastifyInstance } from "fastify";

// Universal search: one query, every kind of content, grouped by kind.
// Music (artists/albums/tracks) comes from the FTS index the scanner maintains.
// Podcasts and radio are per-user tables, not in that index: they are scoped to
// the caller and small enough for a LIKE scan.
export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/search", { preHandler: app.authRequired }, async (req: any) => {
    const EMPTY = {
      artists: [], albums: [], tracks: [],
      audiobooks: [], podcasts: [], episodes: [], stations: [],
    };
    const { q } = req.query as any;
    if (!q || !String(q).trim()) return EMPTY;
    const db = app.db;
    const userId = req.user.id;

    // Quote each token so FTS5 operators in user input ((), :, ^, AND/OR/NEAR)
    // are treated as text. The final token is a prefix match.
    const tokens = String(q).trim().split(/\s+/)
      .map(t => t.replace(/"/g, "")).filter(Boolean);
    if (!tokens.length) return EMPTY;
    const match = tokens.map((t, i) => i === tokens.length - 1 ? `"${t}"*` : `"${t}"`).join(" ");
    const rows = db.prepare(
      "SELECT kind, ref_id FROM search_fts WHERE search_fts MATCH ? LIMIT 80"
    ).all(match) as any[];
    const ids = (k: string) => rows.filter(r => r.kind === k).map(r => r.ref_id as number);
    const ph = (list: number[]) => list.map(() => "?").join(",");
    const uniq = (list: number[]) => [...new Set(list)];

    const artistIds = ids("artist");

    // When artists match, include their albums and top songs too, not just
    // name-matched rows.
    let albumIds = ids("album");
    let trackIds = ids("track");
    if (artistIds.length) {
      const byArtistAlbums = db.prepare(
        `SELECT id FROM albums WHERE artist_id IN (${ph(artistIds)})`
      ).all(...artistIds) as any[];
      albumIds = uniq([...albumIds, ...byArtistAlbums.map(r => r.id)]);

      // Credited tracks, not just tracks filed under them. IN (subquery) so the
      // artist index drives it; an EXISTS form scans every track.
      const byArtistTracks = db.prepare(
        `SELECT t.id FROM tracks t
         LEFT JOIN play_counts pc ON pc.track_id = t.id
         WHERE t.id IN (SELECT track_id FROM track_artists
                        WHERE artist_id IN (${ph(artistIds)}))
         ORDER BY COALESCE(pc.count,0) DESC, t.title LIMIT 10`
      ).all(...artistIds) as any[];
      trackIds = uniq([...trackIds, ...byArtistTracks.map(r => r.id)]);
    } else {
      albumIds = uniq(albumIds);
      trackIds = uniq(trackIds);
    }

    // Fetch full rows, preserving the id ordering above.
    const fetchOrdered = (sql: string, list: number[]) => {
      if (!list.length) return [];
      const map = new Map<number, any>();
      for (const r of db.prepare(sql).all(...list) as any[]) map.set(r.id, r);
      return list.map(id => map.get(id)).filter(Boolean);
    };

    const LOSSLESS = (col: string) =>
      `(LOWER(${col}) LIKE '%.flac' OR LOWER(${col}) LIKE '%.wav' OR LOWER(${col}) LIKE '%.aiff' OR LOWER(${col}) LIKE '%.aif' OR LOWER(${col}) LIKE '%.ape' OR LOWER(${col}) LIKE '%.wv')`;

    // Albums and audiobooks share a table but get separate result groups.
    const albumRows = fetchOrdered(
      `SELECT al.id, al.title, al.year, al.artist_id, al.cover_path, ar.name AS artist,
              COALESCE(al.is_audiobook, 0) AS isAudiobook,
              COALESCE((SELECT MIN(${LOSSLESS("path")}) FROM tracks WHERE tracks.album_id = al.id), 0) AS lossless
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE al.id IN (${ph(albumIds)})`, albumIds);

    // LIKE needs its own escaping: a typed underscore or percent is a wildcard otherwise.
    const like = `%${String(q).trim().replace(/[\\%_]/g, c => "\\" + c)}%`;

    return {
      artists: artistIds.length
        ? db.prepare(`SELECT id,name FROM artists WHERE id IN (${ph(artistIds)})`).all(...artistIds)
        : [],
      albums: albumRows.filter((a: any) => !a.isAudiobook),
      audiobooks: albumRows.filter((a: any) => a.isAudiobook),
      tracks: fetchOrdered(
        `SELECT t.id, t.title, t.album_id AS albumId, t.artist_id AS artistId, t.duration,
                ar.name AS artist, al.title AS album, ${LOSSLESS("t.path")} AS lossless
         FROM tracks t
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums al ON al.id = t.album_id
         WHERE t.id IN (${ph(trackIds)})`, trackIds),

      // Per-user, so scoped to the caller.
      podcasts: db.prepare(
        `SELECT id, title, author, image_url AS image
         FROM podcast_channels
         WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')
         ORDER BY title LIMIT 8`
      ).all(userId, like, like),
      episodes: db.prepare(
        `SELECT e.id, e.title, e.pub_date AS pubDate, e.duration,
                e.channel_id AS channelId, c.title AS channel,
                COALESCE(e.image_url, c.image_url) AS image
         FROM podcast_episodes e JOIN podcast_channels c ON c.id = e.channel_id
         WHERE c.user_id = ? AND e.title LIKE ? ESCAPE '\\'
         ORDER BY e.pub_date DESC LIMIT 10`
      ).all(userId, like),
      stations: db.prepare(
        `SELECT id, name, stream_url AS streamUrl, favicon
         FROM internet_radio_stations
         WHERE user_id = ? AND name LIKE ? ESCAPE '\\'
         ORDER BY name LIMIT 8`
      ).all(userId, like),
    };
  });
}

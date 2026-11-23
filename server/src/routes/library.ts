import type { FastifyInstance } from "fastify";
import { createReadStream, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { extname, join } from "node:path";
import { parseFile } from "music-metadata";
import { config } from "../config.js";
import { thumbnail, bucketSize } from "../lib/thumbnail.js";
import { albumColors } from "../lib/artColor.js";
import { recordPlay } from "../lib/plays.js";
import { enqueueArtistImage, backfillArtistImages } from "../lib/artistImage.js";
import { getSettings } from "../lib/settings.js";
import { safeFetch, BlockedUrlError } from "../lib/ssrf.js";
import { similarTracks, autoDJPool } from "../lib/similar.js";
import { isAlbumArtist, APPEARS_ON_ALBUMS, creditsForTracks, groupCredits } from "../lib/credits.js";


// 1 when every track on the album is a lossless format (drives the LOSSLESS badge).
export const albumLossless = "COALESCE((SELECT MIN(" + "(LOWER(path) LIKE '%.flac' OR LOWER(path) LIKE '%.wav' OR LOWER(path) LIKE '%.aiff' OR LOWER(path) LIKE '%.aif' OR LOWER(path) LIKE '%.ape' OR LOWER(path) LIKE '%.wv')" + ") FROM tracks WHERE tracks.album_id = al.id), 0) AS lossless";
export async function libraryRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };

  // Library size + disk usage for the storage panel on the Account page.
  app.get("/api/library/storage", guard, async () => {
    const one = (sql: string) => ((app.db.prepare(sql).get() as any)?.v ?? 0) as number;
    const out: {
      totalSize: number; tracks: number; albums: number; artists: number;
      disk: { total: number; free: number; used: number } | null;
    } = {
      totalSize: one("SELECT COALESCE(SUM(size),0) AS v FROM tracks"),
      tracks: one("SELECT COUNT(*) AS v FROM tracks"),
      albums: one("SELECT COUNT(*) AS v FROM albums WHERE COALESCE(is_audiobook,0)=0 AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)"),
      artists: one(`SELECT COUNT(*) AS v FROM artists WHERE ${isAlbumArtist("artists.id")}`),
      disk: null,
    };
    try {
      const s = await statfs(config.musicDir);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize; // space actually writable by a normal user
      out.disk = { total, free, used: total - free };
    } catch { /* statfs unavailable on this platform/mount */ }
    return out;
  });

  // Cheap lossless check by extension (avoids reading every file for list views).
  // ALAC/.m4a is ambiguous so it's treated as lossy here.
  const lossless = (col: string) =>
    `(LOWER(${col}) LIKE '%.flac' OR LOWER(${col}) LIKE '%.wav' OR LOWER(${col}) LIKE '%.aiff' OR LOWER(${col}) LIKE '%.aif' OR LOWER(${col}) LIKE '%.ape' OR LOWER(${col}) LIKE '%.wv')`;

  // Album artists only (see lib/credits.ts). Guests and audiobook authors are excluded.
  app.get("/api/artists", guard, async () =>
    app.db.prepare(
      `SELECT id,name FROM artists WHERE ${isAlbumArtist("artists.id")} ORDER BY name`
    ).all());

  // Music albums. Audiobooks are served by /api/audiobooks.
  app.get("/api/albums", guard, async () =>
    app.db.prepare(
      `SELECT al.id, al.title, al.year, al.artist_id, ar.name AS artist, ${albumLossless}
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE COALESCE(al.is_audiobook, 0) = 0
         AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)
       ORDER BY ar.name, al.year, al.title`
    ).all());

  // Audiobooks: albums classified as spoken-word (a track is .m4b, lives under an
  // audiobooks folder, or is tagged with an audiobook-ish genre). Author = artist,
  // book = album, chapters = tracks; resume is per-track via bookmarks.
  app.get("/api/audiobooks", guard, async () =>
    app.db.prepare(
      `SELECT al.id, al.title, al.year, al.artist_id, ar.name AS artist, ${albumLossless},
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS trackCount,
              (SELECT COALESCE(SUM(t.duration),0) FROM tracks t WHERE t.album_id = al.id) AS duration
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE COALESCE(al.is_audiobook, 0) = 1
         AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)
       ORDER BY ar.name, al.title`
    ).all());

  // Bookmarks: per-(user,track) resume position in ms (shared table with the
  // Subsonic API). Written by the player for long-form audio.
  app.get("/api/bookmarks", guard, async (req: any) =>
    app.db.prepare(
      `SELECT b.track_id AS trackId, b.position, b.comment, b.changed,
              t.title, t.duration, t.album_id AS albumId, t.artist_id AS artistId,
              ar.name AS artist, al.title AS album
       FROM bookmarks b JOIN tracks t ON t.id = b.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE b.user_id = ? ORDER BY b.changed DESC`
    ).all(req.user.id));

  app.put("/api/bookmarks/:trackId", guard, async (req: any, reply) => {
    const trackId = Number(req.params.trackId);
    if (!app.db.prepare("SELECT 1 FROM tracks WHERE id=?").get(trackId))
      return reply.code(404).send({ error: "track not found" });
    const position = Math.max(0, Math.round(Number((req.body as any)?.position) || 0));
    const comment = (req.body as any)?.comment != null ? String((req.body as any).comment) : null;
    const now = Date.now();
    app.db.prepare(
      `INSERT INTO bookmarks(user_id, track_id, position, comment, created, changed)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id, track_id) DO UPDATE SET
         position = excluded.position, comment = excluded.comment, changed = excluded.changed`
    ).run(req.user.id, trackId, position, comment, now, now);
    return { ok: true };
  });

  app.delete("/api/bookmarks/:trackId", guard, async (req: any) => {
    app.db.prepare("DELETE FROM bookmarks WHERE user_id=? AND track_id=?")
      .run(req.user.id, Number(req.params.trackId));
    return { ok: true };
  });

  // Chapters for a chaptered file (single-file .m4b audiobooks). Cached in
  // track_chapters after the first ffprobe; [] for files with no embedded chapters.
  const ffprobe = promisify(execFile);
  app.get("/api/tracks/:id/chapters", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const cached = app.db.prepare(
      "SELECT idx, title, start_ms AS startMs, end_ms AS endMs FROM track_chapters WHERE track_id=? ORDER BY idx"
    ).all(id) as any[];
    if (cached.length) return cached;
    const row = app.db.prepare("SELECT path FROM tracks WHERE id=?").get(id) as any;
    if (!row) return reply.code(404).send({ error: "track not found" });
    let chapters: any[] = [];
    try {
      const { stdout } = await ffprobe("ffprobe",
        ["-v", "quiet", "-print_format", "json", "-show_chapters", row.path],
        { maxBuffer: 8 * 1024 * 1024 });
      chapters = ((JSON.parse(stdout || "{}").chapters) || []).map((c: any, i: number) => ({
        idx: i,
        title: c.tags?.title || `Chapter ${i + 1}`,
        startMs: Math.round(Number(c.start_time) * 1000) || 0,
        endMs: c.end_time != null ? Math.round(Number(c.end_time) * 1000) : null,
      }));
    } catch { chapters = []; } // no ffprobe / unreadable: treat as chapterless
    if (chapters.length) {
      const ins = app.db.prepare(
        "INSERT OR REPLACE INTO track_chapters(track_id, idx, title, start_ms, end_ms) VALUES(?,?,?,?,?)");
      app.db.transaction((rows: any[]) => { for (const c of rows) ins.run(id, c.idx, c.title, c.startMs, c.endMs); })(chapters);
    }
    return chapters;
  });

  // Integrated loudness (LUFS) for a track, for client-side volume normalization.
  // null until the background backfill has analyzed it.
  app.get("/api/tracks/:id/loudness", guard, async (req: any) => {
    const row = app.db.prepare("SELECT loudness FROM tracks WHERE id=?").get(Number(req.params.id)) as any;
    return { loudness: row && typeof row.loudness === "number" ? row.loudness : null };
  });

  // Internet-radio stations (per user), same table the Subsonic API uses.
  app.get("/api/radio", guard, async (req: any) =>
    app.db.prepare(
      "SELECT id, name, stream_url AS streamUrl, homepage_url AS homepageUrl, favicon FROM internet_radio_stations WHERE user_id=? ORDER BY name COLLATE NOCASE"
    ).all(req.user.id));

  // Search the radio-browser.info directory for stations. Tries a few mirrors.
  app.get("/api/radio/search", guard, async (req: any, reply) => {
    const q = String((req.query as any)?.q ?? "").trim();
    if (!q) return [];
    const mirrors = ["https://de1.api.radio-browser.info", "https://nl1.api.radio-browser.info", "https://at1.api.radio-browser.info"];
    for (const base of mirrors) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 8000);
        const res = await fetch(`${base}/json/stations/search?name=${encodeURIComponent(q)}&limit=40&hidebroken=true&order=votes&reverse=true`,
          { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic/1.0" } });
        clearTimeout(timer);
        if (!res.ok) continue;
        const rows = await res.json() as any[];
        return rows.filter(s => s.url_resolved || s.url).map(s => ({
          name: (s.name || "").trim() || "Unknown", url: s.url_resolved || s.url, favicon: s.favicon || null,
          homepage: s.homepage || null, tags: s.tags || "", country: s.country || "", bitrate: s.bitrate || 0, codec: s.codec || "",
        })).slice(0, 40);
      } catch { /* try the next mirror */ }
    }
    return reply.code(502).send({ error: "The station directory is unavailable right now." });
  });

  // Resolve and validate a radio URL server-side (the browser can't probe most
  // streams because of CORS). Follows a .pls/.m3u playlist to its stream URL, then
  // confirms the target serves audio.
  app.post("/api/radio/resolve", guard, async (req: any) => {
    const raw = String(req.body?.url ?? "").trim();
    if (!/^https?:\/\//i.test(raw)) return { ok: false, error: "Enter a full http(s):// URL." };
    return resolveStation(raw, 0);
  });

  app.post("/api/radio", guard, async (req: any, reply) => {
    const name = String(req.body?.name ?? "").trim();
    const streamUrl = String(req.body?.streamUrl ?? "").trim();
    if (!name || !streamUrl) return reply.code(400).send({ error: "name and streamUrl are required" });
    const favicon = req.body?.favicon ? String(req.body.favicon).trim() : null;
    const r = app.db.prepare(
      "INSERT INTO internet_radio_stations(user_id, name, stream_url, homepage_url, favicon, created) VALUES(?,?,?,?,?,?)"
    ).run(req.user.id, name, streamUrl, req.body?.homepageUrl ? String(req.body.homepageUrl).trim() : null, favicon, Date.now());
    return { id: r.lastInsertRowid, name, streamUrl };
  });

  app.put("/api/radio/:id", guard, async (req: any, reply) => {
    const name = String(req.body?.name ?? "").trim();
    const streamUrl = String(req.body?.streamUrl ?? "").trim();
    if (!name || !streamUrl) return reply.code(400).send({ error: "name and streamUrl are required" });
    const r = app.db.prepare(
      "UPDATE internet_radio_stations SET name=?, stream_url=?, homepage_url=? WHERE id=? AND user_id=?"
    ).run(name, streamUrl, req.body?.homepageUrl ? String(req.body.homepageUrl).trim() : null, Number(req.params.id), req.user.id);
    if (!r.changes) return reply.code(404).send({ error: "station not found" });
    return { ok: true };
  });

  app.delete("/api/radio/:id", guard, async (req: any) => {
    app.db.prepare("DELETE FROM internet_radio_stations WHERE id=? AND user_id=?").run(Number(req.params.id), req.user.id);
    return { ok: true };
  });

  // Proxy a station's stream so the browser plays it same-origin: a cross-origin
  // stream taints the Web Audio graph (the visualizer gets silence). ICY metadata is
  // requested, stripped from the audio, and the StreamTitle kept for /nowplaying.
  // `:id` is a saved station, never an arbitrary URL, so this isn't an open proxy.
  app.get("/api/radio/:id/stream", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const row = app.db.prepare("SELECT stream_url FROM internet_radio_stations WHERE id=? AND user_id=?").get(id, req.user.id) as any;
    if (!row?.stream_url) return reply.code(404).send();
    const ac = new AbortController();
    let upstream: Response;
    try {
      // The station URL is user-supplied, so it goes through the SSRF guard (lib/ssrf.ts).
      upstream = await safeFetch(row.stream_url, { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic", "Icy-MetaData": "1" } });
    } catch (e) {
      if (e instanceof BlockedUrlError) return reply.code(400).send({ error: e.message });
      return reply.code(502).send();
    }
    if (!upstream.body || (!upstream.ok && upstream.status !== 200)) return reply.code(502).send();
    reply.header("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
    reply.header("Cache-Control", "no-store");
    const metaint = Number(upstream.headers.get("icy-metaint")) || 0;
    const source = Readable.fromWeb(upstream.body as any);
    // Aborting the upstream on client disconnect makes these streams emit 'error'
    // (AbortError). Swallow it on every stream so it can't crash the server.
    source.on("error", () => {});
    let out: Readable = source;
    if (metaint > 0) {
      const strip = icyStripper(metaint, (title) => radioNowPlaying.set(id, { title, at: Date.now() }));
      strip.on("error", () => {});
      out = source.pipe(strip);
      out.on("error", () => {});
    }
    req.raw.on("close", () => { ac.abort(); source.destroy(); });
    return reply.send(out);
  });

  // Last-seen "now playing" title for a station (from ICY metadata via the proxy).
  app.get("/api/radio/:id/nowplaying", guard, async (req: any) => {
    const np = radioNowPlaying.get(Number(req.params.id));
    return { title: np && Date.now() - np.at < 10 * 60 * 1000 ? np.title : null };
  });

  // Albums the artist owns (they're the album artist).
  app.get("/api/artists/:id/albums", guard, async (req) => {
    const { id } = req.params as any;
    return app.db.prepare(
      `SELECT al.id, al.title, al.year, al.cover_path, ${albumLossless}
       FROM albums al
       WHERE al.artist_id=? AND COALESCE(al.is_audiobook, 0) = 0
         AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)
       ORDER BY al.year, al.title`
    ).all(id);
  });

  // Every track credited to the artist, newest release first. Backs the artist
  // page's Play/Shuffle and its Top Songs shelf.
  // Credits come from track_artists, not tracks.artist_id, so guest appearances count.
  app.get("/api/artists/:id/tracks", guard, async (req) => {
    const { id } = req.params as any;
    const tracks = app.db.prepare(
      `SELECT t.id, t.title, t.duration, t.track_no, t.disc_no,
              t.album_id AS albumId, al.title AS album, al.year,
              t.artist_id AS artistId, ar.name AS artist,
              ${lossless("t.path")} AS lossless, COALESCE(pc.count, 0) AS plays
       FROM track_artists ta
       JOIN tracks t ON t.id = ta.track_id
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN play_counts pc ON pc.track_id = t.id
       WHERE ta.artist_id = ?
       ORDER BY al.year DESC, al.id, t.disc_no, t.track_no`
    ).all(id) as any[];
    return { tracks };
  });

  app.get("/api/artists/:id/appears-on", guard, async (req) => {
    const { id } = req.params as any;
    const albums = app.db.prepare(APPEARS_ON_ALBUMS).all(id, id) as any[];
    if (!albums.length) return { albums: [], tracks: [] };

    // The specific tracks they're on, so the shelf can say why they appear here.
    const tracks = app.db.prepare(
      `SELECT t.id, t.title, t.duration, t.album_id AS albumId, t.track_no AS trackNo,
              al.title AS album, ar.name AS artist, ta.role,
              ${lossless("t.path")} AS lossless
       FROM track_artists ta
       JOIN tracks t  ON t.id = ta.track_id
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       WHERE ta.artist_id = ?
         AND COALESCE(al.is_audiobook, 0) = 0
         AND (al.artist_id IS NULL OR al.artist_id <> ?)
       ORDER BY al.year, al.title, t.disc_no, t.track_no`
    ).all(id, id);
    return { albums, tracks };
  });

  // Technical audio quality for a track (format/bitrate/sample rate/etc).
  // Requested on every track change, so cached by (id, mtime).
  const qualityCache = new Map<number, { mtime: number; data: any }>();
  app.get("/api/tracks/:id/quality", guard, async (req, reply) => {
    const id = Number((req.params as any).id);
    const row = app.db.prepare("SELECT path, size FROM tracks WHERE id=?").get(id) as any;
    if (!row) return reply.code(404).send({ error: "track not found" });
    try {
      const mtime = statSync(row.path).mtimeMs;
      const hit = qualityCache.get(id);
      if (hit && hit.mtime === mtime) return hit.data;
      const f = (await parseFile(row.path, { duration: false })).format;
      const data = {
        ext: extname(row.path).replace(".", "").toUpperCase(),
        container: f.container ?? null,
        codec: f.codec ?? null,
        lossless: !!f.lossless,
        bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null, // kbps
        sampleRate: f.sampleRate ?? null,                          // Hz
        bitsPerSample: f.bitsPerSample ?? null,
        channels: f.numberOfChannels ?? null,
        size: row.size,
      };
      if (qualityCache.size > 5000) qualityCache.clear();
      qualityCache.set(id, { mtime, data });
      return data;
    } catch (e: any) {
      return reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });

  // Record a play (drives "most played" discovery and your Home history).
  app.post("/api/tracks/:id/play", guard, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!app.db.prepare("SELECT 1 FROM tracks WHERE id=?").get(id))
      return reply.code(404).send({ error: "track not found" });
    recordPlay(app.db, req.user!.id, id, Date.now());
    return { ok: true };
  });

  // Similar tracks for "Start radio" / Auto DJ. Uses Last.fm similar-artists
  // (matched against this library) with local fallbacks, see lib/similar.ts.
  app.get("/api/tracks/:id/similar", guard, async (req, reply) => {
    const id = Number((req.params as any).id);
    const limit = Math.min(100, Math.max(1, Number((req.query as any).limit) || 40));
    if (!app.db.prepare("SELECT 1 FROM tracks WHERE id=?").get(id))
      return reply.code(404).send({ error: "track not found" });
    return await similarTracks(app.db, id, limit);
  });

  // Unified Auto DJ pool. mode = similar-artists|similar-songs|favorites|random;
  // unit = songs|albums; limit = songs (or albums when unit=albums); seed = track id.
  app.get("/api/autodj", guard, async (req: any) => {
    const mode = String(req.query?.mode ?? "similar-artists");
    const unit = String(req.query?.unit ?? "songs");
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
    const seed = req.query?.seed ? Number(req.query.seed) : null;
    return await autoDJPool(app.db, { seedTrackId: seed, userId: req.user.id, mode, unit, limit });
  });

  // Discovery for the empty search screen: everything, most-played first.
  app.get("/api/discover", guard, async () => {
    const artists = app.db.prepare(
      `SELECT ar.id, ar.name, SUM(COALESCE(pc.count,0)) AS plays
       FROM artists ar
       LEFT JOIN tracks t ON t.artist_id = ar.id
       LEFT JOIN play_counts pc ON pc.track_id = t.id
       WHERE ar.name <> 'Unknown Artist'
       GROUP BY ar.id HAVING COUNT(t.id) > 0 ORDER BY plays DESC, ar.name LIMIT 24`
    ).all();
    const albums = app.db.prepare(
      `SELECT al.id, al.title, al.year, ar.name AS artist, ${albumLossless}, SUM(COALESCE(pc.count,0)) AS plays
       FROM albums al
       LEFT JOIN artists ar ON ar.id = al.artist_id
       LEFT JOIN tracks t ON t.album_id = al.id
       LEFT JOIN play_counts pc ON pc.track_id = t.id
       GROUP BY al.id HAVING COUNT(t.id) > 0 ORDER BY plays DESC, ar.name, al.title LIMIT 24`
    ).all();
    const tracks = app.db.prepare(
      `SELECT t.id, t.title, t.album_id AS albumId, t.artist_id AS artistId, t.duration, ar.name AS artist, al.title AS album,
              ${lossless("t.path")} AS lossless, COALESCE(pc.count,0) AS plays
       FROM tracks t
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       LEFT JOIN play_counts pc ON pc.track_id = t.id
       ORDER BY plays DESC, t.title LIMIT 20`
    ).all();
    return { artists, albums, tracks };
  });

  // Recently played albums (most recent first), derived from play_counts.last_played.
  app.get("/api/recent", guard, async () =>
    app.db.prepare(
      `SELECT al.id, al.title, al.year, ar.name AS artist, ${albumLossless},
              MAX(pc.last_played) AS played
       FROM play_counts pc
       JOIN tracks t ON t.id = pc.track_id
       JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE pc.last_played IS NOT NULL
       GROUP BY al.id ORDER BY played DESC LIMIT 18`
    ).all());

  app.get("/api/albums/:id", guard, async (req) => {
    const { id } = req.params as any;
    const album = app.db.prepare(
      `SELECT al.id, al.title, al.year, al.artist_id, ar.name AS artist
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE al.id = ?`
    ).get(id);
    const tracks = app.db.prepare(
      `SELECT t.id, t.title, t.track_no, t.disc_no, t.duration, t.artist_id AS artistId, ar.name AS artist, ${lossless("t.path")} AS lossless
       FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
       WHERE t.album_id = ? ORDER BY t.disc_no, t.track_no`
    ).all(id) as any[];

    // Attach the full credit list per track. One query for the whole album.
    if (tracks.length) {
      const ids = tracks.map(t => t.id);
      const rows = app.db.prepare(creditsForTracks(ids.map(() => "?").join(","))).all(...ids) as any[];
      const by = groupCredits(rows);
      for (const t of tracks) t.artists = by.get(t.id) ?? [];
    }
    return { ...(album as object), tracks };
  });

  // Image routes have no auth guard: the OS/MPRIS media widget fetches artwork
  // without the session cookie.
  // Serves an image file with an mtime/size ETag so expired cache entries
  // revalidate as a 304.
  const sendImage = async (req: any, reply: any, path: string, maxAge: number) => {
    try { statSync(path); } catch { return reply.code(404).send(); }
    // ?size=N serves a cached, resized thumbnail (snapped to a size bucket).
    const size = bucketSize(req.query?.size);
    let filePath = path;
    if (size) {
      try { filePath = await thumbnail(path, size, join(config.dataDir, "thumb-cache")); }
      catch { filePath = path; } // resize failed, fall back to the original
    }
    let st;
    try { st = statSync(filePath); } catch { return reply.code(404).send(); }
    const etag = `"${st.mtimeMs}-${st.size}-${size ?? 0}"`;
    // Artwork URLs don't change when the artwork does, so stale-while-revalidate
    // lets a corrected image reach clients that bypass the service worker.
    reply.header("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=604800`)
      .header("ETag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.type("image/jpeg");
    return createReadStream(filePath);
  };

  app.get("/api/artists/:id/image", async (req, reply) => {
    const { id } = req.params as any;
    const row = app.db.prepare("SELECT path FROM artist_images WHERE artist_id=?").get(id) as any;
    if (row === undefined) {
      // Never looked yet: start a background fetch, 404 for now (client shows a monogram).
      const ar = app.db.prepare("SELECT name FROM artists WHERE id=?").get(id) as any;
      if (ar?.name && getSettings(app.db).onlineArtistMeta) enqueueArtistImage(app.db, Number(id), ar.name);
      return reply.code(404).send();
    }
    if (!row.path) return reply.code(404).send(); // negative marker: looked, none found
    return sendImage(req, reply, row.path, 3600);
  });

  // On startup, backfill artist images for the whole library in the background (rate-limited).
  if (getSettings(app.db).onlineArtistMeta) backfillArtistImages(app.db);

  // albumId to cover colour map, for painting grid tiles before their images arrive.
  app.get("/api/albums/colors", guard, async (_req, reply) => {
    reply.header("Cache-Control", "private, max-age=300");
    return albumColors(app.db, config.dataDir);
  });

  app.get("/api/albums/:id/cover", async (req, reply) => {
    const { id } = req.params as any;
    const row = app.db.prepare("SELECT cover_path FROM albums WHERE id=?").get(id) as any;
    if (!row?.cover_path) return reply.code(404).send();
    return sendImage(req, reply, row.cover_path, 86400);
  });
}

type ResolveResult =
  | { ok: true; streamUrl: string; contentType: string; name?: string }
  | { ok: false; error: string };

// Pull the first http(s) stream URL (and a title) out of a .pls or .m3u body.
function parsePlaylist(body: string): { url?: string; title?: string } {
  const pls = body.match(/^\s*File\d+\s*=\s*(\S+)/im);
  const title = body.match(/^\s*Title\d+\s*=\s*(.+)$/im)?.[1]?.trim();
  if (pls) return { url: pls[1].trim(), title };
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#") && /^https?:\/\//i.test(t)) return { url: t, title };
  }
  return { title };
}

async function resolveStation(url: string, depth: number): Promise<ResolveResult> {
  if (depth > 2) return { ok: false, error: "Too many playlist redirects." };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await safeFetch(url, { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic", "Icy-MetaData": "0" } });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const finalUrl = res.url || url;
    const isPlaylist = /scpls|mpegurl|pls\+xml|vnd\.apple\.mpegurl/.test(ct) || /\.(pls|m3u|m3u8)(\?|$)/i.test(finalUrl);
    if (isPlaylist) {
      const body = await res.text();
      const { url: inner, title } = parsePlaylist(body);
      if (!inner) return { ok: false, error: "That playlist had no stream URL." };
      const r = await resolveStation(inner, depth + 1);
      return r.ok ? { ...r, name: r.name || title } : r;
    }
    ac.abort(); // a (possible) stream, don't download the body
    if (!res.ok && res.status !== 200 && res.status !== 206) return { ok: false, error: `Stream returned HTTP ${res.status}.` };
    const isAudio = /^(audio|video)\//.test(ct) || /(ogg|mpegurl|aacp|octet-stream)/.test(ct);
    if (!isAudio) return { ok: false, error: `That doesn't look like an audio stream (type: ${ct || "unknown"}).` };
    return { ok: true, streamUrl: finalUrl, contentType: ct };
  } catch (e) {
    if (e instanceof BlockedUrlError) return { ok: false, error: e.message };
    return { ok: false, error: "Couldn't reach that URL (timeout or blocked)." };
  } finally { clearTimeout(timer); }
}

// Last-seen StreamTitle per station id (in-memory; the /nowplaying endpoint reads it).
const radioNowPlaying = new Map<number, { title: string; at: number }>();

// ICY (SHOUTcast/Icecast) interleaves metadata into the audio: after every `metaint`
// bytes of audio comes a length byte (x16) and a metadata block containing
// StreamTitle. Strips those blocks, forwards only audio, and reports the title.
function icyStripper(metaint: number, onTitle: (t: string) => void): Transform {
  let audioLeft = metaint;   // audio bytes until the next metadata block
  let metaLeft = 0;          // metadata bytes still to read
  let expectLen = false;     // the next byte is the metadata length (x16)
  let metaChunks: Buffer[] = [];
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const out: Buffer[] = [];
      let i = 0;
      while (i < chunk.length) {
        if (metaLeft > 0) {
          const take = Math.min(metaLeft, chunk.length - i);
          metaChunks.push(chunk.subarray(i, i + take));
          i += take; metaLeft -= take;
          if (metaLeft === 0) {
            const m = Buffer.concat(metaChunks).toString("utf8").match(/StreamTitle='(.*?)';/);
            metaChunks = [];
            if (m && m[1]) onTitle(m[1].trim());
            audioLeft = metaint;
          }
        } else if (expectLen) {
          metaLeft = chunk[i] * 16; i += 1; expectLen = false;
          if (metaLeft === 0) audioLeft = metaint; // no metadata this cycle
        } else {
          const take = Math.min(audioLeft, chunk.length - i);
          out.push(chunk.subarray(i, i + take));
          i += take; audioLeft -= take;
          if (audioLeft === 0) expectLen = true;
        }
      }
      cb(null, out.length ? Buffer.concat(out) : Buffer.alloc(0));
    },
  });
}

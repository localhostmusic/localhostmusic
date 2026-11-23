import type { FastifyInstance } from "fastify";
import { publishToLrclib } from "../lib/lrclib.js";

const LRCLIB = "https://lrclib.net/api";
const UA = "LocalhostMusic/1.0 (self-hosted music server)";

// How long a "checked LRCLIB, found nothing" result stays cached before a re-check.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Fetch lyrics for a track from LRCLIB (https://lrclib.net), caching results in the
// DB. Returns { synced, plain, source }: `synced` is LRC (timestamped) when available.
export async function lyricsRoutes(app: FastifyInstance) {
  // Save manually-synced (or pasted) lyrics for a track, overriding the cache.
  app.post("/api/tracks/:id/lyrics", { preHandler: app.authRequired }, async (req: any, reply) => {
    const id = Number(req.params.id);
    const { synced, plain } = req.body ?? {};
    if (!synced && !plain) return reply.code(400).send({ error: "nothing to save" });
    if (!app.db.prepare("SELECT id FROM tracks WHERE id=?").get(id)) {
      return reply.code(404).send({ error: "track not found" });
    }
    app.db.prepare(
      "INSERT OR REPLACE INTO track_lyrics(track_id,synced,plain,source,fetched_at) VALUES(?,?,?,?,?)"
    ).run(id, synced ?? null, plain ?? null, "manual", Date.now());
    return { ok: true };
  });

  // List every set of user-created ("manual") lyrics, flagged by whether it has
  // been published to LRCLIB. Unpublished sorted first.
  app.get("/api/lyrics/mine", { preHandler: app.authRequired }, async () => {
    const rows = app.db.prepare(
      `SELECT tl.track_id AS trackId, t.title, t.album_id AS albumId,
              ar.name AS artist, al.title AS album,
              (tl.synced IS NOT NULL AND tl.synced <> '') AS synced,
              (tl.published_at IS NOT NULL) AS published
       FROM track_lyrics tl
       JOIN tracks t ON t.id = tl.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE tl.source = 'manual'
       ORDER BY published ASC, tl.fetched_at DESC`
    ).all() as any[];
    return rows.map((r) => ({ ...r, synced: !!r.synced, published: !!r.published }));
  });

  // Publish a user's hand-synced lyrics to LRCLIB: reads the saved lyrics and track
  // signature, solves LRCLIB's proof-of-work challenge, and submits. Only "manual"
  // lyrics are publishable, never lyrics fetched from LRCLIB.
  app.post("/api/tracks/:id/lyrics/publish", { preHandler: app.authRequired }, async (req: any, reply) => {
    const id = Number(req.params.id);
    const track = app.db.prepare(
      `SELECT t.title, t.duration, ar.name AS artist, al.title AS album
       FROM tracks t
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE t.id = ?`
    ).get(id) as any;
    if (!track) return reply.code(404).send({ error: "track not found" });

    const row = app.db.prepare(
      "SELECT synced, plain, source FROM track_lyrics WHERE track_id=?"
    ).get(id) as any;
    if (!row || (!row.synced && !row.plain)) {
      return reply.code(400).send({ error: "no lyrics to publish" });
    }
    if (row.source !== "manual") {
      return reply.code(400).send({ error: "only lyrics you created can be published" });
    }

    try {
      await publishToLrclib({
        trackName: track.title ?? "",
        artistName: track.artist ?? "",
        albumName: track.album ?? "",
        duration: Math.round(track.duration ?? 0),
        plainLyrics: row.plain ?? "",
        syncedLyrics: row.synced ?? "",
      });
    } catch (e: any) {
      return reply.code(502).send({ error: e?.message || "publish failed" });
    }

    app.db.prepare("UPDATE track_lyrics SET published_at=? WHERE track_id=?").run(Date.now(), id);
    return { ok: true };
  });

  app.get("/api/tracks/:id/lyrics", { preHandler: app.authRequired }, async (req, reply) => {
    const trackId = Number((req.params as any).id);

    const cached = app.db.prepare(
      "SELECT synced, plain, source, fetched_at, published_at FROM track_lyrics WHERE track_id=?"
    ).get(trackId) as any;
    // A real hit (LRCLIB or manual) is cached forever.
    if (cached && (cached.synced || cached.plain)) {
      return { synced: cached.synced, plain: cached.plain, source: cached.source, published: !!cached.published_at };
    }
    // A negative-cached miss (source="none") skips LRCLIB until it goes stale.
    if (cached && cached.source === "none" && Date.now() - (cached.fetched_at ?? 0) < MISS_TTL_MS) {
      return { synced: null, plain: null, source: null };
    }

    const track = app.db.prepare(
      `SELECT t.title, t.duration, ar.name AS artist, al.title AS album
       FROM tracks t
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE t.id = ?`
    ).get(trackId) as any;
    if (!track) return reply.code(404).send({ error: "track not found" });

    let data: any = null;
    try {
      const params = new URLSearchParams({
        track_name: track.title ?? "",
        artist_name: track.artist ?? "",
        album_name: track.album ?? "",
        duration: String(Math.round(track.duration ?? 0)),
      });
      const r = await fetch(`${LRCLIB}/get?${params}`, { headers: { "User-Agent": UA } });
      if (r.ok) {
        data = await r.json();
      } else {
        // Fall back to a fuzzy search when the exact signature doesn't match.
        const sp = new URLSearchParams({ track_name: track.title ?? "", artist_name: track.artist ?? "" });
        const sr = await fetch(`${LRCLIB}/search?${sp}`, { headers: { "User-Agent": UA } });
        if (sr.ok) {
          const arr = await sr.json();
          if (Array.isArray(arr) && arr.length) data = arr.find((x: any) => x.syncedLyrics) ?? arr[0];
        }
      }
    } catch {
      return { synced: null, plain: null, source: null, error: "fetch failed" };
    }

    const result = {
      synced: data?.syncedLyrics || null,
      plain: data?.plainLyrics || null,
      source: data ? "lrclib" : null,
    };
    if (result.synced || result.plain) {
      app.db.prepare(
        "INSERT OR REPLACE INTO track_lyrics(track_id,synced,plain,source,fetched_at) VALUES(?,?,?,?,?)"
      ).run(trackId, result.synced, result.plain, result.source, Date.now());
    } else {
      // Miss: record "checked, none found". Re-checked after MISS_TTL_MS; a later
      // manual save overwrites this row.
      app.db.prepare(
        "INSERT OR REPLACE INTO track_lyrics(track_id,synced,plain,source,fetched_at) VALUES(?,NULL,NULL,'none',?)"
      ).run(trackId, Date.now());
    }
    return result;
  });
}

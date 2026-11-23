import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseByteRange } from "../lib/range.js";
import { config } from "../config.js";
import { fetchFeed, syncEpisodes, parseTranscript } from "../lib/podcast.js";
import { safeFetch, BlockedUrlError } from "../lib/ssrf.js";

export async function podcastRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };
  const db = app.db;
  const addEpisodes = (channelId: number, eps: any[]): number => syncEpisodes(db, channelId, eps);
  const downloadDir = join(config.dataDir, "podcasts");
  // In-flight download progress by episode id, polled by the client. Cleared when
  // the download settles.
  const downloadProgress = new Map<number, { done: number; total: number }>();
  // Episode belongs to a channel the requesting user owns.
  const ownedEpisode = (id: number, userId: number) => db.prepare(
    `SELECT e.id, e.audio_url, e.audio_type, e.local_path, e.transcript_url, e.transcript_type
     FROM podcast_episodes e JOIN podcast_channels c ON c.id = e.channel_id WHERE e.id = ? AND c.user_id = ?`).get(id, userId) as any;

  app.get("/api/podcasts", guard, async (req: any) =>
    db.prepare(
      `SELECT c.id, c.title, c.author, c.description, c.image_url AS imageUrl, c.feed_url AS feedUrl,
              (SELECT COUNT(*) FROM podcast_episodes e WHERE e.channel_id = c.id) AS episodeCount,
              (SELECT COUNT(*) FROM podcast_episodes e WHERE e.channel_id = c.id AND e.played = 0) AS unplayed
       FROM podcast_channels c WHERE c.user_id = ? ORDER BY c.title COLLATE NOCASE`
    ).all(req.user.id));

  // Search the Apple Podcasts directory (free, no key). Returns each result's feedUrl.
  app.get("/api/podcasts/search", guard, async (req: any, reply) => {
    const q = String((req.query as any)?.q ?? "").trim();
    if (!q) return [];
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(`https://itunes.apple.com/search?media=podcast&limit=25&term=${encodeURIComponent(q)}`,
        { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic/1.0" } });
      clearTimeout(timer);
      const data = await res.json() as any;
      return (data.results || []).filter((r: any) => r.feedUrl).map((r: any) => ({
        title: r.collectionName, author: r.artistName, feedUrl: r.feedUrl,
        artwork: r.artworkUrl600 || r.artworkUrl100 || null,
        genre: r.primaryGenreName || "", episodes: r.trackCount || 0,
      }));
    } catch { return reply.code(502).send({ error: "Podcast search is unavailable right now." }); }
  });

  // Subscribe: fetch + parse the feed, upsert the channel, add its episodes.
  app.post("/api/podcasts", guard, async (req: any, reply) => {
    const feedUrl = String(req.body?.feedUrl ?? "").trim();
    if (!/^https?:\/\//i.test(feedUrl)) return reply.code(400).send({ error: "Enter a full feed URL (https://…)." });
    let feed;
    try { feed = await fetchFeed(feedUrl); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || "Couldn't read that podcast feed." }); }
    const now = Date.now();
    const existing = db.prepare("SELECT id FROM podcast_channels WHERE user_id=? AND feed_url=?").get(req.user.id, feedUrl) as any;
    let channelId: number;
    if (existing) {
      channelId = existing.id;
      db.prepare("UPDATE podcast_channels SET title=?, description=?, image_url=?, author=?, link=?, last_refreshed=? WHERE id=?")
        .run(feed.channel.title, feed.channel.description ?? null, feed.channel.imageUrl ?? null, feed.channel.author ?? null, feed.channel.link ?? null, now, channelId);
    } else {
      channelId = db.prepare(
        "INSERT INTO podcast_channels(user_id, feed_url, title, description, image_url, author, link, added_at, last_refreshed) VALUES(?,?,?,?,?,?,?,?,?)"
      ).run(req.user.id, feedUrl, feed.channel.title, feed.channel.description ?? null, feed.channel.imageUrl ?? null, feed.channel.author ?? null, feed.channel.link ?? null, now, now).lastInsertRowid as number;
    }
    const added = addEpisodes(channelId, feed.episodes);
    return { id: channelId, title: feed.channel.title, added };
  });

  app.get("/api/podcasts/:id", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const ch = db.prepare(
      "SELECT id, title, author, description, image_url AS imageUrl, link, feed_url AS feedUrl, last_refreshed AS lastRefreshed FROM podcast_channels WHERE id=? AND user_id=?"
    ).get(id, req.user.id) as any;
    if (!ch) return reply.code(404).send({ error: "podcast not found" });
    const episodes = db.prepare(
      `SELECT id, title, description, audio_url AS audioUrl, audio_type AS audioType,
              pub_date AS pubDate, duration, image_url AS imageUrl, played, position,
              (transcript_url IS NOT NULL) AS hasTranscript,
              (local_path IS NOT NULL) AS downloaded,
              (audio_type LIKE 'video/%') AS isVideo
       FROM podcast_episodes WHERE channel_id=? ORDER BY pub_date DESC, id DESC LIMIT 300`
    ).all(id);
    return { ...ch, episodes };
  });

  app.post("/api/podcasts/:id/refresh", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const ch = db.prepare("SELECT feed_url FROM podcast_channels WHERE id=? AND user_id=?").get(id, req.user.id) as any;
    if (!ch) return reply.code(404).send({ error: "podcast not found" });
    let feed;
    try { feed = await fetchFeed(ch.feed_url); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || "Couldn't refresh the feed." }); }
    const added = addEpisodes(id, feed.episodes);
    db.prepare("UPDATE podcast_channels SET last_refreshed=?, title=?, image_url=?, description=? WHERE id=?")
      .run(Date.now(), feed.channel.title, feed.channel.imageUrl ?? null, feed.channel.description ?? null, id);
    return { added };
  });

  app.delete("/api/podcasts/:id", guard, async (req: any) => {
    db.prepare("DELETE FROM podcast_channels WHERE id=? AND user_id=?").run(Number(req.params.id), req.user.id);
    return { ok: true };
  });

  // Single episode + its channel (for the episode detail page).
  app.get("/api/podcasts/episodes/:id", guard, async (req: any, reply) => {
    const ep = db.prepare(
      `SELECT e.id, e.title, e.description, e.audio_url AS audioUrl, e.audio_type AS audioType,
              e.pub_date AS pubDate, e.duration, e.image_url AS imageUrl, e.played, e.position,
              (e.transcript_url IS NOT NULL) AS hasTranscript, (e.local_path IS NOT NULL) AS downloaded,
              (e.audio_type LIKE 'video/%') AS isVideo,
              e.channel_id AS channelId, c.title AS channelTitle, c.image_url AS channelImage
       FROM podcast_episodes e JOIN podcast_channels c ON c.id = e.channel_id
       WHERE e.id = ? AND c.user_id = ?`).get(Number(req.params.id), req.user.id);
    if (!ep) return reply.code(404).send({ error: "episode not found" });
    return ep;
  });

  app.put("/api/podcasts/episodes/:id/progress", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    if (!ownedEpisode(id, req.user.id)) return reply.code(404).send({ error: "episode not found" });
    const position = Math.max(0, Math.round(Number(req.body?.position) || 0));
    const played = req.body?.played ? 1 : 0;
    db.prepare("UPDATE podcast_episodes SET position=?, played=? WHERE id=?").run(position, played, id);
    return { ok: true };
  });

  // Proxy the episode audio same-origin (no visualizer taint / CORS / mixed content),
  // forwarding Range so seeking works. Streams are error-guarded so a client stop
  // (which aborts the upstream fetch) can't crash the server.
  app.get("/api/podcasts/episodes/:id/stream", guard, async (req: any, reply) => {
    const ep = ownedEpisode(Number(req.params.id), req.user.id);
    if (!ep) return reply.code(404).send();
    const range = req.headers.range as string | undefined;

    // Downloaded: serve the local file directly (range-seekable).
    if (ep.local_path && existsSync(ep.local_path)) {
      const size = statSync(ep.local_path).size;
      const ct = ep.audio_type || "audio/mpeg";
      reply.header("Accept-Ranges", "bytes").header("Content-Type", ct);
      const parsed = parseByteRange(range, size);
      if (parsed === false) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      if (parsed) {
        const [start, end] = parsed;
        reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", String(end - start + 1));
        return reply.send(createReadStream(ep.local_path, { start, end }));
      }
      reply.header("Content-Length", String(size));
      return reply.send(createReadStream(ep.local_path));
    }

    const ac = new AbortController();
    let up: Response;
    try {
      // audio_url comes from third-party feed XML and its response is proxied back
      // to the client, so it goes through the SSRF guard (lib/ssrf.ts).
      up = await safeFetch(ep.audio_url, { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic", ...(range ? { Range: range } : {}) } });
    } catch (e) {
      if (e instanceof BlockedUrlError) return reply.code(400).send({ error: e.message });
      return reply.code(502).send();
    }
    if (!up.body) return reply.code(502).send();
    reply.code(up.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = up.headers.get(h); if (v) reply.header(h, v);
    }
    reply.header("Cache-Control", "no-store");
    const body = Readable.fromWeb(up.body as any);
    body.on("error", () => {});
    reply.raw.on("close", () => { ac.abort(); body.destroy(); });
    return reply.send(body);
  });

  // Download an episode to disk for offline playback.
  app.post("/api/podcasts/episodes/:id/download", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const ep = ownedEpisode(id, req.user.id);
    if (!ep) return reply.code(404).send({ error: "episode not found" });
    if (ep.local_path && existsSync(ep.local_path)) return { ok: true, downloaded: true };
    mkdirSync(downloadDir, { recursive: true });
    const at = (ep.audio_type || "").toLowerCase();
    const ext = at.includes("webm") ? "webm"
      : at.includes("mp4") ? (at.startsWith("video") ? "mp4" : "m4a") // video/mp4 vs audio/mp4
      : at.includes("m4a") ? "m4a"
      : at.includes("ogg") || at.includes("opus") ? "ogg"
      : "mp3";
    const dest = join(downloadDir, `${id}.${ext}`);
    // Video episodes are multi-GB: the fetch is cancelable (client disconnect aborts
    // it) and a partial file is removed on failure/abort.
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.raw.on("close", onClose);
    try {
      const res = await safeFetch(ep.audio_url, { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic" } });
      if (!res.ok || !res.body) throw new Error(`source returned ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      let done = 0;
      downloadProgress.set(id, { done, total });
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(dest);
        const src = Readable.fromWeb(res.body as any);
        src.on("data", (c: Buffer) => { done += c.length; downloadProgress.set(id, { done, total }); });
        src.on("error", reject); out.on("error", reject); out.on("finish", () => resolve());
        src.pipe(out);
      });
      db.prepare("UPDATE podcast_episodes SET local_path=? WHERE id=?").run(dest, id);
      return { ok: true, downloaded: true };
    } catch (e: any) {
      try { unlinkSync(dest); } catch { /* nothing written yet */ }
      if (ac.signal.aborted) return reply.code(499).send({ error: "canceled" });
      return reply.code(502).send({ error: e?.message || "download failed" });
    } finally { req.raw.off("close", onClose); downloadProgress.delete(id); }
  });

  app.get("/api/podcasts/episodes/:id/download/progress", guard, async (req: any) => {
    const pr = downloadProgress.get(Number(req.params.id));
    if (!pr) return { downloading: false };
    return { downloading: true, done: pr.done, total: pr.total, pct: pr.total ? Math.round((pr.done / pr.total) * 100) : 0 };
  });

  app.delete("/api/podcasts/episodes/:id/download", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const ep = ownedEpisode(id, req.user.id);
    if (!ep) return reply.code(404).send({ error: "episode not found" });
    if (ep.local_path) { try { unlinkSync(ep.local_path); } catch { /* already gone */ } }
    db.prepare("UPDATE podcast_episodes SET local_path=NULL WHERE id=?").run(id);
    return { ok: true };
  });

  // Parsed transcript lines (podcast:transcript), when the feed provides one.
  app.get("/api/podcasts/episodes/:id/transcript", guard, async (req: any, reply) => {
    const ep = ownedEpisode(Number(req.params.id), req.user.id);
    if (!ep) return reply.code(404).send({ error: "episode not found" });
    if (!ep.transcript_url) return { lines: [] };
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 12000);
      const res = await safeFetch(ep.transcript_url, { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic" } });
      const bodyText = await res.text();
      clearTimeout(timer);
      return { lines: parseTranscript(bodyText, ep.transcript_type) };
    } catch { return { lines: [] }; }
  });
}

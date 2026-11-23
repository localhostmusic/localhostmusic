import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { materializeSmart, smartStale } from "../lib/smartPlaylist.js";

export async function playlistRoutes(app: FastifyInstance) {
  const g = { preHandler: app.authRequired };
  const coverDir = join(config.dataDir, "playlist-covers");

  app.get("/api/playlists", g, async (req: any) =>
    app.db.prepare(
      `SELECT p.id, p.name, p.dedicated_to, p.mood, p.cover_path, (p.rules IS NOT NULL) AS smart,
              (SELECT GROUP_CONCAT(a) FROM (
                 SELECT DISTINCT t.album_id AS a FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = p.id AND t.album_id IS NOT NULL
                 ORDER BY pt.position LIMIT 4)) AS artAlbums
       FROM playlists p WHERE p.user_id = ? ORDER BY p.name`
    ).all(req.user.id));

  app.post("/api/playlists", g, async (req: any, reply) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    // A `rules` object makes this a smart (dynamic) playlist.
    const rules = req.body?.rules ? JSON.stringify(req.body.rules) : null;
    const id = app.db.prepare("INSERT INTO playlists(user_id,name,rules) VALUES(?,?,?)").run(req.user.id, name, rules).lastInsertRowid;
    if (rules) { try { materializeSmart(app.db, Number(id), req.body.rules, req.user.id); } catch { /* */ } }
    return { id, name, smart: !!rules };
  });

  app.get("/api/playlists/:id", g, async (req: any, reply) => {
    const pl = app.db.prepare(
      "SELECT id,name,description,dedicated_to,mood,cover_path,rules,refreshed_at FROM playlists WHERE id=? AND user_id=?"
    ).get(req.params.id, req.user.id) as any;
    if (!pl) return reply.code(404).send();
    let spec: any = null;
    if (pl.rules) {
      // Smart playlist: refresh its materialized snapshot only when the cadence is due,
      // so playing from it doesn't reshuffle the list mid-session.
      try { spec = JSON.parse(pl.rules); } catch { spec = {}; }
      if (smartStale(spec, pl.refreshed_at)) { materializeSmart(app.db, pl.id, spec, req.user.id); pl.refreshed_at = Date.now(); }
    }
    const tracks = app.db.prepare(
      `SELECT t.id, t.title, t.duration, t.album_id AS albumId, t.artist_id AS artistId, ar.name AS artist, al.title AS album, pt.position,
              (LOWER(t.path) LIKE '%.flac' OR LOWER(t.path) LIKE '%.wav' OR LOWER(t.path) LIKE '%.aiff' OR LOWER(t.path) LIKE '%.aif' OR LOWER(t.path) LIKE '%.ape' OR LOWER(t.path) LIKE '%.wv') AS lossless
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE pt.playlist_id = ? ORDER BY pt.position`
    ).all(req.params.id);
    return { ...pl, rules: spec, smart: !!pl.rules, refreshedAt: pl.refreshed_at, tracks };
  });

  // Force-refresh a smart playlist's snapshot now.
  app.post("/api/playlists/:id/refresh", g, async (req: any, reply) => {
    const pl = app.db.prepare("SELECT id,rules FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id) as any;
    if (!pl || !pl.rules) return reply.code(404).send({ error: "not a smart playlist" });
    let spec: any = {}; try { spec = JSON.parse(pl.rules); } catch { /* */ }
    materializeSmart(app.db, pl.id, spec, req.user.id);
    return { ok: true };
  });

  // Update playlist details (name / description / dedicated to / mood).
  app.post("/api/playlists/:id", g, async (req: any, reply) => {
    const owns = app.db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!owns) return reply.code(404).send();
    const b = req.body ?? {};
    const sets: string[] = [], vals: any[] = [];
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return reply.code(400).send({ error: "name required" });
      sets.push("name=?"); vals.push(String(b.name).trim());
    }
    if (b.description !== undefined) { sets.push("description=?"); vals.push(b.description || null); }
    if (b.dedicated_to !== undefined) { sets.push("dedicated_to=?"); vals.push(b.dedicated_to || null); }
    if (b.mood !== undefined) { sets.push("mood=?"); vals.push(b.mood || null); }
    if (b.rules !== undefined) { sets.push("rules=?"); vals.push(b.rules ? JSON.stringify(b.rules) : null); }
    if (sets.length) app.db.prepare(`UPDATE playlists SET ${sets.join(", ")} WHERE id=?`).run(...vals, req.params.id);
    // Rules changed: re-snapshot now so the new rules take effect immediately.
    if (b.rules) { try { materializeSmart(app.db, Number(req.params.id), b.rules, req.user.id); } catch { /* */ } }
    return { ok: true };
  });

  // Upload a custom playlist cover (base64 data URL).
  app.post("/api/playlists/:id/cover", { ...g, bodyLimit: 8 * 1024 * 1024 }, async (req: any, reply) => {
    const owns = app.db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!owns) return reply.code(404).send();
    const m = String(req.body?.image ?? "").match(/^data:image\/\w+;base64,(.+)$/s);
    if (!m) return reply.code(400).send({ error: "expected image data URL" });
    mkdirSync(coverDir, { recursive: true });
    const path = join(coverDir, `${req.params.id}.jpg`);
    writeFileSync(path, Buffer.from(m[1], "base64"));
    app.db.prepare("UPDATE playlists SET cover_path=? WHERE id=?").run(path, req.params.id);
    return { ok: true };
  });

  // Serve playlist cover (public, like album/artist art).
  app.get("/api/playlists/:id/cover", async (req: any, reply) => {
    const row = app.db.prepare("SELECT cover_path FROM playlists WHERE id=?").get(req.params.id) as any;
    if (!row?.cover_path || !existsSync(row.cover_path)) return reply.code(404).send();
    // no-cache = revalidate every time; the ETag makes that a 304 when unchanged.
    const st = statSync(row.cover_path);
    const etag = `"${st.mtimeMs}-${st.size}"`;
    reply.header("Cache-Control", "no-cache").header("ETag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.type("image/jpeg");
    return createReadStream(row.cover_path);
  });

  // Delete a playlist (its tracks cascade).
  app.delete("/api/playlists/:id", g, async (req: any, reply) => {
    const owns = app.db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!owns) return reply.code(404).send();
    app.db.prepare("DELETE FROM playlist_tracks WHERE playlist_id=?").run(req.params.id);
    app.db.prepare("DELETE FROM playlists WHERE id=?").run(req.params.id);
    return { ok: true };
  });

  // Reorder: body { trackIds: [...] } in the desired order.
  app.post("/api/playlists/:id/reorder", g, async (req: any, reply) => {
    const owns = app.db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!owns) return reply.code(404).send();
    const ids: number[] = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [];
    app.db.transaction(() => {
      // offset first to dodge the (playlist_id, position) uniqueness during the rewrite
      app.db.prepare("UPDATE playlist_tracks SET position = position + 1000000 WHERE playlist_id=?").run(req.params.id);
      ids.forEach((tid, i) =>
        app.db.prepare("UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?").run(i, req.params.id, tid));
    })();
    return { ok: true };
  });

  app.post("/api/playlists/:id/tracks", g, async (req: any, reply) => {
    const owns = app.db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!owns) return reply.code(404).send();
    let next = (app.db.prepare("SELECT COALESCE(MAX(position),-1)+1 p FROM playlist_tracks WHERE playlist_id=?").get(req.params.id) as any).p;
    // Accept a single trackId or a bulk trackIds[] (e.g. saving a genre as a playlist).
    const ids: number[] = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds.map(Number).filter((n: number) => Number.isFinite(n))
      : (req.body?.trackId != null ? [Number(req.body.trackId)] : []);
    const ins = app.db.prepare("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?,?,?)");
    app.db.transaction((list: number[]) => { for (const tid of list) ins.run(req.params.id, tid, next++); })(ids);
    return { ok: true, added: ids.length };
  });

  app.delete("/api/playlists/:id/tracks/:trackId", g, async (req: any, reply) => {
    const owns = app.db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!owns) return reply.code(404).send();
    app.db.prepare("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?").run(req.params.id, req.params.trackId);
    return { ok: true };
  });
}

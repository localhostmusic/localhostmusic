import type { FastifyInstance } from "fastify";
import * as sc from "../lib/scrobble.js";

// Opt-in scrobbling. Nothing is ever sent for a user who hasn't connected an
// account here; disconnecting deletes the stored token.
export async function scrobbleRoutes(app: FastifyInstance) {
  const g = { preHandler: app.authRequired };

  const accountsFor = (userId: number) =>
    app.db.prepare("SELECT provider, token, username FROM scrobble_accounts WHERE user_id=?").all(userId) as any[];

  // Both services need at least an artist + track title.
  const trackMeta = (trackId: number): sc.NowPlaying | null => {
    const row = app.db.prepare(
      `SELECT t.title AS track, ar.name AS artist, al.title AS album
       FROM tracks t LEFT JOIN artists ar ON ar.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id
       WHERE t.id=?`
    ).get(trackId) as any;
    if (!row?.track || !row?.artist) return null;
    return { artist: row.artist, track: row.track, album: row.album || undefined };
  };

  // What's connected, and whether Last.fm is even available on this instance.
  app.get("/api/scrobble/accounts", g, async (req: any) => ({
    lastfmAvailable: sc.lastfmAvailable(),
    accounts: accountsFor(req.user.id).map(a => ({ provider: a.provider, username: a.username })),
  }));

  // ListenBrainz: validate the pasted token, then store it.
  app.post("/api/scrobble/listenbrainz", g, async (req: any, reply) => {
    const token = (req.body?.token || "").trim();
    if (!token) return reply.code(400).send({ error: "token required" });
    const v = await sc.lbValidate(token);
    if (!v.valid) return reply.code(400).send({ error: "invalid ListenBrainz token" });
    app.db.prepare(
      "INSERT OR REPLACE INTO scrobble_accounts(user_id,provider,token,username,created_at) VALUES(?,?,?,?,?)"
    ).run(req.user.id, "listenbrainz", token, v.username ?? null, Date.now());
    return { ok: true, username: v.username };
  });

  // Last.fm two-step auth: get a request token + approval URL, user approves at
  // last.fm, then complete to trade the token for a session key.
  app.get("/api/scrobble/lastfm/connect", g, async (_req, reply) => {
    if (!sc.lastfmAvailable()) return reply.code(400).send({ error: "Last.fm is not configured on this server" });
    const token = await sc.lfmGetToken();
    if (!token) return reply.code(502).send({ error: "could not reach Last.fm" });
    return { token, authUrl: sc.lfmAuthUrl(token) };
  });
  app.post("/api/scrobble/lastfm/complete", g, async (req: any, reply) => {
    const token = (req.body?.token || "").trim();
    if (!token) return reply.code(400).send({ error: "token required" });
    const s = await sc.lfmGetSession(token);
    if (!s) return reply.code(400).send({ error: "not authorized yet, approve on Last.fm first" });
    app.db.prepare(
      "INSERT OR REPLACE INTO scrobble_accounts(user_id,provider,token,username,created_at) VALUES(?,?,?,?,?)"
    ).run(req.user.id, "lastfm", s.key, s.name, Date.now());
    return { ok: true, username: s.name };
  });

  app.delete("/api/scrobble/:provider", g, async (req: any) => {
    app.db.prepare("DELETE FROM scrobble_accounts WHERE user_id=? AND provider=?").run(req.user.id, req.params.provider);
    return { ok: true };
  });

  const pending = new Map<string, Promise<boolean>>();
  async function submit(userId: number, trackId: number, listenedAt?: number): Promise<boolean> {
    const meta = trackMeta(trackId);
    if (!meta) return false;
    const results = await Promise.all(accountsFor(userId).map(async account => {
      const { provider, token } = account;
      const key = `${userId}:${trackId}:${listenedAt ?? "now"}:${provider}`;
      if (listenedAt !== undefined && app.db.prepare("SELECT 1 FROM scrobble_receipts WHERE user_id=? AND track_id=? AND listened_at=? AND provider=?")
        .get(userId, trackId, listenedAt, provider)) return true;
      if (pending.has(key)) return pending.get(key)!;
      const work = (async () => {
        const listen = { ...meta, listenedAt: listenedAt! };
        const ok = provider === "listenbrainz"
          ? await (listenedAt === undefined ? sc.lbNowPlaying(token, meta) : sc.lbListen(token, listen))
          : provider === "lastfm" && await (listenedAt === undefined ? sc.lfmNowPlaying(token, meta) : sc.lfmScrobble(token, listen));
        if (ok && listenedAt !== undefined) {
          app.db.prepare("INSERT OR IGNORE INTO scrobble_receipts(user_id,track_id,listened_at,provider) VALUES(?,?,?,?)")
            .run(userId,trackId,listenedAt,provider);
          app.db.prepare("DELETE FROM scrobble_receipts WHERE listened_at<?").run(Math.floor(Date.now()/1000)-31*86400);
        }
        return !!ok;
      })();
      pending.set(key, work);
      try { return await work; } catch { return false; } finally { pending.delete(key); }
    }));
    return results.every(Boolean);
  }
  app.post("/api/scrobble/now-playing", g, async (req: any, reply) => {
    const ok = await submit(req.user.id, Number(req.body?.trackId));
    return reply.code(ok ? 200 : 502).send({ ok });
  });
  app.post("/api/scrobble/listen", g, async (req: any, reply) => {
    const at = Number(req.body?.listenedAt);
    if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60_000) return reply.code(400).send({ error: "invalid listenedAt" });
    const ok = await submit(req.user.id, Number(req.body?.trackId), Math.floor(at / 1000));
    return reply.code(ok ? 200 : 502).send({ ok });
  });
}

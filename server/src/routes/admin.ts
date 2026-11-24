import type { FastifyInstance } from "fastify";
import { hashPassword, passwordProblem, setPassword } from "../lib/auth.js";
import { isScanning, scanAll } from "../lib/libraryScan.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pruneEmpty } from "../lib/prune.js";
import { getSettings, saveSettings, settingsDefaults, type AppSettings } from "../lib/settings.js";
import { runPrewarm, prewarmStatus, TIERS } from "../lib/prewarm.js";
import { backfillLoudness } from "../lib/loudness.js";
import { audiodbImages, wikimediaImage, lastfmScrapeImage } from "../lib/artistImage.js";

export async function adminRoutes(app: FastifyInstance) {
  const adminOnly = {
    preHandler: [app.authRequired, async (req: any, reply: any) => {
      if (!req.user?.isAdmin) return reply.code(403).send({ error: "forbidden" });
    }],
  };

  const artistImgDir = join(config.dataDir, "artist-images");
  const saveArtistImage = (id: number, buf: Buffer, source: string) => {
    mkdirSync(artistImgDir, { recursive: true });
    const path = join(artistImgDir, `${id}.jpg`);
    writeFileSync(path, buf);
    app.db.prepare(
      "INSERT OR REPLACE INTO artist_images(artist_id,path,source,fetched_at) VALUES(?,?,?,?)"
    ).run(id, path, source, Date.now());
  };

  // Resolve a MusicBrainz id for the artist: the one cached by the artist-info
  // route, else a MusicBrainz search by name.
  async function artistMbid(id: number, name: string): Promise<string | null> {
    const cached = app.db.prepare("SELECT mbid FROM artist_info WHERE artist_id=?").get(id) as any;
    if (cached?.mbid) return cached.mbid;
    try {
      const r = await fetch(
        `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`,
        { headers: { "User-Agent": "LocalhostMusic/1.0 (self-hosted music server)", Accept: "application/json" } }
      );
      const j: any = r.ok ? await r.json() : null;
      return j?.artists?.[0]?.id ?? null;
    } catch { return null; }
  }

  // Wide landscape banner (1920x1080) from fanart.tv, keyed by MusicBrainz id.
  // Returns the best-liked background image URL, or null when unavailable.
  async function fanartBanner(mbid: string): Promise<string | null> {
    if (!config.fanartApiKey) return null;
    try {
      const r = await fetch(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${config.fanartApiKey}`);
      if (!r.ok) return null;
      const j: any = await r.json();
      const bgs: any[] = j?.artistbackground ?? [];
      if (!bgs.length) return null;
      bgs.sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0));
      return bgs[0]?.url ?? null;
    } catch { return null; }
  }

  // Square photo (up to 1800x1800) from the Deezer public API (no key needed).
  async function deezerPhoto(name: string): Promise<string | null> {
    try {
      const r = await fetch(`https://api.deezer.com/search/artist?limit=1&q=${encodeURIComponent(name)}`);
      const j: any = r.ok ? await r.json() : null;
      const xl = j?.data?.[0]?.picture_xl || j?.data?.[0]?.picture_big;
      if (!xl) return null;
      // picture_xl is only 1000x1000, but the Deezer CDN serves other dimensions
      // if the size segment is edited, so request a larger version.
      return xl.replace(/\/\d+x\d+-/, "/1800x1800-");
    } catch { return null; }
  }

  // Auto-fetch an artist photo. Prefer a wide landscape banner from fanart.tv,
  // fall back to a large square Deezer photo.
  app.post("/api/admin/artists/:id/image/fetch", adminOnly, async (req: any, reply) => {
    const id = Number(req.params.id);
    const artist = app.db.prepare("SELECT name FROM artists WHERE id=?").get(id) as any;
    if (!artist) return reply.code(404).send({ error: "artist not found" });
    try {
      let url: string | null = null, source = "";
      const mbid = await artistMbid(id, artist.name);
      if (mbid) { url = await fanartBanner(mbid); if (url) source = "fanart"; }
      if (!url) {
        const dz = await deezerPhoto(artist.name);
        if (dz) { url = dz; source = "deezer"; }
      }
      if (!url) return reply.code(404).send({ error: "no image found" });

      let img = await fetch(url);
      // Deezer's hi-res size can 404 on some CDN entries; retry at the default size.
      if (!img.ok && source === "deezer") img = await fetch(url.replace(/\/\d+x\d+-/, "/1000x1000-"));
      if (!img.ok) return reply.code(502).send({ error: "download failed" });
      saveArtistImage(id, Buffer.from(await img.arrayBuffer()), source);
      return { ok: true, source };
    } catch {
      return reply.code(502).send({ error: "fetch failed" });
    }
  });

  // Candidate photos from every source, so the user can pick or fix a wrong match.
  app.get("/api/admin/artists/:id/image/candidates", adminOnly, async (req: any, reply) => {
    const id = Number(req.params.id);
    const artist = app.db.prepare("SELECT name FROM artists WHERE id=?").get(id) as any;
    if (!artist) return reply.code(404).send({ error: "artist not found" });
    const out: { url: string; thumb: string; source: string; kind: string; label?: string }[] = [];
    let mbid: string | null = null;
    try { mbid = await artistMbid(id, artist.name); } catch { /* MB optional */ }

    if (mbid && config.fanartApiKey) {
      try {
        const r = await fetch(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${config.fanartApiKey}`);
        if (r.ok) {
          const j: any = await r.json();
          const byLikes = (a: any[]) => [...a].sort((x, y) => Number(y.likes ?? 0) - Number(x.likes ?? 0));
          for (const b of byLikes(j?.artistbackground ?? []).slice(0, 8)) out.push({ url: b.url, thumb: b.url, source: "fanart", kind: "banner" });
          for (const t of byLikes(j?.artistthumb ?? []).slice(0, 8)) out.push({ url: t.url, thumb: t.url, source: "fanart", kind: "square" });
        }
      } catch { /* fanart optional */ }
    }
    // TheAudioDB: artist photos (thumbs + banners), keyed by name.
    try {
      for (const im of await audiodbImages(artist.name)) out.push({ url: im.url, thumb: im.url, source: "audiodb", kind: im.kind });
    } catch { /* audiodb optional */ }
    // Last.fm: the artist page's og:image, which the API doesn't expose.
    try {
      const lf = await lastfmScrapeImage(artist.name);
      if (lf) out.push({ url: lf, thumb: lf, source: "lastfm", kind: "banner" });
    } catch { /* last.fm optional */ }
    // Deezer: several matches, labelled so a wrong-artist one can be skipped.
    try {
      const r = await fetch(`https://api.deezer.com/search/artist?limit=6&q=${encodeURIComponent(artist.name)}`);
      const j: any = r.ok ? await r.json() : null;
      for (const a of (j?.data ?? [])) {
        const xl = a.picture_xl || a.picture_big;
        if (xl) out.push({ url: xl.replace(/\/\d+x\d+-/, "/1000x1000-"), thumb: a.picture_medium || xl, source: "deezer", kind: "square", label: a.name });
      }
    } catch { /* deezer optional */ }
    // Wikimedia Commons (via MusicBrainz and Wikidata).
    if (mbid) {
      try { const wm = await wikimediaImage(mbid); if (wm) out.push({ url: wm, thumb: wm, source: "wikimedia", kind: "square" }); }
      catch { /* wikimedia optional */ }
    }
    return { candidates: out };
  });

  // Set the artist photo to a chosen candidate URL.
  app.post("/api/admin/artists/:id/image/pick", adminOnly, async (req: any, reply) => {
    const id = Number(req.params.id);
    if (!app.db.prepare("SELECT 1 FROM artists WHERE id=?").get(id)) return reply.code(404).send({ error: "artist not found" });
    const url = String(req.body?.url ?? "");
    if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: "url required" });
    try {
      const img = await fetch(url);
      if (!img.ok) return reply.code(502).send({ error: "download failed" });
      saveArtistImage(id, Buffer.from(await img.arrayBuffer()), String(req.body?.source || "picked"));
      return { ok: true };
    } catch { return reply.code(502).send({ error: "download failed" }); }
  });

  // Upload your own artist photo (base64 data URL in JSON; raised body limit).
  app.post("/api/admin/artists/:id/image", { ...adminOnly, bodyLimit: 8 * 1024 * 1024 }, async (req: any, reply) => {
    const id = Number(req.params.id);
    const artist = app.db.prepare("SELECT id FROM artists WHERE id=?").get(id);
    if (!artist) return reply.code(404).send({ error: "artist not found" });
    const m = String(req.body?.image ?? "").match(/^data:image\/\w+;base64,(.+)$/s);
    if (!m) return reply.code(400).send({ error: "expected image data URL" });
    saveArtistImage(id, Buffer.from(m[1], "base64"), "upload");
    return { ok: true, source: "upload" };
  });

  // Override the audiobook classification for one album (fix a mis/undetected book).
  app.put("/api/albums/:id/audiobook", adminOnly, async (req: any) => {
    const id = Number(req.params.id);
    const isBook = req.body?.isAudiobook ? 1 : 0;
    app.db.prepare("UPDATE albums SET is_audiobook = ? WHERE id = ?").run(isBook, id);
    return { ok: true, isAudiobook: !!isBook };
  });

  app.post("/api/admin/rescan", adminOnly, async () => {
    const r = await scanAll(app.db, config.dataDir); // music + audiobooks roots, then classify
    void runPrewarm(app.db); // new tracks get their pre-transcodes in the background
    void backfillLoudness(app.db).catch(() => {}); // measure loudness for any new tracks
    return r;
  });

  // Open a configured library folder in the file manager on the Localhost Music host (only
  // useful with a graphical session there). `which` selects a configured path,
  // never a client-supplied one, so there's no path/arg injection.
  const openFolderExec = promisify(execFile);
  app.post("/api/admin/open-folder", adminOnly, async (req: any, reply) => {
    const which = String(req.body?.which ?? "");
    const s = getSettings(app.db);
    const dir = which === "audiobooks" ? s.audiobookDir : which === "music" ? s.musicDir : "";
    if (!dir) return reply.code(400).send({ error: "no path configured for " + (which || "?") });
    if (!existsSync(dir)) return reply.code(400).send({ error: "path does not exist on the host: " + dir });
    const env: Record<string, string> = { ...process.env as any };
    if (!env.DISPLAY) env.DISPLAY = ":0";
    if (!env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`;
    const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
    try {
      // explorer exits non-zero even when the window opens.
      await openFolderExec(opener, [dir], { env, timeout: 5000 }).catch(e => { if (opener !== "explorer") throw e; });
      return { ok: true };
    } catch (e: any) {
      return reply.code(500).send({ error: "couldn't open a file manager on the host (needs a desktop session there): " + (e?.message ?? e) });
    }
  });

  // Per-tier cache footprint: files are `<pathhash>-<bitrate>.<ext>` (m4a for the
  // current fMP4/AAC format, mp3 for legacy files; both are counted).
  const tierStats = (dir: string) => {
    const stats = Object.fromEntries(TIERS.map(b => [b, { count: 0, bytes: 0 }])) as
      Record<number, { count: number; bytes: number }>;
    try {
      for (const f of readdirSync(dir)) {
        const m = /-(\d+)\.(?:mp3|m4a|mp4)$/.exec(f);
        const tier = m && stats[Number(m[1])];
        if (!tier) continue;
        tier.count++;
        try { tier.bytes += statSync(join(dir, f)).size; } catch { /* raced a delete */ }
      }
    } catch { /* dir doesn't exist yet */ }
    return stats;
  };

  app.get("/api/admin/settings", adminOnly, async () => {
    const s = getSettings(app.db);
    return {
      ...s,
      defaults: settingsDefaults(),
      trackCount: (app.db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as any).n,
      cache: tierStats(s.transcodeDir),
      prewarm: prewarmStatus(),
      scanning: isScanning(),
    };
  });

  app.put("/api/admin/settings", adminOnly, async (req: any, reply) => {
    const b = req.body ?? {};
    const patch: Partial<AppSettings> = {};
    if (typeof b.musicDir === "string" && b.musicDir.trim()) {
      const dir = b.musicDir.trim();
      if (!existsSync(dir)) return reply.code(400).send({ error: `music path does not exist: ${dir}` });
      patch.musicDir = dir;
    }
    if (typeof b.audiobookDir === "string") {
      const dir = b.audiobookDir.trim();
      if (dir && !existsSync(dir)) return reply.code(400).send({ error: `audiobooks path does not exist: ${dir}` });
      patch.audiobookDir = dir; // "" clears the dedicated audiobooks root
    }
    if (typeof b.transcodeDir === "string" && b.transcodeDir.trim()) {
      const dir = b.transcodeDir.trim();
      const music = patch.musicDir ?? getSettings(app.db).musicDir;
      // Inside the library the scanner would index the cache MP3s as tracks.
      if ((dir + "/").startsWith(music.replace(/\/+$/, "") + "/"))
        return reply.code(400).send({ error: "transcode cache must not live inside the music library" });
      try { mkdirSync(dir, { recursive: true }); } catch (e: any) {
        return reply.code(400).send({ error: `cannot create transcode path: ${e?.message ?? e}` });
      }
      patch.transcodeDir = dir;
    }
    for (const t of TIERS) {
      const k = `keep${t}` as keyof AppSettings;
      if (typeof b[k] === "boolean") (patch as any)[k] = b[k];
    }
    if (b.streamKbps !== undefined) {
      const n = Number(b.streamKbps);
      if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: "streamKbps must be a non-negative number (0 = unlimited)" });
      patch.streamKbps = Math.round(n);
    }
    for (const k of ["showMissingAlbums", "onlineDiscovery", "onlineArtistMeta", "showUsersOnSignIn"] as const) {
      if (typeof b[k] === "boolean") (patch as any)[k] = b[k];
    }
    if (b.discoverRefreshHours !== undefined) {
      const n = Number(b.discoverRefreshHours);
      if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: "discoverRefreshHours must be ≥ 0 (0 = manual)" });
      patch.discoverRefreshHours = Math.round(n);
    }

    const before = getSettings(app.db);
    saveSettings(app.db, patch);
    const after = getSettings(app.db);

    let rescan = null;
    const rootsChanged = after.musicDir !== before.musicDir || after.audiobookDir !== before.audiobookDir;
    // `background` answers straight away and lets the scan run on. A big library
    // takes minutes, too long to hold a request open.
    const scanning = rootsChanged && b.background === true;
    if (scanning) {
      void scanAll(app.db, config.dataDir).then(() => { pruneEmpty(app.db); return runPrewarm(app.db); })
        .catch(e => console.error("Scan failed", e));
    } else if (rootsChanged) {
      rescan = await scanAll(app.db, config.dataDir);
      pruneEmpty(app.db);
    }
    // Anything that could leave the cache incomplete: top it up in the background.
    if (after.transcodeDir !== before.transcodeDir ||
        TIERS.some(t => (after as any)[`keep${t}`] && !(before as any)[`keep${t}`]) ||
        rescan) {
      void runPrewarm(app.db);
    }
    return { ok: true, settings: after, rescan, scanning };
  });

  // Delete one tier's cached transcodes (also matches legacy id-keyed files).
  app.post("/api/admin/transcodes/clear", adminOnly, async (req: any, reply) => {
    const bitrate = Number(req.body?.bitrate);
    if (!TIERS.includes(bitrate as any)) return reply.code(400).send({ error: "bitrate must be one of " + TIERS.join("/") });
    const dir = getSettings(app.db).transcodeDir;
    let removed = 0;
    try {
      for (const f of readdirSync(dir)) {
        // Clear both the m4a (current) and mp3 (legacy) files for the tier.
        if (/\.(?:mp3|m4a|mp4)$/.test(f) && (f.endsWith(`-${bitrate}.mp3`) || f.endsWith(`-${bitrate}.m4a`) || f.endsWith(`-${bitrate}.mp4`))) {
          try { unlinkSync(join(dir, f)); removed++; } catch { /* */ }
        }
      }
    } catch { /* dir doesn't exist */ }
    return { removed };
  });

  app.get("/api/admin/prewarm", adminOnly, async () => prewarmStatus());

  // Delete a track: remove the file from disk + all DB references, then prune any
  // album/artist left empty.
  app.delete("/api/admin/tracks/:id", adminOnly, async (req: any, reply) => {
    const id = Number(req.params.id);
    const row = app.db.prepare("SELECT path FROM tracks WHERE id=?").get(id) as any;
    if (!row) return reply.code(404).send({ error: "track not found" });
    try {
      if (existsSync(row.path)) unlinkSync(row.path);
    } catch (e: any) {
      return reply.code(500).send({ error: `could not delete file: ${e?.message ?? e}` });
    }
    const db = app.db;
    db.transaction(() => {
      db.prepare("DELETE FROM favorites WHERE track_id=?").run(id);
      db.prepare("DELETE FROM playlist_tracks WHERE track_id=?").run(id);
      db.prepare("DELETE FROM search_fts WHERE kind='track' AND ref_id=?").run(id);
      db.prepare("DELETE FROM tracks WHERE id=?").run(id); // play_counts + lyrics cascade
    })();
    const pruned = pruneEmpty(db);
    return { ok: true, pruned };
  });

  app.get("/api/admin/scan-issues", adminOnly, async () =>
    app.db.prepare("SELECT path,error,at FROM scan_issues ORDER BY at DESC LIMIT 200").all());

  app.get("/api/admin/users", adminOnly, async () =>
    app.db.prepare("SELECT id,username,is_admin FROM users ORDER BY username").all());

  app.post("/api/admin/users", adminOnly, async (req: any, reply: any) => {
    const { password } = req.body;
    const username = String(req.body?.username ?? "").trim();
    if (!username || !password) return reply.code(400).send({ error: "username and password required" });
    // Reject a name that already exists in any casing (usernames are case-insensitive).
    if (app.db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username))
      return reply.code(409).send({ error: "that username is taken" });
    const id = app.db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)")
      .run(username, await hashPassword(password)).lastInsertRowid;
    return { id, username };
  });

  // Set a new password for someone who forgot theirs. Signs them out everywhere.
  // Your own password goes through /api/auth/password, which asks for the old one.
  app.post("/api/admin/users/:id/password", adminOnly, async (req: any, reply: any) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return reply.code(400).send({ error: "Change your own password from your account page." });
    const problem = passwordProblem(req.body?.password);
    if (problem) return reply.code(400).send({ error: problem });
    if (!app.db.prepare("SELECT 1 FROM users WHERE id=?").get(id)) return reply.code(404).send({ error: "no such user" });
    await setPassword(app.db, id, req.body.password);
    return { ok: true };
  });
}

import type { FastifyInstance } from "fastify";
import { mbidByName, getReleaseGroups, resolveArtistMbid, norm, nameKey } from "../lib/musicbrainz.js";
import * as rec from "../lib/recommend.js";
import { getSettings } from "../lib/settings.js";
import { isAlbumArtist } from "../lib/credits.js";

const RG_TTL = 1000 * 60 * 60 * 24 * 30;       // release-group cache lifetime

// Max age of cached Discover data before an auto-rebuild, from the admin setting
// (hours). 0 = manual only (Infinity, never auto-expires).
const refreshMs = (app: any): number => {
  const h = getSettings(app.db).discoverRefreshHours;
  return h > 0 ? h * 60 * 60 * 1000 : Infinity;
};

async function dz(path: string): Promise<any | null> {
  try {
    const r = await fetch(`https://api.deezer.com${path}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Personalized Discover feed seeded from listening history: "Because you listen
// to X" (Deezer related artists) plus new releases from library artists. "New" uses
// the MusicBrainz original release date, so reissues don't count.
export async function discoverRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };

  async function deezerId(name: string): Promise<number | null> {
    const d = await dz(`/search/artist?q=${encodeURIComponent(name)}&limit=1`);
    return d?.data?.[0]?.id ?? null;
  }

  // Content keys, so a dismissal survives a rebuild and applies everywhere the
  // same artist or release could appear.
  const artistKey = (name: string) => `artist:${nameKey(name)}`;
  const releaseKey = (rgid: string) => `rg:${rgid}`;
  const albumKey = (artist: string, title: string) => `alb:${nameKey(artist)}|${nameKey(title)}`;

  function dismissedFor(userId: number): Set<string> {
    return new Set((app.db.prepare("SELECT key FROM discover_dismissed WHERE user_id=?")
      .all(userId) as any[]).map(r => r.key));
  }

  // Every artist already in the library, keyed the same way names are compared
  // everywhere else (accents, "&" vs "and", punctuation).
  function libraryKeys(): Set<string> {
    return new Set((app.db.prepare("SELECT name FROM artists").all() as any[]).map(r => nameKey(r.name)));
  }

  async function buildFeed(userId: number, rot: number) {
    let tops = app.db.prepare(
      `SELECT ar.id, ar.name, SUM(pc.count) AS plays
       FROM play_counts pc JOIN tracks t ON t.id = pc.track_id JOIN artists ar ON ar.id = t.artist_id
       GROUP BY ar.id ORDER BY plays DESC LIMIT 15`
    ).all() as any[];
    if (!tops.length) {
      tops = app.db.prepare(
        `SELECT id, name FROM artists WHERE ${isAlbumArtist("artists.id")}
         ORDER BY name LIMIT 15`
      ).all() as any[];
    }
    // Recommendations come from the top artists; new releases scan a wider pool.
    // Seeds rotate on each refresh so it returns different recommendations.
    const seedPool = tops.slice();
    const recArtists = seedPool.length
      ? Array.from({ length: Math.min(8, seedPool.length) }, (_, i) => seedPool[(rot * 3 + i) % seedPool.length])
      : [];
    const localNames = libraryKeys();
    const dismissed = dismissedFor(userId);
    const keep = (name: string) => !localNames.has(nameKey(name)) && !dismissed.has(artistKey(name));
    const thisYear = new Date().getFullYear();

    // "Because you listen to X": Deezer related artists (parallel; Deezer is lenient).
    const recsRaw = await Promise.all(recArtists.map(async (ar) => {
      const did = await deezerId(ar.name);
      if (!did) return null;
      const rel = await dz(`/artist/${did}/related?limit=12`);
      const artists = (rel?.data ?? [])
        .filter((a: any) => keep(String(a.name)))
        .slice(0, 10)
        .map((a: any) => ({ name: a.name, image: a.picture_big || a.picture_medium || null, deezerId: a.id, key: artistKey(a.name) }));
      return artists.length ? { seed: ar.name, artists } : null;
    }));
    const recs = recsRaw.filter(Boolean) as any[];
    const recommendations = recs.slice(0, 6);

    // "New from artists you might like": latest album/EP from related artists.
    // Deezer-dated, so filter tightly: real albums, last ~13 months, no obvious
    // reissues/special editions.
    const pool = new Map<number, any>();
    for (const r of recs) for (const a of r.artists) if (!pool.has(a.deezerId)) pool.set(a.deezerId, a);
    const REISSUE = /remaster|deluxe|anniversary|expanded|\breissue\b|\bedition\b|live at|\(live\)/i;
    const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 400).toISOString().slice(0, 10);
    const relRaw = await Promise.all([...pool.values()].slice(0, 15).map(async (a) => {
      const alb = await dz(`/artist/${a.deezerId}/albums?limit=20`);
      const top = (alb?.data ?? [])
        .filter((al: any) => al.record_type === "album" || al.record_type === "ep")
        .filter((al: any) => al.release_date && al.release_date >= cutoff && !REISSUE.test(al.title || ""))
        .sort((x: any, y: any) => String(y.release_date).localeCompare(String(x.release_date)))[0];
      return top ? {
        artistName: a.name, artistImage: a.image, deezerId: a.deezerId, title: top.title,
        key: albumKey(a.name, top.title),
        cover: top.cover_medium || top.cover_big || top.cover || null,
        date: top.release_date, year: Number(String(top.release_date).slice(0, 4)) || null,
      } : null;
    }));
    const relatedNew = (relRaw.filter(Boolean) as any[])
      .filter(r => keep(r.artistName) && !dismissed.has(albumKey(r.artistName, r.title)))
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))).slice(0, 16);

    // New releases by MusicBrainz original date. Sequential to respect MB rate limits.
    const newReleases: any[] = [];
    for (const ar of tops) {
      const row = app.db.prepare("SELECT mbid FROM artist_info WHERE artist_id=?").get(ar.id) as any;
      // Owned titles disambiguate artists that share a name; MusicBrainz's top hit
      // alone can be the wrong one.
      const ownedTitles = new Set(
        (app.db.prepare("SELECT title FROM albums WHERE artist_id=?").all(ar.id) as any[]).map(r => norm(r.title))
      );
      const mbid = row?.mbid ?? await resolveArtistMbid(app.db, ownedTitles, ar.name) ?? await mbidByName(ar.name);
      if (!mbid) continue;
      let groups: any[];
      try { groups = await getReleaseGroups(app.db, mbid, RG_TTL); } catch { continue; }
      // nameKey, not norm: norm() strips every non-Latin character, so e.g. a
      // Japanese title normalises to "" and matches nothing.
      const owned = new Set(
        (app.db.prepare("SELECT title FROM albums WHERE artist_id=?").all(ar.id) as any[]).map(r => nameKey(r.title))
      );
      // One release per artist: their latest album/EP, or a single if that's all
      // they've put out recently.
      const byDate = (a: any, b: any) => String(b.date ?? b.year ?? "").localeCompare(String(a.date ?? a.year ?? ""));
      const inWin = groups.filter(g => g.year && g.year >= thisYear - 1 && !owned.has(nameKey(g.title)) && !dismissed.has(releaseKey(g.rgid)));
      const major = inWin.filter(g => g.type !== "Single").sort(byDate);
      const pick = major[0] ?? inWin.sort(byDate)[0];
      if (pick) newReleases.push({ artistName: ar.name, artistId: ar.id, title: pick.title, rgid: pick.rgid, year: pick.year, date: pick.date, type: pick.type, key: releaseKey(pick.rgid) });
    }
    newReleases.sort((a, b) => String(b.date ?? b.year ?? "").localeCompare(String(a.date ?? a.year ?? "")));

    return { recommendations, newReleases: newReleases.slice(0, 24), relatedNew };
  }

  // Runs on every read, not just on build. Stamps each item with its dismiss key
  // (older cached feeds have none), then drops what's already been dismissed.
  function normalizeFeed(feed: any, userId: number) {
    const d = dismissedFor(userId);
    const recommendations = (feed.recommendations ?? [])
      .map((r: any) => ({
        ...r,
        artists: (r.artists ?? [])
          .map((a: any) => ({ ...a, key: a.key ?? artistKey(a.name) }))
          .filter((a: any) => !d.has(a.key)),
      }))
      .filter((r: any) => r.artists.length);
    const relatedNew = (feed.relatedNew ?? [])
      .map((r: any) => ({ ...r, key: r.key ?? albumKey(r.artistName, r.title) }))
      .filter((r: any) => !d.has(r.key) && !d.has(artistKey(r.artistName)));
    const newReleases = (feed.newReleases ?? [])
      .map((r: any) => ({ ...r, key: r.key ?? releaseKey(r.rgid) }))
      .filter((r: any) => !d.has(r.key) && !d.has(artistKey(r.artistName)));
    return { ...feed, recommendations, relatedNew, newReleases };
  }

  app.get("/api/discover/feed", guard, async (req: any) => {
    if (!getSettings(app.db).onlineDiscovery) return { recommendations: [], newReleases: [], relatedNew: [], disabled: true };
    const userId = req.user.id;
    const force = String(req.query.refresh ?? "") === "1";
    const row = app.db.prepare("SELECT json, fetched_at, rot FROM discover_feed WHERE user_id=?").get(userId) as any;
    if (!force && row && Date.now() - row.fetched_at < refreshMs(app)) {
      try { return normalizeFeed(JSON.parse(row.json), userId); } catch { /* rebuild */ }
    }
    // Refresh advances the rotation so it seeds from different artists.
    const rot = (row?.rot ?? 0) + (force ? 1 : 0);
    const feed = await buildFeed(userId, rot);
    app.db.prepare("INSERT OR REPLACE INTO discover_feed(user_id,json,fetched_at,rot) VALUES(?,?,?,?)")
      .run(userId, JSON.stringify(feed), Date.now(), rot);
    return normalizeFeed(feed, userId);
  });

  // Not interested. Keyed by content, so it holds across rebuilds and applies to
  // every section that could surface the same artist or release.
  app.post("/api/discover/dismiss", guard, async (req: any, reply: any) => {
    const key = String(req.body?.key ?? "").trim();
    if (!key || key.length > 300) return reply.code(400).send({ error: "key required" });
    app.db.prepare("INSERT OR REPLACE INTO discover_dismissed(user_id,key,at) VALUES(?,?,?)")
      .run(req.user.id, key, Date.now());
    return { ok: true };
  });

  app.get("/api/discover/dismissed", guard, async (req: any) =>
    ({ keys: [...dismissedFor(req.user.id)] }));

  // Clears all dismissals.
  app.delete("/api/discover/dismissed", guard, async (req: any) => {
    const r = app.db.prepare("DELETE FROM discover_dismissed WHERE user_id=?").run(req.user.id);
    return { ok: true, restored: r.changes };
  });

  // Recommendations seeded from the user's connected scrobble service. Splits
  // similar artists into ones already in the library and new ones.
  app.get("/api/discover/for-you", guard, async (req: any) => {
    if (!getSettings(app.db).onlineDiscovery) return { connected: false, disabled: true };
    const userId = req.user.id;
    const force = String(req.query.refresh ?? "") === "1";
    const cached = app.db.prepare("SELECT json, fetched_at FROM discover_foryou WHERE user_id=?").get(userId) as any;
    if (!force && cached && Date.now() - cached.fetched_at < refreshMs(app)) {
      try {
        const c = JSON.parse(cached.json);
        const d = dismissedFor(userId);
        // As for the feed: stamp keys onto a payload cached without them.
        c.discover = (c.discover ?? [])
          .map((a: any) => ({ ...a, key: a.key ?? artistKey(a.name) }))
          .filter((a: any) => !d.has(a.key));
        return c;
      } catch { /* rebuild */ }
    }
    const save = (data: any) => {
      app.db.prepare("INSERT OR REPLACE INTO discover_foryou(user_id,json,fetched_at) VALUES(?,?,?)")
        .run(userId, JSON.stringify(data), Date.now());
      return data;
    };

    const accounts = app.db.prepare(
      "SELECT provider, username FROM scrobble_accounts WHERE user_id=?"
    ).all(userId) as any[];
    if (!accounts.length) return { connected: false };

    // Seed from Last.fm if connected, otherwise ListenBrainz.
    const lfmAcc = accounts.find(a => a.provider === "lastfm");
    const lbAcc = accounts.find(a => a.provider === "listenbrainz");
    let provider = "", seeds: string[] = [];
    if (lfmAcc?.username) { provider = "lastfm"; seeds = await rec.lfmTopArtists(lfmAcc.username); }
    if (!seeds.length && lbAcc?.username) { provider = "listenbrainz"; seeds = await rec.lbTopArtists(lbAcc.username); }

    const result: any = { connected: true, provider, inLibrary: [], discover: [] };
    if (!seeds.length) return save(result);

    // Similar artists come from Last.fm's graph (needs only the api_key).
    const local = new Map(
      (app.db.prepare("SELECT id, name FROM artists").all() as any[]).map(a => [String(a.name).toLowerCase(), a])
    );
    const seedSet = new Set(seeds.map(s => s.toLowerCase()));
    const seen = new Set<string>();
    const dropped = dismissedFor(userId);   // hoisted: this loop runs hundreds of times
    if (rec.lastfmKeyed()) {
      for (const seed of seeds.slice(0, 8)) {
        for (const s of await rec.lfmSimilarArtists(seed)) {
          const key = s.toLowerCase();
          if (seen.has(key) || seedSet.has(key)) continue;
          seen.add(key);
          const hit = local.get(key);
          if (hit) { if (result.inLibrary.length < 20) result.inLibrary.push({ id: hit.id, name: hit.name, because: seed }); }
          else if (result.discover.length < 24 && !dropped.has(artistKey(s))) {
            result.discover.push({ name: s, because: seed, key: artistKey(s) });
          }
        }
      }
    }
    // Give the external recs photos (Deezer).
    await Promise.all(result.discover.map(async (d: any) => { d.image = await rec.deezerArtistImage(d.name); }));
    return save(result);
  });
}

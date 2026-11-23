import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { mbjget, norm, nameKey, artistNameKeys, mbidByName, getReleaseGroups, resolveArtistMbid } from "../lib/musicbrainz.js";
import { getSettings } from "../lib/settings.js";

const MB = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org";
const UA = "LocalhostMusic/1.0 (self-hosted music server)";
const TTL = 1000 * 60 * 60 * 24 * 30; // refresh the cached release-group list after 30 days

export async function discographyRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };
  const albumLossless =
    "COALESCE((SELECT MIN((LOWER(path) LIKE '%.flac' OR LOWER(path) LIKE '%.wav' OR LOWER(path) LIKE '%.aiff' OR LOWER(path) LIKE '%.aif' OR LOWER(path) LIKE '%.ape' OR LOWER(path) LIKE '%.wv')) FROM tracks WHERE tracks.album_id = al.id), 0)";

  // Resolve the artist's MusicBrainz id. Prefer the id already pinned on the
  // artist; otherwise disambiguate same-named artists against the owned albums.
  async function mbidOf(id: number, name: string, ownedTitles: Set<string>): Promise<string | null> {
    const row = app.db.prepare("SELECT mbid FROM artist_info WHERE artist_id=?").get(id) as any;
    if (row?.mbid) return row.mbid;
    return resolveArtistMbid(app.db, ownedTitles, name);
  }

  async function cachedDiscography(id: number, name: string, ownedTitles: Set<string>): Promise<any[] | null> {
    const mbid = await mbidOf(id, name, ownedTitles);
    if (!mbid) return null;
    try { return await getReleaseGroups(app.db, mbid, TTL); } catch { return null; }
  }

  // Full discography for an artist: library albums plus MusicBrainz releases not
  // owned (requestable). Sorted by year.
  app.get("/api/artists/:id/discography", guard, async (req: any, reply) => {
    const id = Number(req.params.id);
    const artist = app.db.prepare("SELECT name FROM artists WHERE id=?").get(id) as any;
    if (!artist) return reply.code(404).send({ error: "artist not found" });

    const lib = app.db.prepare(
      `SELECT al.id, al.title, al.year, ${albumLossless} AS lossless
       FROM albums al WHERE al.artist_id=? AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)`
    ).all(id) as any[];
    // nameKey, not norm: norm() strips every non-Latin character, so all CJK
    // titles collapse to "" and would share one entry.
    const libByTitle = new Map(lib.map(a => [nameKey(a.title), a]));
    const ownedTitles = new Set(lib.map(a => norm(a.title)));

    // When "show albums you don't own" is off, skip MusicBrainz and list only
    // owned albums (mb=null yields a library-only response below).
    const showMissing = getSettings(app.db).showMissingAlbums;
    const mbid = showMissing ? await mbidOf(id, artist.name, ownedTitles) : null;
    const mb = mbid ? await cachedDiscography(id, artist.name, ownedTitles) : null;

    // Self-titled albums can be tagged in a different script than MusicBrainz uses.
    // Release groups have no aliases but the artist does, so an album named after
    // the artist in either script matches the owned one.
    const selfKeys = mbid ? new Set(await artistNameKeys(mbid)) : new Set<string>();
    selfKeys.add(nameKey(artist.name));
    const selfTitled = lib.find(a => selfKeys.has(nameKey(a.title)));

    // Tracks which library albums got matched to an MB release-group.
    const matched = new Set<string>();
    const requested = new Set(
      (app.db.prepare("SELECT subject FROM reports WHERE user_id=? AND kind='add_album' AND status='open'")
        .all(req.user.id) as any[]).map(r => norm(r.subject))
    );

    const out: any[] = [];
    for (const rg of mb ?? []) {
      const k = nameKey(rg.title);
      const local = libByTitle.get(k) ?? (selfKeys.has(k) ? selfTitled : undefined);
      if (local) {
        // Key the match by the local title: with the self-titled bridge the two
        // titles differ, and the unmatched-albums pass below looks up local keys.
        matched.add(nameKey(local.title));
        out.push({ title: local.title, year: local.year ?? rg.year, type: rg.type, inLibrary: true, albumId: local.id, lossless: !!local.lossless });
      } else {
        out.push({ title: rg.title, year: rg.year, type: rg.type, inLibrary: false, rgid: rg.rgid,
                   requested: requested.has(norm(`${rg.title} - ${artist.name}`)) });
      }
    }
    // Library albums MusicBrainz didn't list (local-only / unmatched).
    for (const a of lib) {
      if (!matched.has(nameKey(a.title))) out.push({ title: a.title, year: a.year, type: "Album", inLibrary: true, albumId: a.id, lossless: !!a.lossless });
    }

    // Owned first, then newest to oldest within each group.
    out.sort((x, y) => (Number(y.inLibrary) - Number(x.inLibrary)) || (y.year ?? -1) - (x.year ?? -1) || x.title.localeCompare(y.title));
    return { artist: artist.name, source: mb ? "musicbrainz" : "library", albums: out };
  });

  // Search Deezer (no key) for artists, dropping any already in the library.
  app.get("/api/discover/search", guard, async (req: any) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return { artists: [] };
    const localNames = new Set(
      (app.db.prepare("SELECT LOWER(name) AS n FROM artists").all() as any[]).map(r => r.n)
    );
    try {
      const r = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=12`);
      if (!r.ok) return { artists: [] };
      const d = await r.json();
      const artists = (d.data ?? [])
        .filter((a: any) => !localNames.has(String(a.name).toLowerCase()))
        .map((a: any) => ({
          name: a.name,
          image: a.picture_xl || a.picture_big || a.picture_medium || null,
          deezerId: a.id, albums: a.nb_album ?? null, fans: a.nb_fan ?? null,
        }));
      return { artists };
    } catch { return { artists: [] }; }
  });

  // Full discography for an external artist (looked up by name in MusicBrainz).
  // Nothing is in the library; requested status is per-user.
  app.get("/api/discography/by-name", guard, async (req: any, reply) => {
    const name = String(req.query.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const mbid = await mbidByName(name);
    if (!mbid) return { artist: name, mbid: null, albums: [] };
    let list: any[];
    try { list = await getReleaseGroups(app.db, mbid, TTL); } catch { list = []; }

    const requested = new Set(
      (app.db.prepare("SELECT subject FROM reports WHERE user_id=? AND kind='add_album' AND status='open'")
        .all(req.user.id) as any[]).map(r => norm(r.subject))
    );
    const albums = list
      .map(rg => ({ title: rg.title, year: rg.year, type: rg.type, inLibrary: false, rgid: rg.rgid,
                    requested: requested.has(norm(`${rg.title} - ${name}`)) }))
      .sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || a.title.localeCompare(b.title));
    return { artist: name, mbid, albums };
  });

  // Tracklist for a release-group not in the library. Picks a representative
  // release; cached to disk.
  app.get("/api/discography/tracks/:rgid", guard, async (req: any, reply) => {
    const rgid = String(req.params.rgid).replace(/[^a-z0-9-]/gi, "");
    if (!rgid) return reply.code(404).send({ error: "bad id" });
    const dir = join(config.dataDir, "disco-tracks");
    const file = join(dir, `${rgid}.json`);
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, "utf8")); } catch { /* refetch */ }
    }
    try {
      const rg = await mbjget(`${MB}/release-group/${rgid}?inc=releases&fmt=json`);
      const releaseId = rg.releases?.[0]?.id;
      if (!releaseId) return { rgid, title: rg.title ?? null, tracks: [] };
      const rel = await mbjget(`${MB}/release/${releaseId}?inc=recordings&fmt=json`);
      const tracks: any[] = [];
      for (const m of rel.media ?? []) {
        for (const t of m.tracks ?? []) {
          tracks.push({ position: tracks.length + 1, title: t.title, duration: t.length ? Math.round(t.length / 1000) : null });
        }
      }
      const payload = { rgid, title: rg.title ?? rel.title ?? null, tracks };
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(payload));
      return payload;
    } catch (e: any) {
      return reply.code(502).send({ error: "musicbrainz unavailable" });
    }
  });

  // Proxy + disk-cache Cover Art Archive thumbnails for albums not in the library.
  // A ".none" marker prevents re-hitting CAA for releases that have no front art.
  app.get("/api/discography/cover/:rgid", guard, async (req: any, reply) => {
    const rgid = String(req.params.rgid).replace(/[^a-z0-9-]/gi, "");
    if (!rgid) return reply.code(404).send();
    const dir = join(config.dataDir, "disco-covers");
    const file = join(dir, `${rgid}.jpg`);
    const none = join(dir, `${rgid}.none`);
    if (existsSync(none)) return reply.code(404).send();
    if (existsSync(file)) {
      reply.type("image/jpeg").header("Cache-Control", "public, max-age=604800");
      return createReadStream(file);
    }
    try {
      const r = await fetch(`${CAA}/release-group/${rgid}/front-250`, { headers: { "User-Agent": UA }, redirect: "follow" });
      mkdirSync(dir, { recursive: true });
      if (!r.ok) { writeFileSync(none, ""); return reply.code(404).send(); }
      const buf = Buffer.from(await r.arrayBuffer());
      writeFileSync(file, buf);
      reply.type("image/jpeg").header("Cache-Control", "public, max-age=604800");
      return reply.send(buf);
    } catch {
      return reply.code(404).send();
    }
  });
}

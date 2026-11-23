import type { FastifyInstance } from "fastify";
import { resolveArtistMbid, norm } from "../lib/musicbrainz.js";
import * as rec from "../lib/recommend.js";
import { getSettings } from "../lib/settings.js";
import { syncArtistGenres } from "../lib/genres.js";

const MB = "https://musicbrainz.org/ws/2";
const UA = "LocalhostMusic/1.0 (self-hosted music server)";
const TTL = 1000 * 60 * 60 * 24 * 30; // refresh cached info after 30 days
const EMPTY_RETRY = 1000 * 60 * 60 * 24 * 3; // but retry blank entries every 3 days

async function jget(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Best-effort artist metadata for a known MusicBrainz id: structured fields and
// genres from MB, then url-rels to Wikidata to Wikipedia for a biography.
async function fetchArtistDetail(mbid: string) {
  const a = await jget(`${MB}/artist/${mbid}?inc=url-rels+genres&fmt=json`);
  const type: string | null = a.type ?? null;
  const area: string | null = a["begin-area"]?.name ?? a.area?.name ?? a.country ?? null;
  const begin: string | null = a["life-span"]?.begin ?? null;
  const ended: string | null = a["life-span"]?.ended ? (a["life-span"]?.end ?? null) : null;
  const genres: string[] = (a.genres ?? [])
    .slice().sort((x: any, y: any) => (y.count || 0) - (x.count || 0))
    .map((g: any) => g.name).slice(0, 4);

  let bio: string | null = null;
  try {
    const rels: any[] = a.relations ?? [];
    const wpDirect = rels.find((x) => x.type === "wikipedia")?.url?.resource;
    const wd = rels.find((x) => x.type === "wikidata")?.url?.resource;
    let host = "en.wikipedia.org", title: string | null = null;
    if (wpDirect) {
      const m = wpDirect.match(/https?:\/\/([a-z]+)\.wikipedia\.org\/wiki\/(.+)$/);
      if (m) { host = `${m[1]}.wikipedia.org`; title = decodeURIComponent(m[2]); }
    } else if (wd) {
      const q = wd.match(/(Q\d+)/)?.[1];
      if (q) {
        const ent = await jget(`https://www.wikidata.org/wiki/Special:EntityData/${q}.json`);
        title = ent.entities?.[q]?.sitelinks?.enwiki?.title ?? null;
      }
    }
    if (title) {
      const sum = await jget(`https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
      bio = (sum.extract && !sum.type?.includes("disambiguation")) ? sum.extract : null;
    }
  } catch { /* bio is best-effort; structured fields still return */ }

  return { mbid, type, area, begin, ended, genres: genres.join(", ") || null, bio };
}

// Capitalize a genre list ("indie rock, emo" becomes "Indie Rock, Emo").
function titleCase(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function artistInfoRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };
  const adminOnly = {
    preHandler: [app.authRequired, async (req: any, reply: any) => {
      if (!req.user?.isAdmin) return reply.code(403).send({ error: "forbidden" });
    }],
  };

  // Local library stats for the artist (no network).
  // Track counts go through track_artists, not tracks.artist_id.
  function stats(id: number) {
    return app.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM albums al WHERE al.artist_id=?
            AND EXISTS(SELECT 1 FROM tracks WHERE tracks.album_id=al.id)) AS albums,
         (SELECT COUNT(*) FROM track_artists WHERE artist_id=?) AS tracks,
         (SELECT COALESCE(SUM(t.duration),0) FROM track_artists ta
            JOIN tracks t ON t.id=ta.track_id WHERE ta.artist_id=?) AS duration,
         (SELECT COALESCE(SUM(pc.count),0) FROM play_counts pc
            JOIN track_artists ta ON ta.track_id=pc.track_id WHERE ta.artist_id=?) AS plays`
    ).get(id, id, id, id) as any;
  }

  async function getOrFetch(id: number, force = false) {
    const artist = app.db.prepare("SELECT name FROM artists WHERE id=?").get(id) as any;
    if (!artist) return undefined;
    let cached = app.db.prepare("SELECT * FROM artist_info WHERE artist_id=?").get(id) as any;
    // A completely empty entry (no bio and no genres) retries on a shorter window.
    const empty = cached && !cached.bio && !cached.genres;
    const fresh = cached && Date.now() - cached.fetched_at < (empty ? EMPTY_RETRY : TTL);
    // With web enrichment off, never fetch, just return what's cached.
    // A manual admin refresh overrides.
    if (!getSettings(app.db).onlineArtistMeta && !force) return cached;
    if (!cached || force || !fresh) {
      try {
        // Disambiguate same-named artists by the owned albums, then fetch details
        // for that MusicBrainz artist.
        const owned = new Set(
          (app.db.prepare("SELECT title FROM albums WHERE artist_id=?").all(id) as any[]).map(r => norm(r.title))
        );
        const mbid = await resolveArtistMbid(app.db, owned, artist.name);
        const info = mbid ? await fetchArtistDetail(mbid) : null;
        // Fill bio/genre gaps from Last.fm (works without a MusicBrainz match).
        let bio = info?.bio ?? null, genres = info?.genres ?? null;
        if ((!bio || !genres) && rec.lastfmKeyed()) {
          const lf = await rec.lfmArtistInfo(artist.name);
          if (!bio) bio = lf.bio;
          if (!genres) genres = lf.genres;
        }
        app.db.prepare(
          `INSERT OR REPLACE INTO artist_info(artist_id,bio,type,area,begin,ended,genres,mbid,fetched_at)
           VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(id, bio, info?.type ?? null, info?.area ?? null,
              info?.begin ?? null, info?.ended ?? null, genres, info?.mbid ?? mbid ?? null, Date.now());
        syncArtistGenres(app.db, id, genres); // keep the genre browse index in sync
        cached = app.db.prepare("SELECT * FROM artist_info WHERE artist_id=?").get(id);
      } catch { /* keep stale cache (or none) on network failure */ }
    }
    return cached;
  }

  // When the artist's photo last changed. The image URL is otherwise stable, so
  // the client puts this in ?v= to bust the cache when the photo is replaced.
  function imageV(id: number): number {
    const row = app.db.prepare("SELECT fetched_at FROM artist_images WHERE artist_id=?").get(id) as any;
    return row?.fetched_at ?? 0;
  }

  app.get("/api/artists/:id/info", guard, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!app.db.prepare("SELECT id FROM artists WHERE id=?").get(id))
      return reply.code(404).send({ error: "artist not found" });
    const info = await getOrFetch(id);
    return { ...(info ?? {}), genres: titleCase(info?.genres ?? null), stats: stats(id), imageV: imageV(id) };
  });

  app.post("/api/admin/artists/:id/info/refresh", adminOnly, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!app.db.prepare("SELECT id FROM artists WHERE id=?").get(id))
      return reply.code(404).send({ error: "artist not found" });
    const info = await getOrFetch(id, true);
    return { ...(info ?? {}), genres: titleCase(info?.genres ?? null), stats: stats(id), imageV: imageV(id) };
  });
}

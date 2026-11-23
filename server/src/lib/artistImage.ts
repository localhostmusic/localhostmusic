import { config } from "../config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlbumArtist } from "./credits.js";

// Auto-fetch artist photos. Prefer a wide fanart.tv banner (keyed by MusicBrainz
// id), fall back to a large square Deezer photo. Fetches go through a rate-limited
// background queue (MusicBrainz allows ~1 req/sec). A failed lookup is
// negative-marked so it isn't retried.

const UA = "LocalhostMusic/1.0 (self-hosted music server)";
const artistImgDir = () => join(config.dataDir, "artist-images");

function saveArtistImage(db: any, id: number, buf: Buffer, source: string) {
  mkdirSync(artistImgDir(), { recursive: true });
  const path = join(artistImgDir(), `${id}.jpg`);
  writeFileSync(path, buf);
  db.prepare("INSERT OR REPLACE INTO artist_images(artist_id,path,source,fetched_at) VALUES(?,?,?,?)")
    .run(id, path, source, Date.now());
}
// Remember "looked, found nothing" (empty path) so we don't re-fetch on every miss.
function markNone(db: any, id: number) {
  db.prepare("INSERT OR REPLACE INTO artist_images(artist_id,path,source,fetched_at) VALUES(?,'','none',?)")
    .run(id, Date.now());
}

async function artistMbid(db: any, id: number, name: string): Promise<string | null> {
  const cached = db.prepare("SELECT mbid FROM artist_info WHERE artist_id=?").get(id) as any;
  if (cached?.mbid) return cached.mbid;
  try {
    const r = await fetch(
      `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`,
      { headers: { "User-Agent": UA, Accept: "application/json" } }
    );
    const j: any = r.ok ? await r.json() : null;
    return j?.artists?.[0]?.id ?? null;
  } catch { return null; }
}
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
export async function deezerPhoto(name: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.deezer.com/search/artist?limit=1&q=${encodeURIComponent(name)}`);
    const j: any = r.ok ? await r.json() : null;
    const xl = j?.data?.[0]?.picture_xl || j?.data?.[0]?.picture_big;
    if (!xl) return null;
    return xl.replace(/\/\d+x\d+-/, "/1800x1800-");
  } catch { return null; }
}

// TheAudioDB: artist thumbs, banners and fanart. Proper artist photos, unlike
// Deezer's, which is sometimes an album cover.
export async function audiodbImages(name: string): Promise<{ url: string; kind: string }[]> {
  try {
    const r = await fetch(`https://www.theaudiodb.com/api/v1/json/${config.audiodbApiKey}/search.php?s=${encodeURIComponent(name)}`);
    if (!r.ok) return [];
    const j: any = await r.json();
    const a = j?.artists?.[0];
    if (!a) return [];
    const out: { url: string; kind: string }[] = [];
    if (a.strArtistThumb) out.push({ url: a.strArtistThumb, kind: "square" });
    if (a.strArtistWideThumb) out.push({ url: a.strArtistWideThumb, kind: "banner" });
    for (const k of ["strArtistFanart", "strArtistFanart2", "strArtistFanart3", "strArtistFanart4"])
      if (a[k]) out.push({ url: a[k], kind: "banner" });
    if (a.strArtistBanner) out.push({ url: a.strArtistBanner, kind: "banner" });
    return out;
  } catch { return []; }
}

// Last.fm's API only returns placeholder images, so scrape the artist page's
// og:image instead. Skips the known grey-star placeholder hash.
const LFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";
export async function lastfmScrapeImage(name: string): Promise<string | null> {
  try {
    const slug = encodeURIComponent(name).replace(/%20/g, "+");
    const r = await fetch(`https://www.last.fm/music/${slug}`,
      { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) LocalhostMusic/1.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    const url = html.match(/og:image"\s+content="([^"]+)"/i)?.[1];
    if (!url || !/lastfm.*\/i\/u\//.test(url) || url.includes(LFM_PLACEHOLDER)) return null;
    return url;
  } catch { return null; }
}

// Wikimedia Commons image via MusicBrainz and Wikidata (P18).
export async function wikimediaImage(mbid: string): Promise<string | null> {
  try {
    const r = await fetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`,
      { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return null;
    const j: any = await r.json();
    const wd = (j?.relations ?? []).find((x: any) => x.type === "wikidata")?.url?.resource as string | undefined;
    const qid = wd?.split("/").pop();
    if (!qid) return null;
    const wr = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
    if (!wr.ok) return null;
    const wj: any = await wr.json();
    const file = wj?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value as string | undefined;
    if (!file) return null;
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1000`;
  } catch { return null; }
}

const inflight = new Map<number, Promise<{ ok: boolean; source?: string }>>();

// Fetch and store an artist image now. Deduped per artist. Writes a negative
// marker on a miss.
export function fetchArtistImage(db: any, id: number, name: string): Promise<{ ok: boolean; source?: string }> {
  if (inflight.has(id)) return inflight.get(id)!;
  const p = (async () => {
    try {
      let url: string | null = null, source = "";
      const mbid = await artistMbid(db, id, name);
      if (mbid) { url = await fanartBanner(mbid); if (url) source = "fanart"; }
      if (!url) { const ad = await audiodbImages(name); if (ad[0]) { url = ad[0].url; source = "audiodb"; } }
      if (!url) { const lf = await lastfmScrapeImage(name); if (lf) { url = lf; source = "lastfm"; } }
      if (!url) { const dz = await deezerPhoto(name); if (dz) { url = dz; source = "deezer"; } }
      if (!url && mbid) { const wm = await wikimediaImage(mbid); if (wm) { url = wm; source = "wikimedia"; } }
      if (!url) { markNone(db, id); return { ok: false }; }
      let img = await fetch(url);
      if (!img.ok && source === "deezer") img = await fetch(url.replace(/\/\d+x\d+-/, "/1000x1000-"));
      if (!img.ok) { markNone(db, id); return { ok: false }; }
      saveArtistImage(db, id, Buffer.from(await img.arrayBuffer()), source);
      return { ok: true, source };
    } catch { return { ok: false }; }
  })();
  inflight.set(id, p);
  p.finally(() => inflight.delete(id));
  return p;
}

const queue: { db: any; id: number; name: string }[] = [];
const queued = new Set<number>();
let running = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Queue an artist for a background image fetch. No-op if it already has a row
// (image or negative marker) or is already queued.
export function enqueueArtistImage(db: any, id: number, name: string) {
  if (queued.has(id) || !name) return;
  if (db.prepare("SELECT 1 FROM artist_images WHERE artist_id=?").get(id)) return;
  queued.add(id);
  queue.push({ db, id, name });
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      queued.delete(job.id);
      if (job.db.prepare("SELECT 1 FROM artist_images WHERE artist_id=?").get(job.id)) continue;
      await fetchArtistImage(job.db, job.id, job.name);
      await sleep(1200); // stay under MusicBrainz's ~1 req/sec
    }
  } finally { running = false; }
}

// Enqueue every library artist that has no image row yet (startup backfill).
export function backfillArtistImages(db: any) {
  const missing = db.prepare(
    `SELECT a.id, a.name FROM artists a
     WHERE ${isAlbumArtist("a.id")}
       AND NOT EXISTS (SELECT 1 FROM artist_images ai WHERE ai.artist_id = a.id)`
  ).all() as any[];
  for (const a of missing) enqueueArtistImage(db, a.id, a.name);
  return missing.length;
}

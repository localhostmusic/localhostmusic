// Turns a track id into a URL an <audio> element can play.
//
// One media load must be fed from one source. Chrome's pipeline dies with
// PIPELINE_ERROR_READ if a resource mixes network bytes with service-worker 206
// slices, so the page decides up front and puts the answer in the URL (?src=c or
// ?src=n), where it travels with every range request.
// A cache-pinned load breaks if its entry is evicted mid-song. markLive() protects it.
// A media URL that failed once keeps failing for the rest of the document, even on a
// new element. Recovery needs a URL the page has never used (see reloadToken).

import { downloadedUrl } from "../downloads";

export const AUDIO_CACHE = "lhm-audio-v1";
export const DL_CACHE = "lhm-downloads";
const LIVE_CACHE = "lhm-audio-live";
// How many pinned keys stay protected from eviction: the active track, the
// gapless preload, and slack for a couple of rapid skips.
const LIVE_KEEP = 4;

// Tell the service worker a load is playing from these bytes, so its rolling
// eviction leaves them alone. The markers live in a cache, not in memory, because
// the worker is terminated whenever it goes idle. Cache.put moves an existing key
// to the newest position, so this is an LRU ring.
async function markLive(key: string): Promise<void> {
  try {
    const c = await caches.open(LIVE_CACHE);
    await c.put(key, new Response(""));
    const keys = await c.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - LIVE_KEEP))) await c.delete(k);
  } catch { /* no Cache API (or private mode): nothing cached, nothing to protect */ }
}

// Is this stream already whole in a cache? The answer pins the load's source for
// its entire life: ?src=c to be served from the cache, ?src=n to pass through
// from the network.
export async function pinnedSrc(url: string, reloadToken = 0): Promise<string> {
  let pin = "n";
  try {
    const c = await caches.open(AUDIO_CACHE);
    if (await c.match(url)) pin = "c";
    else {
      const dl = await caches.open(DL_CACHE);
      if (await dl.match(url)) pin = "c";
    }
  } catch { /* no Cache API (or private mode): use the network */ }
  if (pin === "c") await markLive(url);
  return url + (url.includes("?") ? "&" : "?") + "src=" + pin + (reloadToken ? "&rl=" + reloadToken : "");
}

// iPhone / iPad (an iPad reports itself as a Mac with a touch screen).
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
}

export interface ResolvedSource {
  src: string;
  // A blob: URL the caller owns and must revoke when it replaces the source.
  blob: boolean;
}

// Above this a cached file is streamed out of the cache by the service worker
// (?src=c) instead of being held in memory twice (active + preloaded element).
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

// A whole cached file as an in-memory blob: URL. Returns "pin" when the entry
// exists but should be streamed (too big, or a legacy entry with no declared
// length), null when it is not usable.
async function cachedBlob(cacheName: string, url: string, evictIfBroken: boolean): Promise<string | "pin" | null> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(url);
  if (!hit) return null;
  const declared = Number(hit.headers.get("content-length"));
  if (!(declared > 0) || declared > MAX_BLOB_BYTES) return "pin";
  const blob = await hit.blob();
  // A short body would play as a song that ends early. Drop it so it is
  // fetched again.
  if (blob.size !== declared) {
    if (evictIfBroken) { try { await cache.delete(url); } catch { /* */ } }
    return null;
  }
  return URL.createObjectURL(blob);
}

// Resolve a library track to something playable.
// A track already whole in a cache (a download, or one the prefetcher warmed)
// plays from a blob: URL, with no network and no service worker in the byte path.
// On a locked iPhone the worker can be suspended while the page keeps playing.
// Everything else is a pinned stream URL: ?src=n goes to the network, ?src=c is a
// cached file too large to hold in memory.
// `liveUrl` depends on the streaming quality setting. Prefetch, playback and
// preload must all use the same one or they warm different cache entries.
async function resolveSource(trackId: number, liveUrl: string, reloadToken = 0): Promise<ResolvedSource> {
  const durl = downloadedUrl(trackId);
  try {
    if (durl) {
      const dl = await cachedBlob(DL_CACHE, durl, false);
      if (dl === "pin") return { src: await pinnedSrc(durl, reloadToken), blob: false };
      if (dl) return { src: dl, blob: true };
    }
    // Not on iOS: preloading prefetched tracks as blobs there froze playback at
    // 0:00 on the first track change (cause unknown), so iOS streams.
    if (!isIOS()) {
      const warm = await cachedBlob(AUDIO_CACHE, liveUrl, true);
      if (warm && warm !== "pin") return { src: warm, blob: true };
    }
  } catch { /* no Cache API, or the entry is gone: fall through to the URL */ }
  return { src: await pinnedSrc(liveUrl, reloadToken), blob: false };
}

// Cache Storage can stall while iOS restores a suspended PWA, so the lookup is
// capped at 3s. A blob that arrives after the fallback was chosen is revoked.
export async function resolveTrackSource(trackId: number, liveUrl: string, reloadToken = 0): Promise<ResolvedSource> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const work = resolveSource(trackId, liveUrl, reloadToken).then(result => {
    if (timedOut && result.blob) URL.revokeObjectURL(result.src);
    return result;
  });
  const deadline = new Promise<ResolvedSource>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      const downloaded = downloadedUrl(trackId);
      const url = downloaded || liveUrl;
      resolve({ src: url + (url.includes("?") ? "&" : "?") + `src=${downloaded ? "c" : "n"}` + (reloadToken ? `&rl=${reloadToken}` : ""), blob: false });
    }, 3000);
  });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer!); }
}

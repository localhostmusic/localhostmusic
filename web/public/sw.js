// Service worker for Localhost Music: offline app shell + cached static assets, plus an
// audio cache so played/prefetched tracks survive brief network drops and can
// finish while offline.
const SW_VERSION = "26";
const CACHE = "lhm-v26";
const AUDIO_CACHE = "lhm-audio-v1";  // rolling LRU cache of played/prefetched tracks
const DL_CACHE = "lhm-downloads";    // persistent, never-evicted user downloads
// Zero-byte marker entries for the stream keys a page has a live media load
// pinned to (see liveKeys).
const LIVE_CACHE = "lhm-audio-live";
// Soft cap. cachePut evicts further if the browser's real quota is smaller.
const MAX_TRACKS = 30;
// key -> { abort() }: background cache-fills in progress. Either a fetch's
// AbortController, or a canceller for a tee'd playback stream (see storeTee).
const inflight = new Map();
// Larger files (audiobooks) still stream from the network, they just are not cached.
const MAX_CACHE_BYTES = 80 * 1024 * 1024;
// Chrome's media pipeline fails (PIPELINE_ERROR_READ) if one resource load mixes
// network passthrough responses with SW-synthesized 206 slices. So the page pins the
// source in the URL when it creates the load: ?src=c (cache) or ?src=n (network).
// Nothing is remembered here, because the worker is terminated whenever it goes idle.
// Eviction skips keys a load is pinned to (see liveKeys): a 504 mid-song kills the
// load, and Chrome keeps that URL failing for the rest of the document.
const srcPin = (url) => url.searchParams.get("src");   // "c" | "n" | null (older client)

// Logs which source served a media range. Enabled by `?debug` in the page.
let swDebug = false;
function swlog(...args) { if (swDebug) console.log("[lhm-sw]", ...args); }
// Max concurrent background cache-fills. The page's prefetch abort does not reach
// the SW's own fetch, so without a cap rapid skips pile up full downloads.
const MAX_FILLS = 2;


self.addEventListener("message", (e) => {
  const reply = (msg) => { if (e.ports && e.ports[0]) e.ports[0].postMessage(msg); else e.source && e.source.postMessage(msg); };
  if (e.data === "cancelPrefetch") {
    for (const job of inflight.values()) if (job.clientId && job.clientId === e.source?.id) job.abort();
  }
  if (e.data === "version") reply({ swVersion: SW_VERSION });
  // Activated on demand (the user taps Refresh), so an update never reloads mid-playback.
  if (e.data === "skipWaiting") self.skipWaiting();
  if (e.data === "debugOn") swDebug = true;
  // Audio cache diagnostics: entry count, quota, and whether a put works.
  if (e.data === "cacheDiag") e.waitUntil((async () => {
    const out = { swVersion: SW_VERSION, audioCount: 0, quota: 0, usage: 0, putOk: false, err: "", inflight: inflight.size };
    try { out.audioCount = (await (await caches.open(AUDIO_CACHE)).keys()).length; } catch (e) { out.err = "keys:" + (e && e.message || e); }
    try { if (navigator.storage && navigator.storage.estimate) { const est = await navigator.storage.estimate(); out.quota = est.quota || 0; out.usage = est.usage || 0; } } catch { /* */ }
    try {
      const c = await caches.open(AUDIO_CACHE);
      const body = new Uint8Array(4 * 1024 * 1024); // 4MB, about one audio chunk
      await c.put("/__cachetest__", new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) } }));
      out.putOk = !!(await c.match("/__cachetest__"));
      await c.delete("/__cachetest__");
    } catch (e) { out.err = "put:" + (e && e.message || e); }
    reply(out);
  })());
});

// The app shell is index.html plus the hashed bundle it names. Both are stored
// together, or an offline launch gets HTML without its script.
// Some SPA fallbacks answer a missing asset with the HTML shell and a 200. Never
// cache that as an asset.
const isHtml = (res) => (res.headers.get("Content-Type") || "").includes("text/html");

async function cacheShell(cache, res) {
  if (!res?.ok || !isHtml(res)) throw new Error("App shell unavailable");
  const html = await res.clone().text();
  const assets = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]));
  // The manifest lists every JS/CSS chunk, including lazy routes. An older
  // deployment may not have one.
  let hasManifest = false;
  try {
    const manifest = await fetch("/asset-manifest.json", { cache: "no-store" });
    if (manifest.ok && !isHtml(manifest)) {
      const files = await manifest.json();
      if (Array.isArray(files) && [...assets].every(a => files.includes(a))) {
        hasManifest = true;
        for (const file of files) if (typeof file === "string" && file.startsWith("/assets/")) assets.add(file);
      }
    }
  } catch { /* direct HTML dependencies remain required */ }
  if (html.includes("lhm-offline-manifest") && !hasManifest) throw new Error("App asset manifest unavailable");
  // Commit the HTML only after all named assets exist, so a failed download
  // leaves the previous shell intact.
  for (const a of assets) {
    if (await cache.match(a)) continue;
    const r = await fetch(a, { credentials: "same-origin" });
    if (!r.ok || isHtml(r)) throw new Error("App asset unavailable: " + a);
    await cache.put(a, r);
  }
  await cache.put("/index.html", res.clone());
  await cache.put("/", res.clone());
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // no-store: a stale index.html from the HTTP cache would name the wrong bundle.
    await cacheShell(c, await fetch("/index.html", { cache: "no-store" }));
  })());
  // No skipWaiting here: the new worker waits until the user opts in.
});

self.addEventListener("activate", (e) => {
  const keep = new Set([CACHE, AUDIO_CACHE, DL_CACHE, LIVE_CACHE]);
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)))));
  self.clients.claim();
});

const isStream = (url) => url.pathname.startsWith("/api/stream/");

// Stream keys a page has a live media load pinned to (?src=c). Written by
// WebAudioEngine.pinnedSrc, read here so eviction skips them.
// Kept in a cache, not a Map: the worker is terminated whenever it goes idle.
async function liveKeys() {
  try { return new Set((await (await caches.open(LIVE_CACHE)).keys()).map(r => r.url)); }
  catch { return new Set(); }
}

// Evict oldest-first down to `keep`, skipping anything a live load is pinned to.
// Cache.keys() is insertion-ordered and Cache.put moves an existing key to the end,
// so this is an LRU.
async function trim(cache, keep = MAX_TRACKS) {
  const keys = await cache.keys();
  let over = keys.length - keep;
  if (over <= 0) return;
  const live = await liveKeys();
  for (const k of keys) {
    if (over <= 0) break;
    if (live.has(k.url)) continue;
    await cache.delete(k);
    over--;
  }
}

// Put into the cache, evicting the oldest and retrying when the storage quota is
// exceeded (iOS Safari's quota is small).
async function cachePut(cache, key, resp) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await cache.put(key, resp.clone()); return true; }
    catch {
      // Same rule as trim(): never evict a key a live load is pinned to.
      const live = await liveKeys();
      const victims = (await cache.keys()).filter(k => !live.has(k.url));
      if (!victims.length) return false;
      for (const k of victims.slice(0, Math.max(1, Math.ceil(victims.length / 3)))) await cache.delete(k);
    }
  }
  return false;
}

// Download + cache the whole file in the background (so seeks/replays/offline
// work) without blocking the range request the player is waiting on.
async function cacheFull(cache, key, clientId) {
  if (inflight.has(key)) return inflight.get(key).done;
  if (await cache.match(key)) return;
  // Recheck after await: another fetch handler can have acquired this slot.
  if (inflight.has(key)) return inflight.get(key).done;
  if (inflight.size >= MAX_FILLS) return;
  const ac = new AbortController();
  const job = { abort: () => ac.abort(), done: null, clientId };
  inflight.set(key, job);
  job.done = (async () => {
    const watchdog = setTimeout(() => ac.abort(), 90000);
    try {
      const net = await fetch(key, { credentials: "same-origin", signal: ac.signal });
      const size = Number(net.headers.get("Content-Length"));
      if (net.status === 200 && size > 0 && size <= MAX_CACHE_BYTES) {
        await trim(cache, MAX_TRACKS - 1);
        await cachePut(cache, key, net);
      } else await net.body?.cancel();
    } catch { /* cancellation/offline/quota is a best-effort cache miss */ }
    finally { clearTimeout(watchdog); if (inflight.get(key) === job) inflight.delete(key); }
  })();
  return job.done;
}

// Does this response carry the file's whole bytes, starting at 0? Only then can the
// body be stored as the cache's full-file entry (rangeFrom slices from byte 0).
function isCompleteBody(resp) {
  if (resp.status === 200) return true;
  if (resp.status !== 206) return false;
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(resp.headers.get("Content-Range") || "");
  return !!m && m[1] === "0" && Number(m[2]) === Number(m[3]) - 1;
}

// Cache the audio the player is already downloading by teeing its response body.
// Cancelling the player's branch does not cancel this one. A body that ends short of
// `size` is discarded: a truncated entry would make the track end early.
async function storeTee(cache, key, stream, size, ctype) {
  if (inflight.has(key) || inflight.size >= MAX_FILLS) {
    void stream.cancel().catch(() => {}); return;
  }
  const reader = stream.getReader();
  let cancelled = false;
  const job = { abort: () => { cancelled = true; void reader.cancel().catch(() => {}); }, done: null };
  inflight.set(key, job);
  job.done = (async () => {
    const watchdog = setTimeout(job.abort, 90000);
    const chunks = [];
    let bytes = 0;
    try {
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > size || bytes > MAX_CACHE_BYTES) { job.abort(); return; }
        chunks.push(value);
      }
      if (cancelled || bytes !== size) return;
      await trim(cache, MAX_TRACKS - 1);
      await cachePut(cache, key, new Response(new Blob(chunks), {
        headers: { "Content-Length": String(size), "Content-Type": ctype || "audio/mpeg" },
      }));
    } catch { /* aborted or truncated data is never stored */ }
    finally {
      clearTimeout(watchdog);
      reader.releaseLock();
      if (inflight.get(key) === job) inflight.delete(key);
    }
  })();
  return job.done;
}

// When the player requests an uncached track, abort the other background fills so
// they cannot starve the live stream.
function abortFillsExcept(key) {
  for (const [k, ac] of [...inflight]) {
    if (k !== key) { try { ac.abort(); } catch { /* */ } }
  }
}

async function rangeFrom(resp, _key, range) {
  let size = Number(resp.headers.get("Content-Length"));
  let body = resp.body;
  // Legacy downloads may lack Content-Length. New cache writes always include it.
  if (!(size > 0)) { const blob = await resp.blob(); size = blob.size; body = blob.stream(); }
  const headers = { "Content-Type": resp.headers.get("Content-Type") || "audio/mpeg", "Accept-Ranges": "bytes" };
  if (!range) return new Response(body, { headers: { ...headers, "Content-Length": String(size) } });
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = NaN, end = NaN;
  if (m && m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  else if (m && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    void body?.cancel().catch(() => {});
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const reader = body.getReader();
  let offset = 0;
  const sliced = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          const from = Math.max(0, start - offset);
          const to = Math.min(value.byteLength, end + 1 - offset);
          offset += value.byteLength;
          if (to > from) controller.enqueue(value.subarray(from, to));
          if (offset > end) { controller.close(); void reader.cancel().catch(() => {}); return; }
          if (to > from) return;
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(sliced, { status: 206, headers: { ...headers,
    "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`,
  } });
}

async function serveAudio(event) {
  const request = event.request;
  const url = new URL(request.url);
  const range = request.headers.get("range");

  // 0) A download in progress (x-lhm-dl) always hits the network, so a broken
  // download can be replaced.
  if (request.headers.get("x-lhm-dl")) {
    try { return await fetch(request); } catch { return new Response("", { status: 504 }); }
  }

  // Cache keys exclude the source pin and the reload token, so ?src=c, ?src=n and
  // retries share one entry.
  const keyUrl = new URL(request.url);
  keyUrl.searchParams.delete("src");
  keyUrl.searchParams.delete("rl");

  // 1) A user download (persistent, exact URL incl. ?bitrate). Works offline.
  const dlKey = keyUrl.origin + keyUrl.pathname + keyUrl.search;
  // The fetch listener already declines ?src=n media loads. This keeps serveAudio
  // correct on its own.
  if (srcPin(url) === "n" && !request.headers.has("x-lhm-prefetch")) return networkAudio(event, dlKey);
  const dl = await caches.open(DL_CACHE);
  const dlHit = await dl.match(dlKey);
  const requestedPin = srcPin(url);
  if (dlHit && requestedPin !== "n" && !request.headers.has("x-lhm-prefetch")) return rangeFrom(dlHit, dlKey, range);

  // 2) Any stream (lossless or transcoded) goes to the rolling cache, keyed by the
  // full URL incl. ?bitrate so each quality caches separately.
  const key = keyUrl.origin + keyUrl.pathname + keyUrl.search;
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(key);

  // Prefetch is explicit. A real media GET without Range must receive audio.
  if (request.headers.has("x-lhm-prefetch")) {
    if (!cached && !dlHit) {
      const fill = cacheFull(cache, key, event.clientId);
      event.waitUntil(fill);
      await fill; // serializes the provider's next prefetch, with no audio body
    }
    return new Response(null, { status: 204 });
  }

  // Media (ranged) request: obey the source the page pinned for this load.
  const pin = srcPin(url) ?? (cached ? "c" : "n");   // no pin = older client, best effort
  if (pin === "c") {
    if (cached) { swlog("range from cache", key, range); return rangeFrom(cached, key, range); }
    // Pinned to the cache but the entry is gone (the browser can evict the whole
    // cache under storage pressure). Serving the network here would mix sources, so
    // fail the load. The engine re-pins on a fresh URL.
    swlog("pinned cache but entry gone, 504 so the load restarts", key);
    return new Response(null, { status: 504 });
  }

  return networkAudio(event, key);
}

async function networkAudio(event, key) {
  abortFillsExcept(key);
  let net;
  try { net = await fetch(event.request); }
  catch { return new Response(null, { status: 504 }); }
  // No cache lookup delays live playback. Only a complete, bounded body is
  // copied. A seek/probe never triggers a second full-file download.
  if (!net.ok || !net.body || !isCompleteBody(net)) return net;
  const size = Number(net.headers.get("Content-Length") || 0);
  if (!size || size > MAX_CACHE_BYTES) return net;
  const [toClient, toCache] = net.body.tee();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(AUDIO_CACHE);
      if (await cache.match(key)) { void toCache.cancel().catch(() => {}); return; }
      await storeTee(cache, key, toCache, size, net.headers.get("Content-Type"));
    } catch { void toCache.cancel().catch(() => {}); }
  })());
  return new Response(toClient, { status: net.status, statusText: net.statusText, headers: net.headers });
}

// How long a launch waits on the network before opening from the cache. With no
// route to the server the connection hangs for tens of seconds, and an installed
// PWA shows a blank screen meanwhile.
const SHELL_TIMEOUT = 4000;

// Last resort: the app has never been cached and the server is unreachable.
const offlinePage = () => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
  `<title>Localhost Music</title><style>html,body{height:100%;margin:0;background:#0a0a0c;color:#e8e8ea;` +
  `font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;` +
  `display:flex;align-items:center;justify-content:center}div{text-align:center;padding:2rem;max-width:22rem}` +
  `h1{font-size:1.25rem;margin:0 0 .5rem}p{opacity:.65;margin:0 0 1.5rem}` +
  `button{font:inherit;color:inherit;background:#26262b;border:0;border-radius:999px;padding:.6rem 1.6rem}</style>` +
  `<div><h1>Can't reach Localhost Music</h1><p>Your server didn't answer. Check the connection and try again.</p>` +
  `<button onclick="location.reload()">Retry</button></div>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
);

async function serveShell(e) {
  const cache = await caches.open(CACHE);
  const cached = (await cache.match("/index.html")) || (await cache.match("/"));
  // .catch here, not on the race: a rejection after the timeout wins would be unhandled.
  const net = fetch(e.request).then(r => {
    // Keep the cached shell in step with what is deployed, or it names a bundle
    // that was never cached.
    if (r && r.ok) e.waitUntil(cacheShell(cache, r.clone()).catch(() => {}));
    return r;
  }).catch(() => null);

  if (!cached) return (await Promise.race([net, new Promise(r => setTimeout(() => r(null), SHELL_TIMEOUT))])) || offlinePage();
  const raced = await Promise.race([net, new Promise(r => setTimeout(() => r(null), SHELL_TIMEOUT))]);
  // Open from the cached shell. The in-app update check compares bundle hashes,
  // so a shell one deploy behind still shows the Refresh toast.
  return (raced && raced.ok) ? raced : cached;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // Audio: cache-aware + offline-tolerant. Other /api/* stays network-only.
  if (isStream(url)) {
    // A load pinned to the network (?src=n) is left to the browser's own media
    // loader (return without respondWith). Passing the bytes through a JS stream here
    // stalls playback when iOS suspends the worker on a locked phone. The cache is
    // filled by explicit prefetches instead.
    if (srcPin(url) === "n" && !e.request.headers.has("x-lhm-prefetch") && !e.request.headers.has("x-lhm-dl")) return;
    e.respondWith(serveAudio(e));
    return;
  }
  // Cover/artist art saved with a download is served offline. A ?size thumbnail is
  // not downloaded separately, so fall back to the full-res copy.
  // Network-first: artwork changes but its URL does not. `no-cache` forces
  // revalidation, which the ETag turns into a small 304 when nothing changed.
  if (/\/api\/(albums|playlists)\/\d+\/cover$/.test(url.pathname) || /\/api\/artists\/\d+\/image$/.test(url.pathname)) {
    e.respondWith((async () => {
      const dl = await caches.open(DL_CACHE);
      const keyed = url.origin + url.pathname + url.search;
      let downloaded = await dl.match(keyed);
      let exact = !!downloaded;
      if (!downloaded && url.search) downloaded = await dl.match(url.origin + url.pathname);
      try {
        const net = await fetch(e.request, { cache: "no-cache" });
        if (!net || !net.ok) return downloaded || net;
        // Refresh the offline copy. Only on an exact key hit: a ?size thumbnail must
        // not overwrite the full-res copy.
        if (exact) { try { await dl.put(keyed, net.clone()); } catch { /* quota */ } }
        return net;
      } catch {
        return downloaded || new Response("", { status: 504 });
      }
    })());
    return;
  }
  // Lyrics saved with a download are available offline. Network-first (lyrics can
  // be updated), falling back to the downloaded copy.
  if (/\/api\/tracks\/\d+\/lyrics$/.test(url.pathname)) {
    e.respondWith((async () => {
      try { const net = await fetch(e.request); if (net && net.ok) return net; } catch { /* offline */ }
      const dl = await caches.open(DL_CACHE);
      return (await dl.match(url.origin + url.pathname + url.search)) || new Response("", { status: 504 });
    })());
    return;
  }
  if (url.pathname.startsWith("/api/")) return;

  // SPA navigations: the app must always open, even with no route to the server.
  if (e.request.mode === "navigate") { e.respondWith(serveShell(e)); return; }

  // Only cache build assets / images (avoids caching dev-server modules).
  const cacheable = url.pathname.startsWith("/assets/") || /\.(png|svg|jpe?g|woff2?|ico)$/.test(url.pathname);
  if (!cacheable) return;

  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok && !isHtml(r)) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

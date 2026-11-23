import { api } from "../api";

// Offline downloads: copies of tracks (at a chosen bitrate) in a dedicated Cache
// Storage bucket the service worker never evicts. Each group's track metadata and
// cover art are stored too, since the library API isn't reachable offline.
const DL_CACHE = "lhm-downloads";
const TRACKS_KEY = "lhm-dl-tracks";   // { [trackId]: bitrate }  (0 = original/lossless)
const URLS_KEY = "lhm-dl-urls";
function readUrls(): Record<number,string> { try { return JSON.parse(localStorage.getItem(URLS_KEY) || "{}"); } catch { return {}; } }
function writeUrls(urls: Record<number,string>) { localStorage.setItem(URLS_KEY, JSON.stringify(urls)); }
const GROUPS_KEY = "lhm-dl-groups";   // DlGroup[]

export type DlTrack = { id: number; title: string; artist?: string; album?: string; albumId?: number; duration?: number };
export type DlGroup = { kind: "album" | "playlist"; id: number; name: string; tracks: DlTrack[]; bitrate: number; at: number; complete?: boolean; expected?: number };
type Tracks = Record<number, number>;

function readTracks(): Tracks { try { return JSON.parse(localStorage.getItem(TRACKS_KEY) || "{}"); } catch { return {}; } }
function writeTracks(t: Tracks) { localStorage.setItem(TRACKS_KEY, JSON.stringify(t)); }
function readGroups(): DlGroup[] { try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]"); } catch { return []; } }
function writeGroups(g: DlGroup[]) { localStorage.setItem(GROUPS_KEY, JSON.stringify(g)); }

const listeners = new Set<() => void>();
export function onDownloadsChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const emit = () => listeners.forEach(f => f());

const urlFor = (trackId: number, bitrate: number) => (bitrate > 0 ? api.streamUrl(trackId, bitrate) : api.streamUrl(trackId));

export function isDownloaded(trackId: number): boolean { return trackId in readTracks(); }
export function downloadedBitrate(trackId: number): number | undefined {
  const t = readTracks(); return trackId in t ? t[trackId] : undefined;
}
// The URL the player should use for a track if it's downloaded (else null).
export function downloadedUrl(trackId: number): string | null {
  const b = downloadedBitrate(trackId);
  return b === undefined ? null : readUrls()[trackId] ?? `/api/stream/${trackId}${b > 0 ? `?bitrate=${b}` : ""}`;
}
export function listGroups(): DlGroup[] { return readGroups().sort((a, b) => b.at - a.at); }
export function groupDownloaded(kind: "album" | "playlist", id: number): boolean {
  return readGroups().some(g => g.kind === kind && g.id === id && g.tracks.length > 0 && g.complete !== false);
}
// The stored, offline-playable track list for a downloaded group.
export function groupTracks(kind: "album" | "playlist", id: number): DlTrack[] {
  return readGroups().find(g => g.kind === kind && g.id === id)?.tracks ?? [];
}
// The bitrate a group was downloaded at (so re-download keeps its quality).
export function groupBitrate(kind: "album" | "playlist", id: number): number | undefined {
  return readGroups().find(g => g.kind === kind && g.id === id)?.bitrate;
}
// Album-card-shaped list of downloaded albums (for offline library fallback).
export function downloadedAlbums(): { id: number; title: string; artist?: string }[] {
  return readGroups().filter(g => g.kind === "album" && g.tracks.length > 0).map(g => ({ id: g.id, title: g.name, artist: g.tracks[0]?.artist }));
}
export function downloadedAlbumIds(): Set<number> {
  return new Set(readGroups().filter(g => g.kind === "album" && g.tracks.length > 0).map(g => g.id));
}
// Artists with something downloaded on this device. Matched by name, since a
// download stores only each track's artist name, not an id.
export function downloadedArtistNames(): Set<string> {
  const names = new Set<string>();
  for (const g of readGroups()) for (const t of g.tracks) if (t.artist) names.add(t.artist.trim().toLowerCase());
  return names;
}

// "Show only what's on this device": one persisted, library-wide switch.
const ONLY_KEY = "lhm-dl-only";
const onlyListeners = new Set<() => void>();
export function downloadedOnly(): boolean {
  try { return localStorage.getItem(ONLY_KEY) === "1"; } catch { return false; }
}
export function setDownloadedOnly(on: boolean) {
  try { localStorage.setItem(ONLY_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  onlyListeners.forEach(f => f());
}
export function onDownloadedOnlyChange(fn: () => void) { onlyListeners.add(fn); return () => { onlyListeners.delete(fn); }; }

export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  let usage = 0, quota = 0, persisted = false;
  try { const e = await navigator.storage?.estimate?.(); usage = e?.usage || 0; quota = e?.quota || 0; } catch { /* */ }
  try { persisted = (await navigator.storage?.persisted?.()) ?? false; } catch { /* */ }
  return { usage, quota, persisted };
}

// Cache each downloaded track's lyrics for offline use. Best-effort, and only
// tracks that have lyrics are stored.
async function cacheLyrics(cache: Cache, tracks: DlTrack[]) {
  for (const t of tracks) {
    const u = `/api/tracks/${t.id}/lyrics`;
    try {
      const r = await fetch(u, { credentials: "same-origin", signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const j = await r.clone().json().catch(() => null);
      if (j && (j.synced || j.plain)) await cache.put(u, r);
    } catch { /* offline or failed, skip */ }
  }
}

// Cache the artwork a download needs so it shows offline (group cover + each
// track's album cover).
async function cacheCovers(cache: Cache, group: { kind: "album" | "playlist"; id: number }, tracks: DlTrack[]) {
  const urls = new Set<string>();
  urls.add(group.kind === "album" ? api.coverUrl(group.id) : api.playlistCoverUrl(group.id));
  for (const t of tracks) if (t.albumId != null) urls.add(api.coverUrl(t.albumId));
  for (const u of urls) {
    try { const r = await fetch(u, { credentials: "same-origin", signal: AbortSignal.timeout(12000) }); if (r.ok) await cache.put(u, r.clone()); } catch { /* */ }
  }
}

// Download every track in a group at `bitrate` (0 = original). Calls onProgress
// after each track. Asks for persistent storage first so the OS won't evict it.
export async function downloadGroup(
  group: { kind: "album" | "playlist"; id: number; name: string },
  tracks: DlTrack[],
  bitrate: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* */ }
  const cache = await caches.open(DL_CACHE);
  const previous = readGroups().find(g => g.kind === group.kind && g.id === group.id);
  const got: DlTrack[] = [];
  let done = 0;
  for (const tr of tracks) {
    const url = urlFor(tr.id, bitrate);
    try {
      // x-lhm-dl makes the SW fetch from the network instead of serving a
      // possibly stale cached entry. Cache the real response when it has a
      // Content-Length: iOS stores those reliably and often drops synthetic ones.
      const resp = await fetch(url, { credentials: "same-origin", headers: { "x-lhm-dl": "1" }, signal: AbortSignal.timeout(300000) });
      if (!resp.ok || /text\/html|application\/json/i.test(resp.headers.get("content-type") || "")) throw new Error("Download did not return audio");
      const len = Number(resp.headers.get("content-length") || 0);
      let ok = false;
      if (resp.ok && len > 0) { await cache.put(url, resp.clone()); ok = true; }
      else if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 0) {
          await cache.put(url, new Response(buf, { headers: {
            "Content-Type": resp.headers.get("content-type") || "audio/mpeg",
            "Content-Length": String(buf.byteLength), "Accept-Ranges": "bytes",
          } }));
          ok = true;
        }
      }
      if (ok) {
        // Read-modify-write per track (not one snapshot for the whole loop) so
        // two groups downloading at once can't erase each other's entries.
        const cur = readTracks();
        const oldUrl = downloadedUrl(tr.id);
        // Re-download at a new bitrate: drop the old copy (below) or it stays
        // orphaned in the cache.
        const urls = readUrls(); urls[tr.id] = url; writeUrls(urls);
        cur[tr.id] = bitrate;
        writeTracks(cur);
        if (oldUrl && oldUrl !== url) { try { await cache.delete(oldUrl); } catch { /* */ } }
        got.push({ id: tr.id, title: tr.title, artist: tr.artist, album: tr.album, albumId: tr.albumId, duration: tr.duration });
      }
    } catch { /* skip a track that failed; keep going */ }
    done++; onProgress?.(done, tracks.length); emit();
  }
  await cacheCovers(cache, group, got);
  await cacheLyrics(cache, got);
  const groups = readGroups().filter(g => !(g.kind === group.kind && g.id === group.id));
  const complete = got.length === tracks.length && got.length > 0;
  groups.push(!complete && previous ? previous : { ...group, tracks: got, bitrate, at: Date.now(), complete, expected: tracks.length });
  writeGroups(groups); emit();
  if (!complete) throw new Error(`Downloaded ${got.length} of ${tracks.length} songs. Check your connection and available storage, then retry.`);
}

// Remove everything. iOS "clear website data" doesn't reliably clear Cache Storage.
export async function clearAllDownloads(): Promise<void> {
  try { await caches.delete(DL_CACHE); } catch { /* */ }
  try { localStorage.removeItem(URLS_KEY); localStorage.removeItem(TRACKS_KEY); localStorage.removeItem(GROUPS_KEY); } catch { /* */ }
  emit();
}

export async function removeGroup(kind: "album" | "playlist", id: number): Promise<void> {
  const groups = readGroups();
  const g = groups.find(x => x.kind === kind && x.id === id);
  if (!g) return;
  const cache = await caches.open(DL_CACHE);
  const tmap = readTracks();
  // Keep tracks still referenced by another downloaded group.
  const keep = new Set(groups.filter(x => !(x.kind === kind && x.id === id)).flatMap(x => x.tracks.map(t => t.id)));
  for (const t of g.tracks) {
    if (keep.has(t.id)) continue;
    // Delete both the tracked bitrate's copy and the group's original one, in
    // case a later re-download at a different quality left an older entry.
    try { await cache.delete(downloadedUrl(t.id) || urlFor(t.id, tmap[t.id] ?? 0)); } catch { /* */ }
    if ((tmap[t.id] ?? 0) !== g.bitrate) { try { await cache.delete(urlFor(t.id, g.bitrate)); } catch { /* */ } }
    delete tmap[t.id];
    const urls = readUrls(); delete urls[t.id]; writeUrls(urls);
  }
  writeTracks(tmap);
  writeGroups(groups.filter(x => !(x.kind === kind && x.id === id)));
  emit();
}

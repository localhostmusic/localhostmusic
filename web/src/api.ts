// Short-lived in-memory cache for GET responses, so navigating back is instant.
// Any mutation (POST/PUT/DELETE), except recording a play, clears it.
import { dlog } from "./ui/debugLog";
const getCache = new Map<string, { t: number; data: any }>();
const GET_TTL = 60_000;
const MAX_GETS = 250;
const pendingGets = new Map<string, Promise<any>>();
let generation = 0;
let libraryRevision = "";
try { libraryRevision = localStorage.getItem("lhm-library-revision") || ""; } catch { /* private mode */ }
const revisionQuery = (hasQuery: boolean) => libraryRevision ? `${hasQuery ? "&" : "?"}v=${encodeURIComponent(libraryRevision)}` : "";
const shortUrl = (u: string) => u.replace(/^\/api\//, "").replace(/\?.*$/, "");

// Fires when a mutation clears the GET cache, so kept-alive views can refresh
// instead of showing stale data.
const cacheClearSubs = new Set<(url: string) => void>();
export function onCacheClear(fn: (url: string) => void) { cacheClearSubs.add(fn); return () => { cacheClearSubs.delete(fn); }; }

// After a mutation succeeds, drop only the cached GETs it could have changed.
// Unknown mutations clear everything.
export const isLibraryMutation = (url: string) => url.startsWith("/api/favorites") || /\/(rating|star)$/.test(url);
function invalidateFor(url: string) {
  generation++;
  pendingGets.clear();
  const prefixes =
    url.startsWith("/api/favorites") ? ["/api/favorites"] :
    url.startsWith("/api/playlists") ? ["/api/playlists"] :
    url.startsWith("/api/radio") ? ["/api/radio"] :
    url.startsWith("/api/podcasts") ? ["/api/podcasts"] :
    url.startsWith("/api/me/avatar") ? ["/api/me"] :
    url.startsWith("/api/reports") || url.startsWith("/api/admin/reports") ? ["/api/reports", "/api/admin/reports"] :
    url.startsWith("/api/admin/users") ? ["/api/admin/users"] :
    /^\/api\/tracks\/\d+\/lyrics$/.test(url) ? [url] :
    /\/(rating|star)$/.test(url) ? ["/api/me"] : // refresh library-state, rated, starred lists, insights
    null; // null = clear everything
  if (prefixes === null) getCache.clear();
  else for (const k of [...getCache.keys()]) { if (prefixes.some(p => k.startsWith(p))) getCache.delete(k); }
  cacheClearSubs.forEach(fn => fn(url));
}

async function req(url: string, opts: RequestInit = {}): Promise<any> {
  const method = (opts.method ?? "GET").toUpperCase();
  // Notifications are never cached (the badge polls for changes), and marking them
  // read does not clear the shared cache. Admin settings/prewarm are polled for
  // progress, so they bypass the cache too. So do bookmarks, written about every 15s
  // while listening.
  const noStore = url.includes("/notifications") || url.startsWith("/api/admin/settings") || url.startsWith("/api/admin/prewarm") || url.startsWith("/api/admin/open-folder") || url.startsWith("/api/bookmarks") || url.includes("/nowplaying") || url.includes("/progress") || url === "/api/scrobble/listen" || url === "/api/scrobble/now-playing" || url === "/api/home";
  const isMutation = method !== "GET" && !/\/play$/.test(url) && !noStore;
  if (method === "GET" && !noStore) {
    const hit = getCache.get(url);
    if (hit && Date.now() - hit.t < GET_TTL) { dlog(`GET cache ${shortUrl(url)}`); return hit.data; }
  }
  const key = generation + ":" + url;
  const cacheable = method === "GET" && !noStore && !opts.signal;
  if (cacheable && pendingGets.has(key)) return pendingGets.get(key)!;
  const version = generation;
  const work = async () => {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.signal?.aborted) abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, method === "GET" ? 12000 : 120000);
  try {
  // Only send a JSON content-type when there is a body. Fastify rejects a body-less
  // POST/DELETE that has one (HTTP 400, "empty JSON body").
  const res = await fetch(url, {
    credentials: "include",
    ...opts,
    signal: controller.signal,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Surface the server's error message instead of a bare status code.
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* no body */ }
    const e = new Error(msg) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  const revision = res.headers.get("x-lhm-library-revision");
  if (revision && revision !== libraryRevision) {
    libraryRevision = revision;
    try { localStorage.setItem("lhm-library-revision", revision); } catch { /* private mode */ }
  }
  const data = res.status === 204 ? null : await res.json();
  if (method === "GET" && version !== generation) return req(url, opts);
  if (method === "GET" && !noStore) {
    for (const [k, v] of getCache) if (Date.now() - v.t >= GET_TTL) getCache.delete(k);
    while (getCache.size >= MAX_GETS) getCache.delete(getCache.keys().next().value!);
    getCache.set(url, { t: Date.now(), data }); dlog(`GET net ${shortUrl(url)} ${Date.now() - started}ms`); }
  // Invalidate after the server confirms the mutation. Clearing before the fetch
  // lets a refetch race the mutation and re-cache old data.
  if (isMutation) invalidateFor(url);
  return data;
  } finally { clearTimeout(deadline); opts.signal?.removeEventListener("abort", abort); }
  };
  const promise = work();
  if (cacheable) {
    pendingGets.set(key, promise);
    void promise.finally(() => { if (pendingGets.get(key) === promise) pendingGets.delete(key); }).catch(() => {});
  }
  return promise;
}

export const api = {
  login: (username: string, password: string) =>
    req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => req("/api/auth/logout", { method: "POST" }),
  // "Don't ask for my password on this device": a secret this device keeps and signs in with.
  createDeviceToken: (): Promise<{ token: string }> => req("/api/auth/device", { method: "POST" }),
  deviceLogin: (username: string, token: string) =>
    req("/api/auth/device-login", { method: "POST", body: JSON.stringify({ username, token }) }),
  dropDeviceToken: (token: string) => req("/api/auth/device", { method: "DELETE", body: JSON.stringify({ token }) }),
  // Usernames the server lists on its sign-in page (empty unless the admin allows it).
  signInUsers: (): Promise<string[]> => req("/api/auth/users"),
  me: () => req("/api/me"),
  uploadAvatar: (dataUrl: string) => req("/api/me/avatar", { method: "POST", body: JSON.stringify({ image: dataUrl }) }),
  removeAvatar: () => req("/api/me/avatar", { method: "DELETE" }),
  getSubsonicPassword: () => req("/api/me/subsonic-password"),
  generateSubsonicPassword: () => req("/api/me/subsonic-password", { method: "POST" }),
  clearSubsonicPassword: () => req("/api/me/subsonic-password", { method: "DELETE" }),
  getArtists: () => req("/api/artists"),
  getAlbums: () => req("/api/albums"),
  getAlbumColors: () => req("/api/albums/colors"),
  getHome: () => req("/api/home"),
  getAudiobooks: () => req("/api/audiobooks"),
  getPodcasts: () => req("/api/podcasts"),
  getPodcast: (id: number) => req(`/api/podcasts/${id}`),
  searchPodcasts: (q: string) => req(`/api/podcasts/search?q=${encodeURIComponent(q)}`),
  getEpisode: (id: number) => req(`/api/podcasts/episodes/${id}`),
  subscribePodcast: (feedUrl: string) => req("/api/podcasts", { method: "POST", body: JSON.stringify({ feedUrl }) }),
  refreshPodcast: (id: number) => req(`/api/podcasts/${id}/refresh`, { method: "POST" }),
  deletePodcast: (id: number) => req(`/api/podcasts/${id}`, { method: "DELETE" }),
  savePodcastProgress: (episodeId: number, position: number, played?: boolean) =>
    req(`/api/podcasts/episodes/${episodeId}/progress`, { method: "PUT", body: JSON.stringify({ position, played }) }),
  downloadEpisode: (episodeId: number) => req(`/api/podcasts/episodes/${episodeId}/download`, { method: "POST" }),
  episodeDownloadProgress: (episodeId: number) => req(`/api/podcasts/episodes/${episodeId}/download/progress`),
  deleteEpisodeDownload: (episodeId: number) => req(`/api/podcasts/episodes/${episodeId}/download`, { method: "DELETE" }),
  getEpisodeTranscript: (episodeId: number) => req(`/api/podcasts/episodes/${episodeId}/transcript`),
  getRadioStations: () => req("/api/radio"),
  searchRadio: (q: string) => req(`/api/radio/search?q=${encodeURIComponent(q)}`),
  resolveRadio: (url: string) => req("/api/radio/resolve", { method: "POST", body: JSON.stringify({ url }) }),
  getRadioNowPlaying: (id: number) => req(`/api/radio/${id}/nowplaying`),
  addRadioStation: (s: { name: string; streamUrl: string; homepageUrl?: string; favicon?: string }) =>
    req("/api/radio", { method: "POST", body: JSON.stringify(s) }),
  updateRadioStation: (id: number, s: { name: string; streamUrl: string; homepageUrl?: string }) =>
    req(`/api/radio/${id}`, { method: "PUT", body: JSON.stringify(s) }),
  deleteRadioStation: (id: number) => req(`/api/radio/${id}`, { method: "DELETE" }),
  getChapters: (trackId: number) => req(`/api/tracks/${trackId}/chapters`),
  setAlbumAudiobook: (id: number, isAudiobook: boolean) =>
    req(`/api/albums/${id}/audiobook`, { method: "PUT", body: JSON.stringify({ isAudiobook }) }),
  // Per-track resume positions (ms). Written by the player for long-form audio.
  getBookmarks: () => req("/api/bookmarks"),
  saveBookmark: (trackId: number, position: number) =>
    req(`/api/bookmarks/${trackId}`, { method: "PUT", body: JSON.stringify({ position }) }),
  deleteBookmark: (trackId: number) =>
    req(`/api/bookmarks/${trackId}`, { method: "DELETE" }),
  getStorage: () => req("/api/library/storage"),
  getNotifications: () => req("/api/notifications"),
  markNotificationsRead: (ids?: number[]) =>
    req("/api/notifications/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) }),
  deleteNotification: (id: number) => req(`/api/notifications/${id}`, { method: "DELETE" }),
  getDiscover: () => req("/api/discover"),
  getRecent: () => req("/api/recent"),
  getQuality: (trackId: number) => req(`/api/tracks/${trackId}/quality`),
  recordPlay: (trackId: number) => req(`/api/tracks/${trackId}/play`, { method: "POST" }).catch(() => {}),
  // `size` requests a resized thumbnail (the server snaps to a bucket). Use it in
  // grids, omit it for hero art and lock-screen artwork.
  artistImageUrl: (id: number, size?: number) => `/api/artists/${id}/image${size ? `?size=${size}` : ""}`,
  fetchArtistImage: (id: number) => req(`/api/admin/artists/${id}/image/fetch`, { method: "POST" }),
  artistImageCandidates: (id: number) => req(`/api/admin/artists/${id}/image/candidates`),
  pickArtistImage: (id: number, url: string, source?: string) =>
    req(`/api/admin/artists/${id}/image/pick`, { method: "POST", body: JSON.stringify({ url, source }) }),
  uploadArtistImage: (id: number, dataUrl: string) =>
    req(`/api/admin/artists/${id}/image`, { method: "POST", body: JSON.stringify({ image: dataUrl }) }),
  getArtistAlbums: (id: number) => req(`/api/artists/${id}/albums`),
  // Albums the artist is credited on but doesn't own (guest verses, compilations).
  getArtistAppearsOn: (id: number) => req(`/api/artists/${id}/appears-on`),
  // Every track credited to the artist. Drives Play/Shuffle and Top Songs.
  getArtistTracks: (id: number) => req(`/api/artists/${id}/tracks`),
  getArtistInfo: (id: number) => req(`/api/artists/${id}/info`),
  getDiscography: (id: number) => req(`/api/artists/${id}/discography`),
  discoCoverUrl: (rgid: string) => `/api/discography/cover/${rgid}`,
  getDiscoTracks: (rgid: string) => req(`/api/discography/tracks/${rgid}`),
  searchExternal: (q: string) => req(`/api/discover/search?q=${encodeURIComponent(q)}`),
  getDiscoverFeed: (refresh?: boolean) => req(`/api/discover/feed${refresh ? "?refresh=1" : ""}`),
  getForYou: (refresh?: boolean) => req(`/api/discover/for-you${refresh ? "?refresh=1" : ""}`),
  // "Not interested", keyed by content so it holds across rebuilds.
  dismissDiscover: (key: string) =>
    req("/api/discover/dismiss", { method: "POST", body: JSON.stringify({ key }) }),
  getDiscoverDismissed: () => req("/api/discover/dismissed"),
  restoreDiscoverDismissed: () => req("/api/discover/dismissed", { method: "DELETE" }),
  getStats: () => req("/api/stats"),
  getScrobbleStats: (range: string) => req(`/api/stats/scrobbles?range=${encodeURIComponent(range)}`),
  getDiscographyByName: (name: string) => req(`/api/discography/by-name?name=${encodeURIComponent(name)}`),
  requestAlbum: (title: string, artist: string, year?: number | null, rgid?: string) =>
    req("/api/reports", { method: "POST", body: JSON.stringify({
      kind: "add_album", subject: `${title} - ${artist}`,
      detail: JSON.stringify({ year: year ?? null, rgid: rgid ?? null }),
    }) }),
  refreshArtistInfo: (id: number) => req(`/api/admin/artists/${id}/info/refresh`, { method: "POST" }),
  getAlbum: (id: number) => req(`/api/albums/${id}`),
  search: (q: string) => req(`/api/search?q=${encodeURIComponent(q)}`),
  getPlaylists: () => req("/api/playlists"),
  getGenres: () => req("/api/genres"),
  getGenre: (genre: string) => req(`/api/genres/${encodeURIComponent(genre)}`),
  createPlaylist: (name: string, rules?: any) => req("/api/playlists", { method: "POST", body: JSON.stringify({ name, rules }) }),
  addTracksToPlaylist: (id: number, trackIds: number[]) =>
    req(`/api/playlists/${id}/tracks`, { method: "POST", body: JSON.stringify({ trackIds }) }),
  getPlaylist: (id: number) => req(`/api/playlists/${id}`),
  addToPlaylist: (id: number, trackId: number) => req(`/api/playlists/${id}/tracks`, { method: "POST", body: JSON.stringify({ trackId }) }),
  removeFromPlaylist: (id: number, trackId: number) => req(`/api/playlists/${id}/tracks/${trackId}`, { method: "DELETE" }),
  renamePlaylist: (id: number, name: string) => req(`/api/playlists/${id}`, { method: "POST", body: JSON.stringify({ name }) }),
  updatePlaylist: (id: number, fields: { name?: string; description?: string; dedicated_to?: string; mood?: string; rules?: any }) =>
    req(`/api/playlists/${id}`, { method: "POST", body: JSON.stringify(fields) }),
  uploadPlaylistCover: (id: number, dataUrl: string) =>
    req(`/api/playlists/${id}/cover`, { method: "POST", body: JSON.stringify({ image: dataUrl }) }),
  playlistCoverUrl: (id: number) => `/api/playlists/${id}/cover`,
  deletePlaylist: (id: number) => req(`/api/playlists/${id}`, { method: "DELETE" }),
  reorderPlaylist: (id: number, trackIds: number[]) => req(`/api/playlists/${id}/reorder`, { method: "POST", body: JSON.stringify({ trackIds }) }),
  refreshSmartPlaylist: (id: number) => req(`/api/playlists/${id}/refresh`, { method: "POST" }),
  changePassword: (current: string, next: string) =>
    req("/api/auth/password", { method: "POST", body: JSON.stringify({ current, next }) }),
  resetUserPassword: (id: number, password: string) =>
    req(`/api/admin/users/${id}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  getUsers: () => req("/api/admin/users"),
  createUser: (username: string, password: string) =>
    req("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password }) }),
  rescan: () => req("/api/admin/rescan", { method: "POST" }),
  // For every user: ask for a background scan, and see whether one is running.
  requestRescan: (): Promise<{ started: boolean; scanning: boolean }> => req("/api/library/rescan", { method: "POST" }),
  scanStatus: (): Promise<{ scanning: boolean; lastScanAt: number | null }> => req("/api/library/scan"),
  getAdminSettings: () => req("/api/admin/settings"),
  serverUpdate: () => req("/api/admin/update"),
  checkServerUpdate: () => req("/api/admin/update/check", { method: "POST" }),
  saveAdminSettings: (patch: Record<string, unknown>) =>
    req("/api/admin/settings", { method: "PUT", body: JSON.stringify(patch) }),
  openFolder: (which: "music" | "audiobooks") =>
    req("/api/admin/open-folder", { method: "POST", body: JSON.stringify({ which }) }),
  clearTranscodes: (bitrate: number) =>
    req("/api/admin/transcodes/clear", { method: "POST", body: JSON.stringify({ bitrate }) }),
  getPrewarmStatus: () => req("/api/admin/prewarm"),
  getDuplicates: () => req("/api/admin/duplicates"),
  getIncompleteAlbums: () => req("/api/admin/incomplete"),
  deleteTrack: (id: number) => req(`/api/admin/tracks/${id}`, { method: "DELETE" }),
  createReport: (kind: string, subject: string, detail: string) =>
    req("/api/reports", { method: "POST", body: JSON.stringify({ kind, subject, detail }) }),
  getMyReports: () => req("/api/reports/mine"),
  getReports: () => req("/api/admin/reports"),
  setReportStatus: (id: number, status: string) =>
    req(`/api/admin/reports/${id}`, { method: "POST", body: JSON.stringify({ status }) }),
  deleteReport: (id: number) => req(`/api/admin/reports/${id}`, { method: "DELETE" }),
  getFavorites: () => req("/api/favorites"),
  addFavorite: (trackId: number) => req(`/api/favorites/${trackId}`, { method: "POST" }),
  removeFavorite: (trackId: number) => req(`/api/favorites/${trackId}`, { method: "DELETE" }),
  // Ratings (0-5), album/artist stars and "start radio" similar tracks. State is
  // shared with the Subsonic API, so it stays in sync with connected apps.
  getLibraryState: () => req("/api/me/library-state"),
  getRated: (rating?: number) => req(`/api/me/rated${rating ? `?rating=${rating}` : ""}`),
  getStarredAlbums: () => req("/api/me/starred-albums"),
  getStarredArtists: () => req("/api/me/starred-artists"),
  getRatingInsights: () => req("/api/me/rating-insights"),
  rateTrack: (trackId: number, rating: number) =>
    req(`/api/tracks/${trackId}/rating`, { method: "PUT", body: JSON.stringify({ rating }) }),
  getSimilar: (trackId: number, limit = 40) => req(`/api/tracks/${trackId}/similar?limit=${limit}`),
  getAutoDJ: (p: { mode: string; unit: string; count: number; seed?: number }) =>
    req(`/api/autodj?mode=${p.mode}&unit=${p.unit}&limit=${p.count}${p.seed ? `&seed=${p.seed}` : ""}`),
  starAlbum: (id: number, on: boolean) => req(`/api/albums/${id}/star`, { method: on ? "POST" : "DELETE" }),
  starArtist: (id: number, on: boolean) => req(`/api/artists/${id}/star`, { method: on ? "POST" : "DELETE" }),
  // Integrated loudness (LUFS) for volume normalization; null until the server has analyzed it.
  getLoudness: (trackId: number): Promise<{ loudness: number | null }> => req(`/api/tracks/${trackId}/loudness`),
  getLyrics: (trackId: number) => req(`/api/tracks/${trackId}/lyrics`),
  saveLyrics: (trackId: number, body: { synced?: string; plain?: string }) =>
    req(`/api/tracks/${trackId}/lyrics`, { method: "POST", body: JSON.stringify(body) }),
  // Publish hand-synced lyrics to LRCLIB. The server solves a proof-of-work, so
  // this can take a few seconds.
  publishLyrics: (trackId: number) =>
    req(`/api/tracks/${trackId}/lyrics/publish`, { method: "POST" }),
  // Your locally-created lyrics, each flagged with whether it's been shared to LRCLIB.
  myLyrics: (): Promise<{ trackId: number; title: string; albumId: number | null; artist: string | null; album: string | null; synced: boolean; published: boolean }[]> =>
    req(`/api/lyrics/mine`),

  // Scrobbling (opt-in). Nothing is sent unless the user connects an account.
  scrobbleAccounts: () => req(`/api/scrobble/accounts`),
  connectListenBrainz: (token: string) =>
    req(`/api/scrobble/listenbrainz`, { method: "POST", body: JSON.stringify({ token }) }),
  lastfmConnect: () => req(`/api/scrobble/lastfm/connect`),
  lastfmComplete: (token: string) =>
    req(`/api/scrobble/lastfm/complete`, { method: "POST", body: JSON.stringify({ token }) }),
  disconnectScrobble: (provider: string) => req(`/api/scrobble/${provider}`, { method: "DELETE" }),
  scrobbleNowPlaying: (trackId: number) =>
    req(`/api/scrobble/now-playing`, { method: "POST", body: JSON.stringify({ trackId }) }),
  scrobbleListen: (trackId: number, listenedAt: number) =>
    req(`/api/scrobble/listen`, { method: "POST", body: JSON.stringify({ trackId, listenedAt }) }),
  searchMetadata: (m: { title?: string; artist?: string; q?: string }) => {
    const p = new URLSearchParams();
    if (m.title) p.set("title", m.title);
    if (m.artist) p.set("artist", m.artist);
    if (m.q) p.set("q", m.q);
    return req(`/api/admin/metadata/search?${p.toString()}`);
  },
  applyMetadata: (trackId: number, m: { title: string; artist: string; album: string; year?: number; trackNo?: number; discNo?: number }) =>
    req(`/api/admin/tracks/${trackId}/metadata`, { method: "POST", body: JSON.stringify(m) }),
  coverUrl: (albumId: number, size?: number) => `/api/albums/${albumId}/cover${size ? `?size=${size}` : ""}`,
  // fmt="m4a" requests the fragmented-MP4/AAC transcode. Only applies when a
  // bitrate is set (original/lossless is served as-is).
  streamUrl: (trackId: number, bitrate?: number, fmt?: "m4a") =>
    `/api/stream/${trackId}${bitrate ? `?bitrate=${bitrate}${fmt ? `&fmt=${fmt}` : ""}` : ""}${revisionQuery(!!bitrate)}`,
};

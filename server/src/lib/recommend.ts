import { config } from "../config.js";

// Recommendation sources from the user's connected scrobble service. Read-only:
// top artists and similar artists. Last.fm's similar-artist graph only needs the
// server's api_key. ListenBrainz provides top-artist stats.

const LFM = "https://ws.audioscrobbler.com/2.0/";
const LB = "https://api.listenbrainz.org";

// Similar-artists (and Last.fm top artists) just need the API key, not a secret.
export const lastfmKeyed = () => !!config.lastfmApiKey;

async function lfm(params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams({ ...params, api_key: config.lastfmApiKey, format: "json" });
  try { const r = await fetch(`${LFM}?${q}`); return await r.json(); } catch { return null; }
}

// A user's top artists on Last.fm over the last 6 months.
export async function lfmTopArtists(username: string, limit = 20): Promise<string[]> {
  const j = await lfm({ method: "user.getTopArtists", user: username, limit: String(limit), period: "6month" });
  return (j?.topartists?.artist ?? []).map((a: any) => a?.name).filter(Boolean);
}
export async function lfmSimilarArtists(name: string, limit = 12): Promise<string[]> {
  const j = await lfm({ method: "artist.getSimilar", artist: name, limit: String(limit), autocorrect: "1" });
  return (j?.similarartists?.artist ?? []).map((a: any) => a?.name).filter(Boolean);
}
// Song-level similarity (track.getSimilar) as ranked {artist, title} pairs.
export async function lfmSimilarTracks(artist: string, title: string, limit = 40): Promise<{ artist: string; title: string }[]> {
  const j = await lfm({ method: "track.getSimilar", artist, track: title, limit: String(limit), autocorrect: "1" });
  return (j?.similartracks?.track ?? [])
    .map((t: any) => ({ artist: t?.artist?.name, title: t?.name }))
    .filter((t: any) => t.artist && t.title);
}

// Last.fm artist bio + tags (genres). Its API image field only returns
// placeholders.
const BAD_TAG = /^(seen live|favou?rites?|favorite|under \d|my |beautiful|awesome|love it|amazing|cool|spotify|albums i own|check out)/i;
export async function lfmArtistInfo(name: string): Promise<{ bio: string | null; genres: string | null }> {
  const j = await lfm({ method: "artist.getInfo", artist: name, autocorrect: "1" });
  const a = j?.artist;
  if (!a) return { bio: null, genres: null };
  const raw = String(a.bio?.content || a.bio?.summary || "");
  const bio = raw
    .replace(/<a\b[^>]*>.*?<\/a>/gis, "")   // drop "Read more on Last.fm" links
    .replace(/<[^>]+>/g, "")                // strip any remaining HTML
    .replace(/\s*User-contributed text is available.*$/is, "")
    .trim() || null;
  const tags = (a.tags?.tag ?? [])
    .map((t: any) => t?.name).filter((n: string) => n && !BAD_TAG.test(n)).slice(0, 4);
  return { bio, genres: tags.length ? tags.join(", ") : null };
}

// Time-ranged listening stats from the connected service (for the Listening
// page). Last.fm periods: 7day/1month/3month/6month/12month/overall.

export async function lfmTopArtistsDetailed(username: string, period: string, limit = 12): Promise<{ name: string; plays: number }[]> {
  const j = await lfm({ method: "user.getTopArtists", user: username, period, limit: String(limit) });
  return (j?.topartists?.artist ?? [])
    .map((a: any) => ({ name: a?.name, plays: Number(a?.playcount) || 0 })).filter((a: any) => a.name);
}
export async function lfmTopTracksDetailed(username: string, period: string, limit = 15): Promise<{ name: string; artist: string; plays: number }[]> {
  const j = await lfm({ method: "user.getTopTracks", user: username, period, limit: String(limit) });
  return (j?.toptracks?.track ?? [])
    .map((t: any) => ({ name: t?.name, artist: t?.artist?.name ?? "", plays: Number(t?.playcount) || 0 })).filter((t: any) => t.name);
}
export async function lfmUserPlaycount(username: string): Promise<number | null> {
  const j = await lfm({ method: "user.getInfo", user: username });
  const p = Number(j?.user?.playcount);
  return Number.isFinite(p) ? p : null;
}

// ListenBrainz equivalents. LB ranges: week/month/quarter/half_yearly/year/all_time.
async function lbGet(path: string): Promise<any> {
  try { const r = await fetch(`${LB}${path}`); return r.ok ? await r.json() : null; } catch { return null; }
}
export async function lbTopArtistsDetailed(username: string, range: string, limit = 12): Promise<{ name: string; plays: number }[]> {
  const j = await lbGet(`/1/stats/user/${encodeURIComponent(username)}/artists?range=${range}&count=${limit}`);
  return (j?.payload?.artists ?? []).map((a: any) => ({ name: a?.artist_name, plays: Number(a?.listen_count) || 0 })).filter((a: any) => a.name);
}
export async function lbTopTracksDetailed(username: string, range: string, limit = 15): Promise<{ name: string; artist: string; plays: number }[]> {
  const j = await lbGet(`/1/stats/user/${encodeURIComponent(username)}/recordings?range=${range}&count=${limit}`);
  return (j?.payload?.recordings ?? []).map((t: any) => ({ name: t?.track_name, artist: t?.artist_name ?? "", plays: Number(t?.listen_count) || 0 })).filter((t: any) => t.name);
}
export async function lbListenCount(username: string): Promise<number | null> {
  const j = await lbGet(`/1/user/${encodeURIComponent(username)}/listen-count`);
  const c = Number(j?.payload?.count);
  return Number.isFinite(c) ? c : null;
}

// A Deezer artist photo (medium, avatar-sized) by name. Last.fm no longer serves
// artist images.
export async function deezerArtistImage(name: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.deezer.com/search/artist?limit=1&q=${encodeURIComponent(name)}`);
    const j: any = r.ok ? await r.json() : null;
    return j?.data?.[0]?.picture_medium || j?.data?.[0]?.picture || null;
  } catch { return null; }
}

// A user's top artists on ListenBrainz (from their stats).
export async function lbTopArtists(username: string, limit = 20): Promise<string[]> {
  try {
    const r = await fetch(`${LB}/1/stats/user/${encodeURIComponent(username)}/artists?count=${limit}&range=month`);
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j?.payload?.artists ?? []).map((a: any) => a?.artist_name).filter(Boolean);
  } catch { return []; }
}

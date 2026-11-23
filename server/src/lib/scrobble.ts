import { createHash } from "node:crypto";
import { config } from "../config.js";

// Scrobble providers. Only reached for a user who has connected an account (see
// routes/scrobble.ts). No connection means nothing is sent.

const LB = "https://api.listenbrainz.org";
const LFM = "https://ws.audioscrobbler.com/2.0/";

export interface NowPlaying { artist: string; track: string; album?: string; }
export interface Listen extends NowPlaying { listenedAt: number; } // unix seconds

// ListenBrainz (token-based, no server config needed)

export async function lbValidate(token: string): Promise<{ valid: boolean; username?: string }> {
  try {
    const r = await fetch(`${LB}/1/validate-token`, { signal: AbortSignal.timeout(10000), headers: { Authorization: `Token ${token}` } });
    const j: any = await r.json();
    return { valid: !!j?.valid, username: j?.user_name };
  } catch { return { valid: false }; }
}

function lbMeta(np: NowPlaying) {
  const m: any = { artist_name: np.artist, track_name: np.track };
  if (np.album) m.release_name = np.album;
  return { track_metadata: m };
}
async function lbSubmit(token: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${LB}/1/submit-listens`, {
      method: "POST",
      signal: AbortSignal.timeout(10000), headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}
export const lbNowPlaying = (token: string, np: NowPlaying) =>
  lbSubmit(token, { listen_type: "playing_now", payload: [lbMeta(np)] });
export const lbListen = (token: string, l: Listen) =>
  lbSubmit(token, { listen_type: "single", payload: [{ listened_at: l.listenedAt, ...lbMeta(l) }] });

// Last.fm (needs an API app key+secret; requests are md5-signed)

export const lastfmAvailable = () => !!(config.lastfmApiKey && config.lastfmApiSecret);

// api_sig = md5( each param as `key+value`, sorted by key, concatenated, + secret ).
function sign(params: Record<string, string>): string {
  const str = Object.keys(params)
    .filter(k => k !== "format" && k !== "callback")
    .sort()
    .map(k => k + params[k])
    .join("") + config.lastfmApiSecret;
  return createHash("md5").update(str, "utf8").digest("hex");
}
async function lfmCall(params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<any> {
  const p = { ...params, api_key: config.lastfmApiKey };
  const body = new URLSearchParams({ ...p, api_sig: sign(p), format: "json" });
  try {
    const r = method === "GET"
      ? await fetch(`${LFM}?${body}`, { signal: AbortSignal.timeout(10000) })
      : await fetch(LFM, { signal: AbortSignal.timeout(10000), method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.ok ? await r.json() : { error: r.status };
  } catch { return { error: -1 }; }
}

export async function lfmGetToken(): Promise<string | null> {
  const j = await lfmCall({ method: "auth.getToken" });
  return j?.token ?? null;
}
export const lfmAuthUrl = (token: string) =>
  `https://www.last.fm/api/auth/?api_key=${config.lastfmApiKey}&token=${token}`;
export async function lfmGetSession(token: string): Promise<{ key: string; name: string } | null> {
  const j = await lfmCall({ method: "auth.getSession", token });
  return j?.session?.key ? { key: j.session.key, name: j.session.name } : null;
}
export async function lfmNowPlaying(sk: string, np: NowPlaying): Promise<boolean> {
  const params: Record<string, string> = { method: "track.updateNowPlaying", artist: np.artist, track: np.track, sk };
  if (np.album) params.album = np.album;
  const j = await lfmCall(params, "POST");
  return !!j && !j.error;
}
export async function lfmScrobble(sk: string, l: Listen): Promise<boolean> {
  const params: Record<string, string> = { method: "track.scrobble", artist: l.artist, track: l.track, timestamp: String(l.listenedAt), sk };
  if (l.album) params.album = l.album;
  const j = await lfmCall(params, "POST");
  return !!j && !j.error && Number(j.scrobbles?.["@attr"]?.accepted) > 0;
}

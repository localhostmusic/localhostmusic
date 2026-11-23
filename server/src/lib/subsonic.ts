// Subsonic / OpenSubsonic protocol helpers: response envelope (JSON + XML),
// credential auth, and id<->entity encoding. A compatibility layer over Localhost Music's
// own DB for third-party Subsonic clients.
import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { verifyPassword } from "./auth.js";
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from "./ratelimit.js";

export const SUBSONIC_API_VERSION = "1.16.1";
const SERVER_TYPE = "localhostmusic";
const SERVER_VERSION = "0.1.0";

// Subsonic error codes (subset we use).
export const ERR = {
  GENERIC: 0,
  MISSING_PARAM: 10,
  WRONG_CREDS: 40,
  TOKEN_UNSUPPORTED: 41,
  NOT_FOUND: 70,
} as const;

export class SubsonicError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

// Clients treat ids as opaque strings, but getAlbum/getArtist/stream must know
// which entity an id names, so ids are prefixed by type.
export const encodeId = {
  artist: (id: number | string) => `ar-${id}`,
  album: (id: number | string) => `al-${id}`,
  track: (id: number | string) => `tr-${id}`,
  playlist: (id: number | string) => `pl-${id}`,
};
// Playlist ids ride in their own params (id/playlistId) so they need only a
// prefix-strip, not the typed decodeId.
export const decodePlaylistId = (id: unknown) => Number(String(id ?? "").replace(/^pl-/, ""));
export function decodeId(id: string): { kind: "artist" | "album" | "track"; num: number } | null {
  const m = /^(ar|al|tr)-(\d+)$/.exec(String(id));
  if (!m) {
    // Some clients pass a bare numeric id (e.g. to stream). Treat it as a track.
    if (/^\d+$/.test(String(id))) return { kind: "track", num: Number(id) };
    return null;
  }
  const kind = ({ ar: "artist", al: "album", tr: "track" } as const)[m[1] as "ar" | "al" | "tr"];
  return { kind, num: Number(m[2]) };
}

// Verify Subsonic query-param credentials. Two schemes:
//   token:    t = md5(secret + s), s = salt. Needs a Subsonic app password
//             (`subsonic_credentials`), since the argon2 login hash can't be
//             re-hashed as md5.
//   password: p = <plaintext> or p = enc:<hex>. Matches the app password or the
//             user's login password.
export async function authenticate(
  db: Database.Database, query: any, ip = ""
): Promise<{ id: number; username: string; isAdmin: boolean }> {
  const username = String(query.u ?? "");
  if (!username) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter 'u' is missing.");

  // Same brute-force throttle as /api/auth/login. Only failures count, so clients
  // that re-authenticate on every request never trip it.
  const retryAfter = checkLoginAllowed(username, ip);
  if (retryAfter !== null)
    throw new SubsonicError(ERR.WRONG_CREDS, `Too many failed sign-in attempts. Try again in ${retryAfter}s.`);

  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as any;
  const appToken = user
    ? (db.prepare("SELECT token FROM subsonic_credentials WHERE user_id=?").get(user.id) as any)?.token as string | undefined
    : undefined;
  const wrong = () => {
    recordLoginFailure(username, ip);
    return new SubsonicError(ERR.WRONG_CREDS, "Wrong username or password.");
  };
  const ok = (u: any) => {
    recordLoginSuccess(username, ip);
    return { id: u.id, username: u.username, isAdmin: !!u.is_admin };
  };

  if (query.t !== undefined || query.s !== undefined) {
    if (query.t === undefined || query.s === undefined) {
      throw new SubsonicError(ERR.MISSING_PARAM, "Token auth requires both 't' and 's'.");
    }
    if (!user || !appToken) {
      throw new SubsonicError(ERR.TOKEN_UNSUPPORTED,
        "Token auth needs a Subsonic app-password. Generate one (POST /api/me/subsonic-password) or use password auth.");
    }
    const expected = createHash("md5").update(appToken + String(query.s)).digest("hex");
    if (String(query.t).toLowerCase() !== expected) throw wrong();
    return ok(user);
  }

  const rawP = query.p;
  if (rawP === undefined) throw new SubsonicError(ERR.MISSING_PARAM, "Required parameter 'p' is missing.");
  const password = String(rawP).startsWith("enc:")
    ? Buffer.from(String(rawP).slice(4), "hex").toString("utf8")
    : String(rawP);

  if (!user) throw wrong();
  if (appToken && password === appToken) return ok(user);
  if (await verifyPassword(user.password_hash, password)) return ok(user);
  throw wrong();
}

function baseResponse(extra: Record<string, unknown>) {
  return {
    status: "ok",
    version: SUBSONIC_API_VERSION,
    type: SERVER_TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    ...extra,
  };
}

// Send an OK response wrapping `payload` (e.g. { albumList2: { album: [...] } }).
export function sendSubsonic(req: FastifyRequest, reply: FastifyReply, payload: Record<string, unknown>) {
  const wantJson = String((req.query as any)?.f ?? "xml").toLowerCase() === "json";
  const body = baseResponse(payload);
  if (wantJson) {
    return reply.type("application/json").send({ "subsonic-response": body });
  }
  return reply.type("application/xml").send(toXml("subsonic-response", body));
}

export function sendSubsonicError(req: FastifyRequest, reply: FastifyReply, code: number, message: string) {
  const wantJson = String((req.query as any)?.f ?? "xml").toLowerCase() === "json";
  const body = {
    status: "failed", version: SUBSONIC_API_VERSION, type: SERVER_TYPE,
    serverVersion: SERVER_VERSION, openSubsonic: true,
    error: { code, message },
  };
  if (wantJson) return reply.type("application/json").send({ "subsonic-response": body });
  return reply.type("application/xml").send(toXml("subsonic-response", body));
}

// Subsonic XML convention: scalars become attributes, arrays repeated child
// elements (named by their key), nested objects a single child element.
function toXml(tag: string, obj: any): string {
  if (tag === "subsonic-response") {
    const { attrs, children } = splitProps(obj);
    return `<?xml version="1.0" encoding="UTF-8"?>` +
      `<subsonic-response xmlns="http://subsonic.org/restapi"${attrs}>${children}</subsonic-response>`;
  }
  return elem(tag, obj);
}

function splitProps(obj: any): { attrs: string; children: string; text: string } {
  let attrs = "", children = "", text = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) children += elem(k, item);
    } else if (typeof v === "object") {
      children += elem(k, v);
    } else if (k === "value") {
      // OpenSubsonic maps an element's text content to a JSON `value` field
      // (e.g. <genre>Rock</genre>). Render it as text, not an attribute.
      text += escapeText(String(v));
    } else {
      attrs += ` ${k}="${escapeAttr(String(v))}"`;
    }
  }
  return { attrs, children, text };
}

function elem(tag: string, v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "object") return `<${tag}>${escapeText(String(v))}</${tag}>`;
  const { attrs, children, text } = splitProps(v);
  const inner = text + children;
  return inner ? `<${tag}${attrs}>${inner}</${tag}>` : `<${tag}${attrs}/>`;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SUFFIX_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", m4b: "audio/mp4", mp4: "audio/mp4",
  aac: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  wav: "audio/wav", aiff: "audio/aiff", aif: "audio/aiff", ape: "audio/x-ape", wv: "audio/x-wavpack",
};
export const suffixOf = (path: string) => (path.split(".").pop() || "").toLowerCase();
export const contentTypeOf = (path: string) => SUFFIX_CONTENT_TYPE[suffixOf(path)] || "audio/mpeg";

export const iso = (ms?: number | null) => ms ? new Date(ms).toISOString() : undefined;

// A track row as a Subsonic Child (song). `opts.starred` (a ms timestamp) marks
// the song as favorited. `opts.rating` (0 to 5) is the user's rating.
export function toChild(t: any, opts?: { starred?: number | null; rating?: number | null }): Record<string, unknown> {
  const suffix = suffixOf(t.path);
  return {
    starred: opts?.starred != null ? iso(opts.starred) : undefined,
    userRating: opts?.rating != null ? opts.rating : undefined,
    id: encodeId.track(t.id),
    parent: t.album_id != null ? encodeId.album(t.album_id) : undefined,
    isDir: false,
    title: t.title,
    album: t.album ?? undefined,
    artist: t.artist ?? undefined,
    track: t.track_no ?? undefined,
    year: t.year ?? undefined,
    genre: t.genre || undefined,
    coverArt: t.album_id != null ? encodeId.album(t.album_id) : undefined,
    size: t.size ?? undefined,
    contentType: contentTypeOf(t.path),
    suffix,
    duration: t.duration != null ? Math.round(t.duration) : undefined,
    discNumber: t.disc_no ?? undefined,
    created: iso(t.added_at),
    albumId: t.album_id != null ? encodeId.album(t.album_id) : undefined,
    artistId: t.artist_id != null ? encodeId.artist(t.artist_id) : undefined,
    type: "music",
  };
}

// An album row (with songCount/duration/artist) as a Subsonic AlbumID3.
export function toAlbumID3(a: any, opts?: { starred?: number | null; rating?: number | null }): Record<string, unknown> {
  return {
    id: encodeId.album(a.id),
    name: a.title,
    artist: a.artist ?? undefined,
    artistId: a.artist_id != null ? encodeId.artist(a.artist_id) : undefined,
    coverArt: encodeId.album(a.id),
    songCount: a.songCount ?? 0,
    duration: a.duration != null ? Math.round(a.duration) : 0,
    created: iso(a.created),
    starred: opts?.starred != null ? iso(opts.starred) : undefined,
    userRating: opts?.rating != null ? opts.rating : undefined,
    year: a.year ?? undefined,
    genre: a.genre || undefined,
  };
}

export function toArtistID3(a: any, opts?: { starred?: number | null }): Record<string, unknown> {
  return {
    id: encodeId.artist(a.id),
    name: a.name,
    coverArt: encodeId.artist(a.id),
    albumCount: a.albumCount ?? 0,
    starred: opts?.starred != null ? iso(opts.starred) : undefined,
  };
}

// A playlist row (with songCount/duration/owner) as a Subsonic Playlist.
export function toPlaylist(p: any): Record<string, unknown> {
  return {
    id: encodeId.playlist(p.id),
    name: p.name,
    owner: p.owner ?? undefined,
    public: false,
    songCount: p.songCount ?? 0,
    duration: p.duration != null ? Math.round(p.duration) : 0,
    created: iso(p.created_at) ?? undefined,
    changed: iso(p.created_at) ?? undefined,
    coverArt: p.cover_path ? encodeId.playlist(p.id) : undefined,
    comment: p.description || undefined,
  };
}

// Parse a stored LRC blob into OpenSubsonic structured-lyrics lines. Returns
// null if there are no timestamped lines.
export function parseLrc(lrc: string): { start: number; value: string }[] | null {
  const out: { start: number; value: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    // A line may carry several [mm:ss.xx] stamps before the text.
    const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(("0." + m[3])) : 0;
      const start = Math.round((Number(m[1]) * 60 + Number(m[2]) + frac) * 1000);
      out.push({ start, value: text });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out.length ? out : null;
}

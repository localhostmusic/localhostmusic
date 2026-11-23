import type Database from "better-sqlite3";

// A smart playlist's track list is computed from rules instead of stored. Rules
// are whitelisted field/op pairs and every user value is parameterized, never
// interpolated.
export type SmartRule = { field: string; op: string; value: unknown };
export type SmartSpec = { match?: "all" | "any"; rules?: SmartRule[]; sort?: string; desc?: boolean; limit?: number };

const NUM_OPS = ["=", ">=", "<=", ">", "<"];

// One rule becomes a WHERE fragment (pushing its params). null skips an unknown/bad rule.
function ruleSql(r: SmartRule, uid: number, now: number, params: unknown[]): string | null {
  const v = r.value;
  switch (r.field) {
    case "rating":
      if (!NUM_OPS.includes(r.op)) return null;
      params.push(uid, Number(v) || 0);
      return `COALESCE((SELECT rating FROM subsonic_ratings WHERE kind='song' AND ref_id=t.id AND user_id=?),0) ${r.op} ?`;
    case "favorite": {
      const yes = v === true || v === "true" || v === "yes" || v === 1;
      params.push(uid);
      return `${yes ? "" : "NOT "}EXISTS(SELECT 1 FROM favorites WHERE track_id=t.id AND user_id=?)`;
    }
    case "genre":
      if (r.op === "contains") { params.push(`%${v}%`); return `t.genre LIKE ? COLLATE NOCASE`; }
      if (r.op === "isnot") { params.push(String(v)); return `(t.genre IS NULL OR t.genre <> ? COLLATE NOCASE)`; }
      params.push(String(v)); return `t.genre = ? COLLATE NOCASE`;
    case "artist":
      if (r.op === "contains") { params.push(`%${v}%`); return `ar.name LIKE ? COLLATE NOCASE`; }
      params.push(String(v)); return `ar.name = ? COLLATE NOCASE`;
    case "plays":
      if (!NUM_OPS.includes(r.op)) return null;
      params.push(Number(v) || 0); return `COALESCE(pc.count,0) ${r.op} ?`;
    case "addedWithinDays":
      params.push(now - (Number(v) || 0) * 86400000); return `t.added_at >= ?`;
    case "notPlayedInDays":
      params.push(now - (Number(v) || 0) * 86400000); return `(pc.last_played IS NULL OR pc.last_played < ?)`;
    case "playedWithinDays":
      params.push(now - (Number(v) || 0) * 86400000); return `pc.last_played >= ?`;
    default: return null;
  }
}

const SORT_EXPR: Record<string, string> = {
  added: "t.added_at", title: "t.title COLLATE NOCASE", artist: "ar.name COLLATE NOCASE",
  plays: "COALESCE(pc.count,0)", random: "RANDOM()",
};
const ASC_SORTS = new Set(["title", "artist"]);

export function evaluateSmart(db: Database.Database, spec: SmartSpec, uid: number, now = Date.now()): any[] {
  const params: unknown[] = [];
  const clauses = (spec.rules || []).map(r => ruleSql(r, uid, now, params)).filter(Boolean) as string[];
  const where = clauses.length ? `WHERE ${clauses.join(spec.match === "any" ? " OR " : " AND ")}` : "";

  const sortKey = SORT_EXPR[spec.sort || ""] ? (spec.sort as string) : (spec.sort === "rating" ? "rating" : "added");
  let orderExpr = SORT_EXPR[sortKey] || "t.added_at";
  const orderParams: unknown[] = [];
  if (sortKey === "rating") { orderExpr = `COALESCE((SELECT rating FROM subsonic_ratings WHERE kind='song' AND ref_id=t.id AND user_id=?),0)`; orderParams.push(uid); }
  const dir = sortKey === "random" ? "" : (ASC_SORTS.has(sortKey) ? "ASC" : (spec.desc === false ? "ASC" : "DESC"));
  const limit = Math.min(2000, Math.max(1, Number(spec.limit) || 200));

  const sql = `
    SELECT t.id, t.title, t.duration, t.album_id AS albumId, t.artist_id AS artistId, ar.name AS artist, al.title AS album,
           (LOWER(t.path) LIKE '%.flac' OR LOWER(t.path) LIKE '%.wav' OR LOWER(t.path) LIKE '%.aiff' OR LOWER(t.path) LIKE '%.aif' OR LOWER(t.path) LIKE '%.ape' OR LOWER(t.path) LIKE '%.wv') AS lossless
    FROM tracks t
    LEFT JOIN artists ar ON ar.id=t.artist_id
    LEFT JOIN albums al ON al.id=t.album_id
    LEFT JOIN play_counts pc ON pc.track_id=t.id
    ${where}
    ORDER BY ${orderExpr} ${dir}
    LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params, ...orderParams) as any[];
  return rows.map((r, i) => ({ ...r, position: i }));
}

// Evaluate, snapshot into playlist_tracks and stamp refreshed_at. The playlist
// serves the snapshot until the next refresh, so playing a track (which changes
// last_played / play count) doesn't reshuffle the list mid-use.
export function materializeSmart(db: Database.Database, playlistId: number, spec: SmartSpec, uid: number, now = Date.now()): void {
  const rows = evaluateSmart(db, spec, uid, now);
  const del = db.prepare("DELETE FROM playlist_tracks WHERE playlist_id=?");
  const ins = db.prepare("INSERT OR IGNORE INTO playlist_tracks(playlist_id,track_id,position) VALUES(?,?,?)");
  const stamp = db.prepare("UPDATE playlists SET refreshed_at=? WHERE id=?");
  db.transaction(() => {
    del.run(playlistId);
    rows.forEach((r, i) => ins.run(playlistId, r.id, i));
    stamp.run(now, playlistId);
  })();
}

// Is the snapshot due for a refresh, given the spec's cadence?
export function smartStale(spec: SmartSpec & { refresh?: string }, refreshedAt: number | null, now = Date.now()): boolean {
  if (refreshedAt == null) return true; // never materialized
  const mode = spec.refresh || "daily";
  if (mode === "open") return true;
  if (mode === "manual") return false;
  const span = mode === "weekly" ? 7 * 86400000 : 86400000; // daily default
  return now - refreshedAt > span;
}

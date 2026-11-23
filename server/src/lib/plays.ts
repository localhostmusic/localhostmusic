import type Database from "better-sqlite3";

// One play of one track: bumps the server-wide counter (most-played, discovery)
// and appends to the user's listen history (Home). Every play path (web player,
// Subsonic scrobble) goes through here.
export function recordPlay(db: Database.Database, userId: number, trackId: number, at: number) {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO play_counts(track_id, count, last_played) VALUES(?, 1, ?)
       ON CONFLICT(track_id) DO UPDATE SET count = count + 1, last_played = MAX(last_played, excluded.last_played)`
    ).run(trackId, at);
    db.prepare("INSERT INTO listens(user_id, track_id, played_at) VALUES(?, ?, ?)").run(userId, trackId, at);
  })();
}

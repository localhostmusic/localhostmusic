import type { FastifyInstance } from "fastify";
import { albumLossless } from "./library.js";

const DAY = 86_400_000;

// The Home screen: shelves built from the user's listen history (the `listens`
// table), plus library-wide ones (recently added, never played). While a user has
// little history, the history shelves fall back to server-wide play counts.
export async function homeRoutes(app: FastifyInstance) {
  const guard = { preHandler: app.authRequired };

  const ALBUM = `al.id, al.title, al.year, al.artist_id, ar.name AS artist, ${albumLossless}`;
  const MUSIC = `COALESCE(al.is_audiobook, 0) = 0`;

  app.get("/api/home", guard, async (req) => {
    const uid = req.user!.id;
    const now = Date.now();
    const all = (sql: string, ...args: unknown[]) => app.db.prepare(sql).all(...args) as any[];
    const listenCount = (app.db.prepare("SELECT COUNT(*) AS n FROM listens WHERE user_id=?").get(uid) as { n: number }).n;
    const ownHistory = listenCount >= 25;

    const jumpBackIn = ownHistory
      ? all(`SELECT ${ALBUM}, MAX(l.played_at) AS played
             FROM listens l JOIN tracks t ON t.id = l.track_id JOIN albums al ON al.id = t.album_id
             LEFT JOIN artists ar ON ar.id = al.artist_id
             WHERE l.user_id = ? AND ${MUSIC}
             GROUP BY al.id ORDER BY played DESC LIMIT 8`, uid)
      : all(`SELECT ${ALBUM}, MAX(pc.last_played) AS played
             FROM play_counts pc JOIN tracks t ON t.id = pc.track_id JOIN albums al ON al.id = t.album_id
             LEFT JOIN artists ar ON ar.id = al.artist_id
             WHERE pc.last_played IS NOT NULL AND ${MUSIC}
             GROUP BY al.id ORDER BY played DESC LIMIT 8`);

    const recentlyAdded = all(
      `SELECT ${ALBUM}, MAX(t.added_at) AS added
       FROM albums al JOIN tracks t ON t.album_id = al.id LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE ${MUSIC} AND t.added_at IS NOT NULL
       GROUP BY al.id ORDER BY added DESC LIMIT 18`);

    // What you've had on repeat this month: albums with at least 3 plays in 30 days.
    const rotation = ownHistory
      ? all(`SELECT ${ALBUM}, COUNT(*) AS plays
             FROM listens l JOIN tracks t ON t.id = l.track_id JOIN albums al ON al.id = t.album_id
             LEFT JOIN artists ar ON ar.id = al.artist_id
             WHERE l.user_id = ? AND l.played_at >= ? AND ${MUSIC}
             GROUP BY al.id HAVING plays >= 3 ORDER BY plays DESC LIMIT 12`, uid, now - 30 * DAY)
      : [];

    // Albums you used to play and haven't touched in three months.
    const rediscover = ownHistory
      ? all(`SELECT ${ALBUM}, COUNT(*) AS plays, MAX(l.played_at) AS played
             FROM listens l JOIN tracks t ON t.id = l.track_id JOIN albums al ON al.id = t.album_id
             LEFT JOIN artists ar ON ar.id = al.artist_id
             WHERE l.user_id = ? AND ${MUSIC}
             GROUP BY al.id HAVING played < ? AND plays >= 3 ORDER BY plays DESC LIMIT 12`, uid, now - 90 * DAY)
      : all(`SELECT ${ALBUM}, SUM(pc.count) AS plays, MAX(pc.last_played) AS played
             FROM play_counts pc JOIN tracks t ON t.id = pc.track_id JOIN albums al ON al.id = t.album_id
             LEFT JOIN artists ar ON ar.id = al.artist_id
             WHERE ${MUSIC}
             GROUP BY al.id HAVING played < ? AND plays >= 3 ORDER BY plays DESC LIMIT 12`, now - 90 * DAY);

    // Never played by anyone: a fresh dozen each visit.
    const unplayed = all(
      `SELECT ${ALBUM}
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE ${MUSIC} AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)
         AND NOT EXISTS (SELECT 1 FROM tracks t JOIN play_counts pc ON pc.track_id = t.id WHERE t.album_id = al.id)
       ORDER BY RANDOM() LIMIT 12`);

    // What you were playing on this date in earlier years (empty until there's a year of history).
    const onThisDay = all(
      `SELECT ${ALBUM}, MIN(strftime('%Y', l.played_at / 1000, 'unixepoch', 'localtime')) AS year_played
       FROM listens l JOIN tracks t ON t.id = l.track_id JOIN albums al ON al.id = t.album_id
       LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE l.user_id = ? AND ${MUSIC}
         AND strftime('%m-%d', l.played_at / 1000, 'unixepoch', 'localtime') = strftime('%m-%d', 'now', 'localtime')
         AND strftime('%Y', l.played_at / 1000, 'unixepoch', 'localtime') < strftime('%Y', 'now', 'localtime')
       GROUP BY al.id ORDER BY COUNT(*) DESC LIMIT 12`, uid);

    const artists = ownHistory
      ? all(`SELECT ar.id, ar.name, COUNT(*) AS plays
             FROM listens l JOIN tracks t ON t.id = l.track_id JOIN artists ar ON ar.id = t.artist_id
             WHERE l.user_id = ? AND l.played_at >= ? AND ar.name <> 'Unknown Artist'
             GROUP BY ar.id ORDER BY plays DESC LIMIT 10`, uid, now - 90 * DAY)
      : all(`SELECT ar.id, ar.name, SUM(pc.count) AS plays
             FROM play_counts pc JOIN tracks t ON t.id = pc.track_id JOIN artists ar ON ar.id = t.artist_id
             WHERE ar.name <> 'Unknown Artist'
             GROUP BY ar.id ORDER BY plays DESC LIMIT 10`);

    return { ownHistory, jumpBackIn, recentlyAdded, rotation, rediscover, unplayed, onThisDay, artists };
  });
}

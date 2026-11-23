import type { FastifyInstance } from "fastify";

// Insert a notification for a user. Shared with other routes (e.g. reports).
export function notify(db: any, userId: number, type: string, title: string, body?: string | null) {
  db.prepare(
    "INSERT INTO notifications(user_id,type,title,body,read,created_at) VALUES(?,?,?,?,0,?)"
  ).run(userId, type, title, body ?? null, Date.now());
}

export async function notificationRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authRequired };

  // The current user's recent notifications + unread count (drives the bell badge).
  app.get("/api/notifications", auth, async (req: any) => {
    const items = app.db.prepare(
      "SELECT id, type, title, body, read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id);
    const unread = (app.db.prepare(
      "SELECT COUNT(*) AS v FROM notifications WHERE user_id=? AND read=0"
    ).get(req.user.id) as any).v;
    return { items, unread };
  });

  // Mark specific ids read, or all of the user's unread when no ids are given.
  app.post("/api/notifications/read", auth, async (req: any) => {
    const ids = req.body?.ids as number[] | undefined;
    if (Array.isArray(ids) && ids.length) {
      const ph = ids.map(() => "?").join(",");
      app.db.prepare(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${ph})`).run(req.user.id, ...ids);
    } else {
      app.db.prepare("UPDATE notifications SET read=1 WHERE user_id=? AND read=0").run(req.user.id);
    }
    return { ok: true };
  });

  app.delete("/api/notifications/:id", auth, async (req: any) => {
    app.db.prepare("DELETE FROM notifications WHERE user_id=? AND id=?").run(req.user.id, Number(req.params.id));
    return { ok: true };
  });
}

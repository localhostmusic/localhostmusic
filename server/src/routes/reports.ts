import type { FastifyInstance } from "fastify";
import { notify } from "./notifications.js";

const KINDS = ["missing_content", "missing_lyrics", "wrong_art", "wrong_info", "add_album", "other"];
const STATUSES = ["open", "resolved", "dismissed"];

// User-submitted requests/reports (missing content, missing lyrics, wrong art/info)
// and the admin review surface.
export async function reportRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authRequired };
  const adminOnly = {
    preHandler: [app.authRequired, async (req: any, reply: any) => {
      if (!req.user?.isAdmin) return reply.code(403).send({ error: "forbidden" });
    }],
  };

  // Submit a request/report.
  app.post("/api/reports", auth, async (req: any, reply) => {
    const { kind, subject, detail } = req.body ?? {};
    if (!KINDS.includes(kind)) return reply.code(400).send({ error: "invalid kind" });
    const id = app.db.prepare(
      "INSERT INTO reports(user_id,kind,subject,detail,status,created_at) VALUES(?,?,?,?,'open',?)"
    ).run(req.user.id, kind, subject ?? null, detail ?? null, Date.now()).lastInsertRowid;
    return { id };
  });

  // The current user's own submissions.
  app.get("/api/reports/mine", auth, async (req: any) =>
    app.db.prepare(
      "SELECT id,kind,subject,detail,status,created_at FROM reports WHERE user_id=? ORDER BY created_at DESC"
    ).all(req.user.id));

  // Admin: everything, with the submitter's name.
  app.get("/api/admin/reports", adminOnly, async () =>
    app.db.prepare(
      `SELECT r.id, r.kind, r.subject, r.detail, r.status, r.created_at, u.username
       FROM reports r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY (r.status='open') DESC, r.created_at DESC`
    ).all());

  // Admin: change status. Resolving ("Mark acquired") notifies the requester.
  app.post("/api/admin/reports/:id", adminOnly, async (req: any, reply) => {
    const { status } = req.body ?? {};
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: "invalid status" });
    const id = Number(req.params.id);
    const r = app.db.prepare("SELECT user_id, kind, subject, status FROM reports WHERE id=?").get(id) as any;
    if (!r) return reply.code(404).send({ error: "not found" });
    app.db.prepare("UPDATE reports SET status=? WHERE id=?").run(status, id);
    // Notify the requester only on the transition into a terminal state.
    // Resolved = fulfilled, dismissed = won't do.
    if (r.status !== status && r.user_id && (status === "resolved" || status === "dismissed")) {
      const subj = r.subject ? `“${r.subject}”` : "your request";
      const msg = status === "resolved"
        ? (r.kind === "add_album" ? { title: "Album added", body: `${subj} is now in the library.` }
          : r.kind === "missing_lyrics" ? { title: "Lyrics added", body: `Lyrics for ${subj} are ready.` }
          : r.kind === "wrong_art" ? { title: "Artwork fixed", body: `Updated the artwork for ${subj}.` }
          : r.kind === "wrong_info" ? { title: "Info fixed", body: `Updated the details for ${subj}.` }
          : { title: "Request resolved", body: `${subj} has been handled.` })
        : (r.kind === "add_album" ? { title: "Album request update", body: `Sorry, ${subj} couldn’t be added.` }
          : { title: "Request update", body: `${subj} was closed without changes.` });
      notify(app.db, r.user_id, `request_${status}`, msg.title, msg.body);
    }
    return { ok: true };
  });

  // Admin: delete.
  app.delete("/api/admin/reports/:id", adminOnly, async (req: any) => {
    app.db.prepare("DELETE FROM reports WHERE id=?").run(Number(req.params.id));
    return { ok: true };
  });
}

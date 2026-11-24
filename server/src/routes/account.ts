import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";

// Per-user profile picture: upload / remove / serve. Stored as a file keyed by
// user id; the client cache-busts the served URL with ?v= on change.
export async function accountRoutes(app: FastifyInstance) {
  const dir = join(config.dataDir, "user-avatars");

  app.post("/api/me/avatar", { preHandler: app.authRequired, bodyLimit: 8 * 1024 * 1024 }, async (req: any, reply) => {
    const m = String(req.body?.image ?? "").match(/^data:image\/\w+;base64,(.+)$/s);
    if (!m) return reply.code(400).send({ error: "expected image data URL" });
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${req.user.id}.jpg`);
    writeFileSync(path, Buffer.from(m[1], "base64"));
    app.db.prepare("INSERT OR REPLACE INTO user_avatars(user_id,path,updated_at) VALUES(?,?,?)").run(req.user.id, path, Date.now());
    return { ok: true };
  });

  app.delete("/api/me/avatar", { preHandler: app.authRequired }, async (req: any) => {
    const row = app.db.prepare("SELECT path FROM user_avatars WHERE user_id=?").get(req.user.id) as any;
    if (row?.path) { try { unlinkSync(row.path); } catch { /* already gone */ } }
    app.db.prepare("DELETE FROM user_avatars WHERE user_id=?").run(req.user.id);
    return { ok: true };
  });

  app.get("/api/me/avatar", { preHandler: app.authRequired }, async (req: any, reply) => {
    const row = app.db.prepare("SELECT path FROM user_avatars WHERE user_id=?").get(req.user.id) as any;
    if (!row?.path || !existsSync(row.path)) return reply.code(404).send();
    // private: the same address returns a different picture per signed-in user.
    reply.type("image/jpeg").header("Cache-Control", "private, no-cache").header("Vary", "Cookie");
    return createReadStream(row.path);
  });

  // Subsonic app-password: a generated secret used as the Subsonic API credential
  // (same username). Enables Subsonic token auth without exposing the login password.
  app.get("/api/me/subsonic-password", { preHandler: app.authRequired }, async (req: any) => {
    const row = app.db.prepare("SELECT token, created_at FROM subsonic_credentials WHERE user_id=?").get(req.user.id) as any;
    return { token: row?.token ?? null, createdAt: row?.created_at ?? null };
  });

  app.post("/api/me/subsonic-password", { preHandler: app.authRequired }, async (req: any) => {
    const token = randomBytes(18).toString("base64url"); // ~24 chars, url/query-safe
    app.db.prepare("INSERT OR REPLACE INTO subsonic_credentials(user_id,token,created_at) VALUES(?,?,?)")
      .run(req.user.id, token, Date.now());
    return { token };
  });

  app.delete("/api/me/subsonic-password", { preHandler: app.authRequired }, async (req: any) => {
    app.db.prepare("DELETE FROM subsonic_credentials WHERE user_id=?").run(req.user.id);
    return { ok: true };
  });
}

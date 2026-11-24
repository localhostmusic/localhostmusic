import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword, signToken, tokenHash, verifyToken, passwordProblem, setPassword } from "../lib/auth.js";
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from "../lib/ratelimit.js";
import { config } from "../config.js";
import { getSettings } from "../lib/settings.js";

// The session cookie carries a 30-day token, so it should not travel in the clear,
// but hardcoding `secure` breaks plain-HTTP LAN installs (the browser drops the
// cookie). Default: follow the request's scheme, honouring x-forwarded-proto only
// with TRUST_PROXY (a client could set that header). COOKIE_SECURE=1/0 overrides.
export function cookieSecureFor(req: FastifyRequest): boolean {
  if (config.cookieSecure !== "auto") return config.cookieSecure;
  return req.protocol === "https";
}

export function sessionCookieOptions(req: FastifyRequest) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: cookieSecureFor(req),
    maxAge: 30 * 24 * 60 * 60, // match the token's own 30d lifetime
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as any;
    const name = String(username ?? "").trim();

    // Throttle before doing any work, including the argon2 hash.
    const retryAfter = checkLoginAllowed(name, req.ip);
    if (retryAfter !== null) {
      return reply.code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: "Too many failed sign-in attempts. Try again shortly.", retryAfter });
    }

    // Usernames are case-insensitive (so "Admin" == "admin"); passwords stay exact.
    const user = app.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(name) as any;
    if (!user || !(await verifyPassword(user.password_hash, password))) {
      recordLoginFailure(name, req.ip);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    recordLoginSuccess(name, req.ip);

    const token = signToken({ id: user.id, username: user.username, isAdmin: !!user.is_admin, sessionVersion: user.session_version });
    reply.setCookie("lhm_session", token, sessionCookieOptions(req));
    return { id: user.id, username: user.username, isAdmin: !!user.is_admin };
  });

  // Names for the sign-in page's profile picker. Public, so it stays empty unless
  // the admin turned the setting on.
  app.get("/api/auth/users", async () =>
    getSettings(app.db).showUsersOnSignIn
      ? (app.db.prepare("SELECT username FROM users ORDER BY username COLLATE NOCASE").all() as any[]).map(u => u.username)
      : []);

  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.lhm_session;
    if (token) try {
      verifyToken(token);
      app.db.prepare("DELETE FROM revoked_sessions WHERE expires_at<?").run(Date.now());
      app.db.prepare("INSERT OR REPLACE INTO revoked_sessions VALUES(?,?)").run(tokenHash(token), Date.now() + 30 * 86400_000);
    } catch { /* already invalid; still clear the browser cookie */ }
    reply.clearCookie("lhm_session", { path: "/", secure: cookieSecureFor(req), sameSite: "lax" });
    return { ok: true };
  });

  // Change your own password. Every other device is signed out; this one gets a
  // fresh cookie. Wrong guesses count against the sign-in throttle.
  app.post("/api/auth/password", { preHandler: app.authRequired }, async (req: any, reply: FastifyReply) => {
    const current = String(req.body?.current ?? ""), next = req.body?.next;
    const problem = passwordProblem(next);
    if (problem) return reply.code(400).send({ error: problem });

    const retryAfter = checkLoginAllowed(req.user.username, req.ip);
    if (retryAfter !== null) {
      return reply.code(429).header("Retry-After", String(retryAfter))
        .send({ error: "Too many wrong attempts. Try again shortly.", retryAfter });
    }
    const row = app.db.prepare("SELECT password_hash FROM users WHERE id=?").get(req.user.id) as any;
    if (!row || !(await verifyPassword(row.password_hash, current))) {
      recordLoginFailure(req.user.username, req.ip);
      return reply.code(403).send({ error: "Your current password is not right." });
    }
    recordLoginSuccess(req.user.username, req.ip);

    const sessionVersion = await setPassword(app.db, req.user.id, next);
    reply.setCookie("lhm_session", signToken({ ...req.user, sessionVersion }), sessionCookieOptions(req));
    return { ok: true };
  });

  app.get("/api/me", { preHandler: app.authRequired }, async (req: any) => req.user);
}

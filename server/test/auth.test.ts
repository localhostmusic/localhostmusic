import { test, expect, beforeEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { loginLimiter, loginIpLimiter } from "../src/lib/ratelimit.js";

async function appWithUser() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)")
    .run("admin", await hashPassword("secret"));
  return buildApp(db);
}

// The throttle is process-wide state; isolate each test from the last.
beforeEach(() => { loginLimiter.clear(); loginIpLimiter.clear(); });

test("login sets cookie and rejects bad password", async () => {
  const app = await appWithUser();
  const ok = await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { username: "admin", password: "secret" } });
  expect(ok.statusCode).toBe(200);
  expect(ok.cookies.find(c => c.name === "lhm_session")).toBeTruthy();

  const bad = await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { username: "admin", password: "nope" } });
  expect(bad.statusCode).toBe(401);
  await app.close();
});

test("protected route rejects without cookie", async () => {
  const app = await appWithUser();
  const res = await app.inject({ method: "GET", url: "/api/me" });
  expect(res.statusCode).toBe(401);
  await app.close();
});

test("repeated wrong passwords are throttled with a 429", async () => {
  const app = await appWithUser();
  const attempt = (password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password } });

  for (let i = 0; i < 10; i++) expect((await attempt("nope")).statusCode).toBe(401);

  const blocked = await attempt("nope");
  expect(blocked.statusCode).toBe(429);
  expect(blocked.headers["retry-after"]).toBeTruthy();

  // Once throttled, the correct password is refused too, so the endpoint can't be
  // used as an oracle.
  expect((await attempt("secret")).statusCode).toBe(429);
  await app.close();
});

test("a successful login clears the failure count", async () => {
  const app = await appWithUser();
  const attempt = (password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password } });

  for (let i = 0; i < 9; i++) await attempt("nope");
  expect((await attempt("secret")).statusCode).toBe(200);
  // Back to a full budget rather than one attempt from a lockout.
  for (let i = 0; i < 9; i++) expect((await attempt("nope")).statusCode).toBe(401);
  await app.close();
});

import { test, expect, beforeEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { resetAdminPassword } from "../src/lib/bootstrap.js";
import { loginLimiter, loginIpLimiter } from "../src/lib/ratelimit.js";

beforeEach(() => { loginLimiter.clear(); loginIpLimiter.clear(); });

async function setup() {
  const db = openDb(":memory:");
  const add = async (name: string, pw: string, admin: number) =>
    Number(db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,?)").run(name, await hashPassword(pw), admin).lastInsertRowid);
  const adminId = await add("admin", "old-admin-pw", 1);
  const bobId = await add("bob", "old-bob-pw", 0);
  const app = buildApp(db);
  const login = async (username: string, password: string) => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    return { status: r.statusCode, cookie: r.cookies.find(c => c.name === "lhm_session")?.value ?? "" };
  };
  const me = (cookie: string) => app.inject({ url: "/api/me", cookies: { lhm_session: cookie } }).then(r => r.statusCode);
  return { db, app, login, me, adminId, bobId };
}

test("changing your password needs the current one and a long enough new one", async () => {
  const { app, login } = await setup();
  const { cookie } = await login("bob", "old-bob-pw");
  const change = (current: string, next: string) =>
    app.inject({ method: "POST", url: "/api/auth/password", cookies: { lhm_session: cookie }, payload: { current, next } });

  expect((await change("wrong", "a-new-password")).statusCode).toBe(403);
  expect((await change("old-bob-pw", "short")).statusCode).toBe(400);
  expect((await login("bob", "old-bob-pw")).status).toBe(200);
  await app.close();
});

test("a password change signs out other devices and keeps this one", async () => {
  const { app, login, me } = await setup();
  const phone = (await login("bob", "old-bob-pw")).cookie;
  const laptop = (await login("bob", "old-bob-pw")).cookie;

  const res = await app.inject({ method: "POST", url: "/api/auth/password", cookies: { lhm_session: laptop },
    payload: { current: "old-bob-pw", next: "a-new-password" } });
  expect(res.statusCode).toBe(200);
  const fresh = res.cookies.find(c => c.name === "lhm_session")!.value;

  expect(await me(fresh)).toBe(200);
  expect(await me(phone)).toBe(401);
  expect(await me(laptop)).toBe(401);
  expect((await login("bob", "old-bob-pw")).status).toBe(401);
  expect((await login("bob", "a-new-password")).status).toBe(200);
  await app.close();
});

test("an admin can reset someone else's password, a regular user cannot", async () => {
  const { app, login, me, bobId, adminId } = await setup();
  const admin = (await login("admin", "old-admin-pw")).cookie;
  const bob = (await login("bob", "old-bob-pw")).cookie;
  const reset = (cookie: string, id: number, password: string) =>
    app.inject({ method: "POST", url: `/api/admin/users/${id}/password`, cookies: { lhm_session: cookie }, payload: { password } });

  expect((await reset(bob, adminId, "hijacked-password")).statusCode).toBe(403);
  expect((await reset(admin, bobId, "short")).statusCode).toBe(400);
  expect((await reset(admin, adminId, "my-own-new-password")).statusCode).toBe(400);
  expect((await reset(admin, 999, "whatever-password")).statusCode).toBe(404);

  expect((await reset(admin, bobId, "reset-by-admin")).statusCode).toBe(200);
  expect(await me(bob)).toBe(401);
  expect((await login("bob", "reset-by-admin")).status).toBe(200);
  expect(await me(admin)).toBe(200);
  await app.close();
});

test("RESET_ADMIN_PASSWORD recovery sets the admin password and refuses a weak one", async () => {
  const { db, app, login } = await setup();
  expect(await resetAdminPassword(db, "admin", "short")).toMatch(/ignored/);
  expect(await resetAdminPassword(db, "bob", "long-enough-password")).toMatch(/no admin/);
  expect((await login("admin", "old-admin-pw")).status).toBe(200);

  expect(await resetAdminPassword(db, "Admin", "recovered-password")).toMatch(/^Reset/);
  expect((await login("admin", "old-admin-pw")).status).toBe(401);
  expect((await login("admin", "recovered-password")).status).toBe(200);
  await app.close();
});

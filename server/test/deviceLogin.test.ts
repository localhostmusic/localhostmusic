import { test, expect, beforeEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { loginLimiter, loginIpLimiter } from "../src/lib/ratelimit.js";

beforeEach(() => { loginLimiter.clear(); loginIpLimiter.clear(); });

async function setup() {
  const db = openDb(":memory:");
  for (const [name, pw] of [["bob", "bob-password"], ["zoe", "zoe-password"]])
    db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)").run(name, await hashPassword(pw));
  const app = buildApp(db);
  const cookieOf = (r: any) => r.cookies.find((c: any) => c.name === "lhm_session")?.value ?? "";
  const login = async (username: string, password: string) =>
    cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } }));
  const optIn = async (cookie: string) =>
    (await app.inject({ method: "POST", url: "/api/auth/device", cookies: { lhm_session: cookie } })).json().token as string;
  const deviceLogin = (username: string, token: unknown) =>
    app.inject({ method: "POST", url: "/api/auth/device-login", payload: { username, token } });
  const who = async (cookie: string) => (await app.inject({ url: "/api/me", cookies: { lhm_session: cookie } })).json().username;
  return { db, app, login, optIn, deviceLogin, who, cookieOf };
}

test("a device that opted in signs in without the password, as that user only", async () => {
  const { app, db, login, optIn, deviceLogin, who, cookieOf } = await setup();
  const token = await optIn(await login("bob", "bob-password"));
  expect(token.length).toBeGreaterThan(30);
  // Only a hash is stored.
  expect((db.prepare("SELECT token_hash FROM device_logins").get() as any).token_hash).not.toBe(token);

  const ok = await deviceLogin("Bob", token); // usernames are case-insensitive
  expect(ok.statusCode).toBe(200);
  expect(await who(cookieOf(ok))).toBe("bob");

  expect((await deviceLogin("zoe", token)).statusCode).toBe(401); // bob's secret does not open zoe
  expect((await deviceLogin("bob", "not-the-token")).statusCode).toBe(401);
  expect((await deviceLogin("bob", undefined)).statusCode).toBe(401);
  await app.close();
});

test("opting in needs a signed-in session", async () => {
  const { app } = await setup();
  expect((await app.inject({ method: "POST", url: "/api/auth/device" })).statusCode).toBe(401);
  await app.close();
});

test("changing the password, removing the device, or long disuse turns it off", async () => {
  const { app, db, login, optIn, deviceLogin } = await setup();
  const cookie = await login("bob", "bob-password");
  const a = await optIn(cookie), b = await optIn(cookie), c = await optIn(cookie);

  // Removed from one device: the others keep working.
  await app.inject({ method: "DELETE", url: "/api/auth/device", payload: { token: a } });
  expect((await deviceLogin("bob", a)).statusCode).toBe(401);
  expect((await deviceLogin("bob", b)).statusCode).toBe(200);

  // Unused for too long.
  db.prepare("UPDATE device_logins SET last_used_at=?").run(Date.now() - 181 * 86400_000);
  expect((await deviceLogin("bob", b)).statusCode).toBe(401);
  loginLimiter.clear(); loginIpLimiter.clear();

  // A password change clears every device.
  const d = await optIn(cookie);
  expect((await deviceLogin("bob", d)).statusCode).toBe(200);
  const changed = await app.inject({ method: "POST", url: "/api/auth/password", cookies: { lhm_session: cookie }, payload: { current: "bob-password", next: "a-brand-new-password" } });
  expect(changed.statusCode).toBe(200);
  expect((await deviceLogin("bob", d)).statusCode).toBe(401);
  expect((await deviceLogin("bob", c)).statusCode).toBe(401);
  await app.close();
});

test("wrong secrets are throttled like wrong passwords", async () => {
  const { app, deviceLogin } = await setup();
  let last = 0;
  for (let i = 0; i < 30 && last !== 429; i++) last = (await deviceLogin("bob", "guess-" + i)).statusCode;
  expect(last).toBe(429);
  await app.close();
});

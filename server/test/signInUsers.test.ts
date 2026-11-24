import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { saveSettings } from "../src/lib/settings.js";

test("the sign-in page gets no usernames unless the admin turns the setting on", async () => {
  const db = openDb(":memory:");
  for (const [name, admin] of [["zoe", 0], ["Admin", 1], ["bob", 0]] as const)
    db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,?)").run(name, await hashPassword("some-password"), admin);
  const app = buildApp(db);
  const list = async () => (await app.inject({ url: "/api/auth/users" })).json();

  expect(await list()).toEqual([]);
  saveSettings(db, { showUsersOnSignIn: true });
  expect(await list()).toEqual(["Admin", "bob", "zoe"]);
  saveSettings(db, { showUsersOnSignIn: false });
  expect(await list()).toEqual([]);
  await app.close();
});

test("only an admin can change the setting", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)").run("bob", await hashPassword("some-password"));
  const app = buildApp(db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "bob", password: "some-password" } });
  const cookie = login.cookies.find(c => c.name === "lhm_session")!.value;
  const r = await app.inject({ method: "PUT", url: "/api/admin/settings", cookies: { lhm_session: cookie }, payload: { showUsersOnSignIn: true } });
  expect(r.statusCode).toBe(403);
  expect((await app.inject({ url: "/api/auth/users" })).json()).toEqual([]);
  await app.close();
});

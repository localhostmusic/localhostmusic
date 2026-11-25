import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { saveSettings } from "../src/lib/settings.js";
import { isScanning } from "../src/lib/libraryScan.js";

test("any signed-in user can ask for a rescan, but not twice in a row", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)").run("bob", await hashPassword("some-password"));
  saveSettings(db, { musicDir: mkdtempSync(join(tmpdir(), "lhm-empty-music-")) });
  const app = buildApp(db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "bob", password: "some-password" } });
  const cookies = { lhm_session: login.cookies.find(c => c.name === "lhm_session")!.value };

  expect((await app.inject({ method: "POST", url: "/api/library/rescan" })).statusCode).toBe(401);

  const first = await app.inject({ method: "POST", url: "/api/library/rescan", cookies });
  expect(first.statusCode).toBe(200);
  expect(first.json().started).toBe(true);
  for (let i = 0; i < 100 && isScanning(); i++) await new Promise(r => setTimeout(r, 20));

  const status = (await app.inject({ url: "/api/library/scan", cookies })).json();
  expect(status.scanning).toBe(false);
  expect(status.lastScanAt).toBeGreaterThan(0);

  const again = await app.inject({ method: "POST", url: "/api/library/rescan", cookies });
  expect(again.statusCode).toBe(429);
  expect(again.json().retryAfter).toBeGreaterThan(0);

  // The admin's own button is still admin-only.
  expect((await app.inject({ method: "POST", url: "/api/admin/rescan", cookies })).statusCode).toBe(403);
  await app.close();
});

test("the automatic scan interval is at least five minutes, and 0 turns it off", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("some-password"));
  const app = buildApp(db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "some-password" } });
  const cookies = { lhm_session: login.cookies.find(c => c.name === "lhm_session")!.value };
  const set = async (n: unknown) => {
    const r = await app.inject({ method: "PUT", url: "/api/admin/settings", cookies, payload: { autoScanMinutes: n } });
    return r.statusCode === 200 ? (await app.inject({ url: "/api/admin/settings", cookies })).json().autoScanMinutes : r.statusCode;
  };
  expect((await app.inject({ url: "/api/admin/settings", cookies })).json().autoScanMinutes).toBe(15);
  expect(await set(1)).toBe(5);
  expect(await set(60)).toBe(60);
  expect(await set(0)).toBe(0);
  expect(await set(-3)).toBe(400);
  await app.close();
});

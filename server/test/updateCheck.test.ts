import { test, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { hashPassword } from "../src/lib/auth.js";
import { saveSettings } from "../src/lib/settings.js";
import { checkForUpdate, compareVersions, updateInfo } from "../src/lib/updateCheck.js";

const github = (tag: string, body = "## What's new\n\n- Something") => async () =>
  ({ ok: true, status: 200, json: async () => ({ tag_name: tag, body, html_url: "https://example.test/release" }) });

beforeEach(() => { process.env.LHM_VERSION = "0.1.11"; delete process.env.LHM_UPDATE_CHECK; });
afterEach(() => { delete process.env.LHM_VERSION; delete process.env.LHM_UPDATE_CHECK; });

async function setup() {
  const db = openDb(":memory:");
  const admin = Number(db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("some-password")).lastInsertRowid);
  const bob = Number(db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)").run("bob", await hashPassword("some-password")).lastInsertRowid);
  const notes = (id: number) => (db.prepare("SELECT title FROM notifications WHERE user_id=? AND type='update'").all(id) as any[]).map(n => n.title);
  return { db, admin, bob, notes };
}

test("versions compare by number, not as text", () => {
  expect(compareVersions("0.1.12", "0.1.11")).toBe(1);
  expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
  expect(compareVersions("v0.2.0", "0.1.99")).toBe(1);
  expect(compareVersions("0.1.11", "0.1.11")).toBe(0);
  expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
});

test("a newer release is reported and admins are told once", async () => {
  const { db, admin, bob, notes } = await setup();
  const info = await checkForUpdate(db, github("v0.1.12"));
  expect(info).toMatchObject({ current: "0.1.11", latest: "0.1.12", available: true, enabled: true });
  expect(info.notes).toContain("Something");
  expect(notes(admin)).toEqual(["Version 0.1.12 is available"]);
  expect(notes(bob)).toEqual([]); // not an admin

  await checkForUpdate(db, github("v0.1.12")); // the next day, same version
  expect(notes(admin)).toHaveLength(1);
  await checkForUpdate(db, github("v0.1.13"));
  expect(notes(admin)).toHaveLength(2);
});

test("the same or an older release is not an update", async () => {
  const { db, admin, notes } = await setup();
  expect((await checkForUpdate(db, github("v0.1.11"))).available).toBe(false);
  expect((await checkForUpdate(db, github("v0.1.10"))).available).toBe(false);
  expect(notes(admin)).toEqual([]);
});

test("turned off, the server does not contact GitHub", async () => {
  const { db } = await setup();
  let calls = 0;
  const counting = async () => { calls++; return github("v9.9.9")(); };

  saveSettings(db, { updateCheck: false });
  expect((await checkForUpdate(db, counting)).enabled).toBe(false);
  saveSettings(db, { updateCheck: true });
  process.env.LHM_UPDATE_CHECK = "0"; // how the desktop app switches it off
  expect((await checkForUpdate(db, counting)).enabled).toBe(false);
  expect(calls).toBe(0);
});

test("GitHub being unreachable is reported, not thrown", async () => {
  const { db } = await setup();
  const info = await checkForUpdate(db, async () => { throw new Error("offline"); });
  expect(info.error).toContain("offline");
  expect(updateInfo(db).current).toBe("0.1.11");
});

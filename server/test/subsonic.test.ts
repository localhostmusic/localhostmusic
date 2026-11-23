import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { hashPassword } from "../src/lib/auth.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

async function setup() {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname, "fixtures"), mkdtempSync(join(tmpdir(), "s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  db.prepare("INSERT INTO subsonic_credentials(user_id,token,created_at) VALUES(1,?,?)").run("app-secret-123", Date.now());
  return { db, app: buildApp(db) };
}
// Subsonic token auth params for a given salt.
function tokenAuth(secret: string, salt: string) {
  const t = createHash("md5").update(secret + salt).digest("hex");
  return `u=admin&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`;
}

test("token auth with the app-password succeeds; wrong token fails 40", async () => {
  const { app } = await setup();
  const ok = await app.inject({ url: `/rest/ping.view?${tokenAuth("app-secret-123", "abcd")}` });
  expect(ok.json()["subsonic-response"].status).toBe("ok");

  const bad = await app.inject({ url: "/rest/ping.view?u=admin&t=deadbeef&s=abcd&v=1.16.1&c=test&f=json" });
  expect(bad.json()["subsonic-response"].error.code).toBe(40);

  const noCred = await app.inject({ url: "/rest/ping.view?f=json&v=1.16.1&c=test" });
  expect(noCred.json()["subsonic-response"].error.code).toBe(10); // missing 'u'
  await app.close();
});

test("password auth also works with the real login password", async () => {
  const { app } = await setup();
  const r = await app.inject({ url: "/rest/ping.view?u=admin&p=pw&v=1.16.1&c=test&f=json" });
  expect(r.json()["subsonic-response"].status).toBe("ok");
  await app.close();
});

test("getAlbumList2 returns albums in the OpenSubsonic envelope", async () => {
  const { app } = await setup();
  const r = await app.inject({ url: `/rest/getAlbumList2.view?${tokenAuth("app-secret-123", "s1")}&type=newest` });
  const body = r.json()["subsonic-response"];
  expect(body.status).toBe("ok");
  expect(body.openSubsonic).toBe(true);
  expect(Array.isArray(body.albumList2.album)).toBe(true);
  expect(body.albumList2.album.length).toBeGreaterThan(0);
  await app.close();
});

test("star + rating via Subsonic land in getStarred2 / userRating", async () => {
  const { db, app } = await setup();
  const albumId = (db.prepare("SELECT id FROM albums LIMIT 1").get() as any).id;
  const trackId = (db.prepare("SELECT id FROM tracks LIMIT 1").get() as any).id;

  await app.inject({ url: `/rest/star.view?${tokenAuth("app-secret-123", "s2")}&id=al-${albumId}` });
  await app.inject({ url: `/rest/setRating.view?${tokenAuth("app-secret-123", "s3")}&id=tr-${trackId}&rating=4` });

  const starred = (await app.inject({ url: `/rest/getStarred2.view?${tokenAuth("app-secret-123", "s4")}` }))
    .json()["subsonic-response"].starred2;
  expect((starred.album ?? []).map((a: any) => a.id)).toContain(`al-${albumId}`);

  const song = (await app.inject({ url: `/rest/getSong.view?${tokenAuth("app-secret-123", "s5")}&id=tr-${trackId}` }))
    .json()["subsonic-response"].song;
  expect(song.userRating).toBe(4);
  await app.close();
});

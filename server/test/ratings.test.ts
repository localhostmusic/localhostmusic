import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { hashPassword } from "../src/lib/auth.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// A seeded app + its db + a logged-in cookie. Fixtures give 1 artist / 1 album /
// 2 tracks; tests add extra rows where richer data is needed.
async function setup() {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname, "fixtures"), mkdtempSync(join(tmpdir(), "s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  const app = buildApp(db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "pw" } });
  const cookie = r.cookies.find((c: any) => c.name === "lhm_session").value;
  const get = (url: string) => app.inject({ url, cookies: { lhm_session: cookie } });
  const send = (method: any, url: string, payload?: any) => app.inject({ method, url, cookies: { lhm_session: cookie }, payload });
  return { db, app, get, send };
}
const ids = (db: any) => ({
  tracks: (db.prepare("SELECT id FROM tracks ORDER BY id").all() as any[]).map(r => r.id),
  album: (db.prepare("SELECT id FROM albums LIMIT 1").get() as any).id,
  artist: (db.prepare("SELECT id FROM artists LIMIT 1").get() as any).id,
});

test("rate a track: shows in library-state, and rating 0 clears it", async () => {
  const { db, app, get, send } = await setup();
  const [t1] = ids(db).tracks;
  expect((await send("PUT", `/api/tracks/${t1}/rating`, { rating: 4 })).statusCode).toBe(200);
  expect((await get("/api/me/library-state")).json().ratings[t1]).toBe(4);
  await send("PUT", `/api/tracks/${t1}/rating`, { rating: 0 });
  expect((await get("/api/me/library-state")).json().ratings[t1]).toBeUndefined();
  // out-of-range is rejected
  expect((await send("PUT", `/api/tracks/${t1}/rating`, { rating: 9 })).statusCode).toBe(400);
  await app.close();
});

test("star album + artist: reflected in library-state and the starred lists", async () => {
  const { db, app, get, send } = await setup();
  const { album, artist } = ids(db);
  await send("POST", `/api/albums/${album}/star`);
  await send("POST", `/api/artists/${artist}/star`);
  const state = (await get("/api/me/library-state")).json();
  expect(state.starredAlbums).toContain(album);
  expect(state.starredArtists).toContain(artist);
  expect((await get("/api/me/starred-albums")).json().map((a: any) => a.id)).toContain(album);
  expect((await get("/api/me/starred-artists")).json().map((a: any) => a.id)).toContain(artist);
  // unstar removes it
  await send("DELETE", `/api/albums/${album}/star`);
  expect((await get("/api/me/library-state")).json().starredAlbums).not.toContain(album);
  await app.close();
});

test("rated endpoint filters by exact star", async () => {
  const { db, app, get, send } = await setup();
  const [t1, t2] = ids(db).tracks;
  await send("PUT", `/api/tracks/${t1}/rating`, { rating: 5 });
  await send("PUT", `/api/tracks/${t2}/rating`, { rating: 3 });
  expect((await get("/api/me/rated?rating=5")).json().length).toBe(1);
  expect((await get("/api/me/rated?rating=3")).json().length).toBe(1);
  expect((await get("/api/me/rated")).json().length).toBe(2); // all rated
  await app.close();
});

test("rating insights: total, average, distribution", async () => {
  const { db, app, get, send } = await setup();
  const [t1, t2] = ids(db).tracks;
  await send("PUT", `/api/tracks/${t1}/rating`, { rating: 5 });
  await send("PUT", `/api/tracks/${t2}/rating`, { rating: 3 });
  const ins = (await get("/api/me/rating-insights")).json();
  expect(ins.total).toBe(2);
  expect(ins.average).toBe(4); // (5+3)/2
  expect(ins.counts[4]).toBe(1); // one 5-star
  expect(ins.counts[2]).toBe(1); // one 3-star
  await app.close();
});

test("Auto DJ: favorites pool returns rated/hearted; random returns tracks", async () => {
  const { db, app, get, send } = await setup();
  const [t1] = ids(db).tracks;
  await send("PUT", `/api/tracks/${t1}/rating`, { rating: 5 });
  const fav = (await get("/api/autodj?mode=favorites&unit=songs&limit=10")).json();
  expect(fav.map((t: any) => t.id)).toContain(t1); // the 5-star song is in the pool
  const rand = (await get("/api/autodj?mode=random&unit=songs&limit=10")).json();
  expect(Array.isArray(rand)).toBe(true);
  expect(rand.length).toBeGreaterThan(0);
  await app.close();
});

test("Auto DJ albums unit returns whole albums (all their tracks)", async () => {
  const { db, app, get } = await setup();
  const albums = (await get("/api/autodj?mode=random&unit=albums&limit=1")).json();
  const albumId = ids(db).album;
  const trackCount = (db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE album_id=?").get(albumId) as any).n;
  expect(albums.length).toBe(trackCount); // one album, all its tracks
  await app.close();
});

test("similar endpoint returns a track list (local fallback without Last.fm)", async () => {
  const { db, app, get } = await setup();
  const [t1] = ids(db).tracks;
  const res = await get(`/api/tracks/${t1}/similar?limit=5`);
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.json())).toBe(true);
  await app.close();
});

import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { recordPlay } from "../src/lib/plays.js";

const DAY = 86_400_000;

async function setup() {
  const db = openDb(":memory:");
  const artist = (name: string) => Number(db.prepare("INSERT INTO artists(name) VALUES(?)").run(name).lastInsertRowid);
  const album = (title: string, artistId: number, addedAt: number, audiobook = 0) => {
    const id = Number(db.prepare("INSERT INTO albums(title, artist_id, is_audiobook) VALUES(?,?,?)").run(title, artistId, audiobook).lastInsertRowid);
    const track = Number(db.prepare(
      "INSERT INTO tracks(path,title,album_id,artist_id,mtime,size,added_at) VALUES(?,?,?,?,0,0,?)"
    ).run(`/m/${title}.mp3`, `${title} 1`, id, artistId, addedAt).lastInsertRowid);
    return { id, track };
  };
  const users: Record<string, { id: number; cookie: string }> = {};
  const app = buildApp(db);
  for (const name of ["alice", "bob"]) {
    const id = Number(db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)")
      .run(name, await hashPassword("pw")).lastInsertRowid);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: name, password: "pw" } });
    users[name] = { id, cookie: res.cookies.find((x: any) => x.name === "lhm_session")!.value };
  }
  const home = async (who: string) =>
    (await app.inject({ url: "/api/home", cookies: { lhm_session: users[who].cookie } })).json();
  return { db, app, artist, album, users, home };
}

test("the play endpoint records a listen for the signed-in user", async () => {
  const { db, app, artist, album, users } = await setup();
  const a = album("A", artist("X"), 1);
  await app.inject({ method: "POST", url: `/api/tracks/${a.track}/play`, cookies: { lhm_session: users.alice.cookie } });
  expect(db.prepare("SELECT user_id, track_id FROM listens").all()).toEqual([{ user_id: users.alice.id, track_id: a.track }]);
  expect((db.prepare("SELECT count FROM play_counts WHERE track_id=?").get(a.track) as any).count).toBe(1);
  await app.close();
});

test("with enough history, shelves are per user", async () => {
  const { db, app, artist, album, users, home } = await setup();
  const x = artist("X");
  const mine = album("Mine", x, 1), theirs = album("Theirs", x, 2);
  const now = Date.now();
  for (let i = 0; i < 30; i++) recordPlay(db, users.alice.id, mine.track, now - i * 1000);
  recordPlay(db, users.bob.id, theirs.track, now);

  const h = await home("alice");
  expect(h.ownHistory).toBe(true);
  expect(h.jumpBackIn.map((a: any) => a.title)).toEqual(["Mine"]);
  expect(h.rotation.map((a: any) => a.title)).toEqual(["Mine"]);
  expect(h.artists.map((a: any) => a.name)).toEqual(["X"]);
  await app.close();
});

test("before there's enough history, history shelves fall back to server-wide plays", async () => {
  const { db, app, artist, album, users, home } = await setup();
  const b = album("Bob's", artist("Y"), 1);
  recordPlay(db, users.bob.id, b.track, Date.now());
  const h = await home("alice");
  expect(h.ownHistory).toBe(false);
  expect(h.jumpBackIn.map((a: any) => a.title)).toEqual(["Bob's"]);
  expect(h.rotation).toEqual([]);
  await app.close();
});

test("recently added, rediscover, never played and on-this-day", async () => {
  const { db, app, artist, album, users, home } = await setup();
  const z = artist("Z");
  const now = Date.now();
  const old = album("Old favourite", z, 1);
  const fresh = album("Fresh", z, now);
  album("Untouched", z, 2);
  album("A book", z, now + 1, 1);
  const lastYear = new Date(); lastYear.setFullYear(lastYear.getFullYear() - 1);
  for (let i = 0; i < 25; i++) recordPlay(db, users.alice.id, old.track, now - 200 * DAY + i);
  recordPlay(db, users.alice.id, fresh.track, lastYear.getTime());

  const h = await home("alice");
  expect(h.recentlyAdded[0].title).toBe("Fresh");
  expect(h.recentlyAdded.map((a: any) => a.title)).not.toContain("A book");
  expect(h.rediscover.map((a: any) => a.title)).toEqual(["Old favourite"]);
  expect(h.unplayed.map((a: any) => a.title)).toEqual(["Untouched"]);
  expect(h.onThisDay.map((a: any) => a.title)).toEqual(["Fresh"]);
  await app.close();
});

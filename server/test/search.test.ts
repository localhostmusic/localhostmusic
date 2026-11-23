import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { hashPassword } from "../src/lib/auth.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("search finds by name", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname,"fixtures"), mkdtempSync(join(tmpdir(),"s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  const app = buildApp(db);
  const c = (await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"admin",password:"pw"}}))
    .cookies.find((x:any)=>x.name==="lhm_session").value;
  const res = await app.inject({ url:"/api/search?q=Song", cookies:{ lhm_session:c }});
  expect(res.json().tracks.length).toBe(2);
  const a = await app.inject({ url:"/api/search?q=Artist", cookies:{ lhm_session:c }});
  expect(a.json().artists.length).toBe(1);

  // FTS5 operators in user input must be treated as text, not syntax (no 500s).
  for (const q of ["(sic)", "AC:DC", "NEAR", "song AND", '"Song"', "^start", "*"]) {
    const r = await app.inject({ url:`/api/search?q=${encodeURIComponent(q)}`, cookies:{ lhm_session:c }});
    expect(r.statusCode, `query ${q}`).toBe(200);
  }
  await app.close();
});

// A hit of any kind must come back correctly labelled. Audiobooks and albums
// share a table but are separate result groups.
test("search is universal and groups results by kind", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname, "fixtures"), mkdtempSync(join(tmpdir(), "s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,0)").run("other", await hashPassword("pw"));

  // Flag one album as an audiobook, and give each user their own podcast + station.
  db.prepare("UPDATE albums SET is_audiobook=1 WHERE id=(SELECT MIN(id) FROM albums)").run();
  const book = db.prepare("SELECT title FROM albums WHERE is_audiobook=1").get() as any;
  db.prepare("INSERT INTO podcast_channels(user_id,feed_url,title,added_at) VALUES(1,'u1','Zebra Cast',0)").run();
  db.prepare("INSERT INTO podcast_channels(user_id,feed_url,title,added_at) VALUES(2,'u2','Zebra Cast',0)").run();
  db.prepare("INSERT INTO podcast_episodes(channel_id,title,audio_url) VALUES(1,'Zebra Episode','x')").run();
  db.prepare("INSERT INTO internet_radio_stations(user_id,name,stream_url,created) VALUES(1,'Zebra FM','x',0)").run();
  db.prepare("INSERT INTO internet_radio_stations(user_id,name,stream_url,created) VALUES(2,'Zebra FM','x',0)").run();

  const app = buildApp(db);
  const login = async (u: string) => (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: "pw" } }))
    .cookies.find((x: any) => x.name === "lhm_session").value;
  const c = await login("admin");

  // The audiobook comes back as an audiobook, not as an album.
  const b = (await app.inject({ url: `/api/search?q=${encodeURIComponent(book.title)}`, cookies: { lhm_session: c } })).json();
  expect(b.audiobooks.map((x: any) => x.title)).toContain(book.title);
  expect(b.albums.map((x: any) => x.title)).not.toContain(book.title);

  // Podcasts, episodes and stations are all reachable from the one query.
  const z = (await app.inject({ url: "/api/search?q=Zebra", cookies: { lhm_session: c } })).json();
  expect(z.podcasts.map((x: any) => x.title)).toEqual(["Zebra Cast"]);
  expect(z.episodes.map((x: any) => x.title)).toEqual(["Zebra Episode"]);
  expect(z.stations.map((x: any) => x.name)).toEqual(["Zebra FM"]);

  // ...and they're per-user: admin must never see the other user's subscriptions.
  expect(z.podcasts.length).toBe(1);
  expect(z.stations.length).toBe(1);
  const other = (await app.inject({ url: "/api/search?q=Zebra", cookies: { lhm_session: await login("other") } })).json();
  expect(other.episodes.length).toBe(0); // the episode belongs to admin's channel

  // A LIKE wildcard typed into the box is text, not a wildcard.
  const w = await app.inject({ url: "/api/search?q=%25", cookies: { lhm_session: c } });
  expect(w.statusCode).toBe(200);
  expect(w.json().stations.length).toBe(0);
  await app.close();
});

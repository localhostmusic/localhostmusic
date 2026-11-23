import { test, expect, vi, afterEach, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { hashPassword } from "../src/lib/auth.js";

// Deezer + MusicBrainz are stubbed so the feed is deterministic: the only things
// under test are which candidates survive (library match, dismissal) and whether
// Refresh actually seeds from somewhere new.
function stubNetwork(relatedByArtist: Record<string, string[]>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/search/artist")) {
      const q = decodeURIComponent(u.split("q=")[1].split("&")[0]);
      return { ok: true, json: async () => ({ data: [{ id: `dz-${q}` }] }) };
    }
    if (u.includes("/related")) {
      const who = u.match(/artist\/dz-([^/]+)\/related/)?.[1] ?? "";
      const names = relatedByArtist[decodeURIComponent(who)] ?? [];
      return { ok: true, json: async () => ({ data: names.map((n, i) => ({ name: n, id: 100 + i, picture_big: null })) }) };
    }
    if (u.includes("/albums")) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

let app: any;
async function login() {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { username: "u", password: "pw" },
  });
  return res.headers["set-cookie"];
}

beforeEach(async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES('u',?,1)").run(await hashPassword("pw"));
  // A library with one artist, so "already own it" has something to match against.
  db.prepare("INSERT INTO artists(id,name) VALUES(1,'Boards of Canada')").run();
  db.prepare("INSERT INTO artists(id,name) VALUES(2,'Bjork')").run();
  // Seeds come from album artists, so each needs a release with a track on it.
  db.prepare("INSERT INTO albums(id,title,artist_id,year) VALUES(1,'Music Has the Right',1,1998)").run();
  db.prepare("INSERT INTO albums(id,title,artist_id,year) VALUES(2,'Homogenic',2,1997)").run();
  db.prepare("INSERT INTO tracks(id,path,title,album_id,artist_id,mtime,size) VALUES(1,'/a.flac','A',1,1,0,0)").run();
  db.prepare("INSERT INTO tracks(id,path,title,album_id,artist_id,mtime,size) VALUES(2,'/b.flac','B',2,2,0,0)").run();
  app = buildApp(db);
  await app.ready();
});
afterEach(async () => { vi.unstubAllGlobals(); await app.close(); });

const feed = async (cookie: any, refresh = false) => {
  const res = await app.inject({
    method: "GET", url: `/api/discover/feed${refresh ? "?refresh=1" : ""}`, headers: { cookie },
  });
  return res.json();
};
const names = (f: any) => f.recommendations.flatMap((r: any) => r.artists.map((a: any) => a.name));

// Library matching ignores case, punctuation and accents.
test("never recommends an artist already in the library, however it's spelled", async () => {
  stubNetwork({ "Boards of Canada": ["Björk", "Boards Of Canada", "Plaid"], "Bjork": [] });
  const cookie = await login();
  const f = await feed(cookie);
  expect(names(f)).toContain("Plaid");
  expect(names(f)).not.toContain("Boards Of Canada");   // same artist, different case
  expect(names(f)).not.toContain("Björk");              // same artist, accented
});

test("a dismissed artist disappears immediately and stays gone", async () => {
  stubNetwork({ "Boards of Canada": ["Plaid", "Autechre"], "Bjork": [] });
  const cookie = await login();
  const before = await feed(cookie);
  const plaid = before.recommendations.flatMap((r: any) => r.artists).find((a: any) => a.name === "Plaid");
  expect(plaid.key).toBe("artist:plaid");

  const res = await app.inject({ method: "POST", url: "/api/discover/dismiss", headers: { cookie }, payload: { key: plaid.key } });
  expect(res.statusCode).toBe(200);

  // Served from the same cached feed: the filter runs on read.
  expect(names(await feed(cookie))).not.toContain("Plaid");
  expect(names(await feed(cookie))).toContain("Autechre");
  // And a full rebuild doesn't bring it back.
  expect(names(await feed(cookie, true))).not.toContain("Plaid");
});

test("dismissals can be undone", async () => {
  stubNetwork({ "Boards of Canada": ["Plaid"], "Bjork": [] });
  const cookie = await login();
  await app.inject({ method: "POST", url: "/api/discover/dismiss", headers: { cookie }, payload: { key: "artist:plaid" } });
  expect(names(await feed(cookie))).not.toContain("Plaid");

  const res = await app.inject({ method: "DELETE", url: "/api/discover/dismissed", headers: { cookie } });
  expect(res.json().restored).toBe(1);
  expect(names(await feed(cookie, true))).toContain("Plaid");
});

// Refresh must seed from different top artists, not return the same feed.
test("refresh seeds from different artists", async () => {
  const many: Record<string, string[]> = {};
  const db = (app as any).db;
  for (let i = 0; i < 12; i++) {
    const aid = db.prepare("INSERT INTO artists(name) VALUES(?)").run(`Seed ${i}`).lastInsertRowid;
    const alb = db.prepare("INSERT INTO albums(title,artist_id,year) VALUES(?,?,2000)").run(`Album ${i}`, aid).lastInsertRowid;
    db.prepare("INSERT INTO tracks(path,title,album_id,artist_id,mtime,size) VALUES(?,?,?,?,0,0)")
      .run(`/s${i}.flac`, `T${i}`, alb, aid);
    many[`Seed ${i}`] = [`Rec ${i}`];
  }
  many["Boards of Canada"] = ["Rec BoC"]; many["Bjork"] = ["Rec Bjork"];
  stubNetwork(many);
  const cookie = await login();
  const first = new Set((await feed(cookie)).recommendations.map((r: any) => r.seed));
  const second = new Set((await feed(cookie, true)).recommendations.map((r: any) => r.seed));
  const shared = [...second].filter(x => first.has(x));
  expect(shared.length).toBeLessThan(second.size);   // the seed set moved on
});

test("dismiss rejects an empty key", async () => {
  const cookie = await login();
  const res = await app.inject({ method: "POST", url: "/api/discover/dismiss", headers: { cookie }, payload: { key: "  " } });
  expect(res.statusCode).toBe(400);
});

// A feed cached before dismissals existed has no keys on its items. They are
// stamped on read so the dismiss button has something to send.
test("stamps dismiss keys onto a feed cached before they existed", async () => {
  stubNetwork({ "Boards of Canada": ["Plaid"], "Bjork": [] });
  const cookie = await login();
  const legacy = {
    recommendations: [{ seed: "Boards of Canada", artists: [{ name: "Plaid", deezerId: 1 }] }],
    relatedNew: [{ artistName: "Plaid", title: "Reachy Prints" }],
    newReleases: [{ artistName: "Plaid", title: "Polymer", rgid: "rg-1" }],
  };
  (app as any).db.prepare("INSERT OR REPLACE INTO discover_feed(user_id,json,fetched_at,rot) VALUES(1,?,?,0)")
    .run(JSON.stringify(legacy), Date.now());

  const f = await feed(cookie);
  expect(f.recommendations[0].artists[0].key).toBe("artist:plaid");
  expect(f.relatedNew[0].key).toBe("alb:plaid|reachy prints");
  expect(f.newReleases[0].key).toBe("rg:rg-1");
});

import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { pruneMissing } from "../src/lib/prune.js";

// Build a library root with `files` on disk, and a tracks row for every path in
// `rows` (which may point at files that were never created: the ghost case).
function fixture(files: string[], rows?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "lhm-prune-"));
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
  const db = openDb(":memory:");
  const ins = db.prepare(
    "INSERT INTO tracks(path,title,mtime,size) VALUES(?,?,0,0)"
  );
  for (const p of rows ?? files) ins.run(join(root, p), p);
  return { db, root, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

const paths = (db: any) =>
  (db.prepare("SELECT path FROM tracks ORDER BY path").all() as any[]).map(r => r.path);

test("drops rows whose file is gone, keeps the ones still on disk", async () => {
  const { db, root, cleanup } = fixture(["01 - Oni.flac"], ["01 - Oni.flac", "split/01 - Oni.flac"]);
  const res = await pruneMissing(db, [root]);
  expect(res.tracks).toBe(1);
  expect(paths(db)).toEqual([join(root, "01 - Oni.flac")]);
  cleanup();
});

test("a scan with nothing missing removes nothing", async () => {
  const { db, root, cleanup } = fixture(["a.flac", "b.flac"]);
  expect((await pruneMissing(db, [root])).tracks).toBe(0);
  expect(paths(db).length).toBe(2);
  cleanup();
});

// The library share is unmounted, so every file reads as gone. A scan must not
// delete the whole collection.
test("never prunes a root that is missing or empty", async () => {
  const { db, root, cleanup } = fixture([], ["a.flac", "b.flac"]);
  const res = await pruneMissing(db, [root]);
  expect(res.tracks).toBe(0);
  expect(res.skipped[0]).toContain("empty");
  expect(paths(db).length).toBe(2);
  cleanup();
});

test("bails out when most of a root's tracks are missing", async () => {
  // 1 file present, 4 rows: 75% missing, over the safety threshold.
  const { db, root, cleanup } = fixture(["a.flac"], ["a.flac", "b.flac", "c.flac", "d.flac"]);
  const res = await pruneMissing(db, [root]);
  expect(res.tracks).toBe(0);
  expect(res.skipped[0]).toContain("unmounted");
  expect(paths(db).length).toBe(4);
  cleanup();
});

test("leaves tracks outside the scanned roots alone", async () => {
  const { db, root, cleanup } = fixture(["a.flac", "b.flac"]);
  db.prepare("INSERT INTO tracks(path,title,mtime,size) VALUES(?,?,0,0)")
    .run("/some/other/root/ghost.flac", "ghost");
  expect((await pruneMissing(db, [root])).tracks).toBe(0);
  expect(paths(db)).toContain("/some/other/root/ghost.flac");
  cleanup();
});

// favorites/playlist_tracks reference tracks without ON DELETE CASCADE, so a naive
// delete trips the foreign_keys pragma instead of removing the ghost.
test("clears references so a favorited/playlisted ghost can still be pruned", async () => {
  const { db, root, cleanup } = fixture(["a.flac"], ["a.flac", "gone.flac"]);
  const id = (db.prepare("SELECT id FROM tracks WHERE path LIKE '%gone.flac'").get() as any).id;
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES('u','h',0)").run();
  db.prepare("INSERT INTO favorites(user_id,track_id) VALUES(1,?)").run(id);
  db.prepare("INSERT INTO playlists(name,user_id) VALUES('p',1)").run();
  db.prepare("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(1,?,0)").run(id);
  db.prepare("INSERT INTO search_fts(kind,ref_id,name) VALUES('track',?,'gone')").run(id);

  expect((await pruneMissing(db, [root])).tracks).toBe(1);
  expect((db.prepare("SELECT COUNT(*) c FROM favorites").get() as any).c).toBe(0);
  expect((db.prepare("SELECT COUNT(*) c FROM playlist_tracks").get() as any).c).toBe(0);
  expect((db.prepare("SELECT COUNT(*) c FROM search_fts WHERE kind='track'").get() as any).c).toBe(0);
  cleanup();
});

test("the server keeps running while a large library is checked", async () => {
  const names = Array.from({ length: 3000 }, (_, i) => `a/${i}.flac`);
  const { db, root, cleanup } = fixture(names.slice(0, 2990), names);
  // A timer can only fire if the check gives the event loop back between files.
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const res = await pruneMissing(db, [root]);
  clearInterval(timer);
  expect(res.tracks).toBe(10);
  expect(ticks).toBeGreaterThan(0);
  cleanup();
});

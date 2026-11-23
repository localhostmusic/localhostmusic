import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { readTags } from "../src/scanner/tags.js";
import { pruneEmpty } from "../src/lib/prune.js";
import { isAlbumArtist } from "../src/lib/credits.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Two fixtures:
//   collab.flac: ARTIST=BROCKHAMPTON / A$AP Rocky / A$AP Ferg (three frames)
//   guest.flac:  ARTIST=Jonathan Evans, ALBUMARTIST=VANISHING GIRL (guest owns nothing)
const fixtures = join(import.meta.dirname, "fixtures-credits");
const scratch = () => mkdtempSync(join(tmpdir(), "lhm-"));

const idOf = (db: any, name: string) =>
  (db.prepare("SELECT id FROM artists WHERE name=?").get(name) as any)?.id;

test("reads every ARTIST frame, not just the first", async () => {
  const t = await readTags(join(fixtures, "collab.flac"));
  expect(t.artists).toEqual(["BROCKHAMPTON", "A$AP Rocky", "A$AP Ferg"]);
  expect(t.artist).toBe("BROCKHAMPTON"); // primary stays the first frame
});

test("scan creates an artist for every credit and records the credit list", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, fixtures, scratch());

  for (const name of ["BROCKHAMPTON", "A$AP Rocky", "A$AP Ferg", "Jonathan Evans", "VANISHING GIRL"]) {
    expect(idOf(db, name), `${name} should exist`).toBeTruthy();
  }

  const credits = db.prepare(
    `SELECT ar.name, ta.role, ta.position FROM track_artists ta
     JOIN artists ar ON ar.id = ta.artist_id
     JOIN tracks t ON t.id = ta.track_id
     WHERE t.title = 'Bankroll' ORDER BY ta.position`
  ).all() as any[];
  expect(credits).toEqual([
    { name: "BROCKHAMPTON", role: "primary",  position: 0 },
    { name: "A$AP Rocky",   role: "featured", position: 1 },
    { name: "A$AP Ferg",    role: "featured", position: 2 },
  ]);
  db.close();
});

// The artists grid lists album artists only. Guests are reached from a track credit.
test("the artists grid lists album artists and excludes guests", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, fixtures, scratch());

  const listed = db.prepare(
    `SELECT name FROM artists WHERE ${isAlbumArtist("artists.id")}`
  ).all().map((r: any) => r.name);

  expect(listed).toContain("BROCKHAMPTON");     // owns Roadrunner
  expect(listed).toContain("VANISHING GIRL");   // owns Summer Skin
  expect(listed).not.toContain("A$AP Rocky");   // guest only
  expect(listed).not.toContain("A$AP Ferg");    // guest only
  expect(listed).not.toContain("Jonathan Evans"); // leads a track, owns no album
  db.close();
});

// A guest still needs a page, or the credit link on a track row goes nowhere.
test("a guest artist still has an Appears On shelf, without owning an album", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, fixtures, scratch());

  const rocky = idOf(db, "A$AP Rocky");
  const evans = idOf(db, "Jonathan Evans");

  // Neither owns an album.
  for (const id of [rocky, evans]) {
    const owned = db.prepare("SELECT COUNT(*) c FROM albums WHERE artist_id=?").get(id) as any;
    expect(owned.c).toBe(0);
  }

  // The Appears On shelf is what gives them something to render.
  const appears = db.prepare(
    `SELECT DISTINCT al.title FROM track_artists ta
     JOIN tracks t ON t.id = ta.track_id
     JOIN albums al ON al.id = t.album_id
     WHERE ta.artist_id = ? AND (al.artist_id IS NULL OR al.artist_id <> ?)`
  );
  expect((appears.all(rocky, rocky) as any[]).map(r => r.title)).toEqual(["Roadrunner"]);
  expect((appears.all(evans, evans) as any[]).map(r => r.title)).toEqual(["Summer Skin"]);
  db.close();
});

// prune deletes artists nothing points at. A guest is referenced only through
// track_artists, so prune has to check that table.
test("prune keeps credited artists and still removes truly orphaned ones", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, fixtures, scratch());

  const orphan = db.prepare("INSERT INTO artists(name) VALUES('Nobody')").run().lastInsertRowid as number;
  const rocky = idOf(db, "A$AP Rocky");

  const res = pruneEmpty(db);
  expect(res.artists).toBe(1);
  expect(idOf(db, "A$AP Rocky")).toBe(rocky);   // credited, so it survives
  expect(db.prepare("SELECT id FROM artists WHERE id=?").get(orphan)).toBeUndefined();
  db.close();
});

// Tracks already in the DB have unchanged mtime+size and would be skipped.
// credits_v forces one re-read of their tags, and only theirs.
test("re-credit pass backfills existing tracks whose credits predate track_artists", async () => {
  const db = openDb(":memory:");
  const data = scratch();
  await scanLibrary(db, fixtures, data);

  // Simulate a pre-migration database: credits wiped, marker rolled back to 0,
  // tracks.artist_id left as the only artist link (what migration 2 backfills).
  db.exec("DELETE FROM track_artists");
  db.exec(`INSERT INTO track_artists(track_id, artist_id, role, position)
           SELECT id, artist_id, 'primary', 0 FROM tracks WHERE artist_id IS NOT NULL`);
  db.exec("UPDATE tracks SET credits_v = 0");

  const before = db.prepare("SELECT COUNT(*) c FROM track_artists").get() as any;
  expect(before.c).toBe(2); // one primary per track, no guests

  const res = await scanLibrary(db, fixtures, data);
  expect(res.added).toBe(0);       // nothing re-inserted
  expect(res.recredited).toBe(2);  // both tracks re-read for credits alone

  const after = db.prepare("SELECT COUNT(*) c FROM track_artists").get() as any;
  expect(after.c).toBe(4); // 3 for Bankroll + 1 for Summer Skin

  // A second scan is a no-op: credits_v is now current, so no tags are re-read.
  const res3 = await scanLibrary(db, fixtures, data);
  expect(res3.recredited).toBe(0);
  db.close();
});

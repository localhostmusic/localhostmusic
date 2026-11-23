import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { seedGenresFromTags } from "../src/lib/genres.js";

function library() {
  const db = openDb(":memory:");
  const artist = (name: string) => Number(db.prepare("INSERT INTO artists(name) VALUES(?)").run(name).lastInsertRowid);
  const album = (artistId: number, title: string) =>
    Number(db.prepare("INSERT INTO albums(title,artist_id) VALUES(?,?)").run(title, artistId).lastInsertRowid);
  let n = 0;
  const track = (albumId: number, genre: string | null) =>
    db.prepare("INSERT INTO tracks(path,title,album_id,genre,mtime,size) VALUES(?,?,?,?,0,0)").run(`/m/${++n}.mp3`, `t${n}`, albumId, genre);
  const genres = (id: number) =>
    (db.prepare("SELECT genre FROM artist_genres WHERE artist_id=? ORDER BY genre").all(id) as any[]).map(r => r.genre);
  return { db, artist, album, track, genres };
}

test("seeds an artist's genres from their tracks' tags, most common first, at most three", () => {
  const { db, artist, album, track, genres } = library();
  const a = artist("A");
  const al = album(a, "One");
  for (const g of ["rock", "rock", "Rock; indie", "jazz", "blues", "blues", "folk", null]) track(al, g);
  expect(seedGenresFromTags(db)).toBe(1);
  expect(genres(a)).toEqual(["Blues", "Folk", "Rock"]); // rock 3, blues 2, then a three-way tie broken by name
  db.close();
});

test("leaves artists that already have genres, and untagged artists, alone", () => {
  const { db, artist, album, track, genres } = library();
  const tagged = artist("Tagged"), online = artist("Online"), bare = artist("Bare");
  track(album(tagged, "T"), "Metal");
  track(album(online, "O"), "Pop");
  track(album(bare, "B"), null);
  db.prepare("INSERT INTO artist_genres(artist_id,genre) VALUES(?,?)").run(online, "Shoegaze");
  expect(seedGenresFromTags(db)).toBe(1);
  expect(genres(tagged)).toEqual(["Metal"]);
  expect(genres(online)).toEqual(["Shoegaze"]);
  expect(genres(bare)).toEqual([]);
  expect(seedGenresFromTags(db)).toBe(0);
  db.close();
});

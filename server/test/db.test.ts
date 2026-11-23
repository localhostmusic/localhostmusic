import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";

test("openDb creates tables", () => {
  const db = openDb(":memory:");
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map((r: any) => r.name);
  for (const t of ["artists","albums","tracks","users","playlists","playlist_tracks","favorites","scan_issues"]) {
    expect(tables).toContain(t);
  }
  db.close();
});

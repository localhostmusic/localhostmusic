import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { hashPassword } from "../src/lib/auth.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

async function seeded() {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname, "fixtures"), mkdtempSync(join(tmpdir(),"s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)")
    .run("admin", await hashPassword("pw"));
  return buildApp(db);
}
async function cookie(app: any) {
  const r = await app.inject({ method:"POST", url:"/api/auth/login", payload:{username:"admin",password:"pw"}});
  return r.cookies.find((c:any)=>c.name==="lhm_session").value;
}

test("lists artists and album tracks", async () => {
  const app = await seeded();
  const c = await cookie(app);
  const artists = await app.inject({ url:"/api/artists", cookies:{ lhm_session:c }});
  expect(artists.json().length).toBe(1);
  const albums = await app.inject({ url:`/api/artists/${artists.json()[0].id}/albums`, cookies:{ lhm_session:c }});
  const albumId = albums.json()[0].id;
  const album = await app.inject({ url:`/api/albums/${albumId}`, cookies:{ lhm_session:c }});
  expect(album.json().tracks.length).toBe(2);
  await app.close();
});

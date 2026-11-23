import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { hashPassword } from "../src/lib/auth.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

async function ctx() {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname,"fixtures"), mkdtempSync(join(tmpdir(),"s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  const app = buildApp(db);
  const c = (await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"admin",password:"pw"}}))
    .cookies.find((x:any)=>x.name==="lhm_session").value;
  return { app, c, db };
}

test("create playlist and add track", async () => {
  const { app, c, db } = await ctx();
  const created = await app.inject({ method:"POST", url:"/api/playlists", cookies:{lhm_session:c}, payload:{ name:"Mix" }});
  const pid = created.json().id;
  const tid = (db.prepare("SELECT id FROM tracks LIMIT 1").get() as any).id;
  await app.inject({ method:"POST", url:`/api/playlists/${pid}/tracks`, cookies:{lhm_session:c}, payload:{ trackId: tid }});
  const got = await app.inject({ url:`/api/playlists/${pid}`, cookies:{lhm_session:c}});
  expect(got.json().tracks.length).toBe(1);
  await app.close();
});

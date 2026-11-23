import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { scanLibrary } from "../src/scanner/scan.js";
import { hashPassword } from "../src/lib/auth.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("toggle favorite", async () => {
  const db = openDb(":memory:");
  await scanLibrary(db, join(import.meta.dirname,"fixtures"), mkdtempSync(join(tmpdir(),"s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  const app = buildApp(db);
  const c = (await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"admin",password:"pw"}}))
    .cookies.find((x:any)=>x.name==="lhm_session").value;
  const tid = (db.prepare("SELECT id FROM tracks LIMIT 1").get() as any).id;
  await app.inject({ method:"POST", url:`/api/favorites/${tid}`, cookies:{lhm_session:c}});
  let fav = await app.inject({ url:"/api/favorites", cookies:{lhm_session:c}});
  expect(fav.json().length).toBe(1);
  await app.inject({ method:"DELETE", url:`/api/favorites/${tid}`, cookies:{lhm_session:c}});
  fav = await app.inject({ url:"/api/favorites", cookies:{lhm_session:c}});
  expect(fav.json().length).toBe(0);
  await app.close();
});

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
  await scanLibrary(db, join(import.meta.dirname,"fixtures"), mkdtempSync(join(tmpdir(),"s-")));
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)")
    .run("admin", await hashPassword("pw"));
  return buildApp(db);
}

test("streams with range support", async () => {
  const app = await seeded();
  const login = await app.inject({ method:"POST", url:"/api/auth/login", payload:{username:"admin",password:"pw"}});
  const c = login.cookies.find((x:any)=>x.name==="lhm_session").value;
  const id = (app.db.prepare("SELECT id FROM tracks LIMIT 1").get() as any).id;

  const full = await app.inject({ url:`/api/stream/${id}`, cookies:{ lhm_session:c }});
  expect(full.statusCode).toBe(200);
  expect(full.headers["accept-ranges"]).toBe("bytes");

  const ranged = await app.inject({ url:`/api/stream/${id}`, cookies:{ lhm_session:c }, headers:{ range:"bytes=0-99" }});
  expect(ranged.statusCode).toBe(206);
  expect(ranged.headers["content-range"]).toMatch(/^bytes 0-99\//);
  await app.close();
});

test("handles suffix, overlong and invalid ranges", async () => {
  const app = await seeded();
  const login = await app.inject({ method:"POST", url:"/api/auth/login", payload:{username:"admin",password:"pw"}});
  const c = login.cookies.find((x:any)=>x.name==="lhm_session").value;
  const row = app.db.prepare("SELECT id, size FROM tracks LIMIT 1").get() as any;

  // Suffix form: last 100 bytes.
  const suffix = await app.inject({ url:`/api/stream/${row.id}`, cookies:{ lhm_session:c }, headers:{ range:"bytes=-100" }});
  expect(suffix.statusCode).toBe(206);
  expect(suffix.headers["content-range"]).toBe(`bytes ${row.size-100}-${row.size-1}/${row.size}`);
  expect(Number(suffix.headers["content-length"])).toBe(100);

  // End past EOF is clamped, not a negative content-length.
  const over = await app.inject({ url:`/api/stream/${row.id}`, cookies:{ lhm_session:c }, headers:{ range:`bytes=0-${row.size+5000}` }});
  expect(over.statusCode).toBe(206);
  expect(Number(over.headers["content-length"])).toBe(row.size);

  // Start past EOF and garbage give 416, not a 500.
  const past = await app.inject({ url:`/api/stream/${row.id}`, cookies:{ lhm_session:c }, headers:{ range:`bytes=${row.size+1}-` }});
  expect(past.statusCode).toBe(416);
  const junk = await app.inject({ url:`/api/stream/${row.id}`, cookies:{ lhm_session:c }, headers:{ range:"bytes=abc" }});
  expect(junk.statusCode).toBe(416);
  await app.close();
});

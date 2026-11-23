import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";

test("admin can create users; non-admin cannot", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)").run("admin", await hashPassword("pw"));
  const app = buildApp(db);
  const c = (await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"admin",password:"pw"}}))
    .cookies.find((x:any)=>x.name==="lhm_session").value;
  const res = await app.inject({ method:"POST", url:"/api/admin/users", cookies:{lhm_session:c}, payload:{ username:"bob", password:"x" }});
  expect(res.statusCode).toBe(200);

  const bob = (await app.inject({method:"POST",url:"/api/auth/login",payload:{username:"bob",password:"x"}}))
    .cookies.find((x:any)=>x.name==="lhm_session").value;
  const denied = await app.inject({ method:"POST", url:"/api/admin/users", cookies:{lhm_session:bob}, payload:{ username:"eve", password:"x" }});
  expect(denied.statusCode).toBe(403);
  await app.close();
});

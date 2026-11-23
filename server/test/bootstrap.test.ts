import { test, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { ensureAdmin } from "../src/lib/bootstrap.js";
import { verifyPassword } from "../src/lib/auth.js";

test("creates admin only when no users exist", async () => {
  const db = openDb(":memory:");
  expect((await ensureAdmin(db, "admin", "pw")).created).toBe(true);
  expect((await ensureAdmin(db, "admin", "pw")).created).toBe(false);
  const n = db.prepare("SELECT COUNT(*) c FROM users").get() as any;
  expect(n.c).toBe(1);
  db.close();
});

// No ADMIN_PASSWORD means a random password, surfaced once in the log, never a
// default one.
test("generates a random admin password when none is supplied", async () => {
  const db = openDb(":memory:");
  const res = await ensureAdmin(db, "admin");
  expect(res.created).toBe(true);
  expect(res.generatedPassword).toBeTruthy();
  expect(res.generatedPassword!.length).toBeGreaterThanOrEqual(12);

  const row = db.prepare("SELECT password_hash FROM users WHERE username='admin'").get() as any;
  expect(await verifyPassword(row.password_hash, res.generatedPassword!)).toBe(true);
  expect(await verifyPassword(row.password_hash, "admin")).toBe(false);
  db.close();
});

test("two fresh installs do not get the same generated password", async () => {
  const a = openDb(":memory:");
  const b = openDb(":memory:");
  const pwA = (await ensureAdmin(a, "admin")).generatedPassword;
  const pwB = (await ensureAdmin(b, "admin")).generatedPassword;
  expect(pwA).not.toBe(pwB);
  a.close(); b.close();
});

import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth.js";

export interface AdminBootstrap { created: boolean; username: string; generatedPassword?: string; }

// Create the first admin, once, on an empty user table. When ADMIN_PASSWORD is
// unset, mint a random password and return it to be printed. No default password.
export async function ensureAdmin(
  db: Database.Database, username: string, password?: string
): Promise<AdminBootstrap> {
  const n = db.prepare("SELECT COUNT(*) c FROM users").get() as any;
  if (n.c > 0) return { created: false, username };

  const generated = password ? undefined : randomBytes(9).toString("base64url");
  db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)")
    .run(username, await hashPassword(password ?? generated!));
  return { created: true, username, generatedPassword: generated };
}

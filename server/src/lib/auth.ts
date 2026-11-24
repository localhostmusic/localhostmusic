import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface SessionUser { id: number; username: string; isAdmin: boolean; sessionVersion?: number; }

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function authenticate(db: Database.Database, token: string): SessionUser {
  const claims = verifyToken(token);
  const row = db.prepare("SELECT id, username, is_admin, session_version FROM users WHERE id=?").get(claims.id) as
    { id: number; username: string; is_admin: number; session_version: number } | undefined;
  if (!row || row.session_version !== (claims.sessionVersion ?? 0) ||
    db.prepare("SELECT 1 FROM revoked_sessions WHERE token_hash=?").get(tokenHash(token))) throw new Error("Session revoked");
  return { id: row.id, username: row.username, isAdmin: !!row.is_admin, sessionVersion: row.session_version };
}

// Null when acceptable, otherwise what is wrong with it. Applies to passwords
// people choose in the app, not to the bootstrap admin password.
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "Use at least 8 characters.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}

// New hash and a bumped session version, which signs the user out everywhere.
export async function setPassword(db: Database.Database, userId: number, pw: string): Promise<number> {
  db.prepare("UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?")
    .run(await hashPassword(pw), userId);
  return (db.prepare("SELECT session_version v FROM users WHERE id=?").get(userId) as any).v;
}

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw);
export const signToken = (u: SessionUser) =>
  jwt.sign(u, config.jwtSecret, { expiresIn: "30d", jwtid: randomUUID() });
export const verifyToken = (token: string): SessionUser =>
  jwt.verify(token, config.jwtSecret) as SessionUser;

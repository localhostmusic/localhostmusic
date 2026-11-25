import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getSettings } from "./settings.js";
import { notify } from "../routes/notifications.js";

// Tells admins when a newer release exists. The server asks GitHub once a day, and
// only for the public release list. It never installs anything: updating a server
// restarts it, and that stays the owner's decision.

const LATEST = "https://api.github.com/repos/localhostmusic/localhostmusic/releases/latest";
const DAY = 24 * 3600_000;

export interface UpdateInfo {
  current: string | null;   // null when this build does not know its version
  latest: string | null;
  notes: string;
  url: string;
  available: boolean;
  checkedAt: number | null;
  enabled: boolean;
  error?: string;
}

// The VERSION file ships beside the server (Docker) or at the repo root (from source).
export function currentVersion(): string | null {
  if (process.env.LHM_VERSION) return process.env.LHM_VERSION.replace(/^v/, "");
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "VERSION"), join(here, "..", "..", "VERSION"), join(here, "..", "..", "..", "VERSION")]) {
    try { if (existsSync(p)) { const v = readFileSync(p, "utf8").trim().replace(/^v/, ""); if (/^\d+\.\d+\.\d+/.test(v)) return v; } } catch { /* try the next */ }
  }
  return null;
}

// 1 when a is newer than b, -1 when older, 0 when equal. Numeric parts only.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1; }
  return 0;
}

// The desktop app updates itself, server included, so it turns this off.
const allowed = () => process.env.LHM_UPDATE_CHECK !== "0";
export const updateCheckEnabled = (db: Database.Database) => allowed() && getSettings(db).updateCheck;

let last: Omit<UpdateInfo, "current" | "available" | "enabled"> = { latest: null, notes: "", url: "", checkedAt: null };

export function updateInfo(db: Database.Database): UpdateInfo {
  const current = currentVersion();
  return {
    ...last, current,
    available: !!current && !!last.latest && compareVersions(last.latest, current) > 0,
    enabled: updateCheckEnabled(db),
  };
}

type Fetcher = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

// Asks GitHub now. Admins get one notification per new version.
export async function checkForUpdate(db: Database.Database, fetcher: Fetcher = fetch as any): Promise<UpdateInfo> {
  if (!updateCheckEnabled(db)) return updateInfo(db);
  try {
    const res = await fetcher(LATEST, {
      headers: { accept: "application/vnd.github+json", "user-agent": "localhostmusic-server" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name ?? "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error("no version in the answer");
    const before = last.latest;
    last = { latest, notes: String(rel.body ?? "").slice(0, 8000), url: String(rel.html_url ?? ""), checkedAt: Date.now() };
    const info = updateInfo(db);
    if (info.available && latest !== before) announce(db, latest);
    return info;
  } catch (e: any) {
    last = { ...last, checkedAt: Date.now(), error: String(e?.message ?? e) };
    return updateInfo(db);
  }
}

function announce(db: Database.Database, version: string) {
  const title = `Version ${version} is available`;
  for (const u of db.prepare("SELECT id FROM users WHERE is_admin=1").all() as { id: number }[]) {
    // Once per version, even across restarts.
    if (db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='update' AND title=?").get(u.id, title)) continue;
    notify(db, u.id, "update", title, "See what changed and how to update under Settings, Server.");
  }
}

export function startUpdateChecks(db: Database.Database) {
  if (!allowed()) return;
  const run = () => { checkForUpdate(db).catch(() => {}); };
  setTimeout(run, 60_000).unref();
  setInterval(run, DAY).unref();
}

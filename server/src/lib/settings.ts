import { join } from "node:path";
import { config } from "../config.js";

type Db = import("better-sqlite3").Database;

// Admin-editable settings, stored in app_settings, falling back to env/config
// defaults when unset. DATA_DIR is not here: the server needs it to open this
// database, so it lives in service config.
export interface AppSettings {
  musicDir: string;      // library root (default: MUSIC_DIR env)
  audiobookDir: string;  // optional second root; everything under it = audiobook ("" = unset)
  transcodeDir: string;  // transcode cache (default: DATA_DIR/transcode-cache)
  keep320: boolean;      // pre-transcode the whole library at this tier
  keep256: boolean;
  keep128: boolean;
  streamKbps: number;    // per-stream send-rate cap in kbps (0 = unlimited). Clips
                         // the burst so remote playback can't saturate home upload.
  // Online-enrichment toggles. Turning them off stops the external API calls.
  // All default on.
  showMissingAlbums: boolean; // list albums you don't own in artist discographies
  onlineDiscovery: boolean;   // Discover feed: recommendations, new releases, "For You"
  onlineArtistMeta: boolean;  // fetch artist bios/genres + photos from the web
  discoverRefreshHours: number; // how often Discover auto-refreshes (0 = manual only)
  // List every username on the sign-in page, for anyone who can reach it. Off by
  // default: only right for a server that is not reachable from the internet.
  showUsersOnSignIn: boolean;
  // Ask GitHub once a day whether a newer release exists, and tell admins.
  updateCheck: boolean;
}

export const settingsDefaults = (): AppSettings => ({
  musicDir: config.musicDir,
  audiobookDir: "",
  transcodeDir: join(config.dataDir, "transcode-cache"),
  keep320: false,
  keep256: false,
  keep128: false,
  streamKbps: 0,
  showMissingAlbums: true,
  onlineDiscovery: true,
  onlineArtistMeta: true,
  discoverRefreshHours: 24, // daily
  showUsersOnSignIn: false,
  updateCheck: true,
});

const KEYS = Object.keys(settingsDefaults()) as (keyof AppSettings)[];

const cache = new WeakMap<Db, AppSettings>();

export function getSettings(db: Db): AppSettings {
  const hit = cache.get(db);
  if (hit) return hit;
  const s = settingsDefaults();
  for (const row of db.prepare("SELECT key, value FROM app_settings").all() as any[]) {
    if (!KEYS.includes(row.key)) continue;
    try { (s as any)[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
  }
  cache.set(db, s);
  return s;
}

// Persist only known keys; unknown/undefined entries are ignored.
export function saveSettings(db: Db, patch: Partial<AppSettings>) {
  const up = db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)");
  for (const k of KEYS) {
    if (patch[k] === undefined) continue;
    up.run(k, JSON.stringify(patch[k]));
  }
  cache.delete(db); // next read merges fresh
}

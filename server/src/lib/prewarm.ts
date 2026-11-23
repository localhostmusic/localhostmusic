import { existsSync } from "node:fs";
import { join } from "node:path";
import { transcodedFile, transcodeKey, formatExt, type TranscodeFormat } from "./transcode.js";
import { getSettings } from "./settings.js";

type Db = import("better-sqlite3").Database;

export const TIERS = [320, 256, 128] as const;

// Pre-warm MP3 transcodes, the format live playback requests for lossy tiers.
// fMP4/AAC (?fmt=m4a) is on demand only.
const PREWARM_FORMAT: TranscodeFormat = "mp3";

// Pre-transcode the library at every enabled tier so first plays never wait on
// ffmpeg. One niced ffmpeg at a time. Incremental: only files missing from the
// cache dir are transcoded.
const status = { running: false, total: 0, done: 0, errors: 0, bitrate: 0 };
export const prewarmStatus = () => ({ ...status });

let queued = false; // a run was requested while one is active, run once more after

export async function runPrewarm(db: Db): Promise<void> {
  if (status.running) { queued = true; return; }
  status.running = true;
  status.total = 0; status.done = 0; status.errors = 0; status.bitrate = 0;
  try {
    const tracks = db.prepare("SELECT path FROM tracks").all() as { path: string }[];
    // Settings are re-read per tier so a mid-run toggle/path change takes effect
    // at the next tier boundary.
    let jobs: { path: string; bitrate: number }[] = [];
    for (const bitrate of TIERS) {
      const s = getSettings(db);
      if (!(s as any)[`keep${bitrate}`]) continue;
      for (const t of tracks) {
        if (!existsSync(t.path)) { status.errors++; continue; }
        if (!existsSync(join(s.transcodeDir, `${transcodeKey(t.path, bitrate)}.${formatExt(PREWARM_FORMAT)}`))) {
          jobs.push({ path: t.path, bitrate });
        }
      }
    }
    status.total = jobs.length;
    for (const job of jobs) {
      const s = getSettings(db);
      if (!(s as any)[`keep${job.bitrate}`]) { status.done++; continue; } // toggled off mid-run
      status.bitrate = job.bitrate;
      try {
        await transcodedFile(transcodeKey(job.path, job.bitrate), job.path, job.bitrate, s.transcodeDir, PREWARM_FORMAT, { nice: true });
      } catch (e) {
        status.errors++;
        console.error(`[prewarm] ${job.bitrate}k failed for ${job.path}:`, (e as Error)?.message ?? e);
      }
      status.done++;
    }
  } finally {
    status.running = false;
    status.bitrate = 0;
    if (queued) { queued = false; void runPrewarm(db); }
  }
}

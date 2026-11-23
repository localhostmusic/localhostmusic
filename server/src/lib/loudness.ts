import { spawnFfmpeg } from "./ffmpeg.js";
import type Database from "better-sqlite3";

// Volume normalization: measure each track's integrated loudness (EBU R128, LUFS)
// with ffmpeg's `loudnorm` analysis pass (`input_i` in its JSON output). Measured
// once, cached in the DB.

// Run loudnorm in measurement mode and return the integrated loudness (LUFS), or
// null if ffmpeg fails or the value can't be parsed. Niced so a backfill doesn't
// compete with playback/transcoding.
export function analyzeLoudness(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-nostats", "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"];
    let err = "";
    let ff;
    try {
      ff = spawnFfmpeg(args, true);
    } catch {
      resolve(null);
      return;
    }
    // loudnorm prints its JSON summary to stderr.
    ff.stderr.on("data", (d) => { err += d.toString(); if (err.length > 1_000_000) err = err.slice(-500_000); });
    ff.on("error", () => resolve(null));
    ff.on("close", () => {
      // The JSON is the last {...} block in the output.
      const start = err.lastIndexOf("{");
      const end = err.lastIndexOf("}");
      if (start < 0 || end <= start) return resolve(null);
      try {
        const json = JSON.parse(err.slice(start, end + 1));
        const i = parseFloat(json.input_i);
        // loudnorm reports a sentinel (~-70/-99) for silence/undecodable input; ignore it.
        if (!isFinite(i) || i <= -70) return resolve(null);
        resolve(i);
      } catch {
        resolve(null);
      }
    });
  });
}

let running = false;

// Fill `loudness` for every track that lacks it, one niced ffmpeg at a time in the
// background. Idempotent, and guarded against overlapping calls.
export async function backfillLoudness(db: Database.Database): Promise<void> {
  if (running) return;
  running = true;
  let done = 0;
  try {
    for (;;) {
      const row = db.prepare(
        "SELECT id, path FROM tracks WHERE loudness IS NULL ORDER BY id LIMIT 1"
      ).get() as { id: number; path: string } | undefined;
      if (!row) break;
      const lufs = await analyzeLoudness(row.path);
      // Store the measured value, or a sentinel 0.0 so we don't retry an undecodable
      // file every pass. 0 LUFS is effectively "no attenuation" on the client.
      db.prepare("UPDATE tracks SET loudness = ? WHERE id = ?").run(lufs ?? 0, row.id);
      done++;
    }
  } finally {
    running = false;
    if (done) console.log(`Loudness: analyzed ${done} tracks`);
  }
}

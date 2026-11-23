import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { dirname, join, extname } from "node:path";

export interface WritableTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  track?: number;
  disc?: number;
}

// Write tags by remuxing with ffmpeg (copy all streams, no re-encode, keeps
// embedded art) into a temp file, then atomically replacing the original. Needs
// write access to the file's directory.
export function writeTags(path: string, tags: WritableTags): Promise<void> {
  return new Promise((resolve, reject) => {
    const ext = extname(path);
    const tmp = join(dirname(path), `.lhm-tmp-${Date.now()}${ext}`);
    const args = ["-i", path, "-map", "0", "-c", "copy", "-map_metadata", "0"];
    const add = (k: string, v: unknown) => {
      if (v != null && String(v) !== "") args.push("-metadata", `${k}=${v}`);
    };
    add("title", tags.title);
    add("artist", tags.artist);
    add("album", tags.album);
    add("album_artist", tags.artist);
    add("date", tags.year);
    add("track", tags.track);
    add("disc", tags.disc);
    args.push("-y", "-loglevel", "error", tmp);

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errOut = "";
    ff.stderr.on("data", d => { errOut += d.toString(); });
    ff.on("error", reject);
    ff.on("close", async code => {
      if (code !== 0) return reject(new Error(errOut.trim() || `ffmpeg exited ${code}`));
      try { await rename(tmp, path); resolve(); }
      catch (e) { reject(e); }
    });
  });
}

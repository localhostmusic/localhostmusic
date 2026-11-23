import { spawn } from "node:child_process";
import { unlink, rename, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parseFile } from "music-metadata";
import { TranscodeQueue } from "./transcodeQueue.js";

// Output containers. "mp3" is for progressive <audio>, "m4a" is fragmented
// MP4/AAC for Media Source Extensions (also plays in a plain <audio>). The format
// is part of the cache filename and URL (?fmt=), so the two never collide.
export type TranscodeFormat = "mp3" | "m4a";
export const formatExt = (f: TranscodeFormat) => (f === "m4a" ? "m4a" : "mp3");

// Cache key for a (source file, bitrate) pair. Keyed by source path, not track id:
// ids are database-local, so path keys survive db rebuilds and let instances share
// a cache dir. The -<bitrate>.<ext> suffix is what per-tier stats/clear match on.
export const transcodeKey = (srcPath: string, bitrate: number) => {
  const st = statSync(srcPath);
  return `t${createHash("sha1").update(`${srcPath}:${st.mtimeMs}:${st.size}`).digest("hex").slice(0, 16)}-${bitrate}`;
};

// Run ffmpeg to a seekable output file, never a pipe. For mp3, ffmpeg seeks back to
// write the Xing/Info header and duration (iOS Safari rejects a headerless MP3). For
// fMP4 it writes the fragmented moov. `nice` lowers CPU priority for pre-warm.
function runFfmpeg(srcPath: string, bitrate: number, outPath: string, format: TranscodeFormat, nice: boolean, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Transcode cancelled"));
  return new Promise((resolve, reject) => {
    const args = format === "m4a"
      // Fragmented MP4/AAC for MSE. `-map 0:a:0` takes only the first audio stream:
      // embedded cover art is a still-image video stream the fMP4 muxer can't write.
      // frag_duration forces ~2s fragments, since audio has no keyframes to split on.
      ? ["-y", "-i", srcPath, "-map", "0:a:0", "-c:a", "aac", "-b:a", `${bitrate}k`,
         "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000",
         "-f", "mp4", outPath]
      : ["-y", "-i", srcPath, "-map", "0:a:0", "-f", "mp3", "-b:a", `${bitrate}k`, outPath];
    const ff = nice
      ? spawn("nice", ["-n", "15", "ffmpeg", ...args], { stdio: ["ignore", "ignore", "pipe"] })
      : spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let killed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      killed = true;
      ff.kill("SIGTERM");
      killTimer = setTimeout(() => ff.kill("SIGKILL"), 3000);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 30 * 60_000);
    const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener("abort", abort); };
    let err = "";
    ff.stderr.on("data", (d) => { err = (err + d.toString()).slice(-300); });
    ff.on("error", e => { cleanup(); reject(e); });
    ff.on("close", code => { cleanup(); if (code === 0 && !killed) resolve(); else reject(new Error(killed ? "Transcode cancelled or timed out" : `ffmpeg exited ${code}: ${err}`)); });
  });
}

// Transcode once into a cache file and reuse it for every later request, including
// HTTP range requests (audio elements, iOS Safari especially, fire many). Concurrent
// requests for the same key share one transcode. The write is atomic (tmp + rename).
const queue = new TranscodeQueue();
type EncodeJob = { promise: Promise<string>; abort: AbortController; consumers: number; abortTimer?: ReturnType<typeof setTimeout> };
const inflight = new Map<string, EncodeJob>();
const originalBitrates = new Map<string, number>();

export async function transcodedFile(key: string, srcPath: string, bitrate: number, cacheDir: string, format: TranscodeFormat = "mp3", opts?: { nice?: boolean; signal?: AbortSignal }): Promise<string> {
  if (![64, 96, 128, 160, 192, 224, 256, 320].includes(bitrate)) return Promise.reject(new Error("Unsupported bitrate"));
  if (opts?.signal?.aborted) return Promise.reject(new Error("Transcode cancelled"));
  const out = resolve(cacheDir, `${key}.${formatExt(format)}`);
  if (existsSync(out)) return Promise.resolve(out);
  // Already compatible MP3s at or below the requested tier can stream now.
  if (format === "mp3" && extname(srcPath).toLowerCase() === ".mp3") {
    let original = originalBitrates.get(key);
    if (original === undefined) {
      original = await parseFile(srcPath, { skipCovers: true }).then(m => m.format.bitrate || 0).catch(() => 0);
      if (originalBitrates.size >= 500) originalBitrates.clear();
      originalBitrates.set(key, original);
    }
    if (original > 0 && original <= bitrate * 1000) return srcPath;
  }
  if (opts?.signal?.aborted) throw new Error("Transcode cancelled");
  let job = inflight.get(out);
  if (!job) {
    const abort = new AbortController();
    const began = Date.now();
    const promise = queue.run(async () => {
      const started = Date.now();
      await mkdir(cacheDir, { recursive: true });
      const tmp = join(cacheDir, `${key}.${randomUUID()}.tmp`);
      try {
        await runFfmpeg(srcPath, bitrate, tmp, format, opts?.nice ?? false, abort.signal);
        await rename(tmp, out);
        if (process.env.LHM_DEBUG_TRANSFER === "1") console.log(`[transcode] wait=${started - began}ms encode=${Date.now() - started}ms tier=${bitrate}`);
        return out;
      } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
    }, opts?.nice ?? false, abort.signal);
    job = { promise, abort, consumers: 0 };
    inflight.set(out, job);
    const current = job;
    void promise.finally(() => { clearTimeout(current.abortTimer); if (inflight.get(out) === current) inflight.delete(out); }).catch(() => {});
  }
  const shared = job;
  clearTimeout(shared.abortTimer);
  shared.abortTimer = undefined;
  shared.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      opts?.signal?.removeEventListener("abort", cancel);
      shared.consumers--;
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      if (!shared.consumers) {
        // A browser recovery often replaces its range request immediately.
        // Let that request rejoin this encode rather than restarting a long book.
        shared.abortTimer = setTimeout(() => {
          if (shared.consumers) return;
          if (inflight.get(out) === shared) inflight.delete(out);
          shared.abort.abort();
        }, 1500);
      }
      reject(new Error("Transcode cancelled"));
    };
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    if (opts?.signal?.aborted) cancel();
    shared.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
  });
}

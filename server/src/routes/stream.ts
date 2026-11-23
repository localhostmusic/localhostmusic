import type { FastifyInstance } from "fastify";
import { createReadStream, statSync } from "node:fs";
import { Transform } from "node:stream";
import { extname } from "node:path";
import { transcodedFile, transcodeKey, type TranscodeFormat } from "../lib/transcode.js";
import { parseByteRange } from "../lib/range.js";
import { getSettings } from "../lib/settings.js";

// Content-Type from the served file's extension. MP4/AAC (transcodes + m4a/alac
// originals) must be audio/mp4 for MSE + iOS; the rest map by container.
function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".m4a": case ".m4b": case ".mp4": case ".aac": return "audio/mp4";
    case ".flac": return "audio/flac";
    case ".wav": return "audio/wav";
    case ".ogg": case ".oga": case ".opus": return "audio/ogg";
    case ".aif": case ".aiff": return "audio/aiff";
    default: return "audio/mpeg";
  }
}

// Opt-in (LHM_DEBUG_TRANSFER=1): log bytes and throughput per stream response.
const DEBUG_TRANSFER = process.env.LHM_DEBUG_TRANSFER === "1";
function withTransferLog<T extends NodeJS.ReadableStream>(stream: T, label: string): NodeJS.ReadableStream {
  if (!DEBUG_TRANSFER) return stream;
  const t0 = Date.now();
  let sent = 0;
  const counter = new Transform({ transform(chunk, _e, cb) { sent += chunk.length; cb(null, chunk); } });
  counter.on("close", () => {
    const secs = (Date.now() - t0) / 1000;
    if (sent > 0 && secs > 0) {
      console.log(`[xfer] ${label}: ${(sent / 1048576).toFixed(2)} MB in ${secs.toFixed(1)}s = ${(sent * 8 / secs / 1e6).toFixed(1)} Mbps`);
    }
  });
  return stream.pipe(counter);
}

// Token-bucket send-rate limiter. Paces bytes to `bytesPerSec` after an initial
// `burstBytes` allowance, so a track starts at full speed and the rest is paced.
function rateLimit(bytesPerSec: number, burstBytes: number): Transform {
  let tokens = burstBytes;
  let last = Date.now();
  const refill = () => {
    const now = Date.now();
    tokens = Math.min(burstBytes, tokens + ((now - last) / 1000) * bytesPerSec);
    last = now;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      refill();
      if (tokens >= chunk.length) { tokens -= chunk.length; return cb(null, chunk); }
      const waitMs = Math.ceil(((chunk.length - tokens) / bytesPerSec) * 1000);
      setTimeout(() => { refill(); tokens -= chunk.length; cb(null, chunk); }, waitMs);
    },
  });
}
// ~2s of audio at 320k plus headroom, so the initial buffer arrives at full speed
// and only the long tail of a track is paced.
const RATE_BURST_BYTES = 1_000_000;

export async function streamRoutes(app: FastifyInstance) {
  app.get("/api/stream/:trackId", { preHandler: app.authRequired }, async (req, reply) => {
    const { trackId } = req.params as any;
    const { bitrate, fmt } = req.query as any;
    if (bitrate !== undefined && ![64, 96, 128, 160, 192, 224, 256, 320].includes(Number(bitrate))) return reply.code(400).send({ error: "unsupported bitrate" });
    if (fmt !== undefined && !["mp3", "m4a"].includes(fmt)) return reply.code(400).send({ error: "unsupported format" });
    const row = app.db.prepare("SELECT path FROM tracks WHERE id=?").get(trackId) as any;
    if (!row) return reply.code(404).send({ error: "track not found" });
    const range = req.headers.range;
    // ?fmt=m4a selects fragmented MP4/AAC; default is legacy mp3. Only applies to
    // the transcoded (bitrate) path. Original/lossless is served as-is.
    const format: TranscodeFormat = fmt === "m4a" ? "m4a" : "mp3";
    const label = `track ${trackId}${bitrate ? `@${bitrate}k${format === "m4a" ? " aac" : ""}` : ""}`;

    // Transcoded (bitrate) path: transcode once into a cache file, then serve that
    // file like the original (seekable range requests, no per-request transcode).
    let path = row.path;
    if (bitrate) {
      const ac = new AbortController();
      const disconnected = () => { if (!reply.raw.writableFinished) ac.abort(); };
      reply.raw.on("close", disconnected);
      try {
        const dir = getSettings(app.db).transcodeDir;
        path = await transcodedFile(transcodeKey(row.path, Number(bitrate)), row.path, Number(bitrate), dir, format, { signal: ac.signal });
      } catch (e: any) {
        return reply.code(500).send({ error: String(e?.message ?? e) });
      } finally { reply.raw.removeListener("close", disconnected); }
    }
    const contentType = contentTypeFor(path);

    const size = statSync(path).size;
    // Optional per-stream send-rate cap (0 = unlimited). Wraps the file stream in
    // a token-bucket pacer so remote playback can't saturate home upload.
    const kbps = getSettings(app.db).streamKbps;
    const pace = <T extends NodeJS.ReadableStream>(s: T): NodeJS.ReadableStream =>
      kbps > 0 ? s.pipe(rateLimit((kbps * 1000) / 8, RATE_BURST_BYTES)) : s;
    if (range) {
      const parsed = parseByteRange(range, size);
      if (!parsed) return reply.code(416).header("content-range", `bytes */${size}`).send();
      const [start, end] = parsed;
      reply.code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("accept-ranges", "bytes")
        .header("content-length", end - start + 1)
        .type(contentType);
      return withTransferLog(pace(createReadStream(path, { start, end })), `${label} ${start}-${end}`);
    }
    reply.header("accept-ranges", "bytes").header("content-length", size).type(contentType);
    return withTransferLog(pace(createReadStream(path)), label);
  });
}

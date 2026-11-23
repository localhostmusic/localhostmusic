import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { statSync, existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

// Resized cover/artwork thumbnails, cached on disk. Covers are stored at full
// embedded resolution (often 1000px+) and grids only need ~300px.
// Cache key includes the source mtime+size so a re-tagged cover regenerates.

// Snap requested sizes to a small set of buckets so arbitrary ?size values can't
// explode the cache. Returns null for "serve the original".
const BUCKETS = [96, 160, 300, 512];
export function bucketSize(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BUCKETS.reduce((best, b) => (Math.abs(b - n) < Math.abs(best - n) ? b : best), BUCKETS[0]);
}

const inflight = new Map<string, Promise<string>>();

// Return a path to a square JPEG thumbnail of srcPath, generating and caching it
// on first request. Throws if the source can't be read.
export async function thumbnail(srcPath: string, size: number, cacheDir: string): Promise<string> {
  const st = statSync(srcPath); // throws, caller 404s
  const key = createHash("sha1").update(`${srcPath}:${st.mtimeMs}:${st.size}:${size}`).digest("hex");
  const out = join(cacheDir, `${key}.jpg`);
  if (existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out)!;
  const p = (async () => {
    await mkdir(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `${key}.${randomUUID()}.tmp`);
    // fit:cover gives a square crop (centre crop for non-square artist portraits).
    await sharp(srcPath, { failOn: "none" })
      .rotate() // honor EXIF orientation
      .resize(size, size, { fit: "cover", position: "centre" })
      .jpeg({ quality: 80 })
      .toFile(tmp);
    await rename(tmp, out);
    return out;
  })();
  inflight.set(out, p);
  try { return await p; } finally { inflight.delete(out); }
}

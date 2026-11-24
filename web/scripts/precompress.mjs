// Write .br and .gz copies next to every text asset in dist/, so the server can
// send them as-is (@fastify/static preCompressed). Uses Node's zlib, no build dependency.
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const TEXT = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".map", ".xml"]);
const root = fileURLToPath(new URL("../dist", import.meta.url));
let files = 0, before = 0, after = 0;
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!TEXT.has(extname(name))) continue;
    const raw = readFileSync(path);
    if (raw.length < 1024) continue;
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    writeFileSync(path + ".br", br);
    writeFileSync(path + ".gz", gzipSync(raw, { level: 9 }));
    files++; before += raw.length; after += br.length;
  }
};
walk(root);
console.log(`precompressed ${files} files: ${(before / 1024).toFixed(0)} KB to ${(after / 1024).toFixed(0)} KB (brotli)`);

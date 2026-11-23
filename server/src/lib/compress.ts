import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const br = promisify(brotliCompress);
const gz = promisify(gzip);

// Compress API responses with Node's zlib (no dependency).
// Only buffered text payloads are touched. Audio, images and streams are already
// compressed or must keep their byte ranges.
const COMPRESSIBLE = /^(application\/(json|javascript|xml|rss\+xml|manifest\+json)|text\/|image\/svg\+xml)/i;
const MIN_BYTES = 1024;

export function registerCompression(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
    if (req.method === "HEAD" || reply.statusCode === 204 || reply.statusCode === 304) return payload;
    if (reply.getHeader("content-encoding") || req.headers.range) return payload;
    if (!COMPRESSIBLE.test(String(reply.getHeader("content-type") ?? ""))) return payload;
    const body = typeof payload === "string" ? Buffer.from(payload) : payload;
    if (body.length < MIN_BYTES) return payload;
    const accept = String(req.headers["accept-encoding"] ?? "");
    reply.header("vary", "Accept-Encoding");
    let out: Buffer; let encoding: string;
    // Quality 4 is the usual on-the-fly setting: close to gzip's speed, smaller output.
    if (/\bbr\b/.test(accept)) { out = await br(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }); encoding = "br"; }
    else if (/\bgzip\b/.test(accept)) { out = await gz(body, { level: 6 }); encoding = "gzip"; }
    else return payload;
    reply.header("content-encoding", encoding);
    reply.header("content-length", out.length);
    return out;
  });
}

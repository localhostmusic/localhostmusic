import { test, expect } from "vitest";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { registerCompression } from "../src/lib/compress.js";

function app() {
  const a = Fastify();
  registerCompression(a);
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ id: i, title: "An album title " + i })) };
  a.get("/big", async () => big);
  a.get("/small", async () => ({ ok: true }));
  a.get("/bytes", async (_req, reply) => reply.type("audio/mpeg").send(Buffer.alloc(4096, 1)));
  return { a, big };
}

test("large JSON is brotli-compressed when the client accepts it", async () => {
  const { a, big } = app();
  const res = await a.inject({ url: "/big", headers: { "accept-encoding": "gzip, deflate, br" } });
  expect(res.headers["content-encoding"]).toBe("br");
  expect(res.headers["vary"]).toBe("Accept-Encoding");
  expect(Number(res.headers["content-length"])).toBe(res.rawPayload.length);
  expect(res.rawPayload.length).toBeLessThan(JSON.stringify(big).length / 3);
  expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(big);
});

test("falls back to gzip, and to nothing", async () => {
  const { a, big } = app();
  const g = await a.inject({ url: "/big", headers: { "accept-encoding": "gzip" } });
  expect(g.headers["content-encoding"]).toBe("gzip");
  expect(JSON.parse(gunzipSync(g.rawPayload).toString())).toEqual(big);
  const plain = await a.inject({ url: "/big" });
  expect(plain.headers["content-encoding"]).toBeUndefined();
  expect(plain.json()).toEqual(big);
});

test("small payloads and audio are left alone", async () => {
  const { a } = app();
  const small = await a.inject({ url: "/small", headers: { "accept-encoding": "br" } });
  expect(small.headers["content-encoding"]).toBeUndefined();
  const audio = await a.inject({ url: "/bytes", headers: { "accept-encoding": "br" } });
  expect(audio.headers["content-encoding"]).toBeUndefined();
  expect(audio.rawPayload.length).toBe(4096);
});

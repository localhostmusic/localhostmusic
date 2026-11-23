import { test, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("serves SPA index for non-api routes", async () => {
  mkdirSync(join(import.meta.dirname, "..", "public"), { recursive: true });
  writeFileSync(join(import.meta.dirname, "..", "public", "index.html"), "<!doctype html><title>Localhost Music</title>");
  const app = buildApp(openDb(":memory:"));
  const res = await app.inject({ url: "/library" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("Localhost Music");
  await app.close();
});

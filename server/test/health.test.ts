import { test, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";

test("GET /api/health returns ok", async () => {
  const app = buildApp(openDb(":memory:"));
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok" });
  await app.close();
});

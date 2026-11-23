import { test, expect, vi } from "vitest";
import { api } from "./api";

test("streamUrl builds correct url", () => {
  expect(api.streamUrl(5)).toBe("/api/stream/5");
  expect(api.streamUrl(5, 128)).toBe("/api/stream/5?bitrate=128");
});

test("login posts credentials", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 1, username: "a", isAdmin: true }));
  vi.stubGlobal("fetch", fetchMock);
  const u = await api.login("a", "b");
  expect(u.username).toBe("a");
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST" }));
});

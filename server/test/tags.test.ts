import { test, expect } from "vitest";
import { readTags } from "../src/scanner/tags.js";
import { join } from "node:path";

const fx = (n: string) => join(import.meta.dirname, "fixtures", n);

test("reads basic tags", async () => {
  const t = await readTags(fx("song-a.mp3"));
  expect(t.title).toBe("Song A");
  expect(t.artist).toBe("Artist X");
  expect(t.album).toBe("Album 1");
  expect(t.trackNo).toBe(1);
});

test("throws on corrupt file", async () => {
  await expect(readTags(fx("corrupt.mp3"))).rejects.toThrow();
});

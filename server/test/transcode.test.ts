import { afterEach, expect, it } from "vitest";
import { mkdtempSync, copyFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "music-metadata";
import { transcodeKey, transcodedFile } from "../src/lib/transcode.js";
const dirs: string[] = [];
const temp = () => {const d=mkdtempSync(join(tmpdir(),"lhm-encode-"));dirs.push(d);return d;};
const fixture = join(import.meta.dirname,"fixtures/song-a.mp3");
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir,{recursive:true,force:true})));
it("streams compatible originals without making another lossy copy", async () => {
  const dir = temp();
  expect(await transcodedFile(transcodeKey(fixture,320),fixture,320,dir)).toBe(fixture);
  expect(readdirSync(dir)).toEqual([]);
});
it("makes seekable conversions and keeps independent cache directories independent", async () => {
  const dirs = [temp(),temp()];
  const key = transcodeKey(fixture,64);
  const results = await Promise.all(dirs.map(dir => transcodedFile(key,fixture,64,dir,"m4a")));
  expect(results[0]).not.toBe(results[1]);
  for (const result of results) {
    expect(statSync(result).size).toBeGreaterThan(0);
    const metadata = await parseFile(result);
    expect(metadata.format.codec).toMatch(/AAC/);
  }
});
it("changes conversion keys when bytes at a path are replaced", () => {
  const path = join(temp(),"song.mp3");
  copyFileSync(fixture,path); const before = transcodeKey(path,128);
  copyFileSync(join(import.meta.dirname,"fixtures/song-b.mp3"),path);
  expect(transcodeKey(path,128)).not.toBe(before);
});
it("does not start cancelled jobs", async () => {
  const ac = new AbortController(); ac.abort(); const dir = temp();
  await expect(transcodedFile(transcodeKey(fixture,64),fixture,64,dir,"m4a",{signal:ac.signal})).rejects.toThrow("cancelled");
  expect(readdirSync(dir)).toEqual([]);
});

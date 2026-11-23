import { expect, it } from "vitest";
import { TranscodeQueue } from "../src/lib/transcodeQueue.js";
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
it("reserves capacity for playback, prioritizes interactive work, and cancels queued work", async () => {
  const q = new TranscodeQueue();
  const started: string[] = [], ends: (() => void)[] = [];
  const work = (name: string) => () => new Promise<void>(resolve => {started.push(name); ends.push(resolve);});
  const ac = new AbortController(), cancel = new AbortController();
  const b1 = q.run(work("background1"), true, ac.signal);
  const b2 = q.run(work("background2"), true, ac.signal);
  const p1 = q.run(work("playback1"), false, ac.signal);
  const gone = q.run(work("cancelled"), false, cancel.signal).catch(e => e);
  const p2 = q.run(work("playback2"), false, ac.signal);
  cancel.abort(); await gone; await flush();
  expect(started).toEqual(["background1", "playback1"]);
  ends.shift()!(); await flush();
  expect(started).toEqual(["background1", "playback1", "playback2"]);
  ends.shift()!(); await flush();
  expect(started).toEqual(["background1", "playback1", "playback2", "background2"]);
  ends.splice(0).forEach(end => end()); await Promise.all([b1,b2,p1,p2]);
});
it("releases capacity after synchronous failure", async () => {
  const q = new TranscodeQueue(), ac = new AbortController();
  await expect(q.run(() => {throw new Error("broken");}, false, ac.signal)).rejects.toThrow("broken");
  await expect(q.run(async () => 42, false, ac.signal)).resolves.toBe(42);
});

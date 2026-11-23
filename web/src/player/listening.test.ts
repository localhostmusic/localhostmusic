import { expect, it } from "vitest";
import { ListeningClock } from "./listening";
it("counts playback but excludes seeking and paused time", () => {
  const c = new ListeningClock();
  c.tick(0, 0, true);
  c.tick(10, 10_000, true);
  c.tick(150, 11_000, true); // seek
  c.tick(151, 12_000, true);
  c.tick(151, 13_000, false);
  c.tick(151, 60_000, true);
  expect(c.tick(152, 61_000, true)).toBe(12);
});
it("accepts sparse background ticks at the actual playback speed", () => {
  const c = new ListeningClock();
  c.tick(0, 0, true, 2);
  expect(c.tick(120, 60_000, true, 2)).toBe(120);
  expect(new ListeningClock().seconds).toBe(0);
});

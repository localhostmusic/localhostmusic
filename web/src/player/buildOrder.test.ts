import { test, expect } from "vitest";
import { buildOrder } from "./PlayerProvider";

// Average play position (0 = first) of the high-weighted track over many shuffles.
function avgPositionOfHighTrack(weights: number[] | undefined, runs = 800): number {
  const n = 10, high = 9;
  let sum = 0;
  for (let r = 0; r < runs; r++) sum += buildOrder(n, -1, true, weights).order.indexOf(high);
  return sum / runs;
}

test("weighted shuffle lands higher-rated songs earlier on average", () => {
  const weights = Array(10).fill(1); weights[9] = 6; // one 5-star (rating+1) vs unrated
  expect(avgPositionOfHighTrack(weights)).toBeLessThan(4); // well before the midpoint (4.5)
});

test("uniform shuffle is unbiased (control)", () => {
  const avg = avgPositionOfHighTrack(undefined);
  expect(avg).toBeGreaterThan(3.5);
  expect(avg).toBeLessThan(5.5);
});

test("shuffle keeps the seed track first and includes every track once", () => {
  const { order, pos } = buildOrder(6, 2, true);
  expect(order[0]).toBe(2);            // seed stays first
  expect(pos).toBe(0);
  expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]); // no dupes/drops
});

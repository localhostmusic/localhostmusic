import { describe, it, expect, beforeEach, vi } from "vitest";
import { savePlayer, savePlayerTime, restoreQueue, restorePrefs } from "./playerStorage";

// Restore reads storage that the user or older app versions may have written, and
// a bad restore fails silently. These pin the validation.
const LS = "lhm_player";
const T = "lhm_player_time";
const track = (id: number) => ({ id, title: `t${id}` });

describe("player storage", () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });

  it("round-trips a queue with its order, cursor and modes", () => {
    savePlayer({ queue: [track(1), track(2), track(3)], order: [2, 0, 1], pos: 1, shuffle: true, repeat: "all", volume: 0.5 });
    savePlayerTime(87.5);

    const r = restoreQueue()!;
    expect(r.queue.map(t => t.id)).toEqual([1, 2, 3]);
    expect(r.order).toEqual([2, 0, 1]);
    expect(r.pos).toBe(1);
    expect(r.shuffle).toBe(true);
    expect(r.repeat).toBe("all");
    expect(r.volume).toBe(0.5);
    expect(r.currentTime).toBe(87.5);
  });

  it("keeps the saved order, because it carries the user's edits", () => {
    // A reordered, partly removed queue: rebuilding would undo that.
    savePlayer({ queue: [track(1), track(2), track(3)], order: [2, 1], pos: 0, shuffle: false });
    expect(restoreQueue()!.order).toEqual([2, 1]);
  });

  it("rebuilds an order that doesn't line up with its queue", () => {
    savePlayer({ queue: [track(1), track(2)], order: [0, 1, 7], pos: 0 }); // 7 is out of range
    const r = restoreQueue()!;
    expect(r.order).toEqual([0, 1]);
  });

  it("clamps a cursor that points past the end", () => {
    savePlayer({ queue: [track(1), track(2)], order: [0, 1], pos: 99 });
    expect(restoreQueue()!.pos).toBe(1);
  });

  it("returns nothing when there is nothing to restore", () => {
    expect(restoreQueue()).toBeNull();
    savePlayer({ queue: [] });
    expect(restoreQueue()).toBeNull();
  });

  it("survives corrupt storage instead of taking the player down with it", () => {
    localStorage.setItem(LS, "{not json");
    expect(restoreQueue()).toBeNull();
    expect(restorePrefs()).toEqual({});
  });

  it("falls back to the queue blob's time when the position key is missing", () => {
    savePlayer({ queue: [track(1)], order: [0], pos: 0, currentTime: 12 });
    localStorage.removeItem(T);
    expect(restoreQueue()!.currentTime).toBe(12);
  });

  it("rejects a repeat mode it doesn't recognise", () => {
    savePlayer({ queue: [track(1)], order: [0], pos: 0, repeat: "sideways" });
    expect(restoreQueue()!.repeat).toBe("off");
  });

  it("validates and clamps Auto DJ preferences", () => {
    savePlayer({ autoDJMode: "nonsense", autoDJUnit: "albums", autoDJSongCount: 9999, autoDJAlbumCount: 0, weightedShuffle: true });
    const p = restorePrefs();
    expect(p.autoDJMode).toBeUndefined();  // unknown mode ignored, not adopted
    expect(p.autoDJUnit).toBe("albums");
    expect(p.autoDJSongCount).toBe(50);    // clamped
    expect(p.autoDJAlbumCount).toBe(1);
    expect(p.weightedShuffle).toBe(true);
  });

  it("merges saves instead of clobbering the blob", () => {
    savePlayer({ queue: [track(1)], order: [0], pos: 0, volume: 0.3 });
    savePlayer({ repeat: "one" }); // a later, unrelated save
    const r = restoreQueue()!;
    expect(r.volume).toBe(0.3);
    expect(r.repeat).toBe("one");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StallRecovery } from "./recovery";

// The host is a stub: these test the policy (when to retry, how long to wait, when
// to ask for a fresh URL, when to give up) without a media element.
function harness(opts: { wants?: () => boolean } = {}) {
  const el = {
    src: "/api/stream/1?src=c",
    paused: true,
    seeking: false,
    error: null as null | { code: number },
  };
  const reloads: boolean[] = [];   // one entry per attempt: was a fresh URL requested?
  const badge: boolean[] = [];
  const rec = new StallRecovery({
    active: () => el as unknown as HTMLMediaElement,
    wantsToPlay: opts.wants ?? (() => true),
    reload: (fresh) => reloads.push(fresh),
    setReconnecting: (on) => badge.push(on),
  });
  return { rec, el, reloads, badge };
}

describe("StallRecovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives a stall time to resolve itself before reloading", () => {
    const { rec, reloads } = harness();
    rec.onStall();
    vi.advanceTimersByTime(5000);
    expect(reloads).toEqual([]);   // still buffering, a reload would discard it
    vi.advanceTimersByTime(2000);
    expect(reloads.length).toBe(1);
  });

  it("acts on an error immediately, with no grace period", () => {
    const { rec, reloads } = harness();
    rec.onError();
    vi.advanceTimersByTime(700);
    expect(reloads.length).toBe(1);
  });

  it("keeps retrying an outage of unknown length", () => {
    const { rec, reloads } = harness();
    for (let i = 0; i < 20; i++) { rec.onError(); vi.advanceTimersByTime(20000); }
    expect(reloads.length).toBeGreaterThanOrEqual(20);
  });

  it("paces repeated failures at the capped 15-second delay", () => {
    const times: number[] = [];
    const el = { src: "/song", paused: true } as HTMLMediaElement;
    const rec = new StallRecovery({active: () => el, wantsToPlay: () => true,
      reload: () => { times.push(Date.now()); rec.onError(); }, setReconnecting: () => {}});
    rec.onError();
    vi.advanceTimersByTime(180_000);
    const intervals = times.slice(1).map((at,i) => at-times[i]);
    expect(intervals.slice(-5)).toEqual([15000,15000,15000,15000,15000]);
    rec.clear();
  });

  it("reuses the address for a stall and demands a fresh one for a dead load", () => {
    const stalled = harness();
    stalled.rec.onStall();
    vi.advanceTimersByTime(8000);
    expect(stalled.reloads[0]).toBe(false); // resumable, no re-download

    const dead = harness();
    dead.el.error = { code: 2 };
    dead.rec.onError();
    vi.advanceTimersByTime(700);
    expect(dead.reloads[0]).toBe(true);     // a failed URL keeps failing
  });

  it("escalates to a fresh address when retries plainly aren't landing", () => {
    const { rec, reloads } = harness(); // no error reported, just not recovering
    for (let i = 0; i < 5; i++) { rec.onError(); vi.advanceTimersByTime(20000); }
    expect(reloads.slice(0, 2)).toEqual([false, false]);
    expect(reloads.at(-1)).toBe(true);
  });

  it("stops the moment the device no longer means to be playing", () => {
    let wants = true;
    const { rec, reloads } = harness({ wants: () => wants });
    rec.onError();
    vi.advanceTimersByTime(700);
    expect(reloads.length).toBe(1);

    wants = false; // audio moved to another device
    for (let i = 0; i < 5; i++) { rec.onError(); vi.advanceTimersByTime(20000); }
    expect(reloads.length).toBe(1);
  });

  it("spends no attempts while offline, but stays armed", () => {
    const { rec, reloads, badge } = harness();
    const nav: Record<string, unknown> = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, "onLine");
    Object.defineProperty(nav, "onLine", { value: false, configurable: true });
    try {
      for (let i = 0; i < 4; i++) { rec.onError(); vi.advanceTimersByTime(20000); }
      expect(reloads).toEqual([]);        // nothing the network could serve
      expect(badge.at(-1)).toBe(true);    // but the user still sees "reconnecting"
    } finally {
      if (had) Object.defineProperty(nav, "onLine", had); else delete nav.onLine;
    }
  });

  it("gives a seek a grace period, then recovers a hung seek", () => {
    const seeking = harness();
    seeking.el.seeking = true;
    seeking.rec.onError();
    vi.advanceTimersByTime(5000);
    expect(seeking.reloads).toEqual([]);
    vi.advanceTimersByTime(15000);
    expect(seeking.reloads.length).toBeGreaterThan(0);

    const deadSeek = harness();
    deadSeek.el.seeking = true;
    deadSeek.el.error = { code: 2 };     // that seek can never complete
    deadSeek.rec.onError();
    vi.advanceTimersByTime(2000);
    expect(deadSeek.reloads.length).toBe(1);
  });

  it("gives up on a source the browser can never play, and drops the badge", () => {
    const { rec, el, reloads, badge } = harness();
    el.error = { code: 4 }; // MEDIA_ERR_SRC_NOT_SUPPORTED (404, bad container)
    for (let i = 0; i < 10; i++) { rec.onError(); vi.advanceTimersByTime(20000); }
    expect(reloads.length).toBeLessThanOrEqual(4);
    expect(badge.at(-1)).toBe(false); // no permanent spinner
  });

  it("drops the backoff and retries at once when connectivity returns", () => {
    const { rec, el, reloads, badge } = harness();
    rec.onError();
    vi.advanceTimersByTime(100); // mid-backoff
    el.paused = true;

    rec.onOnline();

    expect(badge).toContain(false);
    vi.advanceTimersByTime(700);
    expect(reloads.length).toBe(1); // attempt fires on the short first delay, not the long one
  });

  it("clear() cancels a pending attempt and the badge", () => {
    const { rec, reloads, badge } = harness();
    rec.onError();
    rec.clear();
    vi.advanceTimersByTime(60000);
    expect(reloads).toEqual([]);
    expect(badge.at(-1)).toBe(false);
    expect(rec.active).toBe(false);
  });
});

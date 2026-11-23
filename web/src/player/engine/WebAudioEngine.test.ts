import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebAudioEngine } from "./WebAudioEngine";

// Stand-in for the downloads store: tests set dl.url to make a track "downloaded",
// which sends load() down the async cache-lookup path.
const dl = vi.hoisted(() => ({ url: null as string | null, forId: 0 }));
vi.mock("../downloads", () => ({
  downloadedUrl: (id: number) => (dl.url && id === dl.forId ? dl.url : null),
}));

// Stall recovery is event-driven: a failed reload fires `error`, which arms the
// next attempt.
function setup(wantsToPlay = () => true) {
  const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay });
  const el = (engine as any).elems[0] as HTMLAudioElement;
  el.src = "/api/stream/1";
  const load = vi.spyOn(el, "load").mockImplementation(() => {});
  vi.spyOn(el, "play").mockImplementation(() => Promise.resolve());
  return { engine, el, load };
}

// One outage round-trip: the element errors, the backoff elapses, the engine
// reloads. 20s clears the capped delay.
function stallRound(el: HTMLAudioElement) {
  el.dispatchEvent(new Event("error"));
  vi.advanceTimersByTime(20000);
}

describe("WebAudioEngine stall recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps retrying a network stall well past the old 8-attempt ceiling", () => {
    const { el, load } = setup();
    for (let i = 0; i < 15; i++) stallRound(el);
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(15);
  });

  it("paces a sustained outage instead of retrying in a tight loop", () => {
    const { engine, el, load } = setup();
    el.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(180_000);
    load.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(load.mock.calls.length).toBeLessThanOrEqual(4);
    engine.dispose();
  });

  it("stays in the reconnecting state across a long outage", () => {
    const { engine, el } = setup();
    const seen: boolean[] = [];
    engine.on("state", (st) => seen.push(st.reconnecting));
    for (let i = 0; i < 12; i++) stallRound(el);
    expect(seen.at(-1)).toBe(true);
  });

  it("gives up on a source the browser can never play, and drops the badge", () => {
    const { engine, el, load } = setup();
    Object.defineProperty(el, "error", { value: { code: 4 }, configurable: true }); // SRC_NOT_SUPPORTED
    const seen: boolean[] = [];
    engine.on("state", (st) => seen.push(st.reconnecting));

    for (let i = 0; i < 10; i++) stallRound(el);

    expect(load.mock.calls.length).toBeLessThanOrEqual(4); // FATAL_MAX_TRIES
    expect(seen.at(-1)).toBe(false); // no permanent "reconnecting" badge
  });

  it("does not retry once the provider drops play intent (audio went remote)", () => {
    let want = true;
    const { el, load } = setup(() => want);
    el.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(700);
    expect(load).toHaveBeenCalledTimes(1);

    want = false;
    load.mockClear();
    for (let i = 0; i < 5; i++) stallRound(el);
    expect(load).not.toHaveBeenCalled();
  });
});

// A "ghost" is an element the engine no longer tracks as active that keeps playing.
// Swaps invalidate in-flight loads, pause() silences every element, and a
// non-active element that starts playing is paused.
describe("WebAudioEngine ghost-element protection", () => {
  function ghostSetup() {
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => true });
    engine.attach();
    const e = engine as any;
    const [a, b] = e.elems as HTMLAudioElement[];
    const plays = { a: vi.spyOn(a, "play").mockImplementation(() => Promise.resolve()), b: vi.spyOn(b, "play").mockImplementation(() => Promise.resolve()) };
    const pauses = { a: vi.spyOn(a, "pause").mockImplementation(() => {}), b: vi.spyOn(b, "pause").mockImplementation(() => {}) };
    for (const el of [a, b]) vi.spyOn(el, "load").mockImplementation(() => {});
    e.audioUnlocked = true; // past the iOS unlock gate
    return { engine, e, a, b, plays, pauses };
  }

  it("a gapless swap voids an in-flight downloaded-track load (no ghost autoplay)", async () => {
    const { engine, e, a, plays } = ghostSetup();
    // Downloaded track: load() goes async through the cache lookup.
    dl.url = "/api/download/7"; dl.forId = 7;
    let releaseMatch: (v: undefined) => void = () => {};
    (globalThis as any).caches = { open: () => Promise.resolve({ match: () => new Promise((r) => { releaseMatch = r; }) }) };

    Object.defineProperty(a, "readyState", { value: 4, configurable: true });
    engine.load({ trackId: 7, duration: 100 }, { autoplay: true }); // async, cache lookup in flight
    await new Promise((r) => setTimeout(r, 0)); // let the chain reach the (gated) cache match

    // Track boundary lands mid-lookup: the preloaded next track swaps in.
    const idle = e.elems[1] as HTMLAudioElement;
    Object.defineProperty(idle, "readyState", { value: 4, configurable: true });
    e.preloaded = { trackId: 2, idx: 1 };
    engine.setUpcoming({ trackId: 2, duration: 100 });
    engine.goToUpcoming({ trackId: 2, duration: 100 });
    expect(e.activeIdx).toBe(1);

    plays.a.mockClear();
    releaseMatch(undefined); // cache miss, falls back to the download URL
    await new Promise((r) => setTimeout(r, 0)); // flush the rest of the chain

    // The late load must not start the now non-active element.
    expect(plays.a).not.toHaveBeenCalled();
    delete (globalThis as any).caches;
    dl.url = null;
  });

  it("pause() silences every element, not just the active one", () => {
    const { engine, pauses } = ghostSetup();
    engine.pause();
    expect(pauses.a).toHaveBeenCalled();
    expect(pauses.b).toHaveBeenCalled();
  });

  it("a non-active element that starts playing is paused on sight", () => {
    const { e, a, pauses } = ghostSetup();
    e.activeIdx = 1; // element 0 is not active
    a.src = "/api/stream/9";
    a.dispatchEvent(new Event("playing"));
    expect(pauses.a).toHaveBeenCalled();
  });

  it("does not kill the second element mid-crossfade", () => {
    const { e, a, pauses } = ghostSetup();
    e.activeIdx = 1;
    e.crossfading = true; // both elements audible during the ramp
    a.src = "/api/stream/9";
    a.dispatchEvent(new Event("playing"));
    expect(pauses.a).not.toHaveBeenCalled();
  });
});

describe("WebAudioEngine crossfade bookkeeping", () => {
  it("clears upcomingSpec when that track is promoted to active", () => {
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => true });
    engine.attach();
    const e = engine as any;
    const next = { trackId: 2, duration: 100 };
    e.preloaded = { trackId: 2, idx: 1 };
    e.upcomingSpec = next;

    e.swapToPreloaded(next);

    // Left set, the re-arm would preload the now-playing track into the idle
    // element and maybeCrossfade would blend the track into itself.
    expect(e.upcomingSpec).toBeNull();
    expect(e.activeSpec).toBe(next);
  });
});

// A currentTime write before the element has metadata is dropped, so an early
// seek must be deferred and must survive a stall retry.
describe("WebAudioEngine early seek", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fresh(readyState: number) {
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => true });
    const el = (engine as any).elems[0] as HTMLAudioElement;
    el.src = "/api/stream/1";
    Object.defineProperty(el, "readyState", { value: readyState, configurable: true });
    vi.spyOn(el, "load").mockImplementation(() => {});
    vi.spyOn(el, "play").mockImplementation(() => Promise.resolve());
    return { engine, el };
  }

  it("defers a seek issued before metadata instead of dropping it", () => {
    const { engine, el } = fresh(0); // HAVE_NOTHING: a currentTime write clamps to 0
    engine.seek(42);
    expect(el.currentTime).toBe(0); // nothing to seek in yet

    Object.defineProperty(el, "readyState", { value: 1, configurable: true });
    el.dispatchEvent(new Event("loadedmetadata"));
    expect(el.currentTime).toBe(42); // the target survived
  });

  it("seeks straight away once metadata is in", () => {
    const { engine, el } = fresh(1);
    engine.seek(30);
    expect(el.currentTime).toBe(30);
  });

  it("recovers to the seek target, not the top of the track", () => {
    const { engine } = fresh(1);
    engine.seek(90);
    // No timeupdate has fired, so lastTime came from the seek.
    expect((engine as any).lastTime).toBe(90);
  });

  it("preserves a seek target when a hung seek eventually needs recovery", () => {
    const { engine, el } = fresh(1);
    const load = el.load as unknown as ReturnType<typeof vi.fn>;
    engine.seek(90);
    Object.defineProperty(el, "seeking", { value: true, configurable: true });
    el.dispatchEvent(new Event("waiting"));
    vi.advanceTimersByTime(5000);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15000);
    expect(load).toHaveBeenCalled();
    expect((engine as any).lastTime).toBe(90);
    Object.defineProperty(el, "seeking", { value: false, configurable: true });
    Object.defineProperty(el, "paused", { value: false, configurable: true });
    el.currentTime = 91;
    el.dispatchEvent(new Event("timeupdate"));
    load.mockClear();
    vi.advanceTimersByTime(30000);
    expect(load).not.toHaveBeenCalled();
    engine.dispose();
  });
});

// One load, one source. Mixing network bytes with cache-synthesized ones mid-load
// kills Chrome's media pipeline, and the service worker can restart at any time,
// so the page pins the source (cache or network) into the URL.
describe("source pinning", () => {
  const stubCaches = (has: (url: string) => boolean) =>
    vi.stubGlobal("caches", { open: async () => ({ match: async (u: string) => (has(u) ? {} : undefined) }) });
  afterEach(() => vi.unstubAllGlobals());

  const loadAndReadSrc = async (engine: any, el: HTMLAudioElement) => {
    engine.load({ trackId: 7, duration: 100 }, { autoplay: false, resumeAt: 0 });
    await vi.waitFor(() => { if (!/src=/.test(el.src)) throw new Error("not pinned yet"); });
    return el.src;
  };

  it("pins to the cache when the track is already whole in it", async () => {
    stubCaches(() => true);
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => false });
    const el = (engine as any).elems[0] as HTMLAudioElement;
    vi.spyOn(el, "load").mockImplementation(() => {});
    expect(await loadAndReadSrc(engine, el)).toContain("src=c");
  });

  it("pins to the network when it isn't cached", async () => {
    stubCaches(() => false);
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => false });
    const el = (engine as any).elems[0] as HTMLAudioElement;
    vi.spyOn(el, "load").mockImplementation(() => {});
    expect(await loadAndReadSrc(engine, el)).toContain("src=n");
  });

  // No Cache API (private mode, older WebKit) must still play.
  it("falls back to the network when the Cache API is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => false });
    const el = (engine as any).elems[0] as HTMLAudioElement;
    vi.spyOn(el, "load").mockImplementation(() => {});
    expect(await loadAndReadSrc(engine, el)).toContain("src=n");
  });
});

// A cache pin can go stale: the audio cache is a rolling ring and the entry can be
// evicted mid-load. Chrome then kills the load and treats that URL as bad for the
// rest of the document, even on a new element.
describe("recovery from a dead load", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const cacheStub = (opts: { hit: boolean; puts?: string[] }) =>
    vi.stubGlobal("caches", {
      open: async (name: string) => ({
        match: async () => (opts.hit ? {} : undefined),
        put: async (k: string) => { if (name === "lhm-audio-live") opts.puts?.push(String(k)); },
        keys: async () => [],
        delete: async () => true,
      }),
    });

  async function playing(hit: boolean, puts?: string[]) {
    cacheStub({ hit, puts });
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay: () => true });
    const el = (engine as any).elems[0] as HTMLAudioElement;
    const load = vi.spyOn(el, "load").mockImplementation(() => {});
    vi.spyOn(el, "play").mockImplementation(() => Promise.resolve());
    engine.load({ trackId: 7, duration: 100 }, { autoplay: false, resumeAt: 0 });
    await vi.advanceTimersByTimeAsync(20); // let the pin resolve
    // jsdom never populates .error itself. A real dead pipeline reports code 2 or 4.
    const die = (code = 2) => {
      Object.defineProperty(el, "error", { value: { code }, configurable: true });
      el.dispatchEvent(new Event("error"));
    };
    return { engine, el, load, die };
  }

  it("retries on a url the document has never loaded, not the dead one", async () => {
    const { el, load, die } = await playing(true);
    const dead = el.src;
    expect(dead).toContain("src=c");
    load.mockClear();

    die();
    await vi.advanceTimersByTimeAsync(2000); // backoff, then re-resolve

    expect(el.src).not.toBe(dead);   // re-requesting `dead` would fail again
    expect(el.src).toContain("rl=1");
    expect(load).not.toHaveBeenCalled(); // no load() on the same src
  });

  it("re-decides the source on each attempt, so a stale cache pin heals", async () => {
    const { el, die } = await playing(false); // the entry is gone now
    die();
    await vi.advanceTimersByTimeAsync(2000);
    expect(el.src).toContain("src=n"); // this attempt goes to the network
  });

  it("uses a distinct url for every attempt", async () => {
    const { el, die } = await playing(true);
    const seen = new Set<string>([el.src]);
    for (let i = 0; i < 3; i++) {
      die();
      await vi.advanceTimersByTimeAsync(20000);
      seen.add(el.src);
    }
    expect(seen.size).toBe(4);
  });

  // A plain buffering stall keeps the url, so the browser can resume from what
  // it already has instead of re-downloading.
  it("reuses the url for an ordinary stall, and escalates if that isn't working", async () => {
    const { el } = await playing(true);
    const before = el.src;

    el.dispatchEvent(new Event("waiting"));  // stall, no error
    await vi.advanceTimersByTimeAsync(8000); // watchdog + first backoff
    expect(el.src).toBe(before);             // same address, resumable

    for (let i = 0; i < 3; i++) { el.dispatchEvent(new Event("error")); await vi.advanceTimersByTimeAsync(20000); }
    expect(el.src).toContain("rl=");         // retries that don't land get a fresh one
  });

  it("marks a cache-pinned load live so the worker's eviction spares it", async () => {
    const puts: string[] = [];
    await playing(true, puts);
    expect(puts).toContain("/api/stream/7"); // keyed without the pin, like the cache entry
  });

  it("marks nothing when the load streams from the network", async () => {
    const puts: string[] = [];
    await playing(false, puts);
    expect(puts).toEqual([]);
  });
});

// Characterization tests for transport, gapless, buffering and active-element
// filtering.
describe("WebAudioEngine transport contract", () => {
  const spec = (trackId: number, duration = 100) => ({ trackId, duration });

  // Both elements spied, past the iOS unlock gate.
  function rig(wantsToPlay = () => true) {
    const engine = new WebAudioEngine({ getLiveStreamUrl: (id) => `/api/stream/${id}`, wantsToPlay });
    engine.attach();
    const e = engine as any;
    const [a, b] = e.elems as HTMLAudioElement[];
    const spies = [a, b].map((el) => ({
      el,
      play: vi.spyOn(el, "play").mockImplementation(() => Promise.resolve()),
      pause: vi.spyOn(el, "pause").mockImplementation(() => {}),
      load: vi.spyOn(el, "load").mockImplementation(() => {}),
    }));
    e.audioUnlocked = true;
    const ready = (el: HTMLAudioElement, rs: number) => Object.defineProperty(el, "readyState", { value: rs, configurable: true });
    const dur = (el: HTMLAudioElement, d: number) => Object.defineProperty(el, "duration", { value: d, configurable: true });
    return { engine, e, a, b, A: spies[0], B: spies[1], ready, dur };
  }
  // load()/setUpcoming() resolve the source through an async cache lookup.
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("swaps to the preloaded element instead of reloading, and silences the old one", async () => {
    const { engine, e, a, b, A, B, ready } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    ready(b, 4);
    engine.setUpcoming(spec(2)); await settle();
    B.play.mockClear(); A.pause.mockClear(); B.load.mockClear();

    engine.goToUpcoming(spec(2));

    expect(e.activeIdx).toBe(1);          // idle element promoted
    expect(e.activeSpec.trackId).toBe(2);
    expect(B.play).toHaveBeenCalled();    // played as-is
    expect(B.load).not.toHaveBeenCalled();// not re-fetched
    expect(A.pause).toHaveBeenCalled();
    expect(a.src).toBeTruthy();
  });

  // iOS drives the lock screen from the element the user last interacted with,
  // unless it is muted, so the idle element must stay muted.
  it("keeps only the playing element unmuted, across a gapless handoff", async () => {
    const { engine, a, b, ready } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    expect([a.muted, b.muted]).toEqual([false, true]);
    ready(b, 4);
    engine.setUpcoming(spec(2)); await settle();
    expect(b.muted).toBe(true);           // preloading the next song, silently

    engine.goToUpcoming(spec(2));
    expect([a.muted, b.muted]).toEqual([true, false]);
  });

  // A locked iPhone suspends the page moments after sound stops, so the boundary
  // has to be one synchronous play() on an element that already holds the source.
  it("promotes a preload that is still buffering rather than starting a new load", async () => {
    const { engine, e, b, B, ready } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    ready(b, 1); // HAVE_METADATA: source assigned, not yet playable
    engine.setUpcoming(spec(2)); await settle();
    const srcBefore = b.getAttribute("src");
    B.play.mockClear(); B.load.mockClear();

    engine.goToUpcoming(spec(2));

    expect(e.activeIdx).toBe(1);
    expect(B.play).toHaveBeenCalledTimes(1);
    expect(B.load).not.toHaveBeenCalled();
    expect(b.getAttribute("src")).toBe(srcBefore);
    expect(engine.getPlaybackState().buffering).toBe(true);
    expect(e.recovery.active).toBe(true); // watched until it proves healthy
  });

  it("falls back to a normal load when the standby element's load has failed", async () => {
    const { engine, e, b, ready } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    ready(b, 1);
    engine.setUpcoming(spec(2)); await settle();
    Object.defineProperty(b, "error", { value: { code: 2 }, configurable: true });

    engine.goToUpcoming(spec(2)); await settle();

    expect(e.activeIdx).toBe(0);          // no swap
    expect(e.activeSpec.trackId).toBe(2); // but the track did change
  });

  it("retries a failed preload instead of leaving the boundary to the slow path", async () => {
    vi.useFakeTimers();
    try {
      const { engine, e, b } = rig();
      engine.load(spec(1), { autoplay: true }); await vi.advanceTimersByTimeAsync(0);
      engine.setUpcoming(spec(2)); await vi.advanceTimersByTimeAsync(0);
      expect(e.preloaded).not.toBeNull();

      b.dispatchEvent(new Event("error"));
      expect(e.preloaded).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);

      expect(e.preloaded).toEqual({ trackId: 2, idx: 1 });
      expect(b.getAttribute("src")).toContain("rl="); // an address the document hasn't used
      engine.dispose();
    } finally { vi.useRealTimers(); }
  });

  // Seen on iOS after a track change: not paused, clock at 0:00, silence. No event
  // announces it, so only a clock watchdog can see it.
  it("kicks, then reloads, an element that claims to play while its clock is frozen", async () => {
    vi.useFakeTimers();
    try {
      const { engine, a, b, A, B, ready } = rig();
      engine.load(spec(1), { autoplay: true }); await vi.advanceTimersByTimeAsync(0);
      ready(b, 4);
      engine.setUpcoming(spec(2)); await vi.advanceTimersByTimeAsync(0);
      engine.goToUpcoming(spec(2));
      Object.defineProperty(b, "paused", { value: false, configurable: true });
      const srcBefore = b.getAttribute("src");
      B.play.mockClear(); B.pause.mockClear(); A.play.mockClear();

      await vi.advanceTimersByTimeAsync(3100);          // clock never moved
      expect(B.pause).toHaveBeenCalled();
      expect(B.play).toHaveBeenCalledTimes(1);           // the nudge
      expect(b.getAttribute("src")).toBe(srcBefore);

      await vi.advanceTimersByTimeAsync(3100);          // still frozen
      expect(b.getAttribute("src")).not.toBe(srcBefore); // started over on a fresh address
      expect(b.getAttribute("src")).toContain("rl=");
      expect(A.play).not.toHaveBeenCalled();             // the old element was left alone
      expect(a.getAttribute("src")).not.toContain("rl=");
      engine.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("leaves a healthy element alone", async () => {
    vi.useFakeTimers();
    try {
      const { engine, a, A, ready } = rig();
      ready(a, 4);
      engine.load(spec(1), { autoplay: true }); await vi.advanceTimersByTimeAsync(0);
      Object.defineProperty(a, "paused", { value: false, configurable: true });
      const src = a.getAttribute("src");
      A.pause.mockClear();
      for (let t = 1; t <= 10; t++) {
        Object.defineProperty(a, "currentTime", { value: t, writable: true, configurable: true });
        a.dispatchEvent(new Event("timeupdate"));
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(A.pause).not.toHaveBeenCalled();
      expect(a.getAttribute("src")).toBe(src);
      engine.dispose();
    } finally { vi.useRealTimers(); }
  });

  // Restored queue, paused long enough for the next track to preload, then Play:
  // the standby element holds a source but was never unlocked.
  it("unlocks a standby element that was preloaded before the first gesture, then preloads again", async () => {
    const { engine, e, b, B } = rig();
    engine.load(spec(1), { autoplay: false }); await settle();   // restored, paused
    engine.setUpcoming(spec(2)); await settle();                 // preloaded with no gesture yet
    expect(b.getAttribute("src")).toContain("/api/stream/2");
    const made = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unlock");
    B.play.mockClear();

    engine.play();                                               // the first gesture
    expect(b.getAttribute("src")).toBe("blob:unlock");           // silent unlock clip, not the song
    expect(B.play).toHaveBeenCalledTimes(1);
    await settle(); await settle();

    expect(e.primed.has(b)).toBe(true);
    expect(b.getAttribute("src")).toContain("/api/stream/2");    // preload restored
    expect(e.preloaded).toEqual({ trackId: 2, idx: 1 });
    made.mockRestore();
  });

  it("resumes a stream that was cut off instead of skipping the rest of the song", async () => {
    const { engine, e, a, A } = rig();
    engine.load(spec(1, 200), { autoplay: true }); await settle();
    let ended = 0;
    engine.on("ended", () => { ended++; });
    Object.defineProperty(a, "currentTime", { value: 70, writable: true, configurable: true });
    a.dispatchEvent(new Event("timeupdate"));
    A.play.mockClear();

    a.dispatchEvent(new Event("ended")); await settle();

    expect(ended).toBe(0);                          // the queue did not advance
    expect(a.getAttribute("src")).toContain("rl="); // reloaded from a fresh address
    expect(engine.getCurrentTime()).toBe(70);       // at the point it stopped
    expect(A.play).toHaveBeenCalled();

    // Same track cuts out again: it really is that short, let it end.
    a.dispatchEvent(new Event("ended"));
    expect(ended).toBe(1);
    expect(e.earlyEndSeen.has(1)).toBe(true);
  });

  it("advances on an early end while hidden, where a reload could not complete", async () => {
    const { engine, a } = rig();
    engine.load(spec(1, 200), { autoplay: true }); await settle();
    let ended = 0;
    engine.on("ended", () => { ended++; });
    Object.defineProperty(a, "currentTime", { value: 70, writable: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      a.dispatchEvent(new Event("ended"));
      expect(ended).toBe(1);
    } finally { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); }
  });

  it("clearing the upcoming track tears the idle element down", async () => {
    const { engine, e, b, B } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    engine.setUpcoming(spec(2)); await settle();
    expect(e.preloaded).not.toBeNull();

    engine.setUpcoming(null);

    expect(e.preloaded).toBeNull();
    expect(e.upcomingSpec).toBeNull();
    expect(B.pause).toHaveBeenCalled();
    expect(b.getAttribute("src")).toBeNull();
  });

  it("re-arming the same upcoming track does not re-buffer it", async () => {
    const { engine, e } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    engine.setUpcoming(spec(2)); await settle();
    const gen = e.preloadGen;

    engine.setUpcoming(spec(2)); await settle();

    expect(e.preloadGen).toBe(gen); // no second load into the idle element
  });

  it("reports the natural end so the provider can clear intent at a held boundary", async () => {
    const { engine, a } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    let ended = 0;
    engine.on("ended", () => { ended++; });
    Object.defineProperty(a, "currentTime", { value: 100, writable: true, configurable: true }); // played to its end

    a.dispatchEvent(new Event("ended"));
    expect(ended).toBe(1);

    engine.setHold(true);
    a.dispatchEvent(new Event("ended"));
    expect(ended).toBe(2); // still reported under hold, the provider decides not to advance
  });

  it("tracks buffering state from the element's own stall/resume events", async () => {
    const { engine, a } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    expect(engine.getPlaybackState().buffering).toBe(true); // loading the new src

    a.dispatchEvent(new Event("playing"));
    expect(engine.getPlaybackState().buffering).toBe(false);
    a.dispatchEvent(new Event("waiting"));
    expect(engine.getPlaybackState().buffering).toBe(true);
    a.dispatchEvent(new Event("canplay"));
    expect(engine.getPlaybackState().buffering).toBe(false);
  });

  it("publishes only on an actual change, not on every element event", async () => {
    const { engine, a } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    let emissions = 0;
    engine.on("state", () => { emissions++; });

    a.dispatchEvent(new Event("waiting"));  // buffering is already true from the load
    a.dispatchEvent(new Event("waiting"));
    a.dispatchEvent(new Event("timeupdate")); // clock hasn't moved in jsdom
    expect(emissions).toBe(0);

    a.dispatchEvent(new Event("playing"));  // this one changes something
    expect(emissions).toBe(1);
  });

  // The snapshot is derived, so a consumer that missed an event still converges.
  it("re-derives 'playing' from the element, so a missed event self-corrects", async () => {
    const { engine, a } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    expect(engine.getPlaybackState().playing).toBe(false); // jsdom: play() is stubbed

    // The element starts playing without an event.
    Object.defineProperty(a, "paused", { value: false, configurable: true });
    expect(engine.getPlaybackState().playing).toBe(true);

    // The next publish carries the corrected value.
    const seen: boolean[] = [];
    engine.on("state", (st) => seen.push(st.playing));
    Object.defineProperty(a, "currentTime", { value: 5, configurable: true });
    a.dispatchEvent(new Event("timeupdate"));
    expect(seen.at(-1)).toBe(true);
  });

  it("ignores events from the element that is not active", async () => {
    const { engine, e, b, dur } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    const times: number[] = [];
    const durs: number[] = [];
    engine.on("state", (st) => { times.push(st.currentTime); durs.push(st.duration); });

    Object.defineProperty(b, "currentTime", { value: 42, configurable: true });
    dur(b, 999);
    b.dispatchEvent(new Event("timeupdate"));
    b.dispatchEvent(new Event("durationchange"));

    expect(times).not.toContain(42);
    expect(durs).not.toContain(999);
    expect(e.activeIdx).toBe(0);
  });

  it("falls back to the track's known duration when the container won't report one", async () => {
    const { engine, a, dur } = rig();
    engine.load(spec(1, 210), { autoplay: true }); await settle();
    dur(a, NaN); // fragmented MP4 before it is fully buffered
    expect(engine.getDuration()).toBe(210);
    dur(a, 205);
    expect(engine.getDuration()).toBe(205); // the real one wins once it exists
  });

  it("folds loudness normalization into volume without the user losing the slider", () => {
    const { engine, a, b } = rig();
    engine.setVolume(0.8);
    expect(a.volume).toBeCloseTo(0.8);
    engine.setNormalization(0.5);
    expect(a.volume).toBeCloseTo(0.4); // 0.8 * 0.5
    expect(b.volume).toBeCloseTo(0.4); // both elements, so a swap keeps the level
    engine.setNormalization(1);
    expect(a.volume).toBeCloseTo(0.8); // restored
  });

  it("applies playback rate and pitch policy to both elements", () => {
    const { engine, a, b } = rig();
    engine.setPlaybackRate(1.25, false);
    for (const el of [a, b]) {
      expect(el.playbackRate).toBe(1.25);
      expect((el as any).preservesPitch).toBe(false);
    }
  });

  // PlayerProvider relies on these two publishes at the end of a queue and on
  // stop. Without them the UI keeps showing the old track as playing.
  it("publishes the stopped state at the natural end of a track", async () => {
    const { engine, a } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    Object.defineProperty(a, "paused", { value: false, configurable: true });
    a.dispatchEvent(new Event("timeupdate"));
    expect(engine.getPlaybackState().playing).toBe(true);

    const seen: boolean[] = [];
    engine.on("state", (st) => seen.push(st.playing));
    Object.defineProperty(a, "ended", { value: true, configurable: true });
    a.dispatchEvent(new Event("ended"));

    expect(seen.at(-1)).toBe(false);
  });

  it("publishes the cleared state on stop(), even with nothing playing", async () => {
    const { engine } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    const seen: import("./types").PlaybackState[] = [];
    engine.on("state", (st) => seen.push(st));

    engine.stop(); // pausing an already-paused element fires no event

    const last = seen.at(-1)!;
    expect(last).toBeDefined();
    expect(last.trackId).toBeNull();
    expect(last.playing).toBe(false);
    expect(last.currentTime).toBe(0);
    expect(last.duration).toBe(0);
    expect(last.buffering).toBe(false);
  });

  it("stop() leaves no active track and no sound anywhere", async () => {
    const { engine, e, a, b, A, B } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    engine.setUpcoming(spec(2)); await settle();

    engine.stop();

    expect(e.activeSpec).toBeNull();
    expect(e.upcomingSpec).toBeNull();
    expect(e.preloaded).toBeNull();
    expect(A.pause).toHaveBeenCalled();
    expect(B.pause).toHaveBeenCalled();
    expect(a.getAttribute("src")).toBeNull();
    expect(b.getAttribute("src")).toBeNull();
  });

  it("reconnects a live radio stream without seeking it", () => {
    vi.useFakeTimers();
    try {
      const { engine, e, a, A } = rig();
      engine.load({ trackId: 9, url: "http://radio.example/stream", isLive: true }, { autoplay: true });
      Object.defineProperty(a, "currentTime", { value: 30, writable: true, configurable: true });
      A.load.mockClear();

      a.dispatchEvent(new Event("error"));
      vi.advanceTimersByTime(2000); // let recovery take its shot

      expect(A.load).toHaveBeenCalled();  // reconnected
      expect(e.pendingSeek).toBeNull();   // but never seeked: that breaks a live stream
    } finally { vi.useRealTimers(); }
  });

  it("resumes as soon as the network comes back rather than waiting out the backoff", async () => {
    const { engine, a } = rig();
    engine.load(spec(1), { autoplay: true }); await settle();
    const seen: boolean[] = [];
    engine.on("state", (st) => seen.push(st.reconnecting));

    a.dispatchEvent(new Event("error"));
    expect(seen.at(-1)).toBe(true); // badge on, backoff armed

    Object.defineProperty(a, "paused", { value: true, configurable: true });
    window.dispatchEvent(new Event("online"));

    expect(seen).toContain(false); // cleared when connectivity returns
  });
});

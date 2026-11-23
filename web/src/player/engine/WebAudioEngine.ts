// The web AudioEngine: two <audio> elements playing progressive HTTP streams, with
// gapless dual-element swaps, an optional Web Audio crossfade graph, and
// auto-resume after transient network drops.
// No React, no api calls, no Connect knowledge. It emits events and PlayerProvider
// maps them to state. The provider pauses the engine when audio goes remote.

import { resolveTrackSource, isIOS } from "./source";
import { StallRecovery } from "./recovery";
import { AudioGraph } from "./audioGraph";
import { dlog } from "../../ui/debugLog";
import type {
  AudioEngine,
  AudioEngineEvent,
  AudioEngineEvents,
  AudioDiag,
  BufferedRange,
  LoadOptions,
  PlaybackState,
  TrackSpec,
} from "./types";

function sameRanges(a: BufferedRange[], b: BufferedRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}

// Silent WAV (1 sample, 8-bit mono), played on the second element inside the first
// user gesture. WebKit blocks the first programmatic play() of each media element
// until a gesture has played it, which would block the gapless swap.
const SILENT_WAV_BYTES = new Uint8Array([
  0x52,0x49,0x46,0x46,0x25,0x00,0x00,0x00,0x57,0x41,0x56,0x45,0x66,0x6D,0x74,0x20,
  0x10,0x00,0x00,0x00,0x01,0x00,0x01,0x00,0x40,0x1F,0x00,0x00,0x40,0x1F,0x00,0x00,
  0x01,0x00,0x08,0x00,0x64,0x61,0x74,0x61,0x01,0x00,0x00,0x00,0x80,
]);

export interface WebAudioEngineDeps {
  // Stream URL for a track at the current quality setting. Prefetch, playback and
  // preload all use it so they share one service-worker cache entry.
  getLiveStreamUrl(trackId: number): string;
  // Playback intent ("this device means to be playing"), owned by the provider.
  // The engine only reads it, to decide whether to keep resuming a stalled stream.
  wantsToPlay(): boolean;
}

export class WebAudioEngine implements AudioEngine {
  // Two audio elements for gapless transitions: the next track is preloaded into
  // the idle element while the active one plays, then they swap.
  // Used on iOS too: a single element can't start loading the next track until
  // `ended`, which breaks queue advance in the background.
  private elems: HTMLAudioElement[];
  private activeIdx = 0;
  // Video podcasts: one <video> element driven in place of the audio elements when
  // the active spec is video. The UI mounts it to show the picture.
  private videoEl: HTMLVideoElement | null = null;
  private videoHolder: HTMLDivElement | null = null;
  private usingVideo = false;
  private get active(): HTMLMediaElement { return this.usingVideo && this.videoEl ? this.videoEl : this.elems[this.activeIdx]; }

  private crossfadeSec = 0;
  private held = false;

  // Per-element blob: URLs (downloads), revoked independently.
  private objUrls: (string | null)[] = [null, null];

  // Auto-resume. The retry/backoff rules live in StallRecovery.
  private recovery: StallRecovery;
  private lastTime = 0;       // last good position (errors can zero currentTime)
  private lastReload = 0;
  private positionTarget: number | null = null;
  private pendingSeek: (() => void) | null = null;

  // Smooth-start gate + iOS unlock.
  private startGate: null | (() => void) = null;

  // Async-load generation guards (rapid skips / swaps).
  private loadGen = 0;
  private preloadGen = 0;
  private preloaded: { trackId: number; idx: number } | null = null;

  // What each element is playing/preloading, so durationchange can fall back to
  // the DB duration and setUpcoming is idempotent.
  private activeSpec: TrackSpec | null = null;
  private upcomingSpec: TrackSpec | null = null;

  // Skip-latency stopwatch (tap/next to 'playing').
  private skipT0: number | null = null;
  private skipMs = 0;

  // Optional Web Audio graph (visualizer + crossfade). Absent on touch devices and
  // wherever an AudioContext can't be built, so every use has a fallback.
  private graph: AudioGraph;
  private vol = 1;
  private crossfading = false;
  private crossfadeTimer?: number;
  private disposed = false;
  private attached = false;
  private resolving = false;
  private playRequested = false;
  private playbackError: string | null = null;
  private priming = new Set<HTMLMediaElement>();
  private primed = new WeakSet<HTMLMediaElement>();
  // Frozen-clock watchdog: not paused, not ended, no error, no `waiting` event, but
  // the clock is not moving. No media event announces that state (seen on iOS
  // after a track change).
  private progressAt = 0;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private kicked = false;
  // A failed preload is retried a few times. Without a preloaded element the track
  // boundary needs a full async load, which a locked iPhone suspends before it plays.
  private preloadRetries = 0;
  private preloadRetryTimer?: ReturnType<typeof setTimeout>;
  // Tracks that already "ended" well short of their length this session, so a file
  // with a wrong stored duration only pays for the check once.
  private earlyEndSeen = new Set<number>();

  // The only state that is remembered, not read off the element at publish time.
  private buffering = false;
  private reconnecting = false;
  private published: PlaybackState | null = null;

  private listeners: { [E in AudioEngineEvent]?: Set<AudioEngineEvents[E]> } = {};

  private deps: WebAudioEngineDeps;

  constructor(deps: WebAudioEngineDeps) {
    this.deps = deps;
    this.recovery = new StallRecovery({
      active: () => this.active ?? null,
      wantsToPlay: () => this.deps.wantsToPlay(),
      reload: (fresh) => this.reloadActive(fresh),
      setReconnecting: (on) => { this.reconnecting = on; this.publish(); },
      onFatal: () => {
        this.playbackError = "This audio could not be played. Tap Play to retry.";
        this.buffering = false; this.publish();
      },
    });
    this.elems = typeof Audio !== "undefined"
      ? [new Audio(), new Audio()]
      : [({} as HTMLAudioElement), ({} as HTMLAudioElement)];
    for (const el of this.elems) { try { el.preload = "auto"; } catch { /* */ } }
    this.syncMute();
    this.graph = new AudioGraph(this.elems);
    this.bindElementEvents("addEventListener");
  }

  attach(): void {
    if (this.attached || this.disposed) return;
    this.attached = true;
    dlog("audio transport=dual");
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
    // Mobile browsers suspend the AudioContext while the PWA is backgrounded, which
    // stops playback once audio runs through the graph. Resume it on foreground.
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (this.graph.suspended) this.graph.resume();
    dlog(`audio foreground track=${this.activeSpec?.trackId ?? "none"} paused=${this.active.paused} ready=${this.active.readyState}`);
    // Force a re-read: media events may not have been delivered while backgrounded.
    this.published = null;
    this.publish();
    if (this.playRequested && this.deps.wantsToPlay() && !this.resolving) {
      if (this.active.paused) this.playAudio(this.active);
      else if (this.active.error || (this.active.readyState < 3 && this.recovery.stalledFor() > 3000)) {
        // Retry timers don't run in the background, so reload now and skip the
        // paced retry ladder.
        dlog(`audio foreground reload track=${this.activeSpec?.trackId}`);
        this.recovery.clear();
        this.reloadActive(true);
        this.recovery.onStall();
      } else if (this.active.readyState < 3) this.recovery.onOnline();
      else this.checkProgress(); // timers don't run in the background, so check now
    }
  };

  on<E extends AudioEngineEvent>(event: E, handler: AudioEngineEvents[E]): void {
    (this.listeners[event] ??= new Set() as any).add(handler);
  }
  off<E extends AudioEngineEvent>(event: E, handler: AudioEngineEvents[E]): void {
    this.listeners[event]?.delete(handler);
  }
  private emit<E extends AudioEngineEvent>(event: E, ...args: Parameters<AudioEngineEvents[E]>): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) (fn as (...a: any[]) => void)(...args);
  }

  // Only the active element is unmuted (plus the outgoing one during a crossfade).
  // WebKit picks the element that drives the iOS lock screen by most recent user
  // interaction, not by which is playing, but never picks a muted one.
  private syncMute(): void {
    this.elems.forEach((el, i) => {
      const audible = i === this.activeIdx || this.crossfading;
      try { if (el.muted === audible) el.muted = !audible; } catch { /* */ }
    });
  }

  // Re-reads the active element and emits if anything changed. A full re-read, so
  // a missed or out-of-order media event corrects itself on the next call.
  private publish(): void {
    const next = this.snapshot();
    const prev = this.published;
    if (prev
      && prev.trackId === next.trackId
      && prev.playing === next.playing
      && prev.error === next.error
      && prev.buffering === next.buffering
      && prev.reconnecting === next.reconnecting
      && prev.positionPending === next.positionPending
      && prev.currentTime === next.currentTime
      && prev.duration === next.duration
      && sameRanges(prev.buffered, next.buffered)) return;
    this.published = next;
    this.emit("state", next);
  }
  private snapshot(): PlaybackState {
    const a = this.active as HTMLMediaElement | undefined;
    return {
      trackId: this.activeSpec?.trackId ?? null,
      error: this.playbackError,
      playing: !!a && !this.resolving && !this.priming.has(a) && !a.paused && !a.ended,
      buffering: this.buffering,
      reconnecting: this.reconnecting,
      currentTime: this.getCurrentTime(),
      positionPending: this.positionTarget !== null,
      duration: a ? this.resolveDuration(a as HTMLAudioElement) : 0,
      buffered: a ? this.bufferedOf(a as HTMLAudioElement) : [],
    };
  }
  getPlaybackState(): PlaybackState { return this.snapshot(); }
  private setBuffering(on: boolean): void { this.buffering = on; this.publish(); }

  // Per-track loudness-normalization multiplier (0..1, attenuate only), folded into
  // the effective volume.
  private normFactor = 1;
  private effVol() { return this.vol * this.normFactor; }
  private applyVolumeBoth(v: number) {
    this.vol = v;
    const e = this.effVol();
    // With a graph, volume is a master gain after the analyser tap, so visualizers
    // see full-scale signal. Without one, element volume is the only control.
    if (!this.graph.setMaster(e)) {
      for (const el of this.elems) { try { el.volume = e; } catch { /* */ } }
    }
    // The video element is never in the Web Audio graph.
    if (this.videoEl) { try { this.videoEl.volume = e; } catch { /* */ } }
  }
  setVolume(v: number): void { this.applyVolumeBoth(v); }
  setNormalization(factor: number): void {
    this.normFactor = Math.max(0, Math.min(1, isFinite(factor) ? factor : 1));
    this.applyVolumeBoth(this.vol);
  }

  // Playback speed, applied to both elements so a preloaded next track keeps it.
  // preservesPitch=true time-stretches (podcasts), false lets pitch follow the rate.
  // Setting src resets an element's rate to 1, so finishLoad re-applies this.rate.
  private rate = 1;
  private preservePitch = true;
  setPlaybackRate(r: number, preservePitch = true): void {
    this.rate = r;
    this.preservePitch = preservePitch;
    for (const el of this.elems) { try { el.preservesPitch = preservePitch; el.playbackRate = r; } catch { /* */ } }
    if (this.videoEl) { try { this.videoEl.preservesPitch = preservePitch; this.videoEl.playbackRate = r; } catch { /* */ } }
  }

  // Reverb wet mix. Needs the graph, so it is a no-op on touch devices.
  setReverb(wet: number): void { this.graph.setReverb(wet, this.effVol()); }

  private revokeObjUrl(idx: number) {
    const u = this.objUrls[idx];
    if (u) { try { URL.revokeObjectURL(u); } catch { /* */ } this.objUrls[idx] = null; }
  }
  private resetElementSource(idx: number) { this.revokeObjUrl(idx); }

  // Resume-seek that survives a src change or reload.
  private clearPendingSeek() { this.pendingSeek?.(); this.pendingSeek = null; }
  private seekOnMeta(audio: HTMLAudioElement, at: number) {
    this.clearPendingSeek();
    this.positionTarget = at;
    this.lastTime = at;
    const apply = () => { try { audio.currentTime = at; } catch { /* wait for metadata */ } };
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("seeked", onSeeked);
      if (this.pendingSeek === cleanup) this.pendingSeek = null;
    };
    const finish = () => {
      if (this.pendingSeek !== cleanup || audio !== this.active || audio.readyState < 1 || audio.seeking || Math.abs(audio.currentTime - at) > 1.5) return;
      cleanup();
      this.positionTarget = null;
      this.lastTime = audio.currentTime;
      dlog(`audio seek confirmed track=${this.activeSpec?.trackId} at=${audio.currentTime.toFixed(2)}`);
      this.publish();
    };
    const onMeta = () => apply();
    const onSeeked = () => finish();
    const onCanPlay = () => {
      // A seek issued at loadedmetadata can be dropped until data is seekable, so
      // re-apply here and keep the target until the browser accepts it.
      if (Math.abs(audio.currentTime - at) > 1.5) apply();
      finish();
    };
    this.pendingSeek = cleanup;
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("seeked", onSeeked);
    if (audio.readyState >= 1) { apply(); if (audio.readyState >= 3) finish(); }
  }
  // A URL the browser has failed can't be revived at the same address, so a fresh
  // reload gets its own URL (see source.pinnedSrc).
  private reloadToken = 0;

  /**
   * Reload the active source and resume where it left off.
   * `fresh` uses a never-before-used URL, for a load that failed rather than
   * stalled (re-downloads from the resume point). `force` skips the debounce.
   */
  private reloadActive(fresh: boolean, force = true) {
    const audio = this.active as HTMLAudioElement | null;
    if (!audio?.src) return;
    const now = Date.now();
    if (!force && now - this.lastReload < 2500) return;
    this.lastReload = now;
    dlog(`audio retry track=${this.activeSpec?.trackId} fresh=${fresh}`);
    // Live radio reconnects but must never seek: seeking a live stream breaks it.
    if (this.activeSpec?.isLive) {
      try { audio.load(); } catch { /* */ }
      if (this.deps.wantsToPlay() && this.playRequested) this.safePlay(audio);
      return;
    }
    if (!fresh && !audio.error && !audio.paused && audio.readyState < 3) {
      // Leave an in-progress download (e.g. a cold server transcode) alone. The
      // watchdog escalates to a fresh source if it makes no progress.
      if (this.playRequested && this.deps.wantsToPlay()) this.safePlay(audio);
      return;
    }
    const at = this.getCurrentTime() || this.lastTime || 0;
    const spec = this.activeSpec;
    // A direct URL (podcast enclosure) has nothing to re-resolve.
    if (!spec || spec.url) {
      this.positionTarget = at;
      try { audio.load(); } catch { /* */ }
      this.seekOnMeta(audio, at);
      if (this.deps.wantsToPlay() && this.playRequested) this.safePlay(audio);
      return;
    }
    // A library track: resolve the source again instead of reloading the old URL.
    // The cache pin may be stale (entry evicted, the worker answers 504).
    const gen = ++this.loadGen;
    const url = this.deps.getLiveStreamUrl(spec.trackId);
    const apply = ({ src, blob }: { src: string; blob: boolean }) => {
      if (gen !== this.loadGen || audio !== this.active || this.disposed) {
        if (blob) URL.revokeObjectURL(src);
        return;
      } // a newer load won
      // Not applySrc(): that clears the recovery backoff and zeroes lastTime, and a
      // recovery has to keep both.
      this.positionTarget = at;
      this.clearStartGate();
      this.clearPendingSeek();
      this.resetElementSource(Math.max(0, this.elems.indexOf(audio)));
      if (blob) this.objUrls[Math.max(0, this.elems.indexOf(audio))] = src;
      audio.src = src;
      try { audio.preservesPitch = this.preservePitch; audio.playbackRate = this.rate; } catch { /* */ }
      this.seekOnMeta(audio, at);
      if (this.deps.wantsToPlay() && this.playRequested) this.safePlay(audio);
    };
    resolveTrackSource(spec.trackId, url, fresh ? ++this.reloadToken : 0).then(apply).catch(() => apply({ src: url, blob: false }));
  }
  private playAudio(audio: HTMLAudioElement) {
    // Play on an errored element: reload it first. Debounced, since it is user-driven.
    if (audio.error && audio === this.active) this.reloadActive(true, false);
    this.safePlay(audio);
  }


  private watchProgress() {
    this.progressAt = Date.now();
    this.kicked = false;
    this.armProgressCheck();
  }
  private armProgressCheck() {
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => { this.progressTimer = undefined; this.checkProgress(); }, 3000);
  }
  private clearProgressWatch() { clearTimeout(this.progressTimer); this.progressTimer = undefined; }
  private checkProgress() {
    if (this.disposed || !this.playRequested || !this.deps.wantsToPlay() || this.resolving) return;
    const a = this.active;
    if (!a || a.paused || a.ended || this.priming.has(a)) return;
    // Buffering and errors are StallRecovery's job. This is for the silent case.
    if (a.error || a.readyState < 3 || this.recovery.active) { this.armProgressCheck(); return; }
    if (a.seeking || Date.now() - this.progressAt < 2500) { this.armProgressCheck(); return; }
    if (!this.kicked) {
      // First try: pause, then play.
      this.kicked = true;
      dlog(`audio frozen track=${this.activeSpec?.trackId} at=${(a.currentTime || 0).toFixed(1)} ready=${a.readyState} net=${a.networkState} muted=${a.muted} kick`);
      try { a.pause(); } catch { /* */ }
      this.safePlay(a);
      this.progressAt = Date.now();
      this.armProgressCheck();
      return;
    }
    // Still frozen: reload at the current position.
    dlog(`audio frozen track=${this.activeSpec?.trackId} reload`);
    this.kicked = false;
    this.lastTime = Math.max(this.lastTime, a.currentTime || 0);
    this.reloadActive(true);
    this.progressAt = Date.now();
    this.armProgressCheck();
  }

  private clearStartGate() { if (this.startGate) { this.startGate(); this.startGate = null; } }
  private safePlay(audio: HTMLMediaElement) {
    const gen = this.loadGen;
    try {
      const result = audio.play();
      result?.then(() => {
        // An element that has played is unlocked. Mark it, so unlockElements does
        // not discard its preload later to unlock it again.
        this.primed.add(audio);
        if (this.disposed || gen !== this.loadGen || audio !== this.active) return;
        this.playbackError = null;
        this.publish();
      }).catch((error: Error) => {
        if (this.disposed || gen !== this.loadGen || audio !== this.active || error.name === "AbortError") return;
        dlog(`audio play rejected track=${this.activeSpec?.trackId} ${error.name}`);
        this.playbackError = error.name === "NotAllowedError"
          ? "Tap Play to resume audio."
          : "Audio could not start. Tap Play to retry.";
        this.buffering = false;
        if (error.name === "NotAllowedError") this.recovery.clear();
        else this.recovery.onError();
        this.publish();
      });
    } catch { /* media API unavailable */ }
  }

  private smoothStart(audio: HTMLAudioElement) {
    if (audio !== this.active || this.disposed || !this.playRequested || !this.deps.wantsToPlay()) return;
    // play() itself waits for playable data. Waiting for canplay first would lose
    // the user activation.
    this.safePlay(audio);
    this.recovery.onStall();
    this.watchProgress();
  }

  unlock(): void {
    if (this.disposed) return;
    this.unlockElements();
    if (this.crossfadeSec > 0) this.graph.ensure(this.effVol());
    this.graph.resume();
  }

  private unlockElements() {
    // Must run synchronously inside the user gesture, before any await.
    for (const el of this.elems) {
      if (this.primed.has(el) || this.priming.has(el)) continue;
      // The spec to preload again once this element has been unlocked.
      let rearm: TrackSpec | null = null;
      if (el.getAttribute("src")) {
        if (el === this.active || !el.paused) continue;
        // The standby element got its preload before the first gesture (restored
        // queue), so iOS has never unlocked it. Drop the preload, unlock, then
        // preload again.
        const idx = this.elems.indexOf(el);
        rearm = this.upcomingSpec;
        this.preloaded = null; this.preloadGen++;
        this.resetElementSource(idx);
        try { el.removeAttribute("src"); el.load(); } catch { /* */ }
      }
      let url: string;
      try { url = URL.createObjectURL(new Blob([SILENT_WAV_BYTES], { type: "audio/wav" })); }
      catch { continue; }
      this.priming.add(el);
      const done = (ok: boolean) => {
        if (ok) this.primed.add(el);
        this.syncMute();
        // The real source may already have replaced the silent WAV.
        if (el.getAttribute("src") === url) {
          try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* */ }
        }
        this.priming.delete(el);
        URL.revokeObjectURL(url);
        if (rearm && !this.disposed && !this.crossfading && !this.preloaded && this.upcomingSpec === rearm && el === this.elems[1 - this.activeIdx] && !el.getAttribute("src")) {
          dlog(`audio re-preload after unlock track=${rearm.trackId}`);
          this.loadIntoIdle(rearm);
        }
      };
      try {
        el.src = url;
        // Unmuted so the gesture unlocks the element. done() restores the mute.
        el.muted = false;
        const result = el.play();
        if (result?.then) result.then(() => done(true), () => done(false));
        else done(false);
      } catch { done(false); }
    }
  }

  private beginLoad(ai: number) {
    this.clearStartGate();   // a new src cancels any pending smooth-start on the old one
    this.clearPendingSeek(); // and any pending resume-seek from the previous track
    this.recovery.clear();       // and stall-recovery armed for the previous track
    this.lastTime = 0;       // the old track's position must not leak into this one
    this.resetElementSource(ai);
    this.playbackError = null;
  }
  private finishLoad(audio: HTMLAudioElement, resumeAt: number, autoplay: boolean) {
    try { audio.preservesPitch = this.preservePitch; audio.playbackRate = this.rate; } catch { /* */ } // setting src resets the rate
    if (this.activeSpec?.isLive) this.positionTarget = null;
    else this.seekOnMeta(audio, this.positionTarget ?? resumeAt);
    if (autoplay) this.smoothStart(audio); else { try { audio.pause(); } catch { /* */ } }
  }
  private applySrc(audio: HTMLAudioElement, src: string, resumeAt: number, autoplay: boolean) {
    // Index of the element being loaded, not this.activeIdx: a gapless swap may
    // have moved activeIdx while the async cache lookup was in flight.
    const ai = Math.max(0, this.elems.indexOf(audio));
    this.beginLoad(ai);
    if (src.startsWith("blob:")) this.objUrls[ai] = src;
    this.priming.delete(audio);
    audio.src = src;
    this.finishLoad(audio, resumeAt, autoplay);
  }
  // Resolve a track to a playable src and start it. Resolution is async (it reads
  // the caches), so a generation guard drops the result if a newer load or a
  // gapless swap has taken over.
  private loadTrackSrc(audio: HTMLAudioElement, trackId: number, resumeAt: number, autoplay: boolean) {
    if (autoplay) {
      this.skipT0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      this.setBuffering(true); // loading state until the new src plays
    }
    this.resolving = true;
    const gen = ++this.loadGen;
    resolveTrackSource(trackId, this.deps.getLiveStreamUrl(trackId)).then(({ src, blob }) => {
      if (gen !== this.loadGen) { if (blob) { try { URL.revokeObjectURL(src); } catch { /* */ } } return; }
      this.resolving = false;
      this.applySrc(audio, src, resumeAt, this.playRequested && this.deps.wantsToPlay());
    }).catch(() => { /* resolveTrackSource always resolves; nothing to fall back to */ });
  }

  load(spec: TrackSpec, opts: LoadOptions): void {
    if (this.disposed) return;
    this.positionTarget = Math.max(0, opts.resumeAt ?? 0);
    this.cancelCrossfade();
    this.clearStartGate();
    this.clearPendingSeek();
    this.recovery.clear();
    this.playRequested = opts.autoplay;
    this.playbackError = null;
    this.resolving = false;
    if (opts.autoplay) this.unlock();
    if (!this.priming.has(this.active)) { try { this.active.pause(); } catch { /* */ } }
    dlog(`audio load track=${spec.trackId} autoplay=${opts.autoplay}`);
    // Video podcast: drive the <video> element.
    if (spec.isVideo && spec.url) { this.activeSpec = spec; this.loadVideo(spec.url, opts); return; }
    if (this.usingVideo) this.teardownVideo(); // returning to audio
    const audio = this.elems[this.activeIdx];
    if (!audio) return;
    this.activeSpec = spec;
    // Direct URL: live radio never seeks, a podcast enclosure honours resumeAt.
    if (spec.url) { this.playDirectUrl(audio, spec.url, opts.autoplay, spec.isLive ? 0 : (opts.resumeAt ?? 0)); return; }
    this.loadTrackSrc(audio, spec.trackId, opts.resumeAt ?? 0, opts.autoplay);
  }

  getVideoElement(): HTMLVideoElement | null { return this.ensureVideoEl(); }
  // Return the element to its offscreen holder. The UI calls this when the view
  // showing it unmounts, so playback survives leaving Now Playing.
  homeVideo(): void {
    if (this.videoEl && this.videoHolder && this.videoEl.parentElement !== this.videoHolder) {
      this.videoHolder.appendChild(this.videoEl);
    }
  }

  private ensureVideoEl(): HTMLVideoElement | null {
    if (this.videoEl || typeof document === "undefined") return this.videoEl;
    // Lives offscreen by default so audio keeps playing when Now Playing is closed.
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;";
    const v = document.createElement("video");
    v.preload = "auto"; v.playsInline = true; v.setAttribute("playsinline", "");
    v.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;display:block;";
    holder.appendChild(v);
    document.body.appendChild(holder);
    this.videoHolder = holder; this.videoEl = v;
    this.bindEventsOn(v, "addEventListener");
    return v;
  }

  private loadVideo(url: string, opts: LoadOptions): void {
    for (const el of this.elems) { try { el.pause(); } catch { /* */ } } // silence any audio path
    const v = this.ensureVideoEl();
    if (!v) return;
    this.usingVideo = true;
    this.clearPendingSeek();
    this.lastTime = 0;
    ++this.loadGen;
    this.recovery.clear();
    if (opts.autoplay) { this.skipT0 = (typeof performance !== "undefined" ? performance.now() : Date.now()); this.setBuffering(true); }
    // Video is never in the Web Audio graph, so normalization goes on element
    // volume and reverb does not apply.
    try { v.preservesPitch = this.preservePitch; v.playbackRate = this.rate; v.volume = this.effVol(); } catch { /* */ }
    if (v.getAttribute("src") !== url) { v.src = url; try { v.load(); } catch { /* */ } }
    this.seekOnMeta(v, this.positionTarget ?? opts.resumeAt ?? 0);
    this.setPlaybackRate(this.rate, this.preservePitch);
    if (opts.autoplay && this.playRequested) { this.safePlay(v); this.recovery.onStall(); }
    else { try { v.pause(); } catch { /* */ } }
    this.publish();
  }

  private teardownVideo(): void {
    this.usingVideo = false;
    const v = this.videoEl;
    if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* */ } }
  }

  // Play a raw URL (live radio stream or podcast enclosure), no download-cache
  // lookup. Live streams pass resumeAt=0 (not seekable).
  private playDirectUrl(audio: HTMLAudioElement, url: string, autoplay: boolean, resumeAt = 0): void {
    if (autoplay) { this.skipT0 = (typeof performance !== "undefined" ? performance.now() : Date.now()); this.setBuffering(true); }
    ++this.loadGen;
    this.applySrc(audio, url, resumeAt, autoplay);
  }

  play(): void {
    if (this.disposed) return;
    this.playRequested = true;
    this.playbackError = null;
    this.recovery.clear();
    this.unlock();
    if (this.resolving) return;
    const audio = this.active;
    if (!audio) return;
    this.playAudio(audio);
    this.watchProgress();
  }
  // Pauses every element, not just the active one, so a stale active index can
  // never leave another element playing.
  pause(): void {
    this.playRequested = false;
    this.clearProgressWatch();
    this.cancelCrossfade();
    this.recovery.clear();
    this.clearStartGate();
    for (const el of this.elems) { try { el.pause(); } catch { /* */ } }
    if (this.videoEl) { try { this.videoEl.pause(); } catch { /* */ } }
    this.buffering = false;
    this.publish();
  }
  seek(seconds: number): void {
    const audio = this.active;
    if (!audio) return;
    // A user seek wins over the load's pending resume-seek, which would otherwise
    // snap the playhead back on `canplay`.
    this.clearPendingSeek();
    // Stall recovery reloads to `currentTime || lastTime`, so record the target in
    // case timeupdate has not fired yet.
    this.lastTime = seconds;
    this.positionTarget = seconds;
    // While the source lookup is in flight, its completion seeks to positionTarget.
    if (!this.resolving) this.seekOnMeta(audio, seconds);
    this.publish();
  }

  stop(): void {
    this.playRequested = false;
    this.positionTarget = null;
    this.loadGen++;
    this.resolving = false;
    this.clearStartGate();
    this.clearPendingSeek();
    this.cancelCrossfade();
    this.playbackError = null;
    this.recovery.clear();
    this.preloaded = null;
    this.preloadGen++;
    this.clearPreloadRetry();
    this.upcomingSpec = null;
    this.activeSpec = null;
    if (this.usingVideo) this.teardownVideo();
    this.elems.forEach((el, i) => {
      this.resetElementSource(i);
      try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* */ }
    });
    // Publish the cleared state: pausing an already-paused element fires no event.
    this.buffering = false;
    this.publish();
  }

  private clearPreloadRetry() {
    clearTimeout(this.preloadRetryTimer);
    this.preloadRetryTimer = undefined;
    this.preloadRetries = 0;
  }
  // Buffer a track into the idle element without playing it or touching active state.
  private loadIntoIdle(spec: TrackSpec, reloadToken = 0) {
    const trackId = spec.trackId;
    const idleIdx = 1 - this.activeIdx;
    const idle = this.elems[idleIdx];
    if (!idle?.addEventListener) return; // jsdom / no element
    const gen = ++this.preloadGen;
    this.preloaded = null;
    this.resetElementSource(idleIdx);
    try { idle.pause(); idle.removeAttribute("src"); idle.load(); } catch { /* */ }
    const stillIdle = () => gen === this.preloadGen && idleIdx === 1 - this.activeIdx;
    // Resolved like the active load: this element becomes the active one at the
    // gapless swap, so its source must be pinned for the whole load too.
    const source = spec.url ? Promise.resolve({ src: spec.url, blob: false }) : resolveTrackSource(trackId, this.deps.getLiveStreamUrl(trackId), reloadToken);
    source.then(({ src, blob }) => {
      if (!stillIdle() || this.disposed) { if (blob) { try { URL.revokeObjectURL(src); } catch { /* */ } } return; }
      if (blob) this.objUrls[idleIdx] = src;
      this.priming.delete(idle);
      idle.src = src;
      try { idle.load(); idle.playbackRate = this.rate; idle.preservesPitch = this.preservePitch; } catch { /* */ }
      this.preloaded = { trackId, idx: idleIdx };
    }).catch(() => { /* resolveTrackSource always resolves */ });
  }

  setUpcoming(spec: TrackSpec | null): void {
    if (this.disposed) return;
    if (spec?.isVideo || spec?.isLive) spec = null;
    if (this.crossfading) { this.upcomingSpec = spec; return; } // idle element is still fading, defer
    const idleIdx = 1 - this.activeIdx;
    if (spec == null) {
      this.preloaded = null; this.preloadGen++;
      this.clearPreloadRetry();
      this.upcomingSpec = null;
      const idle = this.elems[idleIdx];
      this.resetElementSource(idleIdx);
      try { idle.pause(); idle.removeAttribute("src"); idle.load(); } catch { /* */ }
      return;
    }
    const previous = this.upcomingSpec;
    this.upcomingSpec = spec;
    if (previous?.trackId === spec.trackId && previous.url === spec.url && !this.preloaded) return;
    if (previous?.url === spec.url && this.preloaded?.trackId === spec.trackId && this.preloaded.idx === idleIdx) return; // already warm
    this.clearPreloadRetry();
    this.loadIntoIdle(spec);
  }

  // Can the idle element be swapped in for `spec`? If not, callers fall back to load().
  // `needReady` is for crossfade, which must not blend into silence. A plain track
  // boundary swaps even if the standby is still buffering: play() on an element
  // that already has the source is synchronous, while load() is async.
  private canSwap(spec: TrackSpec, needReady = false): boolean {
    const pre = this.preloaded;
    if (!pre || pre.trackId !== spec.trackId || this.upcomingSpec?.url !== spec.url) return false;
    const idle = this.elems[1 - this.activeIdx];
    if (pre.idx !== 1 - this.activeIdx || !idle || idle.error) return false;
    // iOS only swaps to a ready element.
    return idle.readyState >= 3 || (!needReady && !isIOS() && !!idle.getAttribute?.("src"));
  }

  // Gapless transition: promote the buffered idle element to active and play it,
  // pausing the old one.
  private swapToPreloaded(spec: TrackSpec) {
    const idleIdx = 1 - this.activeIdx;
    const next = this.elems[idleIdx];
    const old = this.active;
    this.preloadGen++;      // any in-flight preload targeting `next` is now void
    this.loadGen++;         // and any in-flight load(): a late applySrc would
                            // autoplay the element this swap abandons
    this.preloaded = null;
    this.clearStartGate(); this.clearPendingSeek(); this.recovery.clear();
    this.lastTime = 0;
    this.positionTarget = null;
    this.resolving = false;
    this.playRequested = true;
    this.activeIdx = idleIdx;
    this.syncMute();
    this.activeSpec = spec;
    if (this.upcomingSpec?.trackId === spec.trackId) this.upcomingSpec = null; // promoted, no longer "upcoming"
    this.clearPreloadRetry();
    const ready = next.readyState >= 3;
    this.buffering = !ready;
    this.skipT0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.setPlaybackRate(this.rate, this.preservePitch);
    this.safePlay(next);
    try { old.pause(); } catch { /* */ }
    dlog(`audio swap track=${spec.trackId} ready=${next.readyState} hidden=${typeof document !== "undefined" && document.visibilityState !== "visible"}`);
    // Promoted while still buffering, so arm the stall watchdog.
    if (!ready) this.recovery.onStall();
    this.watchProgress();
    this.publish();
  }

  goToUpcoming(spec: TrackSpec): void {
    if (this.canSwap(spec)) { this.swapToPreloaded(spec); return; }
    dlog(`audio no-preload track=${spec.trackId} preloaded=${this.preloaded?.trackId ?? "none"} full load`);
    this.load(spec, { autoplay: true });
  }

  setCrossfade(seconds: number): void {
    this.crossfadeSec = seconds;
    if (seconds > 0) { this.graph.ensure(this.effVol()); this.graph.resume(); }
  }
  setHold(on: boolean): void { this.held = on; }

  private beginCrossfade(spec: TrackSpec, sec: number) {
    // No graph (touch device, no AudioContext): nothing to fade with, so the song
    // plays to its end and swaps gaplessly.
    if (!this.graph.ensure(this.effVol())) return;
    const oldIdx = this.activeIdx;
    const newIdx = 1 - oldIdx;
    const nextEl = this.elems[newIdx];
    const oldEl = this.elems[oldIdx];
    this.crossfading = true;
    this.preloadGen++;
    this.loadGen++; // void in-flight load()s, as in swapToPreloaded
    this.preloaded = null;
    this.clearStartGate(); this.clearPendingSeek(); this.recovery.clear();
    this.lastTime = 0;
    this.positionTarget = null;
    this.activeIdx = newIdx;
    this.syncMute(); // both stay audible for the ramp
    this.activeSpec = spec;
    // `spec` is now active. Clear it from upcomingSpec, or the post-ramp re-arm
    // below would preload it again and crossfade the track into itself.
    if (this.upcomingSpec?.trackId === spec.trackId) this.upcomingSpec = null;
    this.buffering = false;
    try { nextEl.currentTime = 0; } catch { /* */ }
    this.graph.rampCrossfade(oldIdx, newIdx, sec);
    this.skipT0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.safePlay(nextEl);
    this.publish();
    this.emit("trackChanged");
    // After the ramp: stop the old element and restore its gain to unity for reuse.
    this.crossfadeTimer = window.setTimeout(() => {
      this.crossfadeTimer = undefined;
      try { oldEl.pause(); } catch { /* */ }
      this.graph.restoreGain(oldIdx);
      this.crossfading = false;
      this.syncMute();
      // A setUpcoming deferred during the ramp now takes effect.
      if (this.upcomingSpec) this.setUpcoming(this.upcomingSpec);
    }, sec * 1000 + 150);
  }

  private cancelCrossfade(): void {
    if (this.crossfadeTimer !== undefined) clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = undefined;
    if (this.crossfading) {
      try { this.elems[1 - this.activeIdx].pause(); } catch { /* */ }
      this.graph.restoreGain(0); this.graph.restoreGain(1);
    }
    this.crossfading = false;
    this.syncMute();
  }

  // Called each tick: when the current track is within `sec` wall-clock seconds of
  // its end, start the blend into the preloaded upcoming track. Element time is
  // media seconds (scaled by rate) and the gain ramps run on the AudioContext wall
  // clock, so remaining time is converted to wall seconds here.
  private maybeCrossfade(a: HTMLAudioElement) {
    const cf = this.crossfadeSec;
    if (cf <= 0 || this.crossfading || this.held) return;
    if (!this.upcomingSpec) return;
    const dur = a.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const rate = this.rate > 0 ? this.rate : 1;
    const remaining = (dur - a.currentTime) / rate;
    const sec = Math.min(cf, dur / 2 / rate);
    if (remaining <= 0.1 || remaining > sec + 0.05) return; // not in the fade window yet
    if (!this.canSwap(this.upcomingSpec, true)) return;
    this.beginCrossfade(this.upcomingSpec, Math.min(sec, remaining));
  }

  private isActiveEl(ev: Event) { return ev.currentTarget === this.active; }
  // Ghost watchdog: a non-active element may only play during a crossfade ramp or
  // the iOS silent-WAV unlock. Anything else is paused and counted for ?debug.
  private unlocking = false;
  private ghostsBlocked = 0;
  private killGhost(ev: Event) {
    if (this.crossfading || this.unlocking || this.priming.has(ev.currentTarget as HTMLMediaElement)) return;
    const el = ev.currentTarget as HTMLMediaElement | null;
    if (!el || el === this.active) return;
    this.ghostsBlocked++;
    try { el.pause(); } catch { /* */ }
  }
  private bufferedOf(a: HTMLAudioElement): BufferedRange[] {
    const ranges: BufferedRange[] = [];
    try { for (let i = 0; i < a.buffered.length; i++) ranges.push([a.buffered.start(i), a.buffered.end(i)]); } catch { /* */ }
    return ranges;
  }
  private resolveDuration(a: HTMLAudioElement): number {
    const d = a.duration;
    // Fragmented MP4 (empty_moov) reports a non-finite duration until fully
    // buffered, so fall back to the track's DB duration.
    if (Number.isFinite(d) && d > 0) return d;
    return this.activeSpec?.duration || 0;
  }

  private onTime = (ev: Event) => {
    if (!this.isActiveEl(ev)) return;
    const a = this.active;
    if (this.priming.has(a) || this.resolving) return;
    if (!a.paused && !a.seeking && a.currentTime > this.lastTime + 0.01) {
      this.progressAt = Date.now();
      this.kicked = false;
      this.recovery.clear();
      this.buffering = false;
      this.playbackError = null;
    }
    if (a.currentTime > 0) this.lastTime = a.currentTime;
    this.publish();
    this.maybeCrossfade(a);
  };
  private onProgress = (ev: Event) => { if (this.isActiveEl(ev)) this.publish(); };
  private onDur = (ev: Event) => { if (this.isActiveEl(ev)) this.publish(); };
  private onPlay = (ev: Event) => { if (this.priming.has(ev.currentTarget as HTMLMediaElement)) return; if (this.isActiveEl(ev)) this.publish(); else this.killGhost(ev); };
  private onPause = (ev: Event) => {
    if (!this.isActiveEl(ev)) return;
    const a = this.active;
    // Paused by something else while we wanted playback: an OS interruption (call,
    // another app's audio, route change). Not an error, and not retried.
    if (this.playRequested && !a.ended && !this.resolving && !this.priming.has(a) && this.deps.wantsToPlay()) {
      dlog(`audio paused externally track=${this.activeSpec?.trackId} at=${(a.currentTime || 0).toFixed(1)}`);
    }
    this.setBuffering(false);
  };
  private onEnded = (ev: Event) => {
    if (!this.isActiveEl(ev) || this.priming.has(this.active) || this.resolving) return;
    if (this.resumeTruncated()) return;
    // Publish before emitting, so listeners see the stopped state.
    this.publish();
    if (this.held) this.playRequested = false; // provider receives boundary and drops intent
    this.emit("ended");
  };
  /**
   * `ended` far short of the track's length means the stream was cut off. Reload
   * from where it stopped instead of advancing.
   * Only while the page is visible (iOS will not complete the async reload in the
   * background), and once per track in case the stored duration is wrong.
   */
  private resumeTruncated(): boolean {
    const spec = this.activeSpec;
    const expected = spec?.duration ?? 0;
    if (!spec || spec.url || spec.isLive || this.usingVideo || !(expected > 0)) return false;
    const at = Math.max(this.active.currentTime || 0, this.lastTime);
    if (expected - at <= Math.max(8, expected * 0.05)) return false;
    dlog(`audio ended early track=${spec.trackId} at=${at.toFixed(1)} of=${expected.toFixed(1)}`);
    if (this.earlyEndSeen.has(spec.trackId)) return false;
    this.earlyEndSeen.add(spec.trackId);
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
    if (!this.playRequested || !this.deps.wantsToPlay()) return false;
    this.lastTime = at;
    this.positionTarget = at;
    this.buffering = true;
    this.reloadActive(true);
    this.recovery.onStall();
    this.publish();
    return true;
  }

  // The standby element's load failed. Retry on a URL the document has not used,
  // up to 3 times with a growing delay.
  private retryPreload() {
    const spec = this.upcomingSpec;
    if (!spec || this.disposed || this.preloadRetries >= 3 || this.preloadRetryTimer !== undefined) return;
    const attempt = ++this.preloadRetries;
    this.preloadRetryTimer = setTimeout(() => {
      this.preloadRetryTimer = undefined;
      if (this.disposed || this.crossfading || this.preloaded || this.upcomingSpec !== spec) return;
      dlog(`audio preload retry track=${spec.trackId} attempt=${attempt}`);
      this.loadIntoIdle(spec, spec.url ? 0 : ++this.reloadToken);
    }, 1500 * attempt);
  }

  private onError = (ev: Event) => {
    if (this.priming.has(ev.currentTarget as HTMLMediaElement) || this.resolving) return;
    dlog(`audio error track=${this.activeSpec?.trackId} code=${(ev.currentTarget as HTMLMediaElement).error?.code ?? 0}`);
    if (this.isActiveEl(ev)) this.recovery.onError();
    else if (this.preloaded || this.upcomingSpec) {
      // The standby preload failed.
      this.preloaded = null; this.preloadGen++;
      this.retryPreload();
    }
  };
  private onWaiting = (ev: Event) => {
    if (this.priming.has(ev.currentTarget as HTMLMediaElement) || this.resolving) return;
    if (!this.isActiveEl(ev)) return;
    this.setBuffering(true);
    this.recovery.onStall(); // waits out its grace period before escalating
  };
  private onPlaying = (ev: Event) => {
    if (this.priming.has(ev.currentTarget as HTMLMediaElement)) return;
    if (!this.isActiveEl(ev)) { this.killGhost(ev); return; }
    this.playbackError = null;
    this.setBuffering(false); // real clock progress clears recovery, not this event alone
    if (this.skipT0 != null) {
      this.skipMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - this.skipT0);
      this.skipT0 = null;
      this.emit("started", this.skipMs);
    }
  };
  private onCanPlay = (ev: Event) => { if (this.isActiveEl(ev)) this.setBuffering(false); };
  private onOnline = () => this.recovery.onOnline();

  private bindEventsOn(el: HTMLMediaElement, fn: "addEventListener" | "removeEventListener") {
    if (!el[fn]) return;
    el[fn]("timeupdate", this.onTime as EventListener);
    el[fn]("progress", this.onProgress as EventListener);
    el[fn]("durationchange", this.onDur as EventListener);
    el[fn]("loadedmetadata", this.onDur as EventListener);
    el[fn]("play", this.onPlay as EventListener);
    el[fn]("pause", this.onPause as EventListener);
    el[fn]("ended", this.onEnded as EventListener);
    el[fn]("error", this.onError as EventListener);
    el[fn]("waiting", this.onWaiting as EventListener);
    el[fn]("playing", this.onPlaying as EventListener);
    el[fn]("canplay", this.onCanPlay as EventListener);
  }
  private bindElementEvents(fn: "addEventListener" | "removeEventListener") {
    for (const el of this.elems) this.bindEventsOn(el, fn);
  }

  getCurrentTime(): number { return this.positionTarget ?? (this.active?.currentTime || 0); }
  getDuration(): number { return this.resolveDuration(this.active); }
  isPaused(): boolean { return this.active?.paused ?? true; }
  // Active track has HAVE_FUTURE_DATA. The provider's prefetch/preload effects
  // wait for this so warming the next tracks does not starve live playback.
  isActiveReady(): boolean { return (this.active?.readyState ?? 0) >= 3; }
  getAudioDiag(): AudioDiag {
    const a = this.active as any;
    const src = (a?.currentSrc || a?.src || "").replace(/^https?:\/\/[^/]+/, "");
    return { src, error: a?.error?.code ?? 0, ready: a?.readyState ?? 0, net: a?.networkState ?? 0, skip: this.skipMs, ghosts: this.ghostsBlocked };
  }

  getAnalyser(): AnalyserNode | null {
    if (!this.graph.ensure(this.effVol())) return null;
    if (this.graph.suspended) this.graph.resume();
    return this.graph.analyser();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    if (this.videoEl) this.bindEventsOn(this.videoEl, "removeEventListener");
    this.videoHolder?.remove();
    this.videoHolder = null; this.videoEl = null;
    this.graph.dispose();
    this.listeners = {};
    this.bindElementEvents("removeEventListener");
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.recovery.clear();
    this.clearPreloadRetry();
    this.clearProgressWatch();
    this.clearStartGate();
    this.clearPendingSeek();
  }
}

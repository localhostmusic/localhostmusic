// The native AudioEngine (Android): playback runs through ExoPlayer via the
// LhmAudio Capacitor plugin, not an <audio> element.
// The plugin is async but the AudioEngine reads are synchronous, so plugin state
// is mirrored locally from its events.
// ExoPlayer needs absolute URLs, so stream URLs are resolved against the WebView
// origin. The native side attaches the WebView cookie for auth.

import type { PluginListenerHandle } from "@capacitor/core";
import { LhmAudio } from "./nativeBridge";
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

export interface NativeAudioEngineDeps {
  getLiveStreamUrl(trackId: number): string; // relative (e.g. /api/stream/1?bitrate=320)
}

export class NativeAudioEngine implements AudioEngine {
  private deps: NativeAudioEngineDeps;
  private listeners: { [E in AudioEngineEvent]?: Set<AudioEngineEvents[E]> } = {};
  private handles: PluginListenerHandle[] = [];

  // Local mirror of native state, kept current from plugin events.
  private curTime = 0;
  private dur = 0;
  private paused = true;
  private buffered = 0;
  private held = false;
  private buffering = false;
  private disposed = false;
  private error: string | null = null;
  private upcomingSpec: TrackSpec | null = null;
  private commands: Promise<void> = Promise.resolve();
  private attached = false;
  private activeSpec: TrackSpec | null = null;

  constructor(deps: NativeAudioEngineDeps) {
    this.deps = deps;
  }
  attach(): void {
    if (this.attached || this.disposed) return;
    this.attached = true;
    this.commands = this.wire().catch(e => this.failed(e));
    document.addEventListener("visibilitychange", this.onVisible);
  }

  private async wire() {
    const on = async (event: string, fn: (d: any) => void) => {
      const handle = await LhmAudio.addListener(event, d => { if (!this.disposed) fn(d); });
      if (this.disposed) await handle.remove(); else this.handles.push(handle);
    };
    await on("time", (d) => {
      this.curTime = d.currentTime ?? 0;
      this.buffered = d.buffered ?? 0;
      this.publish();
    });
    await on("durationchange", (d) => {
      this.dur = d.duration && d.duration > 0 ? d.duration : (this.activeSpec?.duration ?? 0);
      this.publish();
    });
    await on("play", () => { this.paused = false; this.publish(); });
    await on("pause", () => { this.paused = true; this.publish(); });
    await on("ended", () => this.emit("ended"));
    await on("trackChanged", () => {
      if (this.upcomingSpec) { this.activeSpec = this.upcomingSpec; this.upcomingSpec = null; }
      this.curTime = 0; this.dur = this.activeSpec?.duration ?? 0;
      this.publish(); this.emit("trackChanged");
    });
    await on("buffering", (d) => { this.buffering = !!d.buffering; this.publish(); });
    // Lock-screen / notification / Bluetooth next and prev: the provider handles them.
    await on("remoteNext", () => this.emit("remoteNext"));
    await on("remotePrev", () => this.emit("remotePrev"));
    await on("audioerror", d => this.failed(new Error(d.message || "Audio playback failed. Try Play again.")));
    await this.syncState();
  }

  private failed(e: unknown): void {
    if (this.disposed) return;
    this.error = e instanceof Error ? e.message : "Audio playback failed. Try Play again.";
    this.buffering = false; this.paused = true; this.publish();
  }
  private command(run: () => Promise<void>): void {
    this.commands = this.commands.then(async () => {
      if (!this.disposed) await run();
    }).catch(e => this.failed(e));
  }
  private async syncState(): Promise<void> {
    const s = await LhmAudio.getState();
    if (this.disposed) return;
    this.curTime = s.currentTime ?? this.curTime;
    this.dur = s.duration ?? this.dur;
    this.paused = s.paused ?? this.paused;
    this.publish();
  }
  private onVisible = () => { if (document.visibilityState === "visible") this.command(() => this.syncState()); };
  getPlaybackState(): PlaybackState {
    return {
      trackId: this.activeSpec?.trackId ?? null,
      error: this.error,
      playing: !this.paused,
      buffering: this.buffering,
      // ExoPlayer does its own retrying.
      reconnecting: false,
      currentTime: this.curTime,
      duration: this.dur,
      buffered: this.bufferedRanges(),
    };
  }
  private publish(): void { this.emit("state", this.getPlaybackState()); }

  // Absolute stream URL for ExoPlayer.
  private urlFor(spec: TrackSpec): string {
    const rel = spec.url || this.deps.getLiveStreamUrl(spec.trackId);
    try { return new URL(rel, location.origin).href; } catch { return rel; }
  }
  // Metadata for the native lock screen, with an absolute artwork URL.
  private metaOf(spec: TrackSpec) {
    let artworkUrl = spec.artworkUrl;
    if (artworkUrl) { try { artworkUrl = new URL(artworkUrl, location.origin).href; } catch { /* */ } }
    return { title: spec.title, artist: spec.artist, album: spec.album, artworkUrl };
  }
  private bufferedRanges(): BufferedRange[] {
    return this.buffered > 0 ? [[0, this.buffered]] : [];
  }

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

  // Transport calls are fire-and-forget into the async plugin.
  load(spec: TrackSpec, opts: LoadOptions): void {
    this.activeSpec = spec;
    this.error = null; this.upcomingSpec = null; this.dur = spec.duration ?? 0;
    this.paused = !opts.autoplay;
    this.curTime = opts.resumeAt ?? 0;
    this.command(() => LhmAudio.load({ url: this.urlFor(spec), resumeAt: opts.resumeAt ?? 0, autoplay: opts.autoplay, ...this.metaOf(spec) }));
  }
  unlock(): void { /* native audio session has no browser autoplay gate */ }
  play(): void { this.error = null; this.paused = false; this.command(() => LhmAudio.play()); }
  pause(): void { this.paused = true; this.command(() => LhmAudio.pause()); }
  seek(seconds: number): void { this.curTime = seconds; this.command(() => LhmAudio.seek({ position: seconds })); }
  private userVol = 1;
  private normFactor = 1;
  setVolume(v: number): void { this.userVol = v; this.command(() => LhmAudio.setVolume({ volume: v * this.normFactor })); }
  // Native volume is user volume times the loudness-normalization factor.
  setNormalization(factor: number): void {
    this.normFactor = Math.max(0, Math.min(1, isFinite(factor) ? factor : 1));
    this.command(() => LhmAudio.setVolume({ volume: this.userVol * this.normFactor }));
  }
  setPlaybackRate(rate: number, preservePitch = true): void { this.command(() => LhmAudio.setPlaybackRate({ rate, preservePitch })); }
  setReverb(_wet: number): void { /* no native reverb */ }
  stop(): void { this.activeSpec = null; this.upcomingSpec = null; this.error = null; this.paused = true; this.curTime = 0; this.dur = 0; this.command(() => LhmAudio.stop()); }

  setUpcoming(spec: TrackSpec | null): void {
    this.upcomingSpec = this.held ? null : spec;
    // While held (lyrics sync), keep the native queue empty so playback stops at
    // the track boundary.
    if (this.held || !spec) { this.command(() => LhmAudio.setUpcoming({ url: null })); return; }
    this.command(() => LhmAudio.setUpcoming({ url: this.urlFor(spec), ...this.metaOf(spec) }));
  }
  goToUpcoming(spec: TrackSpec): void {
    this.activeSpec = spec;
    this.upcomingSpec = null; this.error = null; this.curTime = 0; this.dur = spec.duration ?? 0;
    this.paused = false;
    this.command(() => LhmAudio.goToUpcoming({ url: this.urlFor(spec), autoplay: true, ...this.metaOf(spec) }));
  }

  // No native crossfade, tracks hard-cut gaplessly.
  setCrossfade(_seconds: number): void { /* no-op on native */ }
  setHold(on: boolean): void { this.held = on; if (on) this.command(() => LhmAudio.setUpcoming({ url: null })); }

  getCurrentTime(): number { return this.curTime; }
  getDuration(): number { return this.dur; }
  isPaused(): boolean { return this.paused; }
  isActiveReady(): boolean { return !this.buffering && !this.error; }
  getAudioDiag(): AudioDiag {
    return { src: this.activeSpec ? `native:${this.activeSpec.trackId}` : "", error: 0, ready: this.paused ? 0 : 4, net: 0, skip: 0 };
  }
  getAnalyser(): AnalyserNode | null { return null; } // no Web Audio graph natively

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisible);
    void LhmAudio.stop().catch(() => {});
    this.listeners = {};
    for (const h of this.handles) { try { void h.remove().catch(() => {}); } catch { /* */ } }
    this.handles = [];
  }
}

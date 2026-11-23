// The audio engine interface.
// PlayerProvider owns the queue, play order, cursor, Connect and React state. An
// AudioEngine owns a current track plus one upcoming track, with a gapless or
// crossfaded transition between them, and recovers from network drops.

export interface TrackSpec {
  trackId: number;
  // Direct source URL (radio stream or podcast enclosure). Played as-is, bypassing
  // the download cache and stream endpoint.
  url?: string;
  // Live stream: not seekable, so stall recovery reconnects without seeking.
  isLive?: boolean;
  // Video podcast: the engine drives a <video> element instead of an <audio> one.
  isVideo?: boolean;
  // DB duration fallback: fragmented MP4 (empty_moov) reports a non-finite
  // duration until fully buffered.
  duration?: number;
  // Display metadata for the native lock screen / notification. Ignored by the web
  // engine, which uses the MediaSession API.
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string; // absolute
}

export interface LoadOptions {
  // Seek here once the media is loaded (resume-after-reload, handoff position).
  resumeAt?: number;
  // Start playing once loadable, or load paused (session restore).
  autoplay: boolean;
}

// A buffered time range [start, end], for the buffer bar under the scrubber.
export type BufferedRange = [number, number];

/**
 * What is playing right now, as one value. Derived from the element at publish
 * time, not accumulated from play/pause events, so a missed event corrects itself
 * on the next publish. Consumers should project this, not keep their own copy.
 */
export interface PlaybackState {
  // currentTime is a seek/load target the browser has not confirmed yet. Do not
  // report it as a playback heartbeat.
  positionPending?: boolean;
  error?: string | null;
  trackId: number | null;
  // Actually producing sound. Playback intent is separate and lives in the
  // provider (see WebAudioEngineDeps.wantsToPlay).
  playing: boolean;
  buffering: boolean;
  reconnecting: boolean;
  currentTime: number;
  duration: number;
  buffered: BufferedRange[];
}

// Events the engine emits. `state` is the snapshot above. The others are one-off
// transitions that carry no state.
export interface AudioEngineEvents {
  // Fires only on an actual change, but often while playing (the position moves),
  // so keep handlers cheap.
  state: (s: PlaybackState) => void;
  // Active track reached its natural end without a crossfade having already
  // advanced. The provider decides what plays next and calls goToUpcoming()/load().
  ended: () => void;
  // The engine advanced on its own (a crossfade): the upcoming track is now
  // active. The provider moves its cursor to match, without calling goToUpcoming.
  trackChanged: () => void;
  // An autoplay load started producing sound. skipMs is the tap-to-sound latency,
  // for the ?debug overlay.
  started: (skipMs: number) => void;
  // Next/prev pressed on an OS surface the engine owns (native lock screen,
  // notification, Bluetooth). The provider runs its own next()/prev(). The web
  // engine never fires these, MediaSession handlers call the provider directly.
  remoteNext: () => void;
  remotePrev: () => void;
}

export type AudioEngineEvent = keyof AudioEngineEvents;

// Diagnostics for the ?debug overlay. Native backends fill what they can.
export interface AudioDiag {
  src: string;
  error: number;
  ready: number;
  net: number;
  skip: number;
  // Times the web engine paused a non-active element that had started playing
  // (see WebAudioEngine.killGhost).
  ghosts?: number;
}

export interface AudioEngine {
  attach?(): void; // connect external listeners after React commits
  // Load `spec` as the active source (first play, prev, jumpTo, Connect handoff).
  // Not gapless: use goToUpcoming() for forward-next.
  load(spec: TrackSpec, opts: LoadOptions): void;
  play(): void;
  pause(): void;
  // Unlock audio from within a user gesture, so a later programmatic play() is
  // allowed on iOS. No-op once unlocked.
  unlock(): void;
  seek(seconds: number): void;
  setVolume(v: number): void; // 0..1, applies to the whole engine
  // Per-track loudness-normalization multiplier (0..1, attenuate only), applied on
  // top of setVolume. 1 = no change.
  setNormalization(factor: number): void;
  // Playback speed, 1 = normal. preservePitch (default true) time-stretches.
  // false lets pitch follow the rate.
  setPlaybackRate(rate: number, preservePitch?: boolean): void;
  // Reverb wet mix 0..1. Needs the Web Audio graph, so it is a no-op on touch
  // devices and native backends.
  setReverb(wet: number): void;
  // Stop and clear everything. After this there is no active track.
  stop(): void;

  // Which track plays next, so the engine can pre-buffer it. null clears the
  // preload. Idempotent.
  setUpcoming(spec: TrackSpec | null): void;
  // Advance to the forward-next track. A gapless swap if it matches the preloaded
  // upcoming track, otherwise a normal load and play. Crossfade advances happen
  // inside the engine and fire `trackChanged`.
  goToUpcoming(spec: TrackSpec): void;
  // Crossfade duration in seconds (0 = off). Enabling it may build or resume the
  // Web Audio graph, so call from a user gesture when possible.
  setCrossfade(seconds: number): void;
  // While held (e.g. the lyrics-sync tool is open) the engine does not crossfade
  // or auto-advance. It stops at the track boundary.
  setHold(on: boolean): void;

  // Same snapshot the `state` event carries, for use outside an event.
  getPlaybackState(): PlaybackState;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  // Active track is buffered enough to play through. The provider's prefetch and
  // preload effects wait for this.
  isActiveReady(): boolean;
  getAudioDiag(): AudioDiag;
  // Web-only visualizer analyser. Native backends return null.
  getAnalyser(): AnalyserNode | null;
  // Web-only <video> element used for video podcasts, for the UI to mount in the
  // Now Playing view.
  getVideoElement?(): HTMLVideoElement | null;
  // Return that element to its offscreen holder when the view unmounts.
  homeVideo?(): void;

  on<E extends AudioEngineEvent>(event: E, handler: AudioEngineEvents[E]): void;
  off<E extends AudioEngineEvent>(event: E, handler: AudioEngineEvents[E]): void;
  dispose(): void;
}

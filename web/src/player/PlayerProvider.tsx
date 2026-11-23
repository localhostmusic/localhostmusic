import { useLibraryRevision } from "../library/useLibraryRevision";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { ConnectClient, type DeviceInfo, type SessionState, type ApplyMsg, type SessionSync, type SessionMember, type PresenceUser } from "./connectClient";

// A live Session (listen together): the host drives, guests mirror the
// host's playback.
export interface SessionInfo { code: string; role: "host" | "guest"; host?: string; members: SessionMember[]; hostAway?: boolean; nightcoreOk?: boolean; }
import { getConnId, setDeviceName } from "./device";
import { downloadedUrl } from "./downloads";
import { isIOS } from "./engine/source";
import type { Chapter } from "./audiobook";
import { loadStreamQuality, saveStreamQuality, resolveBitrate, type StreamQuality } from "./streamQuality";
import { loadCrossfade, saveCrossfade } from "./crossfade";
import { loadNightcore, saveNightcore, loadVibe, saveVibe, vibeReverb, nightcoreSupported, VIBE_MIN, VIBE_MAX } from "./nightcore";
import { loadNormalize, saveNormalize, normFactor } from "./normalize";
import { Capacitor } from "@capacitor/core";
import { Scrobbler } from "./Scrobbler";
import { WebAudioEngine } from "./engine/WebAudioEngine";
import { NativeAudioEngine } from "./engine/NativeAudioEngine";
import type { AudioEngine, TrackSpec } from "./engine/types";
import { buildOrder as buildPlayOrder, nextPos } from "./queueModel";
import { savePlayer as save, savePlayerTime as saveTime, restoreQueue, restorePrefs } from "./playerStorage";

export interface Track {
  id: number;
  title: string;
  duration?: number;
  albumId?: number;
  album?: string;
  artist?: string;       // primary artist (display + filing)
  artistId?: number;
  // Full credit list in tag order, primary first. Only set where the server sends
  // it (the album view), otherwise fall back to `artist`.
  artists?: { id: number; name: string; role: string }[];
  isAudiobook?: boolean; // set when played from the Audiobooks view, enables book UI
  streamUrl?: string;    // direct source URL (internet radio), played as-is, not by id
  isRadio?: boolean;     // live stream: no duration/seek/auto-advance/bookmarks
  radioStationId?: number; // station id, for polling ICY now-playing metadata
  isPodcast?: boolean;   // podcast episode: seekable URL, progress saved server-side
  podcastEpisodeId?: number;
  podcastChannelId?: number; // for the "Episodes" switcher in Now Playing
  hasTranscript?: boolean;   // episode has a podcast:transcript, shown in the lyrics panel
  isVideo?: boolean;         // video-podcast episode: engine drives a <video> element
  artUrl?: string;       // artwork for non-library tracks (podcast episode/channel image)
}

export type RepeatMode = "off" | "all" | "one";
export type AutoDJMode = "similar-artists" | "similar-songs" | "favorites" | "random";
export type AutoDJUnit = "songs" | "albums";

interface Ctx {
  queue: Track[];
  order: number[];
  pos: number;
  current?: Track;
  bookChapters: Chapter[]; // chapters of the current audiobook (single-file .m4b), else []
  radioTitle: string | null; // ICY now-playing title for the current radio station
  isPlaying: boolean;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  quality: any | null; // technical audio info for the current track
  playNow(tracks: Track[], index: number, startAt?: number): void;
  toggle(): void;
  play(): void;
  pause(): void;
  getTransportState(): { playing: boolean; currentTime: number; duration: number };
  getMediaSessionState(): { current?: Track; playing: boolean; currentTime: number; duration: number; effectiveRate: number };
  subscribeTransport(listener: () => void): () => void;
  playbackError: string | null;
  playbackInstance: number;
  next(): void;
  prev(): void;
  seek(t: number): void;
  setVolume(v: number): void;
  playbackRate: number;              // audiobook playback speed (1 = normal)
  setPlaybackRate(r: number): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  weightedShuffle: boolean;      // shuffle favours your higher-rated songs
  setWeightedShuffle(on: boolean): void;
  setHold(on: boolean): void; // suspend auto-advance (e.g. while syncing lyrics)
  getAnalyser(): AnalyserNode | null; // lazily-built Web Audio analyser for visualizers
  getVideoElement(): HTMLVideoElement | null; // <video> the engine drives for video podcasts
  homeVideo(): void; // return that element to its offscreen holder on view unmount
  jumpTo(orderPos: number): void;
  removeFromQueue(orderPos: number): void;
  reorderQueue(from: number, to: number): void;
  playNext(track: Track): void;
  addToQueue(track: Track): void;
  addManyToQueue(tracks: Track[]): void; // append a whole album/list in one update

  startRadio(seed: Track): void; // play a song, then queue similar tracks (Auto DJ)
  autoDJ: boolean;               // endlessly refill the queue when it runs low
  setAutoDJ(on: boolean): void;
  autoDJMode: AutoDJMode;        // similar-artists / similar-songs / favorites / random
  setAutoDJMode(m: AutoDJMode): void;
  autoDJUnit: AutoDJUnit;        // add songs or whole albums
  setAutoDJUnit(u: AutoDJUnit): void;
  autoDJCount: number;           // songs (or albums) added per refill
  setAutoDJCount(n: number): void;
  currentRating: number;         // the playing track's rating (0-5) for this user
  rateCurrent(n: number): void;
  currentFav: boolean;           // is the playing track favorited
  toggleCurrentFav(): void;
  sleepAt: number | null;          // when the sleep timer will pause (ms epoch), or null
  setSleep(minutes: number | null): void;
  getAudioDiag(): { src: string; error: number; ready: number; net: number; skip: number };
  reconnecting: boolean;           // stream stalled; auto-resume is retrying
  buffering: boolean;              // stream is loading/stalled (normal buffering)
  streamQuality: StreamQuality;    // live-playback quality preference
  setStreamQuality(q: StreamQuality): void;
  crossfade: number;               // crossfade seconds (0 = off/gapless)
  setCrossfade(seconds: number): void;
  // Nightcore/slowed mode as engaged right now: false on a device that can't run
  // it or isn't the one playing, whatever the saved preference says.
  nightcore: boolean;
  setNightcore(on: boolean): void;
  nightcoreAvailable: boolean;     // this device can run nightcore and is the one playing
  vibe: number;                    // playback vibe while nightcore is on (1 = normal, >1 nightcore, <1 slowed)
  setVibe(v: number): void;
  effectiveRate: number;           // rate the engine really plays at (nightcore / audiobook speed / guest mirror)
  normalize: boolean;              // volume normalization on/off (per-track loudness leveling)
  setNormalize(on: boolean): void;
  prefetchedId: number | null;     // last track warmed into the offline cache
  // Connect (multi-device)
  connected: boolean;
  devices: DeviceInfo[];
  activeDeviceId: string | null;
  myDeviceId: string;
  isActiveDevice: boolean;      // is this device the one producing audio?
  activeDeviceName: string | null; // name of the active device when it's elsewhere
  transferTo(deviceId: string): void;
  renameDevice(name: string): void;
  // Sessions (listen together across users)
  session: SessionInfo | null;
  isGuest: boolean;              // in a session as a guest, transport is host-driven
  sessionError: string | null;   // last join error (e.g. bad/expired code)
  startSession(): void;
  joinSession(code: string): void;
  leaveSession(): void;
  online: PresenceUser[];        // other users on the server + what they're playing
  // Presence ask-to-join / invite
  joinRequest: { fromUserId: number; fromName: string } | null; // host: pending request to accept
  invite: { fromUserId: number; fromName: string; code: string } | null; // invitee: pending invite
  presenceNote: string | null;   // transient toast (declined / error), auto-clears
  askToJoin(userId: number): void;
  inviteUser(userId: number): void;
  respondJoin(userId: number, accept: boolean): void;
  acceptInvite(): void;
  dismissInvite(): void;
  dismissPresenceNote(): void;
  shareActivity: boolean;         // am I visible to others in presence?
  setShareActivity(share: boolean): void;
}

const PlayerCtx = createContext<Ctx | null>(null);
export const usePlayer = () => {
  const c = useContext(PlayerCtx);
  if (!c) throw new Error("usePlayer outside provider");
  return c;
};

// Playback progress has its own context: it updates several times per second, and
// in the main context it would re-render every usePlayer() consumer on each tick.
interface TimeCtx {
  currentTime: number;
  duration: number;
  buffered: [number, number][]; // buffered time ranges, for the buffer bar
}
const PlayerTimeCtx = createContext<TimeCtx | null>(null);
export const usePlayerTime = () => {
  const c = useContext(PlayerTimeCtx);
  if (!c) throw new Error("usePlayerTime outside provider");
  return c;
};

export { buildOrder } from "./queueModel";

export function PlayerProvider({ children }: { children: ReactNode }) {
  // The engine turns a track into sound. This provider owns the queue, the cursor,
  // Connect and the React state, and drives the engine through AudioEngine.
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) {
    // `liveStreamUrl` and `wantPlayRef` are defined below. These closures only run
    // during playback, after this render has initialized them.
    const getLiveStreamUrl = (id: number) => liveStreamUrl(id);
    engineRef.current = Capacitor.isNativePlatform()
      ? new NativeAudioEngine({ getLiveStreamUrl }) // Android (ExoPlayer)
      : new WebAudioEngine({ getLiveStreamUrl, wantsToPlay: () => wantPlayRef.current });
  }
  const engine = engineRef.current;
  // The engine's view of a track. The display metadata is for the native lock
  // screen, the web engine ignores it.
  const spec = (t?: Track): TrackSpec | null => (t ? {
    trackId: t.id, duration: t.duration, url: t.streamUrl, isLive: t.isRadio, isVideo: t.isVideo,
    title: t.title, artist: t.artist, album: t.album,
    artworkUrl: t.albumId != null ? api.coverUrl(t.albumId) : t.artUrl,
  } : null);
  const libraryVersion = useLibraryRevision();
  const [queue, setQueue] = useState<Track[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [pos, setPos] = useState(0);
  const lifecycleRef = useRef(0);
  const queueGeneration = useRef(0);
  const [playbackInstance, setPlaybackInstance] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [weightedShuffle, setWeightedShuffle] = useState(false); // shuffle favours higher-rated songs
  const [autoDJ, setAutoDJ] = useState(false); // keep the queue topped up automatically
  const [autoDJMode, setAutoDJMode] = useState<AutoDJMode>("similar-artists"); // how it picks
  const [autoDJUnit, setAutoDJUnit] = useState<AutoDJUnit>("songs");           // songs or whole albums
  // Songs and albums need very different scales, so each keeps its own count.
  const [autoDJSongCount, setAutoDJSongCount] = useState(20);
  const [autoDJAlbumCount, setAutoDJAlbumCount] = useState(3);
  const autoDJCount = autoDJUnit === "albums" ? autoDJAlbumCount : autoDJSongCount;
  const setAutoDJCount = (n: number) => (autoDJUnit === "albums" ? setAutoDJAlbumCount : setAutoDJSongCount)(n);
  const autoDJRef = useRef(false);             // guards against overlapping extend fetches
  // Ratings and favorites, for the now-playing view and rating-weighted shuffle.
  // Loaded once, kept in sync locally.
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [favIds, setFavIds] = useState<Set<number>>(new Set());
  // Per-track shuffle weight (rating + 1) when weighted shuffle is on, else uniform.
  const weightsFor = (tracks: Track[]) => weightedShuffle ? tracks.map(t => (ratings[t.id] ?? 0) + 1) : undefined;
  const [reconnecting, setReconnecting] = useState(false); // auto-resume actively retrying a stalled stream
  const [buffering, setBuffering] = useState(false);       // stream is loading/stalled (normal, pre-reconnect)
  const [buffered, setBuffered] = useState<[number, number][]>([]); // buffered time ranges (for the buffer bar)
  const [streamQuality, setStreamQualityState] = useState<StreamQuality>(loadStreamQuality);
  const streamQualityRef = useRef(streamQuality);
  streamQualityRef.current = streamQuality;
  const setStreamQuality = (q: StreamQuality) => { setStreamQualityState(q); saveStreamQuality(q); };
  // Playback speed for audiobooks (persisted). Applied only while an audiobook is
  // current.
  const [playbackRate, setPlaybackRateState] = useState<number>(() => {
    const n = Number(localStorage.getItem("lhm.playbackRate")); return Number.isFinite(n) && n > 0 ? n : 1;
  });
  const setPlaybackRate = (r: number) => {
    setPlaybackRateState(r);
    try { localStorage.setItem("lhm.playbackRate", String(r)); } catch { /* */ }
  };
  // The rate applied to the engine right now, read by hostPush so session
  // heartbeats carry it.
  const effRateRef = useRef(1);

  const [crossfade, setCrossfadeState] = useState<number>(loadCrossfade);
  const setCrossfade = (s: number) => {
    setCrossfadeState(s); saveCrossfade(s);
    // Called here so the engine builds and resumes its Web Audio graph inside the
    // user gesture.
    engine.setCrossfade(s);
  };

  // Nightcore / slowed mode. The effect below applies these. The setters also call
  // the engine directly so the reverb graph is built inside the user gesture.
  const [nightcore, setNightcoreState] = useState<boolean>(loadNightcore);
  const [vibe, setVibeState] = useState<number>(loadVibe);
  const setVibe = (v: number) => {
    const c = Math.max(VIBE_MIN, Math.min(VIBE_MAX, v));
    setVibeState(c); saveVibe(c);
    engine.setReverb(nightcore ? vibeReverb(c) : 0);
  };
  const setNightcore = (on: boolean) => {
    setNightcoreState(on); saveNightcore(on);
    engine.setReverb(on ? vibeReverb(vibe) : 0);
  };

  const [normalize, setNormalizeState] = useState<boolean>(loadNormalize);
  const setNormalize = (on: boolean) => { setNormalizeState(on); saveNormalize(on); };


  const [prefetchedId, setPrefetchedId] = useState<number | null>(null); // last track we warmed into the SW cache

  // Connect state.
  // Our identity is the per-tab connection id, not the per-browser device id that
  // every tab shares. It can be reissued mid-session if another socket claims it,
  // so the mount-captured handlers below read it through the ref.
  const myIdRef = useRef(getConnId());
  const [myId, setMyId] = useState(myIdRef.current);
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  // Playback is ours unless it was cast away. With no realtime channel there is
  // nothing to cast to.
  const isActiveDevice = !connected || activeDeviceId === myId;
  const connRef = useRef<ConnectClient | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [joinRequest, setJoinRequest] = useState<{ fromUserId: number; fromName: string } | null>(null);
  const [invite, setInvite] = useState<{ fromUserId: number; fromName: string; code: string } | null>(null);
  const [presenceNote, setPresenceNote] = useState<string | null>(null);
  const [shareActivity, setShareActivityState] = useState(true); // seeded by presence:self on connect
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<SessionInfo | null>(null);
  sessionRef.current = session; // read the live role inside WS callbacks
  const connectedRef = useRef(false);
  const isActiveRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  // What the server last confirmed as the active device. activeIdRef is optimistic:
  // a device sets it to itself for display even when the server has none. Claims
  // check this one, or a device that shows itself active would never claim.
  const serverActiveIdRef = useRef<string | null>(null);
  const remotePosRef = useRef({ base: 0, baseAt: 0, isPlaying: false, dur: 0 });
  const lastReportRef = useRef(0);

  const current = queue[order[pos]];

  // Chapters of the current audiobook (single-file .m4b), for the book-aware UI.
  // Fetched once per track; [] for music and for chapterless files.
  const [bookChapters, setBookChapters] = useState<Chapter[]>([]);
  useEffect(() => {
    if (!current?.isAudiobook) { setBookChapters([]); return; }
    let live = true;
    api.getChapters(current.id).then((c: Chapter[]) => { if (live) setBookChapters(c); }).catch(() => { if (live) setBookChapters([]); });
    return () => { live = false; };
  }, [current?.id, current?.isAudiobook]);

  // Playback rate, pitch and reverb. Spoken word (audiobooks, podcasts) has its own
  // pitch-preserving speed and never gets nightcore. Music plays at the vibe rate
  // while nightcore is on, otherwise at 1x.
  // A session guest mirrors the host's rate: drift correction projects the host
  // position forward at that rate, so a mismatch would re-seek endlessly.
  const [hostRate, setHostRate] = useState(1);
  const guestRate = session?.role === "guest" ? hostRate : null;
  // Nightcore only engages on a device that supports it (desktop), that is the
  // active device, and in a session only if every member can run it (the server's
  // nightcoreOk). The stored preference is not changed.
  const nightcoreAvailable = nightcoreSupported() && isActiveDevice && session?.nightcoreOk !== false;
  const nightcoreOn = nightcore && nightcoreAvailable;
  const spoken = !!(current?.isAudiobook || current?.isPodcast);
  // The rate applied to the engine. Also sent in session heartbeats and reported
  // to the OS via MediaSession so the lock-screen scrubber stays in step.
  const effectiveRate = guestRate != null ? guestRate : spoken ? playbackRate : nightcoreOn ? vibe : 1;
  useEffect(() => {
    effRateRef.current = effectiveRate;
    // Spoken word time-stretches, nightcore lets pitch follow the rate.
    const preservePitch = guestRate != null ? guestRate === 1 : spoken ? true : !nightcoreOn;
    engine.setPlaybackRate(effectiveRate, preservePitch);
    // Reverb is never mirrored to a guest and never on spoken word.
    engine.setReverb(guestRate == null && !spoken && nightcoreOn ? vibeReverb(vibe) : 0);
  }, [current?.id, spoken, effectiveRate, nightcoreOn, vibe, guestRate]);

  // Loudness normalization: fetch the current track's integrated loudness (LUFS,
  // cached) and set the engine's per-track gain. Skipped for live radio and video.
  const loudnessCache = useRef<Map<number, number | null>>(new Map());
  useEffect(() => {
    const id = current?.id;
    if (id == null || current?.isRadio || current?.isVideo) { engine.setNormalization(1); return; }
    const apply = (l: number | null) => engine.setNormalization(normFactor(l, normalize));
    if (loudnessCache.current.has(id)) { apply(loudnessCache.current.get(id) ?? null); return; }
    let live = true;
    api.getLoudness(id).then((d) => {
      const l = typeof d?.loudness === "number" ? d.loudness : null;
      loudnessCache.current.set(id, l);
      if (live) apply(l);
    }).catch(() => {});
    return () => { live = false; };
  }, [current?.id, current?.isRadio, current?.isVideo, normalize]);

  // Save the outgoing track's resume position when the track changes, since the
  // periodic save only runs every ~15s. The cleanup captures the previous track.
  useEffect(() => {
    const out = current;
    return () => {
      if (!out) return;
      const t = posRef.current;
      const dur = out.duration ?? 0;
      if (out.isPodcast && out.podcastEpisodeId != null) {
        const done = dur > 0 && t >= dur - 20;
        api.savePodcastProgress(out.podcastEpisodeId, done ? 0 : Math.round(t * 1000), done).catch(() => {});
      } else if ((out.isAudiobook || dur >= 20 * 60) && t > 0 && t < dur - 15) {
        api.saveBookmark(out.id, Math.round(t * 1000)).catch(() => {});
      }
    };
  }, [current?.id]);

  // Internet radio: poll the station's ICY "now playing" (Artist - Song) title.
  const [radioTitle, setRadioTitle] = useState<string | null>(null);
  useEffect(() => {
    const sid = current?.radioStationId;
    if (!current?.isRadio || sid == null) { setRadioTitle(null); return; }
    let live = true;
    const poll = () => api.getRadioNowPlaying(sid).then((r: any) => { if (live) setRadioTitle(r?.title || null); }).catch(() => {});
    poll();
    const timer = setInterval(poll, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [current?.id, current?.isRadio, current?.radioStationId]);
  const [quality, setQuality] = useState<any | null>(null);

  // Warm upcoming tracks into the SW cache so transitions are instant. The prefetch
  // competes with the live stream for bandwidth, so: abort in-flight prefetches
  // when the track changes, keep a small connection-aware window, and wait until
  // the current song has buffered enough to play.
  const prefetchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!current) return;
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
    prefetchAbortRef.current?.abort(); // stop any prefetch for the previous track/album
    const ac = new AbortController();
    prefetchAbortRef.current = ac;
    const run = async () => {
      if (ac.signal.aborted) return;
      if (castingRef.current) return; // passive controller, the audio plays elsewhere
      if (!engine.isActiveReady()) { window.setTimeout(run, 700); return; } // let the current song buffer first
      const { order: o, pos: p, queue: q, repeat: rp } = stateRef.current;
      const c = (navigator as any).connection;
      let ahead = 1;
      if (c?.saveData || ["slow-2g", "2g"].includes(c?.effectiveType)) ahead = 0;
      else if (c?.effectiveType === "4g") ahead = 2;
      // This does not refresh a cached track's place in the eviction order (the SW
      // skips what it already has). The playing track is protected from eviction
      // by the engine's live marker (see markLive in engine/source.ts).
      const behind = 0;
      const offsets = [
        ...Array.from({ length: ahead }, (_, i) => i + 1),
        ...Array.from({ length: behind }, (_, i) => -(i + 1)),
      ];
      for (const off of offsets) {
        if (ac.signal.aborted) break;
        let ni = p + off;
        if (ni < 0 || ni >= o.length) { if (rp === "all") ni = ((ni % o.length) + o.length) % o.length; else continue; }
        const tr = q[o[ni]];
        if (!tr || tr.streamUrl || downloadedUrl(tr.id) || !engine.isActiveReady()) continue; // a download is already on the device
        if (off === 1) setPrefetchedId(tr.id);
        // Same url playback will request (bitrate-aware), so the SW cache entry hits.
        try { await fetch(liveStreamUrl(tr.id), { credentials: "same-origin", headers: { "x-lhm-prefetch": "1" }, signal: ac.signal }); } catch { /* aborted or failed */ }
      }
    };
    const t = window.setTimeout(run, 1000);
    return () => { ac.abort(); clearTimeout(t); navigator.serviceWorker.controller?.postMessage("cancelPrefetch"); };
  }, [current?.id]);

  // Gapless: tell the engine which track plays next so it can pre-buffer it.
  // Waits until the current track has buffered, so the preload does not starve
  // live playback.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    let timer: number | undefined;
    const warm = new AbortController();
    const run = async () => {
      if (cancelled) return;
      // Passive/remote: audio plays elsewhere, so no local preload.
      if (castingRef.current || (online() && !amActive())) { engine.setUpcoming(null); return; }
      if (!engine.isActiveReady()) { timer = window.setTimeout(run, 700); return; }
      const { queue: q, order: o, pos: p, repeat: rp } = stateRef.current;
      const np = nextPos(o.length, p, rp);
      const tr = np == null ? undefined : q[o[np]];
      // Get the whole next track into the cache before handing it to the engine,
      // which then preloads it from a blob with no network or service worker in the
      // path. The response is an empty 204 sent once the worker has stored the file.
      // After 20s, give up and preload from the network.
      if (tr && !isIOS() && !tr.streamUrl && !downloadedUrl(tr.id) && "serviceWorker" in navigator && navigator.serviceWorker.controller) {
        const giveUp = window.setTimeout(() => warm.abort(), 20000);
        try { await fetch(liveStreamUrl(tr.id), { credentials: "same-origin", headers: { "x-lhm-prefetch": "1" }, signal: warm.signal }); }
        catch { /* timed out, aborted, or offline: the network preload below still runs */ }
        finally { clearTimeout(giveUp); }
        if (cancelled) return;
        if (castingRef.current || (online() && !amActive())) { engine.setUpcoming(null); return; }
      }
      engine.setUpcoming(spec(tr));
    };
    timer = window.setTimeout(run, 1000);
    return () => { cancelled = true; warm.abort(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order[pos], order, queue, repeat, connected, activeDeviceId]);

  // Fetch technical audio info whenever the current track changes.
  useEffect(() => {
    if (current?.id == null) { setQuality(null); return; }
    let cancelled = false;
    setQuality(null);
    api.getQuality(current.id).then(q => { if (!cancelled) setQuality(q); }).catch(() => { if (!cancelled) setQuality(null); });
    return () => { cancelled = true; };
  }, [current?.id]);

  // Mirror live state for use inside stable audio-event handlers.
  const stateRef = useRef({ queue, order, pos, repeat, shuffle });
  stateRef.current = { queue, order, pos, repeat, shuffle };

  // Connect helpers: who controls audio right now?
  const online = () => connectedRef.current;
  const amActive = () => isActiveRef.current;
  // Casting is an explicit choice (the device picker) to control another device,
  // and the only thing that turns our controls into remote commands. It is never
  // inferred from server state, which can lag.
  const castingRef = useRef(false);
  const remote = () => online() && castingRef.current;
  // Set when casting ended with a mirrored queue whose track was never loaded
  // locally: the next play must load it at this position, not resume a stale src.
  const pendingLocalResumeRef = useRef<number | null>(null);
  // Per-track resume positions (seconds), mirrored from the server, for long-form
  // audio (books, podcasts, mixes).
  const bookmarksRef = useRef<Map<number, number>>(new Map());
  const lastBookmarkSaveRef = useRef(0);
  const lastPodcastSaveRef = useRef(0);
  const posRef = useRef(0); // latest playback position, so we can flush it on track change
  const lastClaimRef = useRef(0); // throttles source-of-truth corrections
  const lastCmdAtRef = useRef(0); // when we last sent a session command
  const lastApplyAtRef = useRef(0); // when we last received an apply directive
  // All session commands go through here so applyServerState knows our own
  // commands are still in flight.
  // `local` tells the server whether we are the device producing audio or a
  // passive controller. A local command makes the server mark us active instead
  // of relaying the command to another device.
  const sendCmd = (cmd: Record<string, unknown>) => {
    lastCmdAtRef.current = Date.now();
    return connRef.current?.command({ ...cmd, local: !castingRef.current });
  };
  // The user acted on this device, so it becomes the audio producer immediately,
  // without waiting on the server.
  const claimActive = () => {
    castingRef.current = false;
    isActiveRef.current = true;
    // Announce the claim unless the server already knows we're active (checked
    // against serverActiveIdRef, not the optimistic activeIdRef).
    const me = myIdRef.current;
    const serverKnows = serverActiveIdRef.current === me;
    activeIdRef.current = me;
    setActiveDeviceId(me);
    // Set optimistically so the transfer is not re-sent on every action.
    if (online() && !serverKnows) {
      serverActiveIdRef.current = me;
      lastCmdAtRef.current = Date.now();
      connRef.current?.transfer(me);
    }
  };
  const report = (force = false) => {
    if (!online() || !amActive()) return;
    const playback = engine.getPlaybackState();
    if (playback.positionPending) return;
    const now = Date.now();
    if (!force && now - lastReportRef.current < 4000) return;
    lastReportRef.current = now;
    connRef.current?.reportPosition(playback.currentTime, playback.playing);
  };

  // Playback intent: whether this device means to be playing, independent of the
  // engine pausing on a network error. The engine reads it to decide whether to
  // resume a stalled stream. Connect reads and sets it.
  const wantPlayRef = useRef(false);
  // The URL live playback requests for a track at the current quality. Prefetch,
  // playback and preload all use it so they share one SW cache entry.
  const liveStreamUrl = (trackId: number) => {
    const br = resolveBitrate(streamQualityRef.current);
    return br ? api.streamUrl(trackId, br) : api.streamUrl(trackId);
  };
  // Load the track at order position `p` as the active source. Autoplay records a
  // play and sets intent, a paused load (session restore) clears it.
  function loadByPos(q: Track[], ord: number[], p: number, resumeAt = 0, autoplay = true) {
    const track = q[ord[p]];
    if (!track) return;
    stateRef.current = { ...stateRef.current, queue: q, order: ord, pos: p };
    pendingLocalResumeRef.current = null;
    setPlaybackInstance(v => v + 1);
    wantPlayRef.current = autoplay;
    if (autoplay && !track.isRadio && !track.isPodcast) api.recordPlay(track.id); // radio/podcast aren't library tracks
    // No explicit resume point: use the track's saved bookmark, if any.
    const resume = resumeAt || bookmarksRef.current.get(track.id) || 0;
    engine.load(spec(track)!, { resumeAt: resume, autoplay });
  }

  // Load a stream by track id (Connect `apply load` directives + handoff),
  // independent of the local queue arrays.
  function loadStream(trackId: number, resumeAt: number, play: boolean) {
    pendingLocalResumeRef.current = null;
    setPlaybackInstance(v => v + 1);
    wantPlayRef.current = play;
    if (play && trackId > 0) api.recordPlay(trackId);
    // Add metadata if the track is in our queue (for the native lock screen).
    const t = stateRef.current.queue.find(x => x.id === trackId);
    engine.load(spec(t) ?? { trackId }, { resumeAt, autoplay: play });
  }

  // Guest side of a Session: mirror the host's playback. The host stamps `at`, so
  // the target is position plus time in flight. Only drift over 1.5s is corrected.
  function mirrorSession(m: SessionSync) {
    if (sessionRef.current?.role !== "guest") return;
    const cur = stateRef.current;
    // Show the host's shuffle/repeat on the guest (display only).
    if (cur.shuffle !== !!m.shuffle) setShuffle(!!m.shuffle);
    if (cur.repeat !== m.repeat) setRepeat(m.repeat);
    if (!m.track) return;
    // Project the host's position forward at the host's playback rate. Assuming 1x
    // would read as constant drift and re-seek on every heartbeat.
    const rate = m.rate && Number.isFinite(m.rate) && m.rate > 0 ? m.rate : 1;
    setHostRate(rate); // the rate effect mirrors it onto the engine
    const target = Math.max(0, m.positionMs / 1000 + (m.playing ? ((Date.now() - m.at) / 1000) * rate : 0));
    const curTrack = cur.queue[cur.order[cur.pos]];
    if (!curTrack || curTrack.id !== m.track.id) {
      stateRef.current = { ...cur, queue: [m.track as Track], order: [0], pos: 0 };
      setQueue([m.track as Track]); setOrder([0]); setPos(0);
      loadStream(m.track.id, target, m.playing);
    } else {
      if (Math.abs(engine.getCurrentTime() - target) > 1.5) engine.seek(target);
      wantPlayRef.current = m.playing;
      if (m.playing && engine.isPaused()) { wantPlayRef.current = true; engine.play(); }
      else if (!m.playing) { engine.pause(); }
    }
  }

  // A session guest mirrors the host and can't drive playback. The mirror calls
  // engine.* directly, so it is not blocked by this.
  const isGuest = () => sessionRef.current?.role === "guest";
  // Push our playback to the session (host only). Used by the heartbeat and on seek.
  const hostPush = () => {
    if (sessionRef.current?.role !== "host") return;
    const cur = stateRef.current;
    const t = cur.queue[cur.order[cur.pos]];
    const track = t ? { ...t } : null;
    connRef.current?.sendSessionState(track, Math.round(engine.getCurrentTime() * 1000), !engine.isPaused(), cur.shuffle, cur.repeat, effRateRef.current);
  };

  function goNext(fromEnded = false) {
    const { queue: q, order: o, pos: pp, repeat: rp } = stateRef.current;
    if (fromEnded && rp === "one") { setPlaybackInstance(v => v + 1); engine.seek(0); wantPlayRef.current = true; engine.play(); return; }
    const np = nextPos(o.length, pp, !fromEnded && rp === "one" ? "off" : rp);
    // End of the queue: clear intent only. The engine reports the playing state.
    if (np == null) { if (fromEnded) wantPlayRef.current = false; return; }
    const tr = q[o[np]];
    if (!tr) return;
    // The engine swaps to the preloaded upcoming track if ready (gapless), else
    // loads it.
    stateRef.current = { ...stateRef.current, pos: np };
    setPos(np);
    setPlaybackInstance(v => v + 1);
    wantPlayRef.current = true;
    if (tr.id > 0) api.recordPlay(tr.id);
    engine.goToUpcoming(spec(tr)!);
  }

  function goPrev() {
    if (engine.getCurrentTime() > 3) { engine.seek(0); return; }
    const { queue: q, order: o, pos: pp, repeat: rp } = stateRef.current;
    let np = pp - 1;
    if (np < 0) { if (rp === "all") np = o.length - 1; else return; }
    setPos(np); loadByPos(q, o, np);
  }

  // While held (e.g. lyrics sync open), don't auto-advance past the track's end.
  const holdRef = useRef(false);

  // Latest goNext for the ended handler, which is registered once.
  const endedRef = useRef<() => void>(() => {});
  endedRef.current = () => {
    if (holdRef.current) { wantPlayRef.current = false; return; } // intent only
    goNext(true);
    if (online() && amActive()) sendCmd({ action: "ended" });
  };

  // Native lock-screen / notification / Bluetooth next and prev arrive as engine
  // events and run the same next()/prev() as an in-app tap. Refs because next/prev
  // are defined below.
  const remoteNextRef = useRef<() => void>(() => {});
  const remotePrevRef = useRef<() => void>(() => {});

  // The engine crossfaded into the upcoming track on its own. Move the queue
  // cursor to match, record the play, and tell Connect the track ended.
  const trackChangedRef = useRef<() => void>(() => {});
  trackChangedRef.current = () => {
    const { queue: q, order: o, pos: pp, repeat: rp } = stateRef.current;
    const np = nextPos(o.length, pp, rp);
    if (np == null) return;
    const tr = q[o[np]];
    stateRef.current = { ...stateRef.current, pos: np };
    setPos(np);
    setPlaybackInstance(v => v + 1);
    if (tr && tr.id > 0) api.recordPlay(tr.id);
    if (online() && amActive()) sendCmd({ action: "ended" });
  };

  // Connect message handlers.
  function applyServerState(s: SessionState) {
    const myId = myIdRef.current; // this closure is captured at mount, so read the ref
    // Keep the server's view of who is active (may be none) current before any branch.
    serverActiveIdRef.current = s.activeDeviceId ?? null;
    // The device producing audio is the source of truth. A lagging broadcast must
    // not move it: push our state up if it differs, never adopt queue/pos from it.
    if (wantPlayRef.current) {
      const st = stateRef.current;
      const stale = s.activeDeviceId !== myId || s.pos !== st.pos || (s.queue?.length ?? 0) !== st.queue.length;
      // Quiet window: while our own commands or freshly received apply directives
      // are in flight, an older broadcast looks stale. Correcting off it would
      // undo the user's skips or revert a remote's switch.
      const quiet = Date.now() - lastCmdAtRef.current > 1500 && Date.now() - lastApplyAtRef.current > 1500;
      // Modes come from stateRef (render-scope values here are first-render ones).
      // Rate-limited, since a correction triggers a broadcast and two devices that
      // both think they are playing could loop.
      if (stale && quiet && Date.now() - lastClaimRef.current > 2000) {
        lastClaimRef.current = Date.now();
        sendCmd({ action: "playNow", claim: true, queue: st.queue, order: st.order, pos: st.pos, shuffle: st.shuffle, repeat: st.repeat });
      }
      setActiveDeviceId(myId); activeIdRef.current = myId; isActiveRef.current = true;
      castingRef.current = false; // we produce audio, so our controls are local
      setVol(s.volume); engine.setVolume(s.volume);
      return;
    }
    // An idle device (paused, nothing pending) becomes a passive controller of a
    // session that is live on another device: it mirrors the queue and its
    // controls act remotely. A device that is playing is never demoted (above).
    const remoteActive = !!s.activeDeviceId && s.activeDeviceId !== myId;
    if (!castingRef.current && remoteActive && (s.queue?.length ?? 0) > 0 && engine.isPaused()) {
      castingRef.current = true;
      engine.setUpcoming(null); // audio is now remote, drop the local preload
    }
    // When the remote player goes away, stop casting but keep the mirrored queue,
    // so Play resumes it here. Local audio has no src for that track yet, so
    // remember the position to load at.
    if (castingRef.current && !remoteActive) {
      castingRef.current = false;
      pendingLocalResumeRef.current = s.position || 0;
    }
    // Not casting: this device owns its own audio. Ignore who the server thinks is
    // active (it may be a stale device).
    if (!castingRef.current) {
      setActiveDeviceId(myId);
      activeIdRef.current = myId;
      isActiveRef.current = true;
      setVol(s.volume);
      engine.setVolume(s.volume);
      // While idle, adopt the shared session (paused) when it differs from what we
      // show, so every device shows the same last-played queue.
      if (!wantPlayRef.current && engine.isPaused() && (s.queue?.length ?? 0) > 0) {
        const st = stateRef.current;
        const localCur = st.queue[st.order[st.pos]]?.id;
        const remoteCur = s.queue?.[s.order?.[s.pos]]?.id;
        if (localCur !== remoteCur || s.queue.length !== st.queue.length) {
          setQueue(s.queue); setOrder(s.order); setPos(s.pos);
          setShuffle(s.shuffle); setRepeat(s.repeat);
          setPlaying(false);
          setCurrentTime(s.position || 0);
          setDuration(s.queue[s.order[s.pos]]?.duration || 0);
          pendingLocalResumeRef.current = s.position || 0; // Play must load, not resume a stale src
        }
      }
      return;
    }
    // Casting: mirror the active (other) device for display, silence local audio.
    setActiveDeviceId(s.activeDeviceId);
    activeIdRef.current = s.activeDeviceId;
    isActiveRef.current = false;
    setQueue(s.queue);
    setOrder(s.order);
    setPos(s.pos);
    setShuffle(s.shuffle);
    setRepeat(s.repeat);
    setVol(s.volume);
    engine.pause(); wantPlayRef.current = false;
    setPlaying(s.isPlaying);
    const t = s.queue[s.order[s.pos]];
    const dur = t?.duration || 0;
    remotePosRef.current = { base: s.position, baseAt: Date.now(), isPlaying: s.isPlaying, dur };
    setCurrentTime(dur ? Math.min(s.position, dur) : s.position);
    setDuration(dur);
  }

  function onApply(a: ApplyMsg) {
    const myId = myIdRef.current; // see applyServerState
    // Holds off corrections until React has committed this directive to stateRef.
    lastApplyAtRef.current = Date.now();
    // Apply directives only go to the active device, so one that starts audio
    // means we are the player. A push-transfer delivers its load before the state
    // broadcast, so casting must be cleared here or our controls stay remote.
    if (a.action === "load" || a.action === "play") {
      castingRef.current = false;
      isActiveRef.current = true;
      activeIdRef.current = myId;
      serverActiveIdRef.current = myId; // the server told us to play, so it knows we're active
      setActiveDeviceId(myId);
    }
    switch (a.action) {
      case "load":
        // Move the queue cursor with the load (the remote skipped or jumped).
        if (typeof a.pos === "number" && stateRef.current.order[a.pos] != null) setPos(a.pos);
        loadStream(a.trackId, a.position || 0, a.play);
        break;
      case "play": wantPlayRef.current = true; engine.play(); break;
      case "pause": case "stop":
        // Remote pause, or playback transferred away. Play intent must be cleared,
        // or this device treats every broadcast as stale and re-claims the session.
        wantPlayRef.current = false;
        engine.pause();
        break;
      case "seek": engine.seek(a.position || 0); setCurrentTime(a.position || 0); break;
      case "setVolume": engine.setVolume(a.volume); setVol(a.volume); break;
      case "queue": // remote queue edit: adopt the arrays, leave audio alone
        if (!Array.isArray(a.order)) break;
        if (Array.isArray(a.queue)) setQueue(a.queue);
        setOrder(a.order);
        if (typeof a.pos === "number") setPos(Math.max(0, Math.min(a.pos, a.order.length - 1)));
        if (typeof a.shuffle === "boolean") setShuffle(a.shuffle);
        break;
      case "mode":
        if (typeof a.shuffle === "boolean") setShuffle(a.shuffle);
        if (a.repeat) setRepeat(a.repeat);
        break;
    }
  }

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    engine.attach?.();
    let lastSaved = 0;
    // Load saved resume positions. Bookmarks are stored in ms, the player uses seconds.
    api.getBookmarks()
      .then((rows: any[]) => { for (const b of rows) bookmarksRef.current.set(b.trackId, (b.position ?? 0) / 1000); })
      .catch(() => {});
    // Project the engine's snapshot onto React state, Connect position reports and
    // persistence. Nothing is accumulated from separate play/pause events.
    let wasPlaying = false;
    let wasPositionPending = false;
    const onState = (s: import("./engine/types").PlaybackState) => {
      setPlaybackError(s.error ?? null);
      setBuffering(s.buffering);
      setReconnecting(s.reconnecting);
      // A remote view's progress comes from server ticks, not our idle engine.
      if (!amActive() && online()) return;
      setPlaying(s.playing);
      setDuration(s.duration);
      setCurrentTime(s.currentTime);
      setBuffered(s.buffered);
      posRef.current = s.currentTime;
      const settledPosition = wasPositionPending && !s.positionPending;
      wasPositionPending = !!s.positionPending;
      if (s.positionPending) return;
      // Started/stopped transition, derived from the state.
      if (s.playing !== wasPlaying) {
        wasPlaying = s.playing;
        report(true);
        if (!s.playing) saveTime(s.currentTime);
      } else {
        report(settledPosition);
      }
      if (Math.abs(s.currentTime - lastSaved) >= 4) { lastSaved = s.currentTime; saveTime(s.currentTime); }
      maybeBookmark(s.currentTime);
      maybePodcast(s.currentTime);
    };
    // Podcast episodes save resume progress server-side, at most every 15s. Within
    // 20s of the end the episode is marked played.
    const maybePodcast = (t: number) => {
      if (!amActive()) return;
      const cur = stateRef.current.queue[stateRef.current.order[stateRef.current.pos]];
      if (!cur?.isPodcast || cur.podcastEpisodeId == null) return;
      const now = Date.now();
      if (now - lastPodcastSaveRef.current < 15000) return;
      lastPodcastSaveRef.current = now;
      const dur = cur.duration ?? 0;
      const done = dur > 0 && t >= dur - 20;
      api.savePodcastProgress(cur.podcastEpisodeId, done ? 0 : Math.round(t * 1000), done).catch(() => {});
    };
    // Save a per-track resume position for long audio (books, mixes), at most every
    // 15s. Near the end it is cleared so a finished item starts fresh.
    const BOOKMARK_MIN = 20 * 60; // seconds. Audiobooks are bookmarked at any length.
    const maybeBookmark = (t: number) => {
      if (!amActive()) return;
      const cur = stateRef.current.queue[stateRef.current.order[stateRef.current.pos]];
      const dur = cur?.duration ?? 0;
      if (!cur || (!cur.isAudiobook && dur < BOOKMARK_MIN)) return; // books always bookmark
      const now = Date.now();
      if (now - lastBookmarkSaveRef.current < 15000) return;
      lastBookmarkSaveRef.current = now;
      if (t >= dur - 15) { // near the end, drop the bookmark
        if (bookmarksRef.current.delete(cur.id)) api.deleteBookmark(cur.id).catch(() => {});
      } else {
        bookmarksRef.current.set(cur.id, t);
        api.saveBookmark(cur.id, Math.round(t * 1000)).catch(() => {});
      }
    };
    const onEnded = () => endedRef.current();
    const onTrackChanged = () => trackChangedRef.current();
    const onRemoteNext = () => remoteNextRef.current();
    const onRemotePrev = () => remotePrevRef.current();
    engine.on("state", onState);
    engine.on("ended", onEnded);
    engine.on("trackChanged", onTrackChanged);
    engine.on("remoteNext", onRemoteNext);
    engine.on("remotePrev", onRemotePrev);
    engine.setCrossfade(crossfade);

    // Restore the last session (validated in playerStorage).
    const prefs = restorePrefs();
    if (prefs.autoDJMode) setAutoDJMode(prefs.autoDJMode as AutoDJMode);
    if (prefs.autoDJUnit) setAutoDJUnit(prefs.autoDJUnit as AutoDJUnit);
    if (prefs.autoDJSongCount != null) setAutoDJSongCount(prefs.autoDJSongCount);
    if (prefs.autoDJAlbumCount != null) setAutoDJAlbumCount(prefs.autoDJAlbumCount);
    if (prefs.weightedShuffle != null) setWeightedShuffle(prefs.weightedShuffle);
    const restored = restoreQueue();
    if (restored) {
      setQueue(restored.queue); setOrder(restored.order); setPos(restored.pos);
      setShuffle(restored.shuffle);
      setRepeat(restored.repeat);
      setVol(restored.volume); engine.setVolume(restored.volume);
      setCurrentTime(restored.currentTime);
      loadByPos(restored.queue, restored.order, restored.pos, restored.currentTime, false); // paused
    }

    // Open the Connect channel (no-op without a WebSocket impl, e.g. jsdom tests).
    if (typeof WebSocket !== "undefined" && typeof location !== "undefined") {
      const client = new ConnectClient({
        onState: applyServerState,
        onDevices: setDevices,
        onApply,
        // Our connId was claimed by another socket (duplicated tab) and we took a
        // new one. Forget any active-device belief keyed to the old id.
        onConnIdChanged: (id) => {
          myIdRef.current = id;
          setMyId(id);
          serverActiveIdRef.current = null;
        },
        onPosition: (p) => {
          if (amActive()) return;
          remotePosRef.current = { ...remotePosRef.current, base: p.position, baseAt: Date.now(), isPlaying: p.isPlaying };
          setPlaying(p.isPlaying);
          setCurrentTime(Math.min(remotePosRef.current.dur || Infinity, Math.max(0, p.position)));
        },
        // Volume changed on another device.
        onVolume: (v) => { setVol(v); engine.setVolume(v); },
        onStatus: (c) => {
          const was = connectedRef.current;
          connectedRef.current = c; setConnected(c);
          if (!c) setOnlineUsers([]); // socket dropped, clear the presence roster
          // Reconnected while playing: commands sent during the gap were lost, so
          // push our state up.
          if (c && !was) {
            if (wantPlayRef.current) {
              const st = stateRef.current;
              sendCmd({ action: "playNow", claim: true, queue: st.queue, order: st.order, pos: st.pos, shuffle: st.shuffle, repeat: st.repeat });
            }
            // Reconnected mid-session: the host resumes its session (the server
            // holds it open), a guest re-joins.
            const sess = sessionRef.current;
            if (sess) {
              if (sess.role === "host") connRef.current?.resumeSession(sess.code);
              else connRef.current?.joinSession(sess.code, undefined, nightcoreSupported());
            }
          }
        },
        // Sessions
        onSessionCreated: (code) => { setSessionError(null); setSession(s => (s?.role === "host" ? { ...s, hostAway: false } : { code, role: "host", members: [] })); },
        onSessionJoined: ({ code, host }) => { setSessionError(null); setSession({ code, role: "guest", host, members: [] }); },
        onSessionMembers: (members, nightcoreOk) => setSession(s => (s ? { ...s, members, nightcoreOk } : s)),
        onSessionSync: (m) => { setSession(s => (s?.hostAway ? { ...s, hostAway: false } : s)); mirrorSession(m); },
        onSessionEnded: () => setSession(null),
        onSessionError: (err) => { setSession(null); setSessionError(err); },
        onSessionHostAway: () => setSession(s => (s ? { ...s, hostAway: true } : s)),
        // Presence
        onPresence: setOnlineUsers,
        onJoinRequest: (r) => setJoinRequest(r),
        // Request accepted, or we accepted an invite: run the normal join. Audio
        // was unlocked by the Ask/Accept tap.
        onJoinApproved: ({ code }) => { engine.unlock(); connRef.current?.joinSession(code, undefined, nightcoreSupported()); },
        onJoinDeclined: ({ fromName }) => showNote(`${fromName} declined your request.`),
        onInvite: (inv) => setInvite(inv),
        onPresenceError: (err) => showNote(err),
        onPresenceSelf: (sharing) => setShareActivityState(sharing),
      });
      connRef.current = client;
      client.start();
    }

    return () => {
      engine.off("state", onState);
      engine.off("ended", onEnded);
      engine.off("trackChanged", onTrackChanged);
      engine.off("remoteNext", onRemoteNext);
      engine.off("remotePrev", onRemotePrev);
      wantPlayRef.current = false;
      engine.pause();
      // StrictMode reattaches this same instance synchronously. A real unmount
      // does not, so dispose in a microtask.
      queueMicrotask(() => { if (lifecycleRef.current === lifecycle) engine.dispose(); });
      connRef.current?.stop();
      connRef.current = null;
    };
  }, []);

  // Smooth progress on remote (non-active) devices between server position ticks.
  useEffect(() => {
    const id = setInterval(() => {
      if (!online() || amActive()) return;
      const r = remotePosRef.current;
      if (r.isPlaying) {
        const t = r.base + (Date.now() - r.baseAt) / 1000;
        setCurrentTime(r.dur ? Math.min(t, r.dur) : t); // never run past the track length
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Persist order + pos so queue edits survive a reload. queueIndex is a fallback
  // for older saved state.
  useEffect(() => {
    save({ queue, order, pos, queueIndex: order[pos] ?? 0, volume, shuffle, repeat, weightedShuffle });
  }, [queue, order, pos, volume, shuffle, repeat, weightedShuffle]);

  // Persist Auto DJ preferences (mode/unit/count). The on/off state is not saved,
  // so a restored queue is never auto-extended.
  useEffect(() => {
    save({ autoDJMode, autoDJUnit, autoDJSongCount, autoDJAlbumCount });
  }, [autoDJMode, autoDJUnit, autoDJSongCount, autoDJAlbumCount]);

  // Auto DJ: when the queue runs low, append more tracks. Only the device
  // producing audio does this, not a remote controller.
  useEffect(() => {
    if (!autoDJ || remote()) return;
    const remaining = order.length - 1 - pos;
    if (remaining > 3 || autoDJRef.current) return;
    const seed = queue[order[pos]];
    // Similar modes need a current song to seed from.
    if (autoDJMode.startsWith("similar") && !seed) return;
    autoDJRef.current = true;
    const generation = queueGeneration.current;
    let cancelled = false;
    api.getAutoDJ({ mode: autoDJMode, unit: autoDJUnit, count: autoDJCount, seed: seed?.id })
      .then((rows: Track[]) => { if (!cancelled && generation === queueGeneration.current) appendTracks(rows || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) autoDJRef.current = false; });
    return () => { cancelled = true; autoDJRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDJ, pos, order.length, autoDJMode, autoDJUnit, autoDJCount]);

  // Load the user's ratings + favorites once, for the now-playing controls.
  useEffect(() => {
    api.getLibraryState().then((s: any) => setRatings(s.ratings || {})).catch(() => {});
    api.getFavorites().then((f: any[]) => setFavIds(new Set(f.map(t => t.id)))).catch(() => {});
  }, [libraryVersion]);

  // Host side of a Session: push playback state on every track/play change, plus a
  // 5s heartbeat so guests can drift-correct.
  useEffect(() => {
    if (session?.role !== "host") return;
    hostPush();
    const iv = setInterval(hostPush, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.role, current?.id, isPlaying, shuffle, repeat]);

  // `startAt` (seconds) starts playback at a position, e.g. an audiobook chapter
  // inside a single-file .m4b.
  const playNow = (tracks: Track[], i: number, startAt = 0) => {
    if (isGuest()) return; // guests follow the host
    queueGeneration.current++;
    const { order: ord, pos: p } = buildPlayOrder(tracks.length, i, shuffle, weightsFor(tracks));
    if (remote()) {
      // Casting: the song plays on the active device, not here. Mirror the new
      // queue optimistically. The server's state broadcast confirms it.
      setQueue(tracks); setOrder(ord); setPos(p);
      setPlaying(true); setCurrentTime(startAt);
      const dur = tracks[ord[p]]?.duration || 0;
      setDuration(dur);
      remotePosRef.current = { base: startAt, baseAt: Date.now(), isPlaying: true, dur };
      sendCmd({ action: "playNow", queue: tracks, order: ord, pos: p, shuffle, repeat });
      if (startAt) sendCmd({ action: "seek", position: startAt });
      return;
    }
    claimActive(); // must run before anything reads amActive()
    setQueue(tracks); setOrder(ord); setPos(p);
    loadByPos(tracks, ord, p, startAt, true); // local: start within the user gesture
    if (online()) sendCmd({ action: "playNow", claim: true, queue: tracks, order: ord, pos: p, shuffle, repeat });
  };
  const play = () => {
    if (isGuest()) return;
    if (remote()) { sendCmd({ action: "play" }); return; }
    claimActive();
    // Session handed back from another device: load its track/position first.
    if (pendingLocalResumeRef.current != null && engine.isPaused()) {
      const at = pendingLocalResumeRef.current;
      pendingLocalResumeRef.current = null;
      const st = stateRef.current;
      if (st.queue[st.order[st.pos]]) {
        loadByPos(st.queue, st.order, st.pos, at, true);
        if (online()) sendCmd({ action: "play" });
        return;
      }
    }
    wantPlayRef.current = true;
    engine.play();
    if (online()) sendCmd({ action: "play" });
  };
  const pause = () => {
    if (isGuest()) return;
    if (remote()) { sendCmd({ action: "pause" }); return; }
    wantPlayRef.current = false;
    engine.pause();
    if (online()) sendCmd({ action: "pause" });
  };
  // Follows what the transport is doing (what the button shows), not the last
  // intent. iOS can pause the element itself (a call, another app's audio, a
  // route change) while intent stays set.
  const toggle = () => {
    if (remote()) { if (remotePosRef.current.isPlaying) pause(); else play(); return; }
    const s = engine.getPlaybackState();
    const busy = s.playing || s.buffering || s.reconnecting || !!s.positionPending;
    if (wantPlayRef.current && busy) pause(); else play();
  };
  const getTransportState = () => {
    if (!remote()) return engine.getPlaybackState();
    const r = remotePosRef.current;
    return { playing: r.isPlaying, duration: r.dur, currentTime: Math.min(r.dur || Infinity, r.base + (r.isPlaying ? (Date.now() - r.baseAt) / 1000 : 0)) };
  };
  // Lets OS controls read a newly promoted track before React commits the queue
  // cursor. Background audio events do not wait for a render.
  const getMediaSessionState = () => {
    const q = stateRef.current;
    const local = engine.getPlaybackState();
    const current = (remote() || local.trackId == null) ? q.queue[q.order[q.pos]] : q.queue.find(t => t.id === local.trackId);
    return { ...getTransportState(), current, effectiveRate: effRateRef.current };
  };
  const subscribeTransport = (listener: () => void) => {
    engine.on("state", listener);
    return () => engine.off("state", listener);
  };
  const seek = (t: number) => {
    if (isGuest()) return;
    if (remote()) {
      // Move the mirrored playhead optimistically: the server's confirming
      // position tick excludes the sender.
      remotePosRef.current = { ...remotePosRef.current, base: t, baseAt: Date.now() };
      setCurrentTime(t);
      sendCmd({ action: "seek", position: t });
      return;
    }
    engine.seek(t); setCurrentTime(t);
    if (online()) sendCmd({ action: "seek", position: t });
    hostPush(); // send a seek to session guests right away
  };
  const setVolume = (v: number) => {
    if (remote()) { setVol(v); sendCmd({ action: "setVolume", volume: v }); return; }
    engine.setVolume(v); setVol(v);
    if (online()) sendCmd({ action: "setVolume", volume: v });
  };

  const next = () => {
    if (isGuest()) return;
    if (remote()) { sendCmd({ action: "next" }); return; }
    claimActive(); goNext(false); if (online()) sendCmd({ action: "next" });
  };
  const prev = () => {
    if (isGuest()) return;
    if (remote()) { sendCmd({ action: "prev" }); return; }
    claimActive(); goPrev(); if (online()) sendCmd({ action: "prev" });
  };
  remoteNextRef.current = next;
  remotePrevRef.current = prev;

  const toggleShuffle = () => {
    if (isGuest()) return;
    const ns = !shuffle;
    const curQueueIdx = order[pos] ?? 0;
    const { order: ord, pos: p } = buildPlayOrder(queue.length, curQueueIdx, ns, weightsFor(queue));
    if (remote()) { sendCmd({ action: "shuffle", shuffle: ns, order: ord, pos: p }); return; }
    setShuffle(ns); setOrder(ord); setPos(p);
    if (online()) sendCmd({ action: "shuffle", shuffle: ns, order: ord, pos: p });
  };
  const cycleRepeat = () => {
    if (isGuest()) return;
    const nr: RepeatMode = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
    if (remote()) { sendCmd({ action: "repeat", repeat: nr }); return; }
    setRepeat(nr);
    if (online()) sendCmd({ action: "repeat", repeat: nr });
  };
  const setHold = (on: boolean) => { holdRef.current = on; engine.setHold(on); };
  // Audio diagnostics for the debug overlay.
  const getAudioDiag = () => engine.getAudioDiag();

  // Add a track right after the current one ("play next") or at the end ("add to
  // queue"), without disturbing what's playing.
  const addToQueueAt = (track: Track, where: "next" | "end") => {
    const { queue, order, pos } = stateRef.current;
    if (order.length === 0) return playNow([track], 0); // nothing queued, just play it
    const qi = queue.length;
    const nq = [...queue, track];
    const insertAt = where === "next" ? Math.min(order.length, pos + 1) : order.length;
    const no = order.slice(); no.splice(insertAt, 0, qi);
    if (remote()) { sendCmd({ action: "queue", queue: nq, order: no, pos }); return; }
    stateRef.current = { ...stateRef.current, queue: nq, order: no, pos };
    setQueue(nq); setOrder(no);
    if (online()) sendCmd({ action: "queue", queue: nq, order: no, pos });
  };
  const playNext = (track: Track) => addToQueueAt(track, "next");
  const addToQueue = (track: Track) => addToQueueAt(track, "end");
  // Bulk append (whole album/list) in one state update. A loop of addToQueue would
  // reuse the same stale closure and keep only the last track.
  const addManyToQueue = (tracks: Track[]) => {
    const { queue, order, pos } = stateRef.current;
    if (!tracks.length) return;
    if (order.length === 0) return playNow(tracks, 0); // nothing queued, just play them
    const base = queue.length;
    const nq = [...queue, ...tracks];
    const no = [...order, ...tracks.map((_, i) => base + i)];
    if (remote()) { sendCmd({ action: "queue", queue: nq, order: no, pos }); return; }
    stateRef.current = { ...stateRef.current, queue: nq, order: no, pos };
    setQueue(nq); setOrder(no);
    if (online()) sendCmd({ action: "queue", queue: nq, order: no, pos });
  };

  // Append tracks to the end of the queue (Auto DJ). Skips ids already queued.
  const appendTracks = (extra: Track[]) => {
    const { queue, order, pos } = stateRef.current;
    const have = new Set(queue.map(t => t.id));
    const fresh = extra.filter(t => { if (!t || have.has(t.id)) return false; have.add(t.id); return true; });
    if (!fresh.length) return;
    const startIdx = queue.length;
    const nq = [...queue, ...fresh];
    const no = [...order, ...fresh.map((_, i) => startIdx + i)];
    if (remote()) { sendCmd({ action: "queue", queue: nq, order: no, pos }); return; }
    stateRef.current = { ...stateRef.current, queue: nq, order: no, pos };
    setQueue(nq); setOrder(no);
    if (online()) sendCmd({ action: "queue", queue: nq, order: no, pos });
  };

  // "Start radio": play the seed now (inside the click gesture) and turn Auto DJ
  // on. The auto-extend effect then fills the near-empty queue from this song.
  const startRadio = (seed: Track) => {
    setAutoDJ(true);
    playNow([seed], 0);
  };

  // Sessions (listen together).
  // engine.unlock() runs inside the tap so a later programmatic play is allowed
  // to make sound on iOS.
  const startSession = () => { setSessionError(null); engine.unlock(); connRef.current?.createSession(undefined, nightcoreSupported()); };
  const joinSession = (code: string) => { if (!code.trim()) return; setSessionError(null); engine.unlock(); connRef.current?.joinSession(code.trim(), undefined, nightcoreSupported()); };
  const leaveSession = () => { connRef.current?.leaveSession(); setSession(null); };

  // Presence ask-to-join / invite
  const showNote = (msg: string) => {
    setPresenceNote(msg);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setPresenceNote(null), 4500);
  };
  // Unlock audio inside the tap, for the mirror-play after approval.
  const askToJoin = (userId: number) => { engine.unlock(); connRef.current?.requestJoin(userId); showNote("Request sent…"); };
  const inviteUser = (userId: number) => { connRef.current?.invitePresence(userId); showNote("Invite sent…"); };
  const respondJoin = (userId: number, accept: boolean) => {
    connRef.current?.respondJoin(userId, accept);
    setJoinRequest(r => (r?.fromUserId === userId ? null : r));
  };
  const acceptInvite = () => { if (!invite) return; engine.unlock(); connRef.current?.joinSession(invite.code, undefined, nightcoreSupported()); setInvite(null); };
  const dismissInvite = () => setInvite(null);
  const dismissPresenceNote = () => setPresenceNote(null);
  // Optimistic. The server echoes presence:self to confirm or correct.
  const setShareActivity = (share: boolean) => { setShareActivityState(share); connRef.current?.setSharing(share); };

  // Rate / favorite the current track (optimistic, reverts on failure).
  const rateCurrent = (n: number) => {
    if (!current) return;
    const id = current.id, prev = ratings[id] ?? 0;
    setRatings(r => ({ ...r, [id]: n }));
    api.rateTrack(id, n).catch(() => setRatings(r => ({ ...r, [id]: prev })));
  };
  const toggleCurrentFav = () => {
    if (!current) return;
    const id = current.id, had = favIds.has(id);
    setFavIds(s => { const x = new Set(s); if (had) x.delete(id); else x.add(id); return x; });
    (had ? api.removeFavorite(id) : api.addFavorite(id))
      .catch(() => setFavIds(s => { const x = new Set(s); if (had) x.add(id); else x.delete(id); return x; }));
  };

  // Sleep timer: pause playback after N minutes.
  const sleepRef = useRef<number | undefined>(undefined);
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  const setSleep = (minutes: number | null) => {
    if (sleepRef.current) { clearTimeout(sleepRef.current); sleepRef.current = undefined; }
    if (!minutes) { setSleepAt(null); return; }
    sleepRef.current = window.setTimeout(() => {
      if (remote()) sendCmd({ action: "pause" });
      else { wantPlayRef.current = false; engine.pause(); if (online()) sendCmd({ action: "pause" }); }
      sleepRef.current = undefined; setSleepAt(null);
    }, minutes * 60000);
    setSleepAt(Date.now() + minutes * 60000);
  };

  const jumpTo = (op: number) => {
    if (isGuest()) return;
    if (order[op] == null) return;
    if (remote()) { sendCmd({ action: "jumpTo", pos: op }); return; }
    claimActive(); setPos(op); loadByPos(queue, order, op);
    if (online()) sendCmd({ action: "jumpTo", pos: op });
  };
  const removeFromQueue = (op: number) => {
    if (order[op] == null) return;
    const no = order.slice(); no.splice(op, 1);
    let np = pos; let reload = false;
    if (op === pos) { np = Math.min(pos, no.length - 1); reload = true; }
    else if (op < pos) np = pos - 1;
    if (remote()) { sendCmd({ action: "queue", order: no, pos: np }); return; }
    setOrder(no);
    if (no.length === 0) {
      // Queue emptied: stop, or audio keeps playing with no track on screen.
      setPos(0);
      wantPlayRef.current = false;
      engine.stop(); // clears the active and preloaded sources and
                     // publishes the cleared state
    } else {
      setPos(np);
      // Keep the current play/pause state.
      if (reload && no[np] != null) loadByPos(queue, no, np, 0, wantPlayRef.current);
    }
    if (online()) sendCmd({ action: "queue", order: no, pos: np });
  };
  const reorderQueue = (from: number, to: number) => {
    if (from === to || order[from] == null) return;
    const curTrackIdx = order[pos];
    const no = order.slice();
    const [m] = no.splice(from, 1); no.splice(to, 0, m);
    const np = no.indexOf(curTrackIdx);
    if (remote()) { sendCmd({ action: "queue", order: no, pos: np >= 0 ? np : pos }); return; }
    setOrder(no);
    if (np >= 0) setPos(np);
    if (online()) sendCmd({ action: "queue", order: no, pos: np >= 0 ? np : pos });
  };

  // Handoff / device management
  const transferTo = (deviceId: string) => {
    if (deviceId === myIdRef.current) {
      if (!remote() && amActive()) return;
      // Pull: start audio locally inside this click gesture (needed on iOS), then claim.
      const t = queue[order[pos]];
      const r = remotePosRef.current;
      const at = r.isPlaying ? r.base + (Date.now() - r.baseAt) / 1000 : r.base;
      castingRef.current = false;
      isActiveRef.current = true;
      activeIdRef.current = myIdRef.current;
      setActiveDeviceId(myIdRef.current);
      serverActiveIdRef.current = myIdRef.current; // the transfer below tells the server
      if (t) loadStream(t.id, at, r.isPlaying || isPlaying);
      // Report what we loaded. If our mirror was stale, the server answers with a
      // corrective load.
      lastCmdAtRef.current = Date.now();
      connRef.current?.transfer(deviceId, t?.id);
      return;
    } else {
      // Explicit cast to another device: from here our controls are remote.
      // Pause and clear intent now, not on the server's echo, or this device
      // re-claims the session on every broadcast.
      if (!remote()) {
        report(true); // publish the current clock before relinquishing ownership
        const playback = engine.getPlaybackState();
        remotePosRef.current = { base: playback.currentTime, baseAt: Date.now(), isPlaying: playback.positionPending ? wantPlayRef.current : playback.playing, dur: playback.duration };
      }
      castingRef.current = true;
      isActiveRef.current = false;
      wantPlayRef.current = false;
      engine.pause();
      engine.setUpcoming(null); // audio moved to another device, drop the local preload
    }
    connRef.current?.transfer(deviceId);
  };
  const renameDevice = (name: string) => { setDeviceName(name); connRef.current?.rename(name); };

  const getAnalyser = (): AnalyserNode | null => engine.getAnalyser();
  const getVideoElement = (): HTMLVideoElement | null => engine.getVideoElement?.() ?? null;
  const homeVideo = (): void => engine.homeVideo?.();

  const activeDeviceName = connected && activeDeviceId && activeDeviceId !== myId
    ? (devices.find(d => d.id === activeDeviceId)?.name ?? "another device")
    : null;

  // Memoized so currentTime ticks (about 4/sec) don't hand every consumer a new
  // object. The callbacks only read refs or state in the dep list.
  const ctxValue = useMemo<Ctx>(() => ({
    queue, order, pos, current, bookChapters, radioTitle, isPlaying, duration, volume, shuffle, repeat, quality,
    playNow, toggle, play, pause, getTransportState, getMediaSessionState, subscribeTransport, playbackError, playbackInstance, next, prev, seek, setVolume, playbackRate, setPlaybackRate, toggleShuffle, cycleRepeat, weightedShuffle, setWeightedShuffle, setHold, getAnalyser, getVideoElement, homeVideo,
    jumpTo, removeFromQueue, reorderQueue, playNext, addToQueue, addManyToQueue, startRadio, autoDJ, setAutoDJ, autoDJMode, setAutoDJMode, autoDJUnit, setAutoDJUnit, autoDJCount, setAutoDJCount,
    currentRating: current ? (ratings[current.id] ?? 0) : 0, rateCurrent, currentFav: current ? favIds.has(current.id) : false, toggleCurrentFav,
    sleepAt, setSleep, reconnecting, buffering, streamQuality, setStreamQuality, crossfade, setCrossfade, nightcore: nightcoreOn, setNightcore, nightcoreAvailable, vibe, setVibe, effectiveRate, normalize, setNormalize, prefetchedId, getAudioDiag,
    connected, devices, activeDeviceId, myDeviceId: myId, isActiveDevice, activeDeviceName,
    transferTo, renameDevice,
    session, isGuest: session?.role === "guest", sessionError, startSession, joinSession, leaveSession, online: onlineUsers,
    joinRequest, invite, presenceNote, askToJoin, inviteUser, respondJoin, acceptInvite, dismissInvite, dismissPresenceNote,
    shareActivity, setShareActivity,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [playbackError, playbackInstance, queue, order, pos, current, bookChapters, radioTitle, isPlaying, duration, volume, playbackRate, shuffle, repeat, weightedShuffle, quality,
       autoDJ, autoDJMode, autoDJUnit, autoDJCount, ratings, favIds, sleepAt, reconnecting, buffering, streamQuality, crossfade, nightcoreOn, nightcoreAvailable, vibe, effectiveRate, normalize, prefetchedId,
       connected, devices, activeDeviceId, myId, isActiveDevice, activeDeviceName, session, sessionError, onlineUsers, joinRequest, invite, presenceNote, shareActivity]);

  const timeValue = useMemo<TimeCtx>(() => ({ currentTime, duration, buffered }),
    [currentTime, duration, buffered]);

  return (
    <PlayerCtx.Provider value={ctxValue}>
      <PlayerTimeCtx.Provider value={timeValue}>
        {children}
        <Scrobbler />
      </PlayerTimeCtx.Provider>
    </PlayerCtx.Provider>
  );
}

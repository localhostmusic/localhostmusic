import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { QueuePanel } from "./QueuePanel";
import { api } from "../api";
import { npDisplay } from "./audiobook";
import { SpeedControl } from "./SpeedControl";
import { NightcoreControl } from "./NightcoreControl";
import { LyricsView } from "./LyricsView";
import { TranscriptView } from "./TranscriptView";
import { VideoView } from "./VideoView";
import { SyncLyrics } from "./SyncLyrics";
import { VIZ_STYLES, type VizStyle } from "./Visualizer";
// Visualizers are lazy chunks: most sessions never open one.
const GlowVisualizer = lazy(() => import("./GlowVisualizer").then(m => ({ default: m.GlowVisualizer })));
const ShaderVisualizer = lazy(() => import("./ShaderVisualizer").then(m => ({ default: m.ShaderVisualizer })));
const OrbVisualizer = lazy(() => import("./OrbVisualizer").then(m => ({ default: m.OrbVisualizer })));
const NeonVisualizer = lazy(() => import("./NeonVisualizer").then(m => ({ default: m.NeonVisualizer })));
const IrisVisualizer = lazy(() => import("./IrisVisualizer").then(m => ({ default: m.IrisVisualizer })));
const FractureVisualizer = lazy(() => import("./FractureVisualizer").then(m => ({ default: m.FractureVisualizer })));
const SiphonVisualizer = lazy(() => import("./SiphonVisualizer").then(m => ({ default: m.SiphonVisualizer })));
const SilkVisualizer = lazy(() => import("./SilkVisualizer").then(m => ({ default: m.SilkVisualizer })));
import { LibraryDrawer } from "./LibraryDrawer";
import { PlayIcon, PauseIcon, PrevIcon, NextIcon, VolumeIcon, ChevronDownIcon, LyricsIcon, EditIcon, VizIcon, ShuffleIcon, RepeatIcon, RepeatOneIcon, HeartIcon, QueueIcon, Spinner, FullscreenIcon, SearchIcon, RadioIcon } from "../ui/icons";
import { Stars } from "../ui/Stars";
import { DevicePicker } from "./DevicePicker";
import { SessionPicker } from "./SessionPicker";
import { Scrubber } from "./Scrubber";
import { downloadedBitrate } from "./downloads";
import { resolveBitrate } from "./streamQuality";

function fmt(d: number) {
  if (!d || !isFinite(d)) return "0:00";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function fill(pct: number) {
  return { background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.22) ${pct}%)` };
}
function qualityLabel(q: any): string | null {
  if (!q) return null;
  const parts: string[] = [];
  if (q.ext || q.codec) parts.push(q.ext || q.codec);
  if (q.sampleRate) parts.push(`${(q.sampleRate / 1000).toFixed(1)} kHz`);
  if (q.bitsPerSample) parts.push(`${q.bitsPerSample}-bit`);
  if (q.bitrate) parts.push(`${q.bitrate} kbps`);
  if (q.channels) parts.push(q.channels === 2 ? "Stereo" : q.channels === 1 ? "Mono" : `${q.channels}ch`);
  return parts.join(" · ");
}

type Tab = "queue" | "lyrics" | "visualizer" | null;
// Wide-layout panels: independently toggleable, resizable via dividers.
type PanelKey = "art" | "lyrics" | "viz" | "queue";
const PANEL_ORDER: PanelKey[] = ["art", "lyrics", "viz", "queue"];
const PANEL_LABEL: Record<PanelKey, string> = { art: "Art", lyrics: "Lyrics", viz: "Visualizer", queue: "Queue" };

// Wide screens get the multi-panel player; narrow stays a single column.
function useWide() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 900px)");
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

// Touch devices: the visualizer needs an AudioContext, which resamples the signal
// and gets suspended in the background, so it is disabled there (see
// WebAudioEngine.graphDisabled). Keyed on input capability, not width.
function useIsMobile() {
  const Q = "(hover: none) and (pointer: coarse)";
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(Q).matches);
  useEffect(() => {
    const mq = window.matchMedia(Q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function NowPlaying({ onClose, onOpenArtist, onOpenAlbum }: {
  onClose: () => void;
  onOpenArtist?: (id: number, name: string) => void;
  onOpenAlbum?: (id: number) => void;
}) {
  const p = usePlayer();
  const t = usePlayerTime();
  const wide = useWide();
  const isMobile = useIsMobile();
  const isBook = !!p.current?.isAudiobook; // audiobook: book-aware title, no lyrics
  const isRadio = !!p.current?.isRadio;
  const isPodcast = !!p.current?.isPodcast;
  const isVideo = !!p.current?.isVideo;
  const special = isBook || isRadio || isPodcast; // subtitle: book/radio/podcast
  const hideLyrics = isBook || isRadio || (isPodcast && !p.current?.hasTranscript);
  const [tab, setTab] = useState<Tab>(null);   // narrow layout: active panel (queue / lyrics / visualizer)
  // Wide layout: which panels are open + their relative widths (both persisted).
  const [panels, setPanels] = useState<Record<PanelKey, boolean>>(() => {
    const def: Record<PanelKey, boolean> = { art: true, lyrics: false, viz: false, queue: true };
    try {
      const s = JSON.parse(localStorage.getItem("lhm.npPanels") || "");
      if (s && typeof s === "object") return { ...def, ...s };
    } catch { /* */ }
    return def;
  });
  const togglePanelKey = (k: PanelKey) => setPanels(prev => {
    const next = { ...prev, [k]: !prev[k] };
    if (!PANEL_ORDER.some(key => next[key])) return prev; // keep at least one open
    try { localStorage.setItem("lhm.npPanels", JSON.stringify(next)); } catch { /* */ }
    return next;
  });
  const [panelW, setPanelW] = useState<Record<PanelKey, number>>(() => {
    const def: Record<PanelKey, number> = { art: 1, lyrics: 1, viz: 1, queue: 0.8 };
    try {
      const s = JSON.parse(localStorage.getItem("lhm.npPanelW") || "");
      if (s && typeof s === "object") return { ...def, ...s };
    } catch { /* */ }
    return def;
  });
  const panelWRef = useRef(panelW);
  useEffect(() => { panelWRef.current = panelW; }, [panelW]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Stage width, used to switch to tiling when a row of panels gets cramped.
  const [stageW, setStageW] = useState(0);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!stageEl) return;
    const ro = new ResizeObserver(() => setStageW(stageEl.clientWidth));
    ro.observe(stageEl);
    setStageW(stageEl.clientWidth);
    return () => ro.disconnect();
  }, [stageEl]);
  // Divider drag: shifts width weight between the two adjacent panels.
  const dividerDrag = (leftKey: PanelKey, rightKey: PanelKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const w0 = { ...panelWRef.current };
    const visKeys = PANEL_ORDER.filter(k => panels[k]);
    const total = visKeys.reduce((s, k) => s + w0[k], 0);
    const pxPerWeight = (stageRef.current?.clientWidth || 1) / Math.max(0.001, total);
    const move = (ev: PointerEvent) => {
      const dw = (ev.clientX - startX) / pxPerWeight;
      setPanelW(prev => ({
        ...prev,
        [leftKey]: Math.min(4, Math.max(0.3, w0[leftKey] + dw)),
        [rightKey]: Math.min(4, Math.max(0.3, w0[rightKey] - dw)),
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try { localStorage.setItem("lhm.npPanelW", JSON.stringify(panelWRef.current)); } catch { /* */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Manual layout preference per open-panel count (auto = width-based tiling).
  // 4 panels: row, 2 vertical + 2 stacked, or 2x2 grid. 3 panels: row or stack.
  const [layoutPref, setLayoutPref] = useState<Record<number, string>>(() => {
    try {
      const s = JSON.parse(localStorage.getItem("lhm.npLayoutPref") || "");
      if (s && typeof s === "object") return s;
    } catch { /* */ }
    return {};
  });
  const visKeys = PANEL_ORDER.filter(k => panels[k] && !(isMobile && k === "viz") && !(isVideo && k === "viz") && !(hideLyrics && k === "lyrics"));
  const layoutModes = visKeys.length === 4 ? ["auto", "row", "mixed", "grid"]
    : visKeys.length === 3 ? ["auto", "row", "stack"] : ["auto"];
  const pref = layoutModes.includes(layoutPref[visKeys.length] ?? "auto") ? (layoutPref[visKeys.length] ?? "auto") : "auto";
  const cycleLayout = () => setLayoutPref(prev => {
    const cur = layoutModes.indexOf(prev[visKeys.length] ?? "auto");
    const next = { ...prev, [visKeys.length]: layoutModes[(cur + 1) % layoutModes.length] };
    try { localStorage.setItem("lhm.npLayoutPref", JSON.stringify(next)); } catch { /* */ }
    return next;
  });
  const LAYOUT_LABEL: Record<string, string> = { auto: "Auto", row: "Cols", stack: "Stack", mixed: "2+2", grid: "Grid" };
  // Double-click a divider: reset every panel to equal width.
  const resetPanelW = () => {
    const even: Record<PanelKey, number> = { art: 1, lyrics: 1, viz: 1, queue: 1 };
    setPanelW(even);
    try { localStorage.setItem("lhm.npPanelW", JSON.stringify(even)); } catch { /* */ }
  };
  const [syncing, setSyncing] = useState(false);
  const [libOpen, setLibOpen] = useState(false); // wide: quick library drawer
  const [lyricsVer, setLyricsVer] = useState(0); // bump to re-fetch lyrics after a manual sync
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  // Neon visualizer as a dimmed backdrop behind the lyrics (persisted).
  const [lyricsVizBg, setLyricsVizBg] = useState(() => {
    try { return localStorage.getItem("lhm.lyricsVizBg") === "1"; } catch { return false; }
  });
  const toggleLyricsVizBg = () => setLyricsVizBg(v => {
    try { localStorage.setItem("lhm.lyricsVizBg", v ? "0" : "1"); } catch { /* */ }
    return !v;
  });
  // Visualizer style persists across sessions (stored by name, not index).
  const [vizIdx, setVizIdx] = useState(() => {
    try {
      const i = VIZ_STYLES.indexOf(localStorage.getItem("lhm.vizStyle") as VizStyle);
      return i >= 0 ? i : 0;
    } catch { return 0; }
  });
  const [dragY, setDragY] = useState(0);     // live downward drag offset (px)
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [coverX, setCoverX] = useState(0);   // live horizontal artwork offset (px)
  const [coverAnim, setCoverAnim] = useState(false); // transition on the artwork slide
  const drag = useRef<{ x: number; y: number; lyrics: HTMLElement | null; active: boolean; axis: "h" | "v" | null; art: boolean } | null>(null);
  const quality = p.quality;
  const vizBoxRef = useRef<HTMLDivElement>(null);
  const [vizFs, setVizFs] = useState(false);
  const [fsIdle, setFsIdle] = useState(false); // hide cursor/button after idle in fullscreen
  useEffect(() => {
    const onFsChange = () => setVizFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  useEffect(() => {
    if (!vizFs) { setFsIdle(false); return; }
    let timer = 0;
    const poke = () => {
      setFsIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFsIdle(true), 2500);
    };
    poke();
    document.addEventListener("mousemove", poke);
    document.addEventListener("touchstart", poke);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousemove", poke);
      document.removeEventListener("touchstart", poke);
    };
  }, [vizFs]);
  const toggleVizFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void vizBoxRef.current?.requestFullscreen().catch(() => {});
  };

  const lyricsActive = (wide ? panels.lyrics : tab === "lyrics") && !hideLyrics;
  // No visualizer (and no analyser) on touch devices, see useIsMobile.
  const vizActive = !isMobile && (wide ? panels.viz : tab === "visualizer");
  const needAnalyser = vizActive || (!isMobile && lyricsActive && lyricsVizBg);
  const vizStyle: VizStyle = VIZ_STYLES[vizIdx % VIZ_STYLES.length];

  // Hold the analyser only while a visualizer is on screen (incl. the lyrics backdrop).
  useEffect(() => {
    if (needAnalyser) { const a = p.getAnalyser(); if (a) setAnalyser(a); }
    else setAnalyser(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needAnalyser]);

  if (!p.current) return null;

  const startClose = () => { setDragging(false); setLeaving(true); };

  // Drag the sheet down to dismiss. Ignores controls, and scrolled lyrics scroll first.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const tgt = e.target as HTMLElement;
    const onControls = !!tgt.closest(".np-controls, .np-progress, .np-toggles, .np-close, .slider, .np-dock, .np-divider, .np-viz-style");
    // Swipe-to-skip only starts on the album artwork, to avoid accidental skips.
    const onArt = !!tgt.closest(".np-art-wrap");
    drag.current = { x: t.clientX, y: t.clientY, lyrics: tgt.closest(".lyrics"), active: !onControls, axis: null, art: onArt };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = drag.current;
    if (!s || !s.active) return;
    const t = e.touches[0];
    const dy = t.clientY - s.y, dx = t.clientX - s.x;
    // Lock the gesture to one axis on the first real movement.
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (s.axis === "h") {                             // horizontal: slide the cover
      if (s.art) { if (coverAnim) setCoverAnim(false); setCoverX(dx); }
      return;
    }
    if (dy <= 0) { if (dragY) setDragY(0); return; }
    if (s.lyrics && s.lyrics.scrollTop > 0) return;   // let lyrics scroll first
    if (!dragging) setDragging(true);
    setDragY(dy);
  };
  // Slide the cover out in the swipe direction, swap the track, slide the new one in
  // from the other side. dir -1 = next, +1 = prev.
  const slideSkip = (dir: number) => {
    const w = window.innerWidth;
    setCoverAnim(true);
    setCoverX(dir * w);
    window.setTimeout(() => {
      if (dir < 0) p.next(); else p.prev();
      setCoverAnim(false);
      setCoverX(-dir * w);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setCoverAnim(true);
        setCoverX(0);
      }));
    }, 220);
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const s = drag.current;
    drag.current = null;
    if (!s || !s.active) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    // Horizontal swipe on the artwork: skip past the threshold, else snap back.
    if (s.axis === "h") {
      if (s.art) {
        if (Math.abs(dx) > 60) slideSkip(dx < 0 ? -1 : 1);
        else { setCoverAnim(true); setCoverX(0); }
      }
      setDragging(false); setDragY(0);
      return;
    }
    if (dragY > 120) startClose();
    else { setDragging(false); setDragY(0); }
  };

  const cur = p.current;
  const np = npDisplay(cur, p.bookChapters, t.currentTime, p.radioTitle); // book/radio-aware title
  const cover = cur.albumId != null ? api.coverUrl(cur.albumId) : (cur.artUrl ?? null);

  const pickTab = (k: Exclude<Tab, null>) => setTab(prev => (prev === k ? null : k)); // narrow only
  // back: one step the other way (right-click).
  const cycleVizStyle = (back = false) => setVizIdx(i => {
    const n = i + (back ? VIZ_STYLES.length - 1 : 1);
    try { localStorage.setItem("lhm.vizStyle", VIZ_STYLES[n % VIZ_STYLES.length]); } catch { /* */ }
    return n;
  });
  const onVizBtn = () => { if (vizActive) cycleVizStyle(); else pickTab("visualizer"); }; // narrow only
  const prevVizStyle = (e: React.MouseEvent) => { e.preventDefault(); cycleVizStyle(true); };

  // Radio has no cover, so show a glyph placeholder.
  const radioArt = (
    <div className="np-art np-art-radio">
      <div className="np-art-radio-glyph"><RadioIcon size={72} /></div>
    </div>
  );
  const artEl = (
    <div className={`np-art-wrap${isVideo ? " np-art-video" : ""}`}>
      {isRadio
        ? radioArt
        : isVideo
        ? <VideoView />
        : cover
        ? <img className="np-art" src={cover} alt=""
            style={{ transform: `translateX(${coverX}px)`, transition: coverAnim ? "transform 0.22s ease" : "none" }}
            onError={e => (e.currentTarget.style.visibility = "hidden")} />
        : <div className="np-art np-art-empty" />}
    </div>
  );
  const vizInner = analyser
    ? (
      <div className={`np-viz-box${vizFs && fsIdle ? " fs-idle" : ""}`} ref={vizBoxRef} onDoubleClick={toggleVizFs}>
        <Suspense fallback={null}>
          {vizStyle === "trip" ? <ShaderVisualizer analyser={analyser} />
            : vizStyle === "orb" ? <OrbVisualizer analyser={analyser} />
            : vizStyle === "neon" ? <NeonVisualizer analyser={analyser} seed={cur.id} />
            : vizStyle === "iris" ? <IrisVisualizer analyser={analyser} />
            : vizStyle === "fracture" ? <FractureVisualizer analyser={analyser} />
            : vizStyle === "siphon" ? <SiphonVisualizer analyser={analyser} />
            : vizStyle === "silk" ? <SilkVisualizer analyser={analyser} />
            // Keyed: the visualizer releases its WebGL context on the way out, so each
            // style needs its own canvas.
            : <GlowVisualizer key={vizStyle} analyser={analyser} style={vizStyle} />}
        </Suspense>
        <button className="np-viz-fs" onClick={toggleVizFs}
          title={vizFs ? "Exit fullscreen" : "Fullscreen"}
          aria-label={vizFs ? "Exit fullscreen visualizer" : "Fullscreen visualizer"}>
          <FullscreenIcon exit={vizFs} />
        </button>
      </div>
    )
    : null;
  const lyricsInner = isPodcast && cur.hasTranscript && cur.podcastEpisodeId != null
    ? <TranscriptView episodeId={cur.podcastEpisodeId} currentTime={t.currentTime} onSeek={p.seek} />
    : <LyricsView key={lyricsVer} trackId={cur.id} currentTime={t.currentTime} onSeek={p.seek} onSync={() => setSyncing(true)} />;
  // Lyrics with an optional neon visualizer backdrop.
  const lyricsStack = (
    <div className={`np-lyrics-stack${lyricsVizBg && !isMobile ? " has-viz" : ""}`}>
      {lyricsVizBg && !isMobile && analyser && (
        <div className="np-lyrics-vizbg" aria-hidden>
          <Suspense fallback={null}>
            <NeonVisualizer analyser={analyser} seed={cur.id} />
          </Suspense>
        </div>
      )}
      <div className="np-lyrics-fg">{lyricsInner}</div>
      {!isMobile && (
        <button className="np-lyrics-vizbg-toggle" onClick={toggleLyricsVizBg}
          title={lyricsVizBg ? "Hide visualizer backdrop" : "Show visualizer behind lyrics"}
          aria-label="Toggle visualizer backdrop" aria-pressed={lyricsVizBg}>
          <VizIcon size={16} />
        </button>
      )}
    </div>
  );

  const artistEl = cur.artist && (
    onOpenArtist && cur.artistId != null
      ? <button className="np-artist link" onClick={() => onOpenArtist(cur.artistId!, cur.artist!)}>{cur.artist}</button>
      : <p className="np-artist">{cur.artist}</p>
  );
  const albumEl = cur.album && (
    onOpenAlbum && cur.albumId != null
      ? <button className="np-album link" onClick={() => onOpenAlbum(cur.albumId!)}>{cur.album}</button>
      : <p className="np-album">{cur.album}</p>
  );
  const heartEl = (
    <button className={`np-heart${p.currentFav ? " on" : ""}`} onClick={p.toggleCurrentFav}
      aria-label={p.currentFav ? "Remove from Favorites" : "Add to Favorites"}>
      <HeartIcon size={20} filled={p.currentFav} />
    </button>
  );
  const qualityEl = (() => {
    if (isRadio || isPodcast) return null; // radio: the "MP3 · Nkbps" figure is our transcode setting, not the stream
    // Show the delivered quality, not the source. Hidden when another device plays.
    if (!p.isActiveDevice) return null;
    const dl = downloadedBitrate(cur.id);
    const effBr = dl !== undefined ? dl : resolveBitrate(p.streamQuality);
    if (effBr > 0) return <p className="np-quality">MP3 · {effBr} kbps</p>;
    return quality ? (
      <p className="np-quality">
        {quality.lossless && <span className="lossless-badge">LOSSLESS</span>}
        {qualityLabel(quality)}
      </p>
    ) : null;
  })();
  const infoEl = (
    <div className="np-info track-fade" key={`i${cur.id}`}>
      <h2 className="np-title">{np.title}</h2>
      {special && np.subtitle && <div className="np-chapter">{np.subtitle}</div>}
      {!(isRadio || isPodcast) && artistEl}
      {!(isRadio || isPodcast) && albumEl}
      {!(isRadio || isPodcast) && (
        <div className="np-rate">
          {heartEl}
          <Stars value={p.currentRating} onRate={p.rateCurrent} size={20} />
        </div>
      )}
      {qualityEl}
    </div>
  );

  const progressEl = cur.isRadio ? (
    <div className="np-progress np-live track-fade" key={`p${cur.id}`}><span className="live-badge">● LIVE</span></div>
  ) : (
    <div className="np-progress track-fade" key={`p${cur.id}`} style={p.isGuest ? { pointerEvents: "none" } : undefined}>
      <span className="pb-time">{fmt(t.currentTime)}</span>
      <Scrubber value={t.currentTime} max={p.duration || 0} buffered={t.buffered} onSeek={p.seek} className="np-scrub" />
      <span className="pb-time">{fmt(p.duration)}</span>
    </div>
  );
  const controlsEl = (
    <>
      <div className={`np-controls${p.isGuest ? " guest-locked" : ""}${(isRadio || isPodcast) ? " radio" : ""}`}>
        {!(isRadio || isPodcast || isBook) && <button className={`ctl-toggle${p.shuffle ? " active" : ""}`} onClick={p.toggleShuffle} disabled={p.isGuest} aria-label="Shuffle" aria-pressed={p.shuffle}><ShuffleIcon size={20} /></button>}
        {!(isRadio || isPodcast) && <button onClick={p.prev} disabled={p.isGuest} aria-label="Previous"><PrevIcon size={26} /></button>}
        <button className="main" onClick={p.toggle} disabled={p.isGuest} aria-label={p.isPlaying ? "Pause" : "Play"}>
          {p.buffering ? <Spinner size={30} /> : p.isPlaying ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
        </button>
        {!(isRadio || isPodcast) && <button onClick={p.next} disabled={p.isGuest} aria-label="Next"><NextIcon size={26} /></button>}
        {!(isRadio || isPodcast || isBook) && <button className={`ctl-toggle${p.repeat !== "off" ? " active" : ""}`} onClick={p.cycleRepeat} disabled={p.isGuest} aria-label={`Repeat: ${p.repeat}`}>
          {p.repeat === "one" ? <RepeatOneIcon size={20} /> : <RepeatIcon size={20} />}
        </button>}
        <SpeedControl />
      </div>
      {p.isGuest && <p className="np-guest-hint">{p.session?.host || "The host"} controls playback · leave the session to play on your own</p>}
    </>
  );
  const volumeEl = (
    <div className={`np-volume${!p.isActiveDevice ? " remote" : ""}`}>
      <VolumeIcon size={18} />
      <input className="slider" type="range" min={0} max={1} step={0.01} value={p.volume} style={fill(p.volume * 100)}
        onChange={e => p.setVolume(Number(e.target.value))} aria-label={p.activeDeviceName ? `Volume on ${p.activeDeviceName}` : "Volume"} />
    </div>
  );

  return (
    <div
      className={`nowplaying${lyricsActive ? " np-lyrics-mode" : ""}${wide ? " np-wide" : ""}`}
      role="dialog" aria-label="Now playing"
      style={{
        transform: `translateY(${leaving ? "100%" : `${dragY}px`})`,
        transition: dragging ? "none" : "transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      onTransitionEnd={() => { if (leaving) onClose(); }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {cover && <div className="np-bg" style={{ backgroundImage: `url(${cover})` }} />}
      <div className="np-scrim" />

      <div className="np-content">
        <button className="np-close" onClick={startClose} aria-label="Close">
          <ChevronDownIcon size={26} />
        </button>
        {wide && (
          <button className="np-close np-lib-open" onClick={() => setLibOpen(true)} aria-label="Browse library" title="Browse library">
            <SearchIcon size={20} />
          </button>
        )}
        <div className="np-toggles">
          <DevicePicker size={22} className="np-lyrics-toggle" />
          <SessionPicker size={22} className="np-lyrics-toggle" />
          {p.nightcoreAvailable && <NightcoreControl />}
          {wide && (
            <div className="np-focus np-panel-chips" role="group" aria-label="Panels">
              {PANEL_ORDER.filter(k => !(isMobile && k === "viz") && !(isVideo && k === "viz") && !(hideLyrics && k === "lyrics")).map(k => {
                const label = k === "queue" ? (isBook ? "Chapters" : isRadio ? "Radio" : isPodcast ? "Episodes" : "Queue") : (k === "lyrics" && isPodcast ? "Transcript" : PANEL_LABEL[k]);
                return (
                  <button key={k} className={panels[k] ? "active" : ""} onClick={() => togglePanelKey(k)}
                    aria-pressed={panels[k]} title={`Toggle ${label}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {/* Always rendered, disabled when they don't apply, so the row never shifts. */}
          {wide && (
            <div className="np-focus np-layout-btn" role="group" aria-label="Panel layout">
              <button className={pref !== "auto" && layoutModes.length > 1 ? "active" : ""} onClick={cycleLayout}
                disabled={layoutModes.length <= 1}
                title={layoutModes.length > 1 ? "Cycle panel layout (Auto / columns / stacked squares)" : "Open more panels to change the layout"}>
                {LAYOUT_LABEL[pref]}
              </button>
            </div>
          )}
          {wide && (
            <button className="np-lyrics-toggle" onClick={() => setSyncing(true)} disabled={!lyricsActive}
              aria-label="Sync lyrics" title={lyricsActive ? "Sync lyrics" : "Open Lyrics to sync them"}>
              <EditIcon size={20} />
            </button>
          )}
        </div>

        {/* Compact title/album shown between the top buttons on phones. */}
        <div className="np-topmeta track-fade" key={`m${cur.id}`}>
          <span className="np-topmeta-title">{np.title}</span>
          {special
            ? (np.subtitle && <span className="np-topmeta-album">{np.subtitle}</span>)
            : (cur.album && <span className="np-topmeta-album">{cur.album}</span>)}
        </div>

        {p.activeDeviceName && <div className="np-oncast">▸ Playing on {p.activeDeviceName}</div>}

        {wide ? (() => {
          const visible = visKeys;
          // Manual pref wins. "auto" keeps a row while each column gets ~380px,
          // else tiles (4 panels: 2x2, 3: master + stack). Dividers exist only in row mode.
          const autoTight = visible.length >= 3 && stageW > 0 && stageW < visible.length * 380;
          const mode = pref !== "auto" ? pref : autoTight ? (visible.length === 3 ? "stack" : "grid") : "row";
          const tiled = mode !== "row";
          const tileClass = mode === "stack" ? "np-tiled-3" : mode === "grid" ? "np-tiled-4" : mode === "mixed" ? "np-tiled-mixed" : "";
          const areas = mode === "stack" || mode === "mixed" ? ["a", "b", "c", "d"] : null;
          return (
          <div className={`np-stage np-panels${tiled ? ` np-tiled ${tileClass}` : ""}`}
            ref={el => { stageRef.current = el; setStageEl(el); }}>
            {/* Normalize weights: flex-grow sums below 1 only claim that fraction
                of free space, so a lone 0.8-weight panel wouldn't fill the row. */}
            {visible.map((k, i, arr) => (
              <Fragment key={k}>
                {!tiled && i > 0 && (
                  <div className="np-divider" role="separator" aria-orientation="vertical"
                    title="Drag to resize · double-click to equalize"
                    onPointerDown={dividerDrag(arr[i - 1], k)} onDoubleClick={resetPanelW} />
                )}
                <div className={`np-panel np-panel-${k}`}
                  style={tiled
                    ? (areas ? { gridArea: areas[i] } : undefined)
                    : { flexGrow: (panelW[k] / arr.reduce((s, key) => s + panelW[key], 0)) * 100 }}>
                  {k === "art" && (
                    <>
                      {/* Ambient fill: blurred cover behind the sharp, uncropped art. */}
                      {cover && <div className="np-art-bg" style={{ backgroundImage: `url(${cover})` }} />}
                      <div className="np-art-fit track-fade" key={`af${cur.id}`}>
                        {isRadio
                          ? radioArt
                          : isVideo
                          ? <VideoView />
                          : cover
                          ? <img src={cover} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                          : <div className="np-art np-art-empty" />}
                      </div>
                      <div className="np-art-extras track-fade" key={`x${cur.id}`}>
                        <h2 className="np-title">{np.title}</h2>
                        {special && np.subtitle && <div className="np-chapter">{np.subtitle}</div>}
                        {!(isRadio || isPodcast) && (
                          <div className="np-rate">
                            <Stars value={p.currentRating} onRate={p.rateCurrent} size={20} />
                          </div>
                        )}
                        {qualityEl}
                      </div>
                    </>
                  )}
                  {k === "lyrics" && <div className="np-side-lyrics">{lyricsStack}</div>}
                  {k === "viz" && (
                    <div className={`np-side-viz${vizStyle === "trip" ? " np-viz-trip" : ""}`}>
                      {vizInner}
                      <button className="np-viz-style" onClick={() => cycleVizStyle()} onContextMenu={prevVizStyle}
                        title="Click for the next style, right-click for the previous one">
                        {vizStyle}
                      </button>
                    </div>
                  )}
                  {k === "queue" && <QueuePanel onClose={() => togglePanelKey("queue")} />}
                </div>
              </Fragment>
            ))}
          </div>
          );
        })() : (
          <>
            {vizActive
              ? <div className={`np-art-wrap np-pane-fill${vizStyle === "trip" ? " np-viz-trip" : ""}`}>{vizInner}</div>
              : lyricsActive
              ? <div className="np-lyrics-wrap np-pane-fill">{lyricsStack}</div>
              : artEl}
            {/* Lyrics/viz get the full screen; a one-line title keeps context. */}
            {(vizActive || lyricsActive) ? (
              <div className="np-mini-info track-fade" key={`mi${cur.id}`}>
                <span className="np-mini-title">{np.title}</span>
                {(special ? np.subtitle : cur.artist) && <span className="np-mini-sub">{special ? np.subtitle : cur.artist}</span>}
              </div>
            ) : infoEl}
          </>
        )}

        {wide ? (
          <div className="np-dock">
            <div className="np-dock-left">
              {cover ? <img className="np-dock-art" src={cover} alt="" />
                : isRadio ? <span className="np-dock-art np-dock-radio"><RadioIcon size={20} /></span> : null}
              <div className="np-dock-meta track-fade" key={`dk${cur.id}`}>
                <span className="np-dock-title">{np.title}</span>
                <span className="np-dock-sub">{special
                  ? (np.subtitle || cur.artist)
                  : <>{artistEl}{cur.artist && cur.album ? <span className="np-dock-dot">·</span> : null}{albumEl}</>}</span>
              </div>
              {!(isRadio || isPodcast) && heartEl}
            </div>
            <div className="np-dock-center">
              {controlsEl}
              {progressEl}
            </div>
            <div className="np-dock-right">{volumeEl}</div>
          </div>
        ) : (
          <>
            {progressEl}
            {controlsEl}
            {volumeEl}
            {/* Phone: panel toggles sit at the bottom, within thumb reach. */}
            <div className="np-bottom-tabs">
              <button className={tab === "queue" ? "active" : ""} onClick={() => pickTab("queue")}
                aria-label="Toggle queue" aria-pressed={tab === "queue"} title="Queue">
                <QueueIcon size={22} />
              </button>
              {!hideLyrics && (
                <button className={lyricsActive ? "active" : ""} onClick={() => pickTab("lyrics")}
                  aria-label="Toggle lyrics" aria-pressed={lyricsActive} title="Lyrics">
                  <LyricsIcon size={22} />
                </button>
              )}
              {!isMobile && (
                <button className={vizActive ? "active" : ""} onClick={onVizBtn}
                  onContextMenu={e => { if (vizActive) prevVizStyle(e); }}
                  aria-label={vizActive ? "Change visualizer style" : "Show visualizer"}
                  title={vizActive ? `Style: ${vizStyle} (right-click for the previous one)` : "Visualizer"}>
                  <VizIcon size={22} />
                </button>
              )}
              {lyricsActive && (
                <button onClick={() => setSyncing(true)} aria-label="Sync lyrics" title="Sync lyrics">
                  <EditIcon size={20} />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {wide && libOpen && (
        <LibraryDrawer onClose={() => setLibOpen(false)} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} />
      )}

      {!wide && tab === "queue" && createPortal(
        <>
          <div className="np-queue-backdrop" onClick={() => setTab(null)} />
          <div className="np-queue-drawer"><QueuePanel onClose={() => setTab(null)} /></div>
        </>,
        document.body,
      )}

      {syncing && (
        <SyncLyrics
          trackId={cur.id}
          title={cur.title}
          onClose={() => setSyncing(false)}
          onSaved={() => { setSyncing(false); setLyricsVer(v => v + 1); }}
        />
      )}
    </div>
  );
}

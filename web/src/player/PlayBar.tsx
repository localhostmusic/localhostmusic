import { useState } from "react";
import { MuteButton } from "./MuteButton";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { npDisplay } from "./audiobook";
import { SpeedControl } from "./SpeedControl";
import { api } from "../api";
import { PlayIcon, PauseIcon, PrevIcon, NextIcon, ShuffleIcon, RepeatIcon, RepeatOneIcon, LyricsIcon, QueueIcon, MoonIcon, Spinner } from "../ui/icons";
import { MarqueeText } from "../ui/MarqueeText";
import { useSwipe } from "../ui/useSwipe";
import { DevicePicker } from "./DevicePicker";
import { Scrubber } from "./Scrubber";
import { downloadedBitrate } from "./downloads";
import { resolveBitrate } from "./streamQuality";

// Sleep timer: pause playback after a chosen number of minutes.
function SleepButton() {
  const p = usePlayer();
  const [open, setOpen] = useState(false);
  const active = p.sleepAt != null;
  return (
    <div className="pb-sleep">
      <button className={`ctl-toggle${active ? " active" : ""}`} onClick={() => setOpen(o => !o)} title="Sleep timer" aria-label="Sleep timer" aria-pressed={active}>
        <MoonIcon size={18} />
      </button>
      {open && (
        <>
          <div className="trk-menu-backdrop" onClick={() => setOpen(false)} />
          <ul className="trk-menu pb-sleep-menu">
            {[15, 30, 45, 60].map(m => (
              <li key={m}><button onClick={() => { p.setSleep(m); setOpen(false); }}>{m} minutes</button></li>
            ))}
            {active && <li><button onClick={() => { p.setSleep(null); setOpen(false); }}>Turn off</button></li>}
          </ul>
        </>
      )}
    </div>
  );
}

function fmt(d: number) {
  if (!d || !isFinite(d)) return "0:00";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// A range input whose filled portion is tinted with the accent up to `pct`.
function fill(pct: number) {
  return { background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.18) ${pct}%)` };
}

export function PlayBar({ onExpand, rightPanel, onToggleLyrics, onToggleQueue }: {
  onExpand?: () => void;
  rightPanel?: "none" | "lyrics" | "queue";
  onToggleLyrics?: () => void;
  onToggleQueue?: () => void;
}) {
  const p = usePlayer();
  const t = usePlayerTime();
  // Mini-player gestures (phone): swipe left/right to skip, up to open Now Playing.
  const swipe = useSwipe({ onSwipeLeft: p.next, onSwipeRight: p.prev, onSwipeUp: onExpand });
  if (!p.current) return null;
  const isBook = !!p.current.isAudiobook;
  const isRadio = !!p.current.isRadio;
  const isPodcast = !!p.current.isPodcast;
  const noTransport = isRadio || isPodcast;          // single item: no prev/next/shuffle/repeat
  const noShufRep = noTransport || isBook;           // no shuffle/repeat for a book
  const hideLyrics = isBook || isRadio || (isPodcast && !p.current.hasTranscript);
  const hideQuality = isRadio || isPodcast;          // no bitrate label for these
  const cover = p.current.albumId != null ? api.coverUrl(p.current.albumId, 160) : (p.current.artUrl ?? null);
  const q = p.quality;
  const qBits = q ? [q.ext || q.codec, q.sampleRate ? `${(q.sampleRate / 1000).toFixed(1)} kHz` : null, q.bitrate ? `${q.bitrate} kbps` : null].filter(Boolean).join(" · ") : "";
  // The delivered bitrate (0 = original/lossless), not the source file's.
  const dlBr = downloadedBitrate(p.current.id);
  const effBr = dlBr !== undefined ? dlBr : resolveBitrate(p.streamQuality);

  return (
    <footer className="playbar">
      <button
        className="pb-left"
        {...swipe.handlers}
        onClick={() => { if (!swipe.moved.current) onExpand?.(); }}
        aria-label="Open now playing"
      >
        {cover && (
          <img className="pb-cover" src={cover} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
        )}
        <div className="pb-meta track-fade" key={p.current.id}>
          {(() => { const np = npDisplay(p.current, p.bookChapters, t.currentTime, p.radioTitle); return (
            <>
              <MarqueeText className="pb-title" text={np.title} />
              {p.activeDeviceName ? (
                <div className="pb-sub pb-oncast">▸ Playing on {p.activeDeviceName}</div>
              ) : (np.isBook || isRadio || isPodcast) ? (
                np.subtitle && <div className="pb-sub">{np.subtitle}</div>
              ) : (p.current.artist || p.current.album) && (
                <div className="pb-sub">{[p.current.artist, p.current.album].filter(Boolean).join(" · ")}</div>
              )}
            </>
          ); })()}
          {/* Delivery quality is this device's setting, so hide it when another device plays. */}
          {!p.isActiveDevice || hideQuality ? null : effBr > 0 ? (
            <div className="pb-quality"><span>MP3 · {effBr} kbps</span></div>
          ) : q && (
            <div className="pb-quality">
              {q.lossless && <span className="lossless-badge sm">LOSSLESS</span>}
              {qBits && <span>{qBits}</span>}
            </div>
          )}
        </div>
      </button>

      {/* Guests mirror the host and transport is a no-op for them, so lock it here too. */}
      <div className={`pb-mini${p.isGuest ? " guest-locked" : ""}`}>
        <button onClick={p.toggle} disabled={p.isGuest} aria-label={p.isPlaying ? "Pause" : "Play"}>
          {p.buffering ? <Spinner size={22} /> : p.isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>
        {!noTransport && <button onClick={p.next} disabled={p.isGuest} aria-label="Next"><NextIcon size={20} /></button>}
      </div>

      <div className="pb-center">
        <div className={`pb-controls${p.isGuest ? " guest-locked" : ""}${noTransport ? " lean" : ""}`}>
          {!noShufRep && (
            <button className={`ctl-toggle${p.shuffle ? " active" : ""}`} onClick={p.toggleShuffle} disabled={p.isGuest} aria-label="Shuffle" aria-pressed={p.shuffle}>
              <ShuffleIcon size={16} />
            </button>
          )}
          {!noTransport && <button onClick={p.prev} disabled={p.isGuest} aria-label="Previous"><PrevIcon size={18} /></button>}
          <button className="main" onClick={p.toggle} disabled={p.isGuest} aria-label={p.isPlaying ? "Pause" : "Play"}>
            {p.buffering ? <Spinner size={20} /> : p.isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          {!noTransport && <button onClick={p.next} disabled={p.isGuest} aria-label="Next"><NextIcon size={18} /></button>}
          {!noShufRep && (
            <button className={`ctl-toggle${p.repeat !== "off" ? " active" : ""}`} onClick={p.cycleRepeat} disabled={p.isGuest} aria-label={`Repeat: ${p.repeat}`}>
              {p.repeat === "one" ? <RepeatOneIcon size={16} /> : <RepeatIcon size={16} />}
            </button>
          )}
          <SpeedControl />
        </div>
        {p.current.isRadio ? (
          <div className="pb-progress pb-live"><span className="live-badge">● LIVE</span></div>
        ) : (
          <div className="pb-progress" style={p.isGuest ? { pointerEvents: "none" } : undefined}>
            <span className="pb-time">{fmt(t.currentTime)}</span>
            <Scrubber value={t.currentTime} max={p.duration || 0} buffered={t.buffered} onSeek={p.seek} className="pb-seek" />
            <span className="pb-time">{fmt(p.duration)}</span>
          </div>
        )}
      </div>

      <div className="pb-right">
        <DevicePicker size={18} />
        <button
          className={`ctl-toggle${rightPanel === "queue" ? " active" : ""}`}
          onClick={onToggleQueue}
          aria-label="Toggle queue"
          aria-pressed={rightPanel === "queue"}
          title="Queue"
        >
          <QueueIcon size={18} />
        </button>
        {!hideLyrics && (
          <button
            className={`ctl-toggle${rightPanel === "lyrics" ? " active" : ""}`}
            onClick={onToggleLyrics}
            aria-label={isPodcast ? "Toggle transcript" : "Toggle lyrics"}
            aria-pressed={rightPanel === "lyrics"}
            title={isPodcast ? "Transcript" : "Lyrics"}
          >
            <LyricsIcon size={18} />
          </button>
        )}
        <SleepButton />
        <MuteButton size={18} />
        <input
          className="slider pb-vol"
          type="range" min={0} max={1} step={0.01} value={p.volume}
          style={fill(p.volume * 100)}
          onChange={e => p.setVolume(Number(e.target.value))}
          aria-label="Volume"
        />
      </div>
    </footer>
  );
}

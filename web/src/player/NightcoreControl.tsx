import { usePlayer } from "./PlayerProvider";
import { VIBE_MIN, VIBE_MAX } from "./nightcore";

function fill(pct: number) {
  return { background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.22) ${pct}%)` };
}

// Nightcore / slowed mode: a button that toggles the mode (audio + UI theme) and,
// while on, a "vibe" dial from slowed-with-reverb through normal to nightcore.
// Hidden for spoken word, which has SpeedControl. A session guest can toggle the
// theme but gets no dial, since their playback follows the host's rate.
export function NightcoreControl({ className }: { className?: string }) {
  const p = usePlayer();
  if (p.current?.isAudiobook || p.current?.isPodcast) return null;
  const pct = ((p.vibe - VIBE_MIN) / (VIBE_MAX - VIBE_MIN)) * 100;
  return (
    <div className={`nc-control${p.nightcore ? " on" : ""}${className ? " " + className : ""}`}>
      <button
        className="nc-star" onClick={() => p.setNightcore(!p.nightcore)}
        aria-pressed={p.nightcore} title="Nightcore mode" aria-label="Nightcore mode"
      >✦</button>
      {p.nightcore && !p.isGuest && (
        <>
          <input
            className="slider nc-vibe" type="range" min={VIBE_MIN} max={VIBE_MAX} step={0.01}
            value={p.vibe} style={fill(pct)} onChange={e => p.setVibe(Number(e.target.value))}
            aria-label="Vibe: slowed to nightcore"
          />
          <button
            className="nc-rate" onClick={() => p.setVibe(p.vibe < 1 ? 0.8 : p.vibe === 1.25 ? 1.5 : 1.25)}
            title="Snap presets: classic 1.25× ↔ osu! 1.5× (slowed: 0.8×)" aria-label="Snap vibe preset"
          >{p.vibe.toFixed(2)}×</button>
        </>
      )}
    </div>
  );
}

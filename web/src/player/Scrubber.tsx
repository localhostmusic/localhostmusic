import { useRef, useState } from "react";

// Progress scrubber with a buffered overlay: track, buffered ranges, played
// portion, and a native range input on top for seeking and keyboard.
// While a pointer is down the bar follows the drag and the seek commits on
// release, so live position updates don't pull the thumb back.
export function Scrubber({ value, max, buffered, onSeek, className }: {
  value: number;
  max: number;
  buffered: [number, number][];
  onSeek: (t: number) => void;
  className?: string;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const pointerActive = useRef(false);
  const shown = drag ?? value;
  const pct = (t: number) => (max > 0 ? Math.min(100, Math.max(0, (t / max) * 100)) : 0);
  return (
    <div className={`scrubber${className ? ` ${className}` : ""}`}>
      <div className="scrub-track" />
      {buffered.map(([s, e], i) => (
        <div key={i} className="scrub-buffered" style={{ left: `${pct(s)}%`, width: `${pct(e) - pct(s)}%` }} />
      ))}
      <div className="scrub-played" style={{ width: `${pct(shown)}%` }} />
      <input
        className="slider scrub-input"
        type="range" min={0} max={max || 0} step={0.1} value={shown}
        onPointerDown={() => { pointerActive.current = true; }}
        onChange={e => {
          const v = Number(e.target.value);
          if (pointerActive.current) setDrag(v);   // live preview while dragging
          else { onSeek(v); setDrag(null); }        // keyboard arrows: seek immediately
        }}
        onPointerUp={e => {
          pointerActive.current = false;
          onSeek(Number(e.currentTarget.value));    // commit once, at the release position
          setDrag(null);
        }}
        onPointerCancel={() => { pointerActive.current = false; setDrag(null); }}
        aria-label="Seek"
      />
    </div>
  );
}

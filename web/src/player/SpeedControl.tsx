import { usePlayer } from "./PlayerProvider";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

// Playback-speed button for spoken word. Clicking steps from 1x up to 2x and
// wraps. The engine preserves pitch.
export function SpeedControl({ className }: { className?: string }) {
  const p = usePlayer();
  if (!p.current?.isAudiobook && !p.current?.isPodcast) return null; // spoken word: books + podcasts
  const cycle = () => {
    const i = SPEEDS.indexOf(p.playbackRate);
    p.setPlaybackRate(SPEEDS[(i + 1) % SPEEDS.length] ?? 1);
  };
  return (
    <button
      className={`speed-btn${p.playbackRate !== 1 ? " on" : ""}${className ? " " + className : ""}`}
      onClick={cycle} title="Playback speed" aria-label={`Playback speed ${p.playbackRate}×`}
    >
      {p.playbackRate}×
    </button>
  );
}

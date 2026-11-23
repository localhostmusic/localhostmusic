import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type Line = { start?: number; text: string };

// Podcast transcript in the lyrics slot. Timed transcripts highlight and follow
// the current line (click to seek), untimed ones render as plain text.
export function TranscriptView({ episodeId, currentTime, onSeek }: {
  episodeId: number; currentTime: number; onSeek: (t: number) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loaded, setLoaded] = useState(false);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLoaded(false); setLines([]);
    api.getEpisodeTranscript(episodeId).then((r: any) => setLines(r?.lines || [])).catch(() => {}).finally(() => setLoaded(true));
  }, [episodeId]);

  const timed = lines.some(l => l.start != null);
  const curIdx = timed ? lines.reduce((best, l, i) => (l.start != null && currentTime * 1000 >= l.start ? i : best), -1) : -1;
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [curIdx]);

  if (!loaded) return <div className="lyrics"><p className="lyrics-empty">Loading transcript…</p></div>;
  if (!lines.length) return <div className="lyrics"><p className="lyrics-empty">No transcript available for this episode.</p></div>;

  return (
    <div className="lyrics transcript">
      {lines.map((l, i) => (
        <button key={i} ref={i === curIdx ? activeRef : undefined}
          className={`transcript-line${i === curIdx ? " active" : ""}${l.start != null ? " seekable" : ""}`}
          onClick={() => l.start != null && onSeek(l.start / 1000)} disabled={l.start == null}>
          {l.text}
        </button>
      ))}
    </div>
  );
}

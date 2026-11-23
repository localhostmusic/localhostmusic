import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";

interface Line { t: number; text: string; }

// Parse LRC ("[mm:ss.xx] text") into timed lines.
function parseLRC(lrc: string): Line[] {
  const lines: Line[] = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(re)];
    if (!stamps.length) continue;
    const text = raw.replace(re, "").trim();
    for (const s of stamps) {
      const min = +s[1], sec = +s[2], frac = s[3] ? +`0.${s[3]}` : 0;
      lines.push({ t: min * 60 + sec + frac, text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

type Data = { synced: string | null; plain: string | null } | null;

export function LyricsView({ trackId, currentTime, onSeek, onSync }: {
  trackId: number;
  currentTime: number;
  onSeek: (t: number) => void;
  onSync?: () => void; // open the tap-to-sync tool (parent owns it)
}) {
  const [data, setData] = useState<Data | "loading">("loading");

  useEffect(() => {
    setData("loading");
    api.getLyrics(trackId).then(setData).catch(() => setData(null));
  }, [trackId]);

  const synced = useMemo(
    () => (data && data !== "loading" && data.synced ? parseLRC(data.synced) : null),
    [data]
  );

  const activeIdx = useMemo(() => {
    if (!synced) return -1;
    let idx = -1;
    for (let i = 0; i < synced.length; i++) {
      if (synced[i].t <= currentTime + 0.25) idx = i; else break;
    }
    return idx;
  }, [synced, currentTime]);

  const listRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = activeRef.current, list = listRef.current;
    if (!el || !list) return;
    // Scroll only the lyrics container. scrollIntoView on iOS also scrolls
    // ancestors/body and shifts the fixed player overlay.
    const elRect = el.getBoundingClientRect(), listRect = list.getBoundingClientRect();
    const top = list.scrollTop + (elRect.top - listRect.top) - list.clientHeight / 2 + elRect.height / 2;
    list.scrollTo({ top, behavior: "smooth" });
  }, [activeIdx]);

  if (data === "loading") return <div className="lyrics empty">Loading lyrics…</div>;

  // No lyrics (a miss or a fetch failure): offer the sync tool, which also takes
  // pasted text.
  if (!data || (!data.synced && !data.plain)) {
    return (
      <div className="lyrics empty lyrics-add">
        <p className="lyrics-add-title">No lyrics found.</p>
        {onSync && (
          <div className="lyrics-add-actions">
            <button className="btn primary" onClick={onSync}>Add lyrics</button>
          </div>
        )}
      </div>
    );
  }

  if (synced) {
    return (
      <ul className="lyrics synced" ref={listRef}>
        {synced.map((l, i) => (
          <li
            key={i}
            ref={i === activeIdx ? activeRef : undefined}
            className={i === activeIdx ? "active" : ""}
            onClick={() => onSeek(l.t)}
          >
            {l.text || "♪"}
          </li>
        ))}
      </ul>
    );
  }
  return <pre className="lyrics plain">{data.plain}</pre>;
}

import { useState } from "react";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { LyricsView } from "./LyricsView";
import { SyncLyrics } from "./SyncLyrics";
import { ChevronDownIcon } from "../ui/icons";

// Right-hand lyrics panel shown while browsing.
export function LyricsPanel({ onClose, closing }: { onClose: () => void; closing?: boolean }) {
  const p = usePlayer();
  const t = usePlayerTime();
  const [syncing, setSyncing] = useState(false);
  const [version, setVersion] = useState(0); // bump to re-fetch after a manual sync

  return (
    <aside className={`lyrics-panel${closing ? " closing" : ""}`}>
      <header className="lyrics-panel-head">
        <span>Lyrics</span>
        <div className="lyrics-panel-actions">
          {p.current && <button className="link-btn" onClick={() => setSyncing(true)}>Sync</button>}
          <button className="lyrics-panel-close" onClick={onClose} aria-label="Hide lyrics">
            <ChevronDownIcon size={18} />
          </button>
        </div>
      </header>
      {p.current
        ? <LyricsView key={version} trackId={p.current.id} currentTime={t.currentTime} onSeek={p.seek} onSync={() => setSyncing(true)} />
        : <div className="lyrics empty">Nothing playing.</div>}

      {syncing && p.current && (
        <SyncLyrics
          trackId={p.current.id}
          title={p.current.title}
          onClose={() => setSyncing(false)}
          onSaved={() => { setSyncing(false); setVersion(v => v + 1); }}
        />
      )}
    </aside>
  );
}

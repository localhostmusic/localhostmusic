import { useEffect, useRef, useState } from "react";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { chapterIndexAt, stripChapterNum } from "./audiobook";
import { stationTrack, type Station } from "./radioStation";
import { episodeTrack, type Episode } from "./podcastEpisode";
import { api } from "../api";
import { ChevronDownIcon, PlayIcon, PauseIcon, GearIcon, RadioIcon } from "../ui/icons";
import type { AutoDJMode, AutoDJUnit } from "./PlayerProvider";

const DJ_MODES: { id: AutoDJMode; label: string }[] = [
  { id: "similar-artists", label: "Similar artists" },
  { id: "similar-songs", label: "Similar tracks" },
  { id: "favorites", label: "Favorites" },
  { id: "random", label: "Random" },
];
const DJ_HINTS: Record<AutoDJMode, string> = {
  "similar-artists": "Songs by artists similar to what's playing.",
  "similar-songs": "Songs that sound like the current track.",
  "favorites": "Your 4★+ and hearted songs.",
  "random": "A shuffle of your whole library.",
};

// Right-hand panel showing the play order: current track and what's coming up.
// Click to jump, drag to reorder, x to remove.
export function QueuePanel({ onClose, closing }: { onClose: () => void; closing?: boolean }) {
  const p = usePlayer();
  const dragIdx = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [djSettings, setDjSettings] = useState(false);
  const currentRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [overflowBottom, setOverflowBottom] = useState(false);

  const t = usePlayerTime();
  const items = p.order.map((qi, opos) => ({ track: p.queue[qi], opos })).filter(x => x.track);
  // Audiobook: show the book's chapters (seek within the file) instead of a
  // one-item queue, and no Auto DJ.
  const isBook = !!p.current?.isAudiobook;
  const isRadio = !!p.current?.isRadio;
  const isPodcast = !!p.current?.isPodcast;
  const showChapters = isBook && p.bookChapters.length > 0;
  const curChapter = showChapters ? chapterIndexAt(p.bookChapters, t.currentTime) : -1;

  // Radio pane: station switcher plus quick-add.
  const [stations, setStations] = useState<Station[]>([]);
  const [rName, setRName] = useState("");
  const [rUrl, setRUrl] = useState("");
  const [rBusy, setRBusy] = useState(false);
  const [rErr, setRErr] = useState("");
  const loadStations = () => api.getRadioStations().then(setStations).catch(() => {});
  useEffect(() => { if (isRadio) loadStations(); }, [isRadio]);
  async function quickAddStation(e: React.FormEvent) {
    e.preventDefault();
    const u = rUrl.trim(), nm = rName.trim();
    if (!u) return;
    setRBusy(true); setRErr("");
    try {
      const r: any = await api.resolveRadio(u);
      if (!r?.ok) { setRErr(r?.error || "Not a valid stream."); return; }
      await api.addRadioStation({ name: nm || r.name || u, streamUrl: r.streamUrl });
      setRName(""); setRUrl(""); loadStations();
    } catch { setRErr("Couldn't add."); }
    finally { setRBusy(false); }
  }

  // Podcast pane: the current show's other episodes.
  const [podChannel, setPodChannel] = useState<any>(null);
  useEffect(() => {
    const cid = p.current?.podcastChannelId;
    if (isPodcast && cid != null) api.getPodcast(cid).then(setPodChannel).catch(() => {});
    else setPodChannel(null);
  }, [isPodcast, p.current?.podcastChannelId]);
  const playEpisode = (ep: Episode) => (
    p.current?.podcastEpisodeId === ep.id
      ? p.toggle()
      : p.playNow([episodeTrack(ep, podChannel.title, podChannel.imageUrl, podChannel.id)], 0, ((ep.position as number) || 0) / 1000)
  );

  // Keep the now-playing row in view when the queue overflows.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [p.pos]);

  // Fade the bottom edge only while there's more queue to scroll to.
  const updateOverflow = () => {
    const el = listRef.current;
    if (!el) return;
    const more = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setOverflowBottom(prev => (prev === more ? prev : more));
  };
  useEffect(() => {
    updateOverflow();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  return (
    <aside className={`lyrics-panel${closing ? " closing" : ""}`}>
      <header className="lyrics-panel-head">
        <span>{showChapters ? "Chapters" : isRadio ? "Radio" : isPodcast ? "Episodes" : "Queue"}</span>
        <div className="queue-head-actions">
          {!isBook && !isRadio && !isPodcast && (<>
          <button
            className={`autodj-toggle${p.autoDJ ? " on" : ""}`}
            onClick={() => p.setAutoDJ(!p.autoDJ)}
            aria-pressed={p.autoDJ}
            title="Auto DJ keeps the queue playing when it runs low"
          >
            Auto DJ
          </button>
          <button className="autodj-gear" onClick={() => setDjSettings(s => !s)} aria-label="Auto DJ settings"><GearIcon size={15} /></button>
          {djSettings && (
            <>
              <div className="trk-menu-backdrop" onClick={() => setDjSettings(false)} />
              <div className="autodj-settings">
                <div className="autodj-settings-title">Auto DJ</div>
                <label className="autodj-field">
                  <span>Source</span>
                  <select className="autodj-select" value={p.autoDJMode} onChange={e => p.setAutoDJMode(e.target.value as AutoDJMode)}>
                    {DJ_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
                <p className="autodj-hint">{DJ_HINTS[p.autoDJMode]}</p>
                <div className="autodj-field">
                  <span>Add</span>
                  <div className="autodj-modes">
                    {(["songs", "albums"] as AutoDJUnit[]).map(u => (
                      <button key={u} className={`autodj-mode${p.autoDJUnit === u ? " on" : ""}`} onClick={() => p.setAutoDJUnit(u)}>
                        {u === "songs" ? "Songs" : "Albums"}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="autodj-count">
                  <span>{p.autoDJUnit === "albums" ? "Albums per refill" : "Songs per refill"}</span>
                  <input
                    type="number" min={p.autoDJUnit === "albums" ? 1 : 5} max={p.autoDJUnit === "albums" ? 8 : 50} value={p.autoDJCount}
                    onChange={e => {
                      const max = p.autoDJUnit === "albums" ? 8 : 50, min = p.autoDJUnit === "albums" ? 1 : 5;
                      p.setAutoDJCount(Math.max(min, Math.min(max, Number(e.target.value) || min)));
                    }}
                  />
                </label>
              </div>
            </>
          )}
          </>)}
          <button className="lyrics-panel-close" onClick={onClose} aria-label="Hide queue"><ChevronDownIcon size={18} /></button>
        </div>
      </header>

      <div className={`queue-list${overflowBottom ? " overflow-bottom" : ""}`} ref={listRef} onScroll={updateOverflow}>
        {isRadio && (
          <div className="radio-q">
            {stations.map(s => {
              const cur = p.current?.radioStationId === s.id;
              return (
                <button key={s.id} className={`radio-q-item${cur ? " current" : ""}`}
                  onClick={() => (cur ? p.toggle() : p.playNow([stationTrack(s)], 0))}>
                  <span className="radio-q-ic">{cur && p.isPlaying ? <PauseIcon size={15} /> : cur ? <PlayIcon size={15} /> : <RadioIcon size={15} />}</span>
                  <span className="radio-q-meta">
                    <span className="radio-q-name">{s.name}</span>
                    {cur && p.radioTitle && <span className="radio-q-now">{p.radioTitle}</span>}
                  </span>
                </button>
              );
            })}
            <form className="radio-q-add" onSubmit={quickAddStation}>
              <input placeholder="Station name (optional)" value={rName} onChange={e => setRName(e.target.value)} />
              <div className="radio-q-add-row">
                <input placeholder="Stream / .pls URL" value={rUrl} onChange={e => setRUrl(e.target.value)} spellCheck={false} />
                <button className="btn primary" disabled={rBusy || !rUrl.trim()}>{rBusy ? "…" : "Add"}</button>
              </div>
            </form>
            {rErr && <p className="err radio-q-err">{rErr}</p>}
          </div>
        )}
        {isPodcast && podChannel?.episodes?.map((ep: Episode) => {
          const cur = p.current?.podcastEpisodeId === ep.id;
          return (
            <button key={ep.id} className={`radio-q-item${cur ? " current" : ""}${ep.played ? " played" : ""}`} onClick={() => playEpisode(ep)}>
              <span className="radio-q-ic">{cur && p.isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}</span>
              <span className="radio-q-meta">
                <span className="radio-q-name">{ep.title}</span>
                {(ep.played || (ep.position ?? 0) > 0) && <span className="radio-q-now">{ep.played ? "Played" : "In progress"}</span>}
              </span>
            </button>
          );
        })}
        {!isRadio && !isPodcast && showChapters && p.bookChapters.map(c => {
          const isCur = c.idx === curChapter;
          return (
            <button key={c.idx} className={`chapter-row${isCur ? " active" : ""}`} onClick={() => p.seek(c.startMs / 1000)}>
              <span className="chapter-num">{isCur && p.isPlaying ? <PauseIcon size={14} /> : isCur ? <PlayIcon size={14} /> : c.idx + 1}</span>
              <span className="chapter-title">{stripChapterNum(c.title)}</span>
            </button>
          );
        })}
        {!isRadio && !isPodcast && !showChapters && items.length === 0 && <div className="lyrics empty">Queue is empty.</div>}
        {!isRadio && !isPodcast && !showChapters && items.map(({ track, opos }) => (
          <div
            key={`${opos}-${track.id}`}
            ref={opos === p.pos ? currentRef : undefined}
            className={`queue-item${opos === p.pos ? " current" : ""}${dragOver === opos ? " drag-over" : ""}`}
            draggable
            onDragStart={() => { dragIdx.current = opos; }}
            onDragOver={e => { e.preventDefault(); setDragOver(opos); }}
            onDragLeave={() => setDragOver(d => (d === opos ? null : d))}
            onDrop={() => { const f = dragIdx.current; dragIdx.current = null; setDragOver(null); if (f != null) p.reorderQueue(f, opos); }}
          >
            <span className="drag-handle" title="Drag to reorder">⠿</span>
            <button className="queue-cover" onClick={() => p.jumpTo(opos)} aria-label={`Play ${track.title}`}>
              {track.albumId != null
                ? <img src={api.coverUrl(track.albumId, 96)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                : <span className="queue-cover-empty" />}
              {opos === p.pos && <span className="queue-now">{p.isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}</span>}
            </button>
            <button className="queue-meta" onClick={() => p.jumpTo(opos)}>
              <span className="queue-title">{track.title}</span>
              {track.artist && <span className="queue-artist">{track.artist}</span>}
            </button>
            <button className="trk-act" onClick={() => p.removeFromQueue(opos)} aria-label="Remove from queue">✕</button>
          </div>
        ))}
      </div>
    </aside>
  );
}

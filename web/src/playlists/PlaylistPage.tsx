import { useLibraryRevision } from "../library/useLibraryRevision";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { PlayIcon, NextIcon, QueueIcon, RadioIcon, AlbumIcon, TrashIcon } from "../ui/icons";
import { openMenuAt, openMenuFrom, type MenuSpec } from "../ui/ContextMenu";
import { Stars } from "../ui/Stars";
import { PlaylistCover } from "./PlaylistCover";
import { PlaylistEditModal } from "./PlaylistEditModal";
import { SmartPlaylistModal } from "./SmartPlaylistModal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { MarqueeText } from "../ui/MarqueeText";
import { DownloadButton } from "../player/DownloadButton";
import { useProgressive } from "../ui/useProgressive";

function fmt(d?: number) {
  if (!d) return "";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function agoStr(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PlaylistPage({ playlistId, onBack, onOpenAlbum }: {
  playlistId: number;
  onBack: () => void;
  onOpenAlbum: (id: number) => void;
}) {
  const libraryVersion = useLibraryRevision();
  const [pl, setPl] = useState<any>(null);
  const [tracks, setTracks] = useState<any[]>([]);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [coverVer, setCoverVer] = useState(0);
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const player = usePlayer();
  const dragIdx = useRef<number | null>(null);

  const load = () => api.getPlaylist(playlistId).then((p: any) => { setPl(p); setTracks(p.tracks); }).catch(() => {});
  useEffect(() => { load(); }, [playlistId]);
  useEffect(() => { api.getLibraryState().then((s: any) => setRatings(s.ratings || {})).catch(() => {}); }, [libraryVersion]);

  async function rate(id: number, n: number) {
    const prev = ratings[id] ?? 0;
    setRatings(r => ({ ...r, [id]: n }));
    try { await api.rateTrack(id, n); } catch { setRatings(r => ({ ...r, [id]: prev })); }
  }

  // A 5,000-song playlist is ~200k DOM nodes if every row is built at once.
  const { visible, more, sentinel } = useProgressive(tracks, `playlist-${playlistId}`, 100, 200);
  if (!pl) return <div className="page">Loading…</div>;

  const smart = !!pl.smart; // rule-driven: no manual reorder / remove
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const queue = () => tracks.map(t => ({ ...t })) as Track[];

  const rowMenu = (t: Track, i: number): MenuSpec => ({
    header: { title: t.title, sub: t.artist, albumId: t.albumId },
    rating: { value: ratings[t.id] ?? 0, onRate: n => rate(t.id, n) },
    sections: [
      [
        { label: "Play", icon: <PlayIcon size={16} />, onSelect: () => player.playNow(queue(), i) },
        { label: "Play next", icon: <NextIcon size={16} />, onSelect: () => player.playNext(t) },
        { label: "Add to queue", icon: <QueueIcon size={16} />, onSelect: () => player.addToQueue(t) },
        { label: "Start radio", icon: <RadioIcon size={16} />, onSelect: () => player.startRadio(t) },
      ],
      t.albumId != null ? [{ label: "Go to album", icon: <AlbumIcon size={16} />, onSelect: () => onOpenAlbum(t.albumId!) }] : [],
      smart ? [] : [{ label: "Remove from playlist", icon: <TrashIcon size={16} />, danger: true, onSelect: () => remove(t.id) }],
    ],
    playlist: { ids: async () => [t.id], defaultName: t.title },
  });

  async function remove(trackId: number) {
    await api.removeFromPlaylist(playlistId, trackId);
    setTracks(ts => ts.filter(t => t.id !== trackId));
  }
  async function del() {
    await api.deletePlaylist(playlistId);
    onBack();
  }
  async function refreshSmart() {
    setRefreshing(true);
    try { await api.refreshSmartPlaylist(playlistId); await load(); } catch { /* */ } finally { setRefreshing(false); }
  }
  function onDrop(i: number) {
    const from = dragIdx.current; dragIdx.current = null; setDragOver(null);
    if (from == null || from === i) return;
    const next = tracks.slice();
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    setTracks(next);
    api.reorderPlaylist(playlistId, next.map(t => t.id)).catch(() => {});
  }

  const albumIds = [...new Set(tracks.map(t => t.albumId).filter((a): a is number => a != null))];

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}>‹ Playlists</button>
      <header className="album-head pl-head">
        <PlaylistCover id={pl.id} hasCover={!!pl.cover_path} albumIds={albumIds} version={coverVer} className="head" />
        <div className="album-head-meta">
          <p className="eyebrow">{smart ? "✦ Smart playlist" : "Playlist"}</p>
          <h1>{pl.name}</h1>
          {pl.dedicated_to && <p className="album-artist">Dedicated to {pl.dedicated_to}</p>}
          {pl.mood && <p className="pl-mood">{pl.mood}</p>}
          <p className="muted">{tracks.length} song{tracks.length === 1 ? "" : "s"}{total ? ` · ${fmt(total)}` : ""}{smart && pl.refreshedAt ? ` · updated ${agoStr(pl.refreshedAt)}` : ""}</p>
          <div className="artist-admin">
            <button className="btn primary" onClick={() => tracks.length && player.playNow(queue(), 0)}>
              <PlayIcon size={16} /> Play
            </button>
            <DownloadButton kind="playlist" id={pl.id} name={pl.name} tracks={tracks} />
            {smart && <button className="btn" onClick={refreshSmart} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
            <button className="btn" onClick={() => setEditing(true)}>{smart ? "Edit rules" : "Edit"}</button>
            <button className="btn" onClick={() => setConfirmDel(true)}>Delete</button>
          </div>
        </div>
      </header>

      {/* Below the header, so the header height is set by the cover alone. */}
      {pl.description && <p className="pl-desc">{pl.description}</p>}

      {tracks.length === 0 && <p className="muted">This playlist is empty. Add songs with the + on any track.</p>}
      <ol className="track-list">
        {visible.map((t, i) => (
          <li
            key={t.id}
            className={`trk${player.current?.id === t.id ? " playing" : ""}${dragOver === i ? " drag-over" : ""}`}
            draggable={!smart}
            onDragStart={() => { if (!smart) dragIdx.current = i; }}
            onDragOver={e => { if (smart) return; e.preventDefault(); setDragOver(i); }}
            onDragLeave={() => setDragOver(d => (d === i ? null : d))}
            onDrop={() => !smart && onDrop(i)}
            onDoubleClick={() => player.playNow(queue(), i)}
            onContextMenu={e => openMenuAt(e, rowMenu(t, i))}
          >
            {smart ? <span className="drag-handle drag-handle-off" aria-hidden="true" /> : <span className="drag-handle" title="Drag to reorder">⠿</span>}
            <button className="row-play" onClick={() => player.playNow(queue(), i)} aria-label={`Play ${t.title}`}>
              {player.current?.id === t.id
                ? <span className={`eq${player.isPlaying ? "" : " paused"}`} aria-label="Now playing"><i /><i /><i /></span>
                : <span className="num">{i + 1}</span>}
              <span className="row-play-icon"><PlayIcon size={14} /></span>
            </button>
            <div className="trk-main">
              <MarqueeText className="trk-title" text={t.title} />
              {t.artist && <span className="trk-artist">{t.artist}</span>}
            </div>
            {t.album && <button className="trk-album" onClick={() => t.albumId != null && onOpenAlbum(t.albumId)}>{t.album}</button>}
            {t.lossless ? <span className="lossless-badge sm">LOSSLESS</span> : null}
            <span className={`trk-rating${ratings[t.id] ? " rated" : ""}`}>
              <Stars value={ratings[t.id] ?? 0} onRate={n => rate(t.id, n)} />
            </span>
            <div className="pl-actions">
              <button className="trk-act" onClick={e => openMenuFrom(e.currentTarget, rowMenu(t, i))} aria-label="More actions">⋯</button>
            </div>
            <span className="dur">{fmt(t.duration)}</span>
          </li>
        ))}
      </ol>
      {more && <div ref={sentinel} className="grid-sentinel" aria-hidden />}

      {editing && (smart
        ? <SmartPlaylistModal
            existing={{ id: pl.id, name: pl.name, rules: pl.rules }}
            onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); load(); }}
          />
        : <PlaylistEditModal
            playlist={pl} albumIds={albumIds}
            onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); setCoverVer(v => v + 1); load(); }}
          />
      )}
      {confirmDel && (
        <ConfirmDialog
          title={`Delete “${pl.name}”?`}
          message="This permanently deletes the playlist. Your songs aren't affected."
          confirmLabel="Delete playlist"
          onConfirm={del}
          onCancel={() => setConfirmDel(false)}
        />
      )}
    </div>
  );
}

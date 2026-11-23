import { useEffect, useState } from "react";
import { api } from "../api";
import { PlaylistCover } from "./PlaylistCover";
import { SmartPlaylistModal } from "./SmartPlaylistModal";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonCards } from "../ui/Skeleton";
import { TRACK_DND } from "../ui/Sidebar";

function parseAlbums(s?: string): number[] {
  return s ? s.split(",").map(Number).filter(n => !isNaN(n)) : [];
}

export function PlaylistsPage({ onOpenPlaylist, onOpenLiked, onAddTrackToPlaylist }: {
  onOpenPlaylist: (id: number) => void;
  onOpenLiked: () => void;
  onAddTrackToPlaylist: (playlistId: number, trackId: number) => void;
}) {
  const [lists, setLists] = useState<any[]>([]);
  const [likedCount, setLikedCount] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [overId, setOverId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [smartOpen, setSmartOpen] = useState(false);
  const load = () => api.getPlaylists().then(setLists).finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    api.getFavorites().then((f: any[]) => setLikedCount(f.length)).catch(() => {});
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createPlaylist(name);
    setName("");
    load();
  }

  return (
    <div className="page">
      <form className="pl-create" onSubmit={create}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="New playlist" />
        <button type="submit" className="play" aria-label="Create">＋</button>
        <button type="button" className="btn pl-smart-btn" onClick={() => setSmartOpen(true)} title="A playlist that fills itself from rules">✦ Smart playlist</button>
      </form>
      {smartOpen && <SmartPlaylistModal onClose={() => setSmartOpen(false)} onSaved={id => { setSmartOpen(false); load(); onOpenPlaylist(id); }} />}
      <div className="pl-grid">
        {/* Liked Songs is a built-in playlist, pinned first. */}
        <button className="pl-card pl-liked" onClick={onOpenLiked}>
          <span className="pl-liked-cover" aria-hidden>♥</span>
          <MarqueeText className="pl-name" text="Liked Songs" />
          <span className="pl-count">
            {likedCount === null ? "-" : `${likedCount} song${likedCount === 1 ? "" : "s"}`}
          </span>
        </button>
        {!loaded && lists.length === 0 && <SkeletonCards count={8} kind="playlist" />}
        {lists.map(l => (
          <button
            key={l.id}
            className={`pl-card${overId === l.id ? " drop-over" : ""}`}
            onClick={() => onOpenPlaylist(l.id)}
            onDragOver={e => {
              if (!e.dataTransfer.types.includes(TRACK_DND)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOverId(l.id);
            }}
            onDragLeave={() => setOverId(id => (id === l.id ? null : id))}
            onDrop={e => {
              e.preventDefault();
              setOverId(null);
              const tid = Number(e.dataTransfer.getData(TRACK_DND));
              if (tid) onAddTrackToPlaylist(l.id, tid);
            }}
          >
            <PlaylistCover id={l.id} hasCover={!!l.cover_path} albumIds={parseAlbums(l.artAlbums)} />
            <MarqueeText className="pl-card-name" text={l.name} />
            {l.smart ? <div className="pl-card-sub pl-card-smart">✦ Smart</div> : null}
            {l.dedicated_to && <div className="pl-card-sub">For {l.dedicated_to}</div>}
            {!l.dedicated_to && l.mood && <div className="pl-card-sub">{l.mood}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

import { EmptyState } from "../ui/EmptyState";
import { useEffect, useState } from "react";
import { api } from "../api";
import { listGroups, removeGroup, storageInfo, onDownloadsChange, groupTracks, clearAllDownloads, type DlGroup } from "../player/downloads";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { MarqueeText } from "../ui/MarqueeText";
import { PlayIcon, TrashIcon, DownloadIcon } from "../ui/icons";

function fmtGB(bytes: number) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
const QUALITY = (b: number) => (b > 0 ? `${b} kbps` : "Original");

interface Props {
  onOpenAlbum: (id: number) => void;
  onOpenPlaylist: (id: number) => void;
}

export function DownloadsPage({ onOpenAlbum, onOpenPlaylist }: Props) {
  const player = usePlayer();
  const [groups, setGroups] = useState<DlGroup[]>(() => listGroups());
  const [store, setStore] = useState<{ usage: number; quota: number; persisted: boolean }>({ usage: 0, quota: 0, persisted: false });

  const refresh = () => { setGroups(listGroups()); storageInfo().then(setStore); };
  useEffect(() => { refresh(); return onDownloadsChange(refresh); }, []);

  const pct = store.quota ? Math.min(100, (store.usage / store.quota) * 100) : 0;
  // Play from the stored metadata, so it works offline (no library API).
  const playGroup = (g: DlGroup) => { if (g.tracks.length) player.playNow(groupTracks(g.kind, g.id) as Track[], 0); };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Downloads</h1>
        {groups.length > 0 && <button className="btn" onClick={() => clearAllDownloads()}>Clear all</button>}
      </header>

      <div className="dl-storage">
        <div className="dl-storage-bar"><div className="dl-storage-fill" style={{ width: `${pct}%` }} /></div>
        <div className="dl-storage-meta">
          <span>{fmtGB(store.usage)} used{store.quota ? ` of ~${fmtGB(store.quota)}` : ""}</span>
          <span className={store.persisted ? "dl-persist ok" : "dl-persist"}>
            {store.persisted ? "Protected from auto-cleanup" : "Best effort: may be cleared if storage runs low"}
          </span>
        </div>
      </div>

      {groups.length === 0 && (
        <EmptyState icon={<DownloadIcon size={26} />} title="Nothing downloaded yet">Open an album or playlist and hit <strong>Download</strong> to keep it on this device for offline listening.</EmptyState>
      )}

      <div className="album-grid">
        {groups.map(g => {
          const cover = g.kind === "album" ? api.coverUrl(g.id, 300) : api.playlistCoverUrl(g.id);
          const open = () => g.kind === "album" ? onOpenAlbum(g.id) : onOpenPlaylist(g.id);
          return (
            <div key={`${g.kind}-${g.id}`} className="album-card dl-card">
              <div className="album-art dl-art">
                <button className="dl-art-open" onClick={open} aria-label={`Open ${g.name}`}>
                  <img src={cover} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                </button>
                <button className="dl-art-remove" onClick={() => removeGroup(g.kind, g.id)} aria-label="Remove download" title="Remove download">
                  <TrashIcon size={15} />
                </button>
                <button className="album-play" onClick={() => playGroup(g)} aria-label="Play (works offline)" title="Play (works offline)">
                  <PlayIcon size={18} />
                </button>
              </div>
              <MarqueeText className="album-title" text={g.name} />
              <div className="album-year">{g.tracks.length} songs · {QUALITY(g.bitrate)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useLibraryRevision } from "../library/useLibraryRevision";
import { useEffect, useState } from "react";
import { api } from "../api";
import { AlbumCard } from "./AlbumCard";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { PlayIcon, StarIcon, BookIcon } from "../ui/icons";
import { openMenuFrom } from "../ui/ContextMenu";
import { MetadataModal } from "./MetadataModal";
import { TrackRow } from "./TrackRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { DownloadButton } from "../player/DownloadButton";
import { SkeletonRows } from "../ui/Skeleton";
import { groupTracks, listGroups } from "../player/downloads";
import { coverPalette } from "../ui/colors";

function fmt(d?: number) {
  if (!d) return "";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AlbumPage({ albumId, onBack, onOpenArtist, onOpenAlbum, isAdmin }: {
  albumId: number;
  onBack?: () => void;
  onOpenArtist?: (id: number, name: string) => void;
  onOpenAlbum?: (id: number) => void;
  isAdmin?: boolean;
}) {
  const libraryVersion = useLibraryRevision();
  const [album, setAlbum] = useState<{ id: number; title: string; year?: number; artist?: string; artist_id?: number; tracks: Track[] } | null>(null);
  const [favs, setFavs] = useState<Set<number>>(new Set());
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [starredAlbums, setStarredAlbums] = useState<Set<number>>(new Set());
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [fixing, setFixing] = useState<Track | null>(null);
  const [delTrack, setDelTrack] = useState<Track | null>(null);
  const [markBook, setMarkBook] = useState(false);    // confirm "mark as audiobook"
  const [tint, setTint] = useState<string | null>(null); // dominant colour of this album's art
  const [moreBy, setMoreBy] = useState<any[]>([]); // the artist's other albums, for the shelf under the songs
  const player = usePlayer();

  const reload = () => api.getAlbum(albumId).then(setAlbum).catch(() => {
    // Offline: render from the downloaded copy if we have it, so the album opens
    // and plays without the library API.
    const tracks = groupTracks("album", albumId);
    if (tracks.length) {
      const g = listGroups().find(x => x.kind === "album" && x.id === albumId);
      setAlbum({ id: albumId, title: g?.name ?? "Album", artist: tracks[0]?.artist, tracks: tracks as Track[] });
    }
  });
  useEffect(() => {
    let live = true;
    const local = groupTracks("album", albumId);
    const group = listGroups().find(g => g.kind === "album" && g.id === albumId);
    setAlbum(local.length ? { id: albumId, title: group?.name ?? "Album", artist: local[0]?.artist, tracks: local as Track[] } : null);
    api.getAlbum(albumId).then(a => { if (live) setAlbum(a); }).catch(() => {});
    return () => { live = false; };
  }, [albumId]);
  // Page tint from the viewed album's cover. Separate from the global accent, which
  // follows the playing album.
  useEffect(() => {
    let cancelled = false;
    setTint(null);
    coverPalette(api.coverUrl(albumId, 160)).then(p => { if (!cancelled) setTint(p?.accent ?? null); });
    return () => { cancelled = true; };
  }, [albumId]);
  // "More by": the artist's other albums.
  const artistId = album?.artist_id;
  useEffect(() => {
    setMoreBy([]);
    if (artistId == null) return;
    let live = true;
    api.getArtistAlbums(artistId).then((list: any[]) => {
      if (live) setMoreBy(list.filter(a => a.id !== albumId).reverse()); // newest first
    }).catch(() => {});
    return () => { live = false; };
  }, [artistId, albumId]);
  useEffect(() => {
    api.getFavorites().then((f: any[]) => setFavs(new Set(f.map(t => t.id)))).catch(() => {});
    api.getPlaylists().then(setPlaylists).catch(() => {});
    api.getLibraryState().then((s: any) => {
      setRatings(s.ratings || {});
      setStarredAlbums(new Set(s.starredAlbums || []));
    }).catch(() => {});
  }, [libraryVersion]);

  async function toggleFav(id: number) {
    const had = favs.has(id);
    setFavs(f => { const n = new Set(f); if (had) n.delete(id); else n.add(id); return n; });
    try { await (had ? api.removeFavorite(id) : api.addFavorite(id)); }
    catch { setFavs(f => { const n = new Set(f); if (had) n.add(id); else n.delete(id); return n; }); } // revert on failure
  }
  async function rate(id: number, n: number) {
    const prev = ratings[id] ?? 0;
    setRatings(r => ({ ...r, [id]: n }));
    try { await api.rateTrack(id, n); }
    catch { setRatings(r => ({ ...r, [id]: prev })); } // revert on failure
  }
  async function toggleAlbumStar() {
    if (!album) return;
    const on = !starredAlbums.has(album.id);
    setStarredAlbums(s => { const n = new Set(s); if (on) n.add(album.id); else n.delete(album.id); return n; });
    try { await api.starAlbum(album.id, on); }
    catch { setStarredAlbums(s => { const n = new Set(s); if (on) n.delete(album.id); else n.add(album.id); return n; }); }
  }
  const addToPlaylist = (pid: number, tid: number) => { api.addToPlaylist(pid, tid).catch(() => {}); };

  async function performDelete(t: Track) {
    try {
      await api.deleteTrack(t.id);
      setDelTrack(null);
      if (album && album.tracks.length <= 1) { onBack?.(); return; } // album now empty
      reload();
    } catch (e: any) {
      setDelTrack(null);
      alert(`Couldn't delete the track: ${e?.message ?? "unknown error"}`);
    }
  }

  if (!album) return (
    <div className="page">
      {onBack && <button className="back-btn" onClick={onBack}>‹ Back</button>}
      <header className="album-head">
        <div className="album-head-cover skeleton" />
        <div className="album-head-meta">
          <div className="skeleton skel-line" style={{ width: 54, height: 11 }} />
          <div className="skeleton skel-line" style={{ width: "68%", height: 26, margin: "8px 0" }} />
          <div className="skeleton skel-line" style={{ width: "40%" }} />
          <div className="skeleton skel-line" style={{ width: "55%" }} />
        </div>
      </header>
      <ol className="track-list"><SkeletonRows count={8} /></ol>
    </div>
  );

  const total = album.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  // Enrich queued tracks with album context so the play bar shows artwork + names.
  const queue: Track[] = album.tracks.map(t => ({
    ...t, albumId: album.id, album: album.title, artist: t.artist ?? album.artist,
  }));
  return (
    <div className="page album-page">
      <div className={`album-bg${tint ? " on" : ""}`} style={tint ? ({ "--album-tint": tint } as Record<string, string>) : undefined}>
        {/* The cover, heavily blurred, as the header backdrop. */}
        <img className="album-backdrop" src={api.coverUrl(album.id, 160)} alt="" aria-hidden />
      </div>
      {onBack && <button className="back-btn" onClick={onBack}>‹ Back</button>}
      <header className="album-head">
        <img
          className="album-head-cover"
          src={api.coverUrl(album.id)}
          alt=""
          onError={e => (e.currentTarget.style.visibility = "hidden")}
        />
        <div className="album-head-meta">
          <p className="eyebrow">Album</p>
          <h1>{album.title}</h1>
          {album.artist && (
            onOpenArtist && album.artist_id != null
              ? <button className="album-artist link" onClick={() => onOpenArtist(album.artist_id!, album.artist!)}>{album.artist}</button>
              : <p className="album-artist">{album.artist}</p>
          )}
          <p className="muted">
            {album.year ? `${album.year} · ` : ""}{album.tracks.length} songs{total ? ` · ${fmt(total)}` : ""}
          </p>
          <div className="head-actions">
            <button className="btn primary play-all" onClick={() => queue.length && player.playNow(queue, 0)}>
              <PlayIcon size={20} /> Play
            </button>
            <button className="btn" onClick={() => queue.length && player.startRadio(queue[0])} title="Play similar songs">
              Radio
            </button>
            <button
              className={`btn album-star${starredAlbums.has(album.id) ? " on" : ""}`}
              onClick={toggleAlbumStar}
              aria-label={starredAlbums.has(album.id) ? "Unstar album" : "Star album"}
              title={starredAlbums.has(album.id) ? "Starred" : "Star album"}
            >
              <StarIcon size={16} filled={starredAlbums.has(album.id)} />
            </button>
            <DownloadButton kind="album" id={album.id} name={album.title} tracks={queue} />
            {isAdmin && (
              <div className="album-menu-wrap">
                <button className="btn album-more" aria-label="More actions" title="More actions"
                  onClick={e => openMenuFrom(e.currentTarget, { sections: [[{ label: "Mark as audiobook", icon: <BookIcon size={16} />, onSelect: () => setMarkBook(true) }]] })}>⋯</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <ol className="track-list">
        {queue.map((t, i) => (
          <TrackRow
            key={t.id} tracks={queue} i={i}
            onPlay={(rows, idx) => player.playNow(rows as Track[], idx)}
            isCurrent={player.current?.id === t.id} isPlaying={player.isPlaying}
            isFav={favs.has(t.id)} onToggleFav={toggleFav}
            rating={ratings[t.id]} onRate={rate}
            playlists={playlists} onAddToPlaylist={addToPlaylist}
            hideAlbum
            onOpenArtist={onOpenArtist}
            onEditMeta={isAdmin ? (tr) => setFixing(tr) : undefined}
            onDeleteTrack={isAdmin ? (tr) => setDelTrack(tr) : undefined}
          />
        ))}
      </ol>

      {moreBy.length > 0 && onOpenAlbum && (
        <section className="shelf album-more-by">
          <div className="shelf-head"><h2>More by {album.artist}</h2></div>
          <div className="shelf-rail">
            {moreBy.map(a => <AlbumCard key={a.id} album={a} onOpen={onOpenAlbum} />)}
          </div>
        </section>
      )}

      {fixing && (
        <MetadataModal
          track={{ id: fixing.id, title: fixing.title, artist: fixing.artist ?? album.artist, album: album.title }}
          onClose={() => { setFixing(null); reload(); }}
          onApplied={() => { setFixing(null); reload(); }}
        />
      )}
      {delTrack && (
        <ConfirmDialog
          title={`Delete “${delTrack.title}”?`}
          message="This permanently removes the file from disk and can't be undone."
          confirmLabel="Delete from disk"
          onConfirm={() => performDelete(delTrack)}
          onCancel={() => setDelTrack(null)}
        />
      )}
      {markBook && album && (
        <ConfirmDialog
          title="Mark as audiobook?"
          message="This album moves to the Audiobooks section (chapter-style playback, resume, no lyrics/radio). You can undo it any time from the audiobook's page."
          confirmLabel="Mark as audiobook"
          danger={false}
          onConfirm={async () => { setMarkBook(false); try { await api.setAlbumAudiobook(album.id, true); onBack?.(); } catch { alert("Couldn't update."); } }}
          onCancel={() => setMarkBook(false)}
        />
      )}
    </div>
  );
}

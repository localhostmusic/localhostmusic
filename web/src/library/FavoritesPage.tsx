import { StarIcon } from "../ui/icons";
import { EmptyState } from "../ui/EmptyState";
import { useLibraryRevision } from "../library/useLibraryRevision";
import { useEffect, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { TrackRow } from "./TrackRow";
import { AlbumCard } from "./AlbumCard";
import { ArtistAvatar } from "./ArtistAvatar";
import { RatingInsights } from "./RatingInsights";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonRows, SkeletonCards } from "../ui/Skeleton";

type Tab = "songs" | "albums" | "artists";
// In the Songs tab: "fav" = hearted; a number = songs rated exactly that many stars.
type Filter = "fav" | number;

export function FavoritesPage({ onOpenAlbum, onOpenArtist }: {
  onOpenAlbum: (id: number) => void;
  onOpenArtist: (id: number, name: string) => void;
}) {
  const libraryVersion = useLibraryRevision();
  const [tab, setTab] = useState<Tab>("songs");
  const [filter, setFilter] = useState<Filter>("fav");
  const [favTracks, setFavTracks] = useState<any[]>([]);
  const [favIds, setFavIds] = useState<Set<number>>(new Set());
  const [ratedTracks, setRatedTracks] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [albums, setAlbums] = useState<any[] | null>(null);
  const [artists, setArtists] = useState<any[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const player = usePlayer();

  useEffect(() => {
    api.getFavorites().then((f: any[]) => { setFavTracks(f); setFavIds(new Set(f.map(t => t.id))); })
      .catch(() => {}).finally(() => setLoaded(true));
    api.getPlaylists().then(setPlaylists).catch(() => {});
    api.getLibraryState().then((s: any) => setRatings(s.ratings || {})).catch(() => {});
  }, [libraryVersion]);
  useEffect(() => {
    if (typeof filter === "number") api.getRated(filter).then(setRatedTracks).catch(() => {});
  }, [filter, libraryVersion]);
  useEffect(() => {
    if (tab === "albums") api.getStarredAlbums().then(setAlbums).catch(() => setAlbums([]));
    if (tab === "artists") api.getStarredArtists().then(setArtists).catch(() => setArtists([]));
  }, [tab, libraryVersion]);

  const tracks = filter === "fav" ? favTracks : ratedTracks;

  async function toggleFav(id: number) {
    const had = favIds.has(id);
    setFavIds(s => { const n = new Set(s); if (had) n.delete(id); else n.add(id); return n; });
    if (filter === "fav" && had) setFavTracks(ts => ts.filter(t => t.id !== id));
    try { await (had ? api.removeFavorite(id) : api.addFavorite(id)); }
    catch { setFavIds(s => { const n = new Set(s); if (had) n.add(id); else n.delete(id); return n; }); }
  }
  async function rate(id: number, n: number) {
    const prev = ratings[id] ?? 0;
    setRatings(r => ({ ...r, [id]: n }));
    if (typeof filter === "number" && n !== filter) setRatedTracks(ts => ts.filter(t => t.id !== id));
    try { await api.rateTrack(id, n); } catch { setRatings(r => ({ ...r, [id]: prev })); }
  }
  const play = (rows: any[], i: number) => player.playNow(rows.map(r => ({ ...r })) as Track[], i);
  const addToPlaylist = (pid: number, tid: number) => { api.addToPlaylist(pid, tid).catch(() => {}); };

  const emptySongs = filter === "fav"
    ? "No favorites yet. Tap the ♥ on any song to add it here."
    : `No songs rated ${filter}★ yet. Rate songs from the ⋯ menu or by hovering a row.`;

  return (
    <div className="page">
      <header className="page-head"><h1>Liked Songs</h1></header>

      <div className="hub-tabs">
        {(["songs", "albums", "artists"] as Tab[]).map(t => (
          <button key={t} className={`hub-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "songs" ? "Songs" : t === "albums" ? "Albums" : "Artists"}
          </button>
        ))}
      </div>

      {tab === "songs" && (
        <>
          <RatingInsights onOpenArtist={onOpenArtist} />
          <div className="rating-filter">
            <button className={`rf-chip${filter === "fav" ? " on" : ""}`} onClick={() => setFilter("fav")}>♥ Favorites</button>
            {[5, 4, 3, 2, 1].map(n => (
              <button key={n} className={`rf-chip${filter === n ? " on" : ""}`} onClick={() => setFilter(n)}>{n}★</button>
            ))}
          </div>
          {loaded && tracks.length === 0 && <p className="muted">{emptySongs}</p>}
          <ol className="track-list">
            {!loaded && tracks.length === 0 && <SkeletonRows count={8} />}
            {tracks.map((t, i) => (
              <TrackRow
                key={t.id} tracks={tracks} i={i}
                onPlay={play} onOpenAlbum={onOpenAlbum}
                isCurrent={player.current?.id === t.id} isPlaying={player.isPlaying} isFav={favIds.has(t.id)} onToggleFav={toggleFav}
                rating={ratings[t.id]} onRate={rate}
                playlists={playlists} onAddToPlaylist={addToPlaylist}
              />
            ))}
          </ol>
        </>
      )}

      {tab === "albums" && (
        <div className="album-grid">
          {albums === null && <SkeletonCards count={12} kind="album" />}
          {albums?.map(al => <AlbumCard key={al.id} album={al} onOpen={onOpenAlbum} showArtist />)}
          {albums?.length === 0 && <EmptyState icon={<StarIcon size={26} />} title="No starred albums yet">Tap the ☆ on an album to save it here.</EmptyState>}
        </div>
      )}

      {tab === "artists" && (
        <div className="artist-grid">
          {artists === null && <SkeletonCards count={12} kind="artist" />}
          {artists?.map(a => (
            <button key={a.id} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
              <ArtistAvatar id={a.id} name={a.name} />
              <MarqueeText className="artist-name" text={a.name} />
            </button>
          ))}
          {artists?.length === 0 && <EmptyState icon={<StarIcon size={26} />} title="No starred artists yet">Tap “Star artist” on an artist to save them here.</EmptyState>}
        </div>
      )}
    </div>
  );
}

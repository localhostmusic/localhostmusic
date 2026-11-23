import { useLibraryRevision } from "../library/useLibraryRevision";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { stationTrack } from "../player/radioStation";
import { AlbumCard } from "../library/AlbumCard";
import { ArtistAvatar } from "../library/ArtistAvatar";
import { TrackRow } from "../library/TrackRow";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonCards, SkeletonRows } from "../ui/Skeleton";

interface Props {
  q: string;                        // owned by App (the header's search field)
  onOpenArtist: (id: number, name: string) => void;
  onOpenAlbum: (id: number) => void;
  onOpenAudiobook: (id: number) => void;
  onOpenPodcast: (id: number) => void;
  onOpenEpisode: (id: number) => void;
  onOpenExternalArtist: (name: string, image?: string) => void;
}

// Round avatar for an external (not in library) artist: Deezer image, monogram fallback.
function ExtAvatar({ name, image }: { name: string; image?: string }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) return <span className="artist-avatar">{(name || "?").slice(0, 1).toUpperCase()}</span>;
  return <img className="artist-avatar img" src={image} alt="" onError={() => setFailed(true)} />;
}

export function SearchPage({ q, onOpenArtist, onOpenAlbum, onOpenAudiobook, onOpenPodcast, onOpenEpisode, onOpenExternalArtist }: Props) {
  const libraryVersion = useLibraryRevision();
  const [res, setRes] = useState<any>(null);
  const [ext, setExt] = useState<any>(null);
  const [discover, setDiscover] = useState<any>(null);
  const [favs, setFavs] = useState<Set<number>>(new Set());
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [playlists, setPlaylists] = useState<any[]>([]);
  const player = usePlayer();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api.getDiscover().then(setDiscover).catch(() => {});
    api.getFavorites().then((f: any[]) => setFavs(new Set(f.map(t => t.id)))).catch(() => {});
    api.getLibraryState().then((s: any) => setRatings(s.ratings || {})).catch(() => {});
    api.getPlaylists().then(setPlaylists).catch(() => {});
  }, [libraryVersion]);

  // Debounced live search. `live` guards against out-of-order responses: a slow
  // reply for an earlier query must not overwrite the current results.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    let live = true;
    if (!q.trim()) { setRes(null); setExt(null); return; }
    timer.current = setTimeout(() => {
      api.search(q).then(r => { if (live) setRes(r); }).catch(() => { if (live) setRes(null); });
      api.searchExternal(q).then(r => { if (live) setExt(r); }).catch(() => { if (live) setExt(null); });
    }, 240);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const toQueue = (rows: any[]): Track[] => rows.map(r => ({ ...r, albumId: r.albumId ?? r.album_id }));
  const playFrom = (rows: any[], i: number) => player.playNow(toQueue(rows), i);

  async function toggleFav(id: number) {
    const had = favs.has(id);
    setFavs(f => { const n = new Set(f); if (had) n.delete(id); else n.add(id); return n; });
    try { await (had ? api.removeFavorite(id) : api.addFavorite(id)); }
    catch { setFavs(f => { const n = new Set(f); if (had) n.add(id); else n.delete(id); return n; }); } // revert on failure
  }
  const addToPlaylist = (pid: number, tid: number) => { api.addToPlaylist(pid, tid).catch(() => {}); };
  async function rate(id: number, n: number) {
    const prev = ratings[id] ?? 0;
    setRatings(r => ({ ...r, [id]: n }));
    try { await api.rateTrack(id, n); } catch { setRatings(r => ({ ...r, [id]: prev })); }
  }

  const rowProps = {
    onPlay: playFrom, onOpenAlbum, onToggleFav: toggleFav, onRate: rate, playlists, onAddToPlaylist: addToPlaylist,
  };
  const renderTracks = (rows: any[]) => (
    <ol className="track-list">
      {rows.map((t: any, i: number) => (
        <TrackRow
          key={t.id} tracks={rows} i={i}
          isCurrent={player.current?.id === t.id} isPlaying={player.isPlaying} isFav={favs.has(t.id)}
          rating={ratings[t.id]} onOpenArtist={onOpenArtist}
          {...rowProps}
        />
      ))}
    </ol>
  );
  const renderArtists = (rows: any[]) => (
    <div className="artist-grid">
      {rows.map((a: any) => (
        <button key={a.id} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
          <ArtistAvatar id={a.id} name={a.name} />
          <MarqueeText className="artist-name" text={a.name} />
        </button>
      ))}
    </div>
  );
  const renderAlbums = (rows: any[], onOpen: (id: number) => void) => (
    <div className="album-grid">
      {rows.map((al: any) => <AlbumCard key={al.id} album={al} onOpen={onOpen} showArtist />)}
    </div>
  );
  const renderExternalArtists = (rows: any[]) => (
    <div className="artist-grid">
      {rows.map((a: any) => (
        <button key={"x" + a.deezerId} className="artist-card" onClick={() => onOpenExternalArtist(a.name, a.image)}>
          <ExtAvatar name={a.name} image={a.image} />
          <MarqueeText className="artist-name" text={a.name} />
        </button>
      ))}
    </div>
  );

  // A hit from another section has to say where it lives (e.g. Podcast).
  const Section = ({ where, children }: { where: string; children: React.ReactNode }) => (
    <>
      <h3 className="section-title search-section">
        <span className="search-where">in {where}</span>
      </h3>
      {children}
    </>
  );

  const idle = !q.trim();
  const groups = res
    ? ["artists", "albums", "tracks", "audiobooks", "podcasts", "episodes", "stations"]
        .reduce((n, k) => n + (res[k]?.length ?? 0), 0)
    : 0;

  return (
    <div className="page">
      {/* No <h1> or input, the header owns both. */}
      {idle && !discover && (
        <>
          <h3 className="section-title">Top artists</h3>
          <div className="artist-grid"><SkeletonCards count={6} kind="artist" /></div>
          <h3 className="section-title">Top albums</h3>
          <div className="album-grid"><SkeletonCards count={6} /></div>
        </>
      )}
      {idle && discover && (
        <>
          {discover.artists?.length > 0 && <><h3 className="section-title">Top artists</h3>{renderArtists(discover.artists)}</>}
          {discover.albums?.length > 0 && <><h3 className="section-title">Top albums</h3>{renderAlbums(discover.albums, onOpenAlbum)}</>}
          {discover.tracks?.length > 0 && <><h3 className="section-title">Top songs</h3>{renderTracks(discover.tracks)}</>}
        </>
      )}

      {!idle && !res && (
        <>
          <h3 className="section-title">Albums</h3>
          <div className="album-grid"><SkeletonCards count={6} /></div>
          <h3 className="section-title">Songs</h3>
          <ol className="track-list"><SkeletonRows count={5} /></ol>
        </>
      )}

      {res && (
        <>
          {res.artists.length > 0 && <Section where="Artists">{renderArtists(res.artists)}</Section>}
          {res.albums.length > 0 && <Section where="Albums">{renderAlbums(res.albums, onOpenAlbum)}</Section>}
          {res.tracks.length > 0 && <Section where="Songs">{renderTracks(res.tracks)}</Section>}

          {res.audiobooks?.length > 0 && (
            <Section where="Audiobooks">{renderAlbums(res.audiobooks, onOpenAudiobook)}</Section>
          )}

          {res.podcasts?.length > 0 && (
            <Section where="Podcasts">
              <ul className="result-list">
                {res.podcasts.map((p: any) => (
                  <li key={p.id}>
                    <button className="result-row" onClick={() => onOpenPodcast(p.id)}>
                      {p.image && <img className="result-art" src={p.image} alt="" />}
                      <span className="result-text">
                        <span className="result-title">{p.title}</span>
                        {p.author && <span className="result-sub">{p.author}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {res.episodes?.length > 0 && (
            <Section where="Podcast episodes">
              <ul className="result-list">
                {res.episodes.map((e: any) => (
                  <li key={e.id}>
                    <button className="result-row" onClick={() => onOpenEpisode(e.id)}>
                      {e.image && <img className="result-art" src={e.image} alt="" />}
                      <span className="result-text">
                        <span className="result-title">{e.title}</span>
                        <span className="result-sub">{e.channel}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {res.stations?.length > 0 && (
            <Section where="Radio">
              <ul className="result-list">
                {res.stations.map((s: any) => (
                  <li key={s.id}>
                    <button className="result-row" onClick={() => player.playNow([stationTrack(s)], 0)}>
                      {s.favicon && <img className="result-art" src={s.favicon} alt="" />}
                      <span className="result-text">
                        <span className="result-title">{s.name}</span>
                        <span className="result-sub">Internet radio</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {groups === 0 && <p className="muted">Nothing in your library for “{q}”.</p>}
        </>
      )}

      {ext && ext.artists?.length > 0 && (
        <Section where="Not in your library">{renderExternalArtists(ext.artists)}</Section>
      )}
    </div>
  );
}

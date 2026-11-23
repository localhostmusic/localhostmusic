import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "./PlayerProvider";
import { PlayIcon, QueueIcon, Spinner } from "../ui/icons";
import { ArtistAvatar } from "../library/ArtistAvatar";

// Quick library browser inside the full-screen player: browse, search, drill
// from artist to albums to tracks, play or queue. Full pages hand off to the app.
export function LibraryDrawer({ onClose, onOpenAlbum, onOpenArtist }: {
  onClose: () => void;
  onOpenAlbum?: (id: number) => void;
  onOpenArtist?: (id: number, name: string) => void;
}) {
  const p = usePlayer();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [allArtists, setAllArtists] = useState<any[]>([]);
  const [allAlbums, setAllAlbums] = useState<any[]>([]);
  const [artist, setArtist] = useState<{ id: number; name: string; albums: any[] } | null>(null);
  const [album, setAlbum] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load the whole library so it is browsable before typing.
  useEffect(() => {
    api.getArtists().then(a => setAllArtists(a || [])).catch(() => {});
    api.getAlbums().then(a => setAllAlbums(a || [])).catch(() => {});
  }, []);

  // Debounced live search; `live` guards out-of-order responses.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    let live = true;
    if (!q.trim()) { setRes(null); return; }
    timer.current = setTimeout(() => {
      api.search(q).then(r => { if (live) setRes(r); }).catch(() => { if (live) setRes({ artists: [], albums: [], tracks: [] }); });
    }, 240);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const toTracks = (rows: any[]): Track[] => rows.map(r => ({ ...r, albumId: r.albumId ?? r.album_id }));
  // Tracks nested in an album payload don't carry album fields, so add them.
  const albumTracks = (al: any): Track[] =>
    (al.tracks || []).map((t: any) => ({ ...t, albumId: t.albumId ?? t.album_id ?? al.id, album: t.album ?? al.title, artist: t.artist ?? al.artist }));
  const drillAlbum = (id: number) => {
    setLoading(true);
    api.getAlbum(id).then(a => { setAlbum(a); setLoading(false); }).catch(() => setLoading(false));
  };
  const drillArtist = (id: number, name: string) => {
    setLoading(true);
    api.getArtistAlbums(id)
      .then((albums: any[]) => { setArtist({ id, name, albums: albums || [] }); setAlbum(null); setLoading(false); })
      .catch(() => setLoading(false));
  };
  const goBack = () => {
    if (album) setAlbum(null);        // album: back to artist view (if any) or lists
    else setArtist(null);             // artist: back to lists
  };

  // `nav` renders the subtitle as clickable artist / album links. Off for
  // in-album track lists.
  const trackRow = (rows: Track[], i: number, showArt: boolean, nav = false) => {
    const tr = rows[i] as any;
    const albumId = tr.albumId ?? tr.album_id;
    return (
      <div key={tr.id} className={`np-dr-track${p.current?.id === tr.id ? " current" : ""}`}
        onClick={() => p.playNow(rows, i)} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter") p.playNow(rows, i); }}>
        {showArt && albumId != null
          ? <img src={api.coverUrl(albumId, 96)} alt="" loading="lazy" />
          : showArt ? <span className="np-dr-noart" /> : <span className="np-dr-num">{i + 1}</span>}
        <div className="np-dr-meta">
          <span className="np-dr-title">{tr.title}</span>
          {nav
            ? (tr.artist || tr.album) && (
              <span className="np-dr-sub">
                {tr.artist && (
                  <button className="np-dr-sublink" title={`Go to ${tr.artist}`} disabled={tr.artistId == null}
                    onClick={e => { e.stopPropagation(); if (tr.artistId != null) drillArtist(tr.artistId, tr.artist); }}>
                    {tr.artist}
                  </button>
                )}
                {tr.artist && tr.album && <span className="np-dr-dot">·</span>}
                {tr.album && (
                  <button className="np-dr-sublink" title={`Go to ${tr.album}`} disabled={albumId == null}
                    onClick={e => { e.stopPropagation(); if (albumId != null) drillAlbum(albumId); }}>
                    {tr.album}
                  </button>
                )}
              </span>
            )
            : tr.artist && <span className="np-dr-sub">{tr.artist}</span>}
        </div>
        <button className="np-dr-queue" title="Add to queue" aria-label={`Queue ${tr.title}`}
          onClick={e => { e.stopPropagation(); p.addToQueue(rows[i]); }}>
          <QueueIcon size={16} />
        </button>
      </div>
    );
  };

  const albumGrid = (albums: any[]) => (
    <div className="np-dr-albums">
      {albums.map((al: any) => (
        <button key={al.id} className="np-dr-album" onClick={() => drillAlbum(al.id)} title={al.title}>
          <img src={api.coverUrl(al.id, 160)} alt="" loading="lazy" />
          <span className="np-dr-title">{al.title}</span>
          {al.artist && <span className="np-dr-sub">{al.artist}</span>}
        </button>
      ))}
    </div>
  );
  const artistList = (artists: any[]) => (
    <div className="np-dr-list">
      {artists.map((a: any) => (
        <button key={a.id} className="np-dr-artist-row" onClick={() => drillArtist(a.id, a.name)} title={a.name}>
          <ArtistAvatar id={a.id} name={a.name} />
          <span className="np-dr-title">{a.name}</span>
          <span className="np-dr-chev">›</span>
        </button>
      ))}
    </div>
  );

  const inDrill = album || artist;

  return (
    <>
      <div className="np-drawer-backdrop" onClick={onClose} />
      <aside className="np-drawer" role="dialog" aria-label="Browse library">
        <input className="search np-dr-search" value={q} autoFocus
          placeholder="Search your library"
          onChange={e => { setQ(e.target.value); setAlbum(null); setArtist(null); }} />

        <div className="np-drawer-body">
          {loading && <div className="np-dr-hint"><Spinner size={22} /></div>}

          {!loading && inDrill && (
            <button className="np-dr-back" onClick={goBack}>
              ‹ {album && artist ? artist.name : "Back"}
            </button>
          )}

          {!loading && album && (
            <>
              <div className="np-dr-albumhead">
                <img src={api.coverUrl(album.id, 160)} alt="" />
                <div className="np-dr-meta">
                  <span className="np-dr-title">{album.title}</span>
                  {album.artist && (() => {
                    const aid = album.artist_id ?? album.artistId;
                    return aid != null
                      ? <button className="np-dr-sub np-dr-sublink" title={`Go to ${album.artist}`}
                          onClick={() => drillArtist(aid, album.artist)}>{album.artist}</button>
                      : <span className="np-dr-sub">{album.artist}</span>;
                  })()}
                  <div className="np-dr-actions">
                    <button className="np-dr-play" onClick={() => p.playNow(albumTracks(album), 0)}>
                      <PlayIcon size={14} /> Play
                    </button>
                    <button className="np-dr-open" onClick={() => p.addManyToQueue(albumTracks(album))} title="Add album to queue">
                      <QueueIcon size={14} /> Queue
                    </button>
                    {onOpenAlbum && <button className="np-dr-open" onClick={() => onOpenAlbum(album.id)}>Open page</button>}
                  </div>
                </div>
              </div>
              <div className="np-dr-list">
                {albumTracks(album).map((_, i, rows) => trackRow(rows as Track[], i, false))}
              </div>
            </>
          )}

          {!loading && !album && artist && (
            <>
              <div className="np-dr-albumhead">
                <div className="np-dr-meta">
                  <span className="np-dr-title">{artist.name}</span>
                  <span className="np-dr-sub">{artist.albums.length} album{artist.albums.length === 1 ? "" : "s"}</span>
                  {onOpenArtist && (
                    <div className="np-dr-actions">
                      <button className="np-dr-open" onClick={() => onOpenArtist(artist.id, artist.name)}>Open page</button>
                    </div>
                  )}
                </div>
              </div>
              {albumGrid(artist.albums)}
            </>
          )}

          {!loading && !inDrill && res && (
            <>
              {res.tracks?.length > 0 && (
                <section>
                  <h4>Songs</h4>
                  <div className="np-dr-list">
                    {toTracks(res.tracks.slice(0, 8)).map((_, i, rows) => trackRow(rows as Track[], i, true, true))}
                  </div>
                </section>
              )}
              {res.albums?.length > 0 && (
                <section>
                  <h4>Albums</h4>
                  {albumGrid(res.albums.slice(0, 12))}
                </section>
              )}
              {res.artists?.length > 0 && (
                <section>
                  <h4>Artists</h4>
                  {artistList(res.artists.slice(0, 12))}
                </section>
              )}
              {!res.tracks?.length && !res.albums?.length && !res.artists?.length && (
                <p className="np-dr-hint">Nothing found.</p>
              )}
            </>
          )}

          {!loading && !inDrill && !res && (
            <>
              {allArtists.length > 0 && (
                <section>
                  <h4>Artists</h4>
                  {artistList(allArtists)}
                </section>
              )}
              {allAlbums.length > 0 && (
                <section>
                  <h4>Albums</h4>
                  {albumGrid(allAlbums)}
                </section>
              )}
              {!allArtists.length && !allAlbums.length && (
                <p className="np-dr-hint">Search your library to play or queue something without leaving the player.</p>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

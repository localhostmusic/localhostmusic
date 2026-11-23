import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePlayer, usePlayerTime, type Track } from "../player/PlayerProvider";
import { useSpatialNav, focusFirst } from "./useSpatialNav";
import { coverPalette, rgbaFromHex, type Palette } from "../ui/colors";
import { PlayIcon, PauseIcon, PrevIcon, NextIcon, HeartIcon, ShuffleIcon, RepeatIcon, RepeatOneIcon, LyricsIcon, SearchIcon } from "../ui/icons";
import { LyricsView } from "../player/LyricsView";
import { NeonVisualizer } from "../player/NeonVisualizer";
import "./tv.css";

type TvView =
  | { name: "browse" }
  | { name: "search" }
  | { name: "artist"; id: number; title?: string }
  | { name: "album"; id: number; title?: string }
  | { name: "playlist"; id: number; title?: string }
  | { name: "favorites" }
  | { name: "queue" }
  | { name: "nowplaying" };

type NpMode = "art" | "lyrics" | "viz";
const NP_MODES: NpMode[] = ["art", "lyrics", "viz"];
const NP_LABEL: Record<NpMode, string> = { art: "Artwork", lyrics: "Lyrics", viz: "Visualizer" };

function fmt(d: number) {
  if (!d || !isFinite(d)) return "0:00";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function yearsRange(begin?: string | null, ended?: string | null): string | null {
  if (!begin) return null;
  const b = begin.slice(0, 4), e = ended ? ended.slice(0, 4) : "present";
  return b === e ? b : `${b}-${e}`;
}
function listenTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Sample an artwork URL into an accent palette (cached per URL while mounted).
function useArtAccent(url?: string): Palette | null {
  const [pal, setPal] = useState<Palette | null>(null);
  useEffect(() => {
    setPal(null);
    if (!url) return;
    let alive = true;
    coverPalette(url).then(p => { if (alive) setPal(p); });
    return () => { alive = false; };
  }, [url]);
  return pal;
}

// A focusable card used across the rails.
function Card({ title, sub, img, round, onSelect }: {
  title: string; sub?: string; img: string | null; round?: boolean; onSelect: () => void;
}) {
  return (
    <button className="tv-card tv-focusable" onClick={onSelect}>
      <div className={`tv-card-art${round ? " round" : ""}`}>
        {img && <img src={img} alt="" loading="lazy" onError={e => (e.currentTarget.style.visibility = "hidden")} />}
      </div>
      <div className="tv-card-title">{title}</div>
      {sub && <div className="tv-card-sub">{sub}</div>}
    </button>
  );
}

export function TVApp({ onExit }: { onExit: () => void }) {
  const p = usePlayer();
  const t = usePlayerTime();
  const [stack, setStack] = useState<TvView[]>([{ name: "browse" }]);
  const view = stack[stack.length - 1];
  const push = (v: TvView) => setStack(s => [...s, v]);
  const back = () => setStack(s => (s.length > 1 ? s.slice(0, -1) : s));
  // Back goes up the screen stack and exits the app at the root.
  const goBack = () => { if (stack.length > 1) back(); else onExit(); };

  const [albums, setAlbums] = useState<any[]>([]);
  const [artists, setArtists] = useState<any[]>([]);
  const [albumData, setAlbumData] = useState<any | null>(null);
  const [artistAlbums, setArtistAlbums] = useState<any[]>([]);
  const [artistInfo, setArtistInfo] = useState<any | null>(null);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [playlistData, setPlaylistData] = useState<any | null>(null);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [npMode, setNpMode] = useState<NpMode>("art");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const showLyrics = npMode === "lyrics";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ artists: any[]; albums: any[]; tracks: any[] }>({ artists: [], albums: [], tracks: [] });
  const [editing, setEditing] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const seekBarRef = useRef<HTMLButtonElement>(null);
  const pRef = useRef(p); pRef.current = p;
  const tRef = useRef(t); tRef.current = t;

  // Tell the native TV wrapper (if any) to route the d-pad to the page while the
  // TV UI is mounted, and release it otherwise (e.g. login, keyboard).
  useEffect(() => {
    const bridge = (window as any).LhmTV;
    bridge?.setNavActive?.(true);
    // Fixed 1920-wide viewport, so the layout renders at its designed size at any
    // pixel density.
    const vp = document.querySelector('meta[name=viewport]');
    const prev = vp?.getAttribute("content") ?? null;
    vp?.setAttribute("content", "width=1920");
    return () => {
      bridge?.setNavActive?.(false);
      if (vp && prev != null) vp.setAttribute("content", prev);
    };
  }, []);
  useEffect(() => {
    api.getAlbums().then(setAlbums).catch(() => {});
    api.getArtists().then(setArtists).catch(() => {});
    api.getPlaylists().then(setPlaylists).catch(() => {});
    api.getFavorites().then(setFavorites).catch(() => {});
  }, []);
  // Refresh "Recently played" on return to the home screen or when the track changes.
  useEffect(() => {
    if (view.name === "browse") api.getRecent().then(setRecent).catch(() => {});
  }, [view.name, p.current?.id]);

  // The analyser needs the audio graph, which exists once playback has started.
  useEffect(() => {
    if (npMode === "viz" && view.name === "nowplaying") setAnalyser(p.getAnalyser());
  }, [npMode, view.name]);

  useEffect(() => {
    if (view.name === "playlist") {
      setPlaylistData(null);
      api.getPlaylist(view.id).then(setPlaylistData).catch(() => {});
    }
  }, [view.name === "playlist" ? (view as any).id : null]);

  useEffect(() => {
    if (view.name === "album") {
      setAlbumData(null);
      api.getAlbum(view.id).then(setAlbumData).catch(() => {});
    }
  }, [view.name === "album" ? (view as any).id : null]);

  useEffect(() => {
    if (view.name === "artist") {
      setArtistAlbums([]); setArtistInfo(null);
      api.getArtistAlbums(view.id).then(setArtistAlbums).catch(() => {});
      api.getArtistInfo(view.id).then(setArtistInfo).catch(() => {});
    }
  }, [view.name === "artist" ? (view as any).id : null]);

  // Debounced live search.
  useEffect(() => {
    if (view.name !== "search") return;
    if (!query.trim()) { setResults({ artists: [], albums: [], tracks: [] }); return; }
    const id = setTimeout(() => { api.search(query).then(setResults).catch(() => {}); }, 280);
    return () => clearTimeout(id);
  }, [query, view.name]);

  useSpatialNav(goBack, [stack.length]);
  // Re-anchor focus whenever the screen changes (and once rail/album data loads).
  useEffect(() => { focusFirst(); }, [stack.length, albumData, artistAlbums.length, playlistData, albums.length, artists.length, playlists.length]);

  // Scrub when the (focused) progress bar captures d-pad left/right.
  useEffect(() => {
    const el = seekBarRef.current;
    if (!el) return;
    const onSeek = (e: any) => {
      const pp = pRef.current;
      const dur = pp.duration || 0;
      const step = Math.max(5, dur * 0.02);
      pp.seek(Math.min(dur, Math.max(0, tRef.current.currentTime + e.detail * step)));
    };
    el.addEventListener("tv-seek", onSeek as EventListener);
    return () => el.removeEventListener("tv-seek", onSeek as EventListener);
  }, [view.name === "nowplaying"]);

  // Enrich tracks with albumId/album so the player shows artwork + names.
  const enrichedTracks = (): Track[] =>
    (albumData?.tracks ?? []).map((t: any) => ({ ...t, albumId: albumData.id, album: albumData.title }));
  const playAlbum = (i: number) => { p.playNow(enrichedTracks(), i); push({ name: "nowplaying" }); };
  // Playlist/Favorites tracks already carry albumId/album/artist/duration.
  const playList = (tracks: Track[], i: number) => { p.playNow(tracks, i); push({ name: "nowplaying" }); };

  // The accent follows the playing track, not the screen being browsed.
  const accentUrl = p.current?.albumId != null ? api.coverUrl(p.current.albumId) : undefined;
  const pal = useArtAccent(accentUrl);
  const accentStyle = (pal ? {
    "--accent": pal.accent,
    "--accent-soft": rgbaFromHex(pal.accent, 0.22),
    "--accent-contrast": pal.contrast,
  } : undefined) as any;

  return (
    <div className="tv-root" style={accentStyle}>
      {view.name === "browse" && (
        <div className="tv-screen tv-browse">
          {p.current?.albumId != null && (
            <div className="tv-screen-bg" style={{ backgroundImage: `url(${api.coverUrl(p.current.albumId)})` }} />
          )}
          <header className="tv-header">
            <span className="tv-logo">localhost<span className="logo-accent">music</span></span>
            <span className="tv-hint">Use the arrow keys · OK to select · Back to return</span>
          </header>

          {p.current && (
            <button className="tv-hero tv-focusable" onClick={() => push({ name: "nowplaying" })}>
              {p.current.albumId != null && <img className="tv-hero-art" src={api.coverUrl(p.current.albumId)} alt="" />}
              <div className="tv-hero-meta">
                <div className="tv-hero-label">{p.isPlaying ? "Now Playing" : "Paused"}{p.activeDeviceName ? ` · on ${p.activeDeviceName}` : ""}</div>
                <div className="tv-hero-title">{p.current.title}</div>
                <div className="tv-hero-sub">{[p.current.artist, p.current.album].filter(Boolean).join(" · ")}</div>
              </div>
            </button>
          )}

          <h2 className="tv-rail-title">Your Library</h2>
          <div className="tv-rail">
            <button className="tv-card tv-focusable" onClick={() => { setQuery(""); setResults({ artists: [], albums: [], tracks: [] }); setEditing(false); push({ name: "search" }); }}>
              <div className="tv-card-art tv-search-art"><SearchIcon size={64} /></div>
              <div className="tv-card-title">Search</div>
              <div className="tv-card-sub">Find music</div>
            </button>
            <button className="tv-card tv-focusable" onClick={() => push({ name: "favorites" })}>
              <div className="tv-card-art tv-fav-art"><HeartIcon size={72} filled /></div>
              <div className="tv-card-title">Favorites</div>
              <div className="tv-card-sub">{favorites.length} song{favorites.length === 1 ? "" : "s"}</div>
            </button>
            {playlists.map(pl => (
              <Card key={pl.id} title={pl.name} sub="Playlist"
                img={api.playlistCoverUrl(pl.id)} onSelect={() => push({ name: "playlist", id: pl.id, title: pl.name })} />
            ))}
          </div>

          {recent.length > 0 && <>
            <h2 className="tv-rail-title">Recently Played</h2>
            <div className="tv-rail">
              {recent.map(al => (
                <Card key={"r" + al.id} title={al.title} sub={al.artist}
                  img={api.coverUrl(al.id)} onSelect={() => push({ name: "album", id: al.id, title: al.title })} />
              ))}
            </div>
          </>}

          <h2 className="tv-rail-title">Albums</h2>
          <div className="tv-rail">
            {albums.map(al => (
              <Card key={al.id} title={al.title} sub={al.artist}
                img={api.coverUrl(al.id)} onSelect={() => push({ name: "album", id: al.id, title: al.title })} />
            ))}
            {albums.length === 0 && <div className="tv-empty">No albums.</div>}
          </div>

          <h2 className="tv-rail-title">Artists</h2>
          <div className="tv-rail">
            {artists.map(ar => (
              <Card key={ar.id} title={ar.name} round img={api.artistImageUrl(ar.id)}
                onSelect={() => push({ name: "artist", id: ar.id, title: ar.name })} />
            ))}
            {artists.length === 0 && <div className="tv-empty">No artists.</div>}
          </div>
        </div>
      )}

      {view.name === "search" && (
        <div className="tv-screen tv-search">
          <input
            ref={searchInputRef}
            className={`tv-search-input tv-focusable${editing ? " editing" : ""}`}
            value={query}
            readOnly={!editing}
            placeholder={editing ? "Type to search…" : "Press OK to search artists, albums, songs…"}
            onChange={e => setQuery(e.target.value.slice(0, 60))}
            onClick={() => {
              if (editing) return;
              setEditing(true);
              (window as any).LhmTV?.setNavActive?.(false);   // hand the d-pad to the TV keyboard
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            onBlur={() => { setEditing(false); (window as any).LhmTV?.setNavActive?.(true); }}
          />
          <div className="tv-search-body">
            <div className="tv-results">
              {results.artists.map(ar => (
                <button key={"ar" + ar.id} className="tv-result tv-focusable" onClick={() => push({ name: "artist", id: ar.id, title: ar.name })}>
                  <img className="tv-result-thumb round" src={api.artistImageUrl(ar.id)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                  <div className="tv-result-text"><span className="tv-result-title">{ar.name}</span><span className="tv-result-type">Artist</span></div>
                </button>
              ))}
              {results.albums.map(al => (
                <button key={"al" + al.id} className="tv-result tv-focusable" onClick={() => push({ name: "album", id: al.id, title: al.title })}>
                  <img className="tv-result-thumb" src={api.coverUrl(al.id)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                  <div className="tv-result-text"><span className="tv-result-title">{al.title}</span><span className="tv-result-type">Album · {al.artist}</span></div>
                </button>
              ))}
              {results.tracks.map(t => (
                <button key={"t" + t.id} className="tv-result tv-focusable" onClick={() => playList([t], 0)}>
                  <img className="tv-result-thumb" src={api.coverUrl(t.albumId)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                  <div className="tv-result-text"><span className="tv-result-title">{t.title}</span><span className="tv-result-type">Song · {t.artist}</span></div>
                </button>
              ))}
              {query.trim() && !results.artists.length && !results.albums.length && !results.tracks.length && <div className="tv-empty">No results.</div>}
              {!query.trim() && <div className="tv-empty">Type to search your library.</div>}
            </div>
          </div>
        </div>
      )}

      {view.name === "artist" && (() => {
        const s = artistInfo?.stats;
        const sub = [artistInfo?.genres, yearsRange(artistInfo?.begin, artistInfo?.ended)].filter(Boolean).join(" · ");
        const stats = s ? [
          `${s.albums} album${s.albums === 1 ? "" : "s"}`,
          `${s.tracks} song${s.tracks === 1 ? "" : "s"}`,
          s.plays > 0 ? `${s.plays.toLocaleString()} play${s.plays === 1 ? "" : "s"}` : null,
          s.duration > 0 ? listenTime(s.duration) : null,
        ].filter(Boolean).join(" · ") : "";
        return (
        <div className="tv-screen tv-browse">
          <div className="tv-screen-bg" style={{ backgroundImage: `url(${api.artistImageUrl(view.id)})` }} />
          <div className="tv-artist-head">
            <img className="tv-artist-pic" src={api.artistImageUrl(view.id)} alt=""
              onError={e => (e.currentTarget.style.visibility = "hidden")} />
            <div className="tv-artist-meta">
              <div className="tv-artist-name">{view.title ?? "Artist"}</div>
              {sub && <div className="tv-artist-genres">{sub}</div>}
              {artistInfo?.area && <div className="tv-artist-sub">{artistInfo.area}</div>}
              {stats && <div className="tv-artist-stats">{stats}</div>}
            </div>
          </div>
          {artistInfo?.bio && <p className="tv-artist-bio">{artistInfo.bio}</p>}
          <h2 className="tv-rail-title">Albums</h2>
          <div className="tv-rail">
            {artistAlbums.map(al => (
              <Card key={al.id} title={al.title} sub={al.year ? String(al.year) : undefined}
                img={api.coverUrl(al.id)} onSelect={() => push({ name: "album", id: al.id, title: al.title })} />
            ))}
            {artistAlbums.length === 0 && <div className="tv-empty">Loading…</div>}
          </div>
        </div>
        );
      })()}

      {view.name === "album" && (
        <div className="tv-screen tv-album">
          <div className="tv-screen-bg" style={{ backgroundImage: `url(${api.coverUrl(albumData?.id ?? (view as any).id)})` }} />
          {!albumData ? <div className="tv-empty">Loading…</div> : (
            <>
              <div className="tv-album-head">
                <img className="tv-album-art" src={api.coverUrl(albumData.id ?? (view as any).id)} alt="" />
                <div className="tv-album-info">
                  <div className="tv-album-name">{albumData.title}</div>
                  <div className="tv-album-artist">{albumData.artist}</div>
                  <button className="tv-play-all tv-focusable"
                    onClick={() => playAlbum(0)}>
                    <PlayIcon size={26} /> Play
                  </button>
                </div>
              </div>
              <div className="tv-tracks">
                {(albumData.tracks ?? []).map((t: any, i: number) => (
                  <button key={t.id} className="tv-track tv-focusable" onClick={() => playAlbum(i)}>
                    <span className="tv-track-num">{i + 1}</span>
                    <span className="tv-track-title">{t.title}</span>
                    <span className="tv-track-dur">{fmt(t.duration)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {view.name === "playlist" && (
        <div className="tv-screen tv-album">
          <div className="tv-screen-bg" style={{ backgroundImage: `url(${api.playlistCoverUrl(view.id)})` }} />
          {!playlistData ? <div className="tv-empty">Loading…</div> : (
            <>
              <div className="tv-album-head">
                <img className="tv-album-art" src={api.playlistCoverUrl(view.id)} alt=""
                  onError={e => (e.currentTarget.style.visibility = "hidden")} />
                <div className="tv-album-info">
                  <div className="tv-album-name">{playlistData.name}</div>
                  <div className="tv-album-artist">Playlist · {(playlistData.tracks ?? []).length} songs</div>
                  <button className="tv-play-all tv-focusable" onClick={() => playList(playlistData.tracks, 0)}>
                    <PlayIcon size={26} /> Play
                  </button>
                </div>
              </div>
              <div className="tv-tracks">
                {(playlistData.tracks ?? []).map((t: any, i: number) => (
                  <button key={`${t.id}-${i}`} className="tv-track tv-focusable" onClick={() => playList(playlistData.tracks, i)}>
                    <span className="tv-track-num">{i + 1}</span>
                    <span className="tv-track-title">{t.title}</span>
                    <span className="tv-track-dur">{fmt(t.duration)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {view.name === "favorites" && (
        <div className="tv-screen tv-album">
          {favorites[0]?.albumId != null && (
            <div className="tv-screen-bg" style={{ backgroundImage: `url(${api.coverUrl(favorites[0].albumId)})` }} />
          )}
          <div className="tv-album-head">
            <div className="tv-album-art tv-fav-art"><HeartIcon size={96} filled /></div>
            <div className="tv-album-info">
              <div className="tv-album-name">Favorites</div>
              <div className="tv-album-artist">{favorites.length} song{favorites.length === 1 ? "" : "s"}</div>
              {favorites.length > 0 && (
                <button className="tv-play-all tv-focusable" onClick={() => playList(favorites, 0)}>
                  <PlayIcon size={26} /> Play
                </button>
              )}
            </div>
          </div>
          <div className="tv-tracks">
            {favorites.map((t: any, i: number) => (
              <button key={`${t.id}-${i}`} className="tv-track tv-focusable" onClick={() => playList(favorites, i)}>
                <span className="tv-track-num">{i + 1}</span>
                <span className="tv-track-title">{t.title}</span>
                <span className="tv-track-dur">{fmt(t.duration)}</span>
              </button>
            ))}
            {favorites.length === 0 && <div className="tv-empty">No favorites yet.</div>}
          </div>
        </div>
      )}

      {view.name === "queue" && (
        <div className="tv-screen tv-album">
          {p.current?.albumId != null && (
            <div className="tv-screen-bg" style={{ backgroundImage: `url(${api.coverUrl(p.current.albumId)})` }} />
          )}
          <div className="tv-album-head">
            <div className="tv-album-info">
              <div className="tv-album-name">Up Next</div>
              <div className="tv-album-artist">{Math.max(0, p.order.length - p.pos - 1)} song{p.order.length - p.pos - 1 === 1 ? "" : "s"} queued</div>
            </div>
          </div>
          <div className="tv-tracks">
            {p.order.map((qi, opos) => ({ qi, opos, t: p.queue[qi] })).filter(x => x.t).map(({ qi, opos, t }) => (
              <div key={`${qi}-${opos}`} className={`tv-queue-row${opos === p.pos ? " now" : ""}`}>
                <button className="tv-track tv-focusable" onClick={() => p.jumpTo(opos)}>
                  <span className="tv-track-num">{opos === p.pos ? "▸" : opos < p.pos ? "·" : opos - p.pos}</span>
                  <span className="tv-track-title">{t.title}{t.artist ? <span className="tv-queue-artist"> · {t.artist}</span> : null}</span>
                  <span className="tv-track-dur">{fmt(t.duration ?? 0)}</span>
                </button>
                {opos !== p.pos && (
                  <button className="tv-queue-remove tv-focusable" onClick={() => p.removeFromQueue(opos)} aria-label="Remove from queue">✕</button>
                )}
              </div>
            ))}
            {p.queue.length === 0 && <div className="tv-empty">Queue is empty.</div>}
          </div>
        </div>
      )}

      {view.name === "nowplaying" && (
        <div className="tv-screen tv-np">
          {!p.current ? <div className="tv-empty">Nothing playing.</div> : (() => {
            const head = (
              <>
                <div className={`tv-np-title${showLyrics ? " sm" : ""}`}>{p.current.title}</div>
                <div className="tv-np-sub">{[p.current.artist, p.current.album].filter(Boolean).join(" · ")}</div>
                {p.activeDeviceName && <div className="tv-np-cast">▸ Playing on {p.activeDeviceName}</div>}
              </>
            );
            const transport = (
              <>
                <button ref={seekBarRef} className="tv-np-bar tv-focusable" data-keycapture="lr" aria-label="Seek (left/right)">
                  <span>{fmt(t.currentTime)}</span>
                  <div className="tv-np-track"><div className="tv-np-fill" style={{ width: `${p.duration ? (t.currentTime / p.duration) * 100 : 0}%` }} /></div>
                  <span>{fmt(p.duration)}</span>
                </button>
                <div className="tv-np-controls">
                  <button className={`tv-focusable tv-np-side${p.shuffle ? " on" : ""}`} onClick={p.toggleShuffle} aria-label="Shuffle"><ShuffleIcon size={26} /></button>
                  <button className="tv-focusable" onClick={p.prev} aria-label="Previous"><PrevIcon size={34} /></button>
                  <button className="tv-focusable tv-np-main" onClick={p.toggle} aria-label={p.isPlaying ? "Pause" : "Play"}>
                    {p.isPlaying ? <PauseIcon size={40} /> : <PlayIcon size={40} />}
                  </button>
                  <button className="tv-focusable" onClick={p.next} aria-label="Next"><NextIcon size={34} /></button>
                  <button className={`tv-focusable tv-np-side${p.repeat !== "off" ? " on" : ""}`} onClick={p.cycleRepeat} aria-label={`Repeat: ${p.repeat}`}>
                    {p.repeat === "one" ? <RepeatOneIcon size={26} /> : <RepeatIcon size={26} />}
                  </button>
                </div>
                <div className="tv-np-extra">
                  <button className={`tv-np-lyrics-toggle tv-focusable${npMode !== "art" ? " on" : ""}`}
                    onClick={() => setNpMode(m => NP_MODES[(NP_MODES.indexOf(m) + 1) % NP_MODES.length])} aria-label="Change view">
                    <LyricsIcon size={22} /> {NP_LABEL[npMode]}
                  </button>
                  <button className="tv-np-lyrics-toggle tv-focusable" onClick={() => push({ name: "queue" })} aria-label="Up next">
                    Up Next · {p.queue.length}
                  </button>
                </div>
              </>
            );
            return (
              <>
                {p.current.albumId != null && <div className="tv-np-bg" style={{ backgroundImage: `url(${api.coverUrl(p.current.albumId)})` }} />}
                {showLyrics ? (
                  <div className="tv-np-inner lyrics">
                    <div className="tv-np-head">{head}</div>
                    <div className="tv-np-lyrics"><LyricsView trackId={p.current.id} currentTime={t.currentTime} onSeek={p.seek} /></div>
                    {transport}
                  </div>
                ) : (
                  <div className="tv-np-inner">
                    {npMode === "viz"
                      ? <div className="tv-np-art tv-np-viz">{analyser && <NeonVisualizer analyser={analyser} seed={p.current.id} />}</div>
                      : (p.current.albumId != null && <img className="tv-np-art" src={api.coverUrl(p.current.albumId)} alt="" />)}
                    {head}
                    {transport}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* On-screen Back, top-right so it clears the art at top-left. Hidden at the root. */}
      {stack.length > 1 && (
        <button className="tv-exit tv-focusable" onClick={back} aria-label="Back">‹ Back</button>
      )}
    </div>
  );
}

import { MusicIcon } from "../ui/icons";
import { EmptyState } from "../ui/EmptyState";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { AlbumCard } from "../library/AlbumCard";
import { ArtistAvatar } from "../library/ArtistAvatar";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonCards } from "../ui/Skeleton";
import { useAlbumColor, fadeInRef } from "../ui/artColors";

interface Album { id: number; title: string; artist?: string; year?: number; lossless?: number }
interface Home {
  ownHistory: boolean;
  jumpBackIn: Album[];
  recentlyAdded: Album[];
  rotation: Album[];
  rediscover: Album[];
  unplayed: Album[];
  onThisDay: (Album & { year_played?: string })[];
  artists: { id: number; name: string }[];
}

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// Re-run `fn` when the page goes from hidden to shown. Pages are kept alive
// (display:none when inactive), so they don't remount on return.
function useOnReveal(ref: React.RefObject<HTMLElement | null>, fn: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let hidden = false;
    const ro = new ResizeObserver(([e]) => {
      const nowHidden = e.contentRect.width === 0;
      if (hidden && !nowHidden) fn();
      hidden = nowHidden;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fn]);
}

// A compact cover + title tile for the "Jump back in" grid.
function QuickTile({ album, onOpen }: { album: Album; onOpen: (id: number) => void }) {
  const tint = useAlbumColor(album.id);
  return (
    <button className="quick-tile" onClick={() => onOpen(album.id)} style={tint ? { ["--tint" as string]: tint } : undefined}>
      <span className="quick-art">
        <img ref={fadeInRef} className="fade-img" src={api.coverUrl(album.id, 160)} alt="" loading="lazy" decoding="async" />
      </span>
      <span className="quick-text">
        <span className="quick-title">{album.title}</span>
        {album.artist && <span className="quick-sub">{album.artist}</span>}
      </span>
    </button>
  );
}

function AlbumShelf({ title, note, albums, onOpenAlbum }: { title: string; note?: string; albums: Album[]; onOpenAlbum: (id: number) => void }) {
  if (!albums.length) return null;
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2>{title}</h2>
        {note && <span className="shelf-count">{note}</span>}
      </div>
      <div className="shelf-rail">
        {albums.map(a => <AlbumCard key={a.id} album={a} onOpen={onOpenAlbum} showArtist />)}
      </div>
    </section>
  );
}

export function HomePage({ onOpenAlbum, onOpenArtist }: {
  onOpenAlbum: (id: number) => void;
  onOpenArtist: (id: number, name: string) => void;
}) {
  const [home, setHome] = useState<Home | null>(null);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api.getHome().then((h: Home) => { setHome(h); setFailed(false); }).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  useOnReveal(root, load);

  const empty = home && !home.jumpBackIn.length && !home.recentlyAdded.length && !home.unplayed.length;
  const lastYear = home?.onThisDay[0]?.year_played;

  return (
    <div className="page home-page" ref={root}>
      <h2 className="home-greeting">{greeting()}</h2>

      {!home && !failed && (
        <div className="quick-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="quick-tile skeleton" />)}</div>
      )}
      {failed && !home && <p className="muted">Couldn't load your home screen. Check your connection and try again.</p>}
      {empty && <EmptyState icon={<MusicIcon size={26} />} title="Nothing here yet">Add music and rescan in Settings, then come back once you've played a few things.</EmptyState>}

      {home && home.jumpBackIn.length > 0 && (
        <section className="shelf">
          <div className="shelf-head"><h2>Jump back in</h2></div>
          <div className="quick-grid">
            {home.jumpBackIn.map(a => <QuickTile key={a.id} album={a} onOpen={onOpenAlbum} />)}
          </div>
        </section>
      )}

      {home && (
        <>
          <AlbumShelf title="Recently added" albums={home.recentlyAdded} onOpenAlbum={onOpenAlbum} />
          <AlbumShelf title="On repeat" note="Your most played this month" albums={home.rotation} onOpenAlbum={onOpenAlbum} />
          <AlbumShelf title="On this day" note={lastYear ? `What you were playing in ${lastYear}` : undefined} albums={home.onThisDay} onOpenAlbum={onOpenAlbum} />
          {home.artists.length > 0 && (
            <section className="shelf">
              <div className="shelf-head">
                <h2>Your artists</h2>
                {home.ownHistory && <span className="shelf-count">Last 90 days</span>}
              </div>
              <div className="shelf-rail artist-rail">
                {home.artists.map(a => (
                  <button key={a.id} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
                    <ArtistAvatar id={a.id} name={a.name} />
                    <MarqueeText className="artist-name" text={a.name} />
                  </button>
                ))}
              </div>
            </section>
          )}
          <AlbumShelf title="Rediscover" note="Old favourites you haven't played in a while" albums={home.rediscover} onOpenAlbum={onOpenAlbum} />
          <AlbumShelf title="Never played" note="A different handful every visit" albums={home.unplayed} onOpenAlbum={onOpenAlbum} />
        </>
      )}
      {!home && !failed && (
        <section className="shelf"><div className="shelf-rail"><SkeletonCards count={6} /></div></section>
      )}
    </div>
  );
}

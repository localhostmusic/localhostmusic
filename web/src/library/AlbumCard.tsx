import { api } from "../api";
import { PlayIcon } from "../ui/icons";
import { openMenuAt } from "../ui/ContextMenu";
import { MarqueeText } from "../ui/MarqueeText";
import { useAlbumColor, fadeInRef } from "../ui/artColors";

export function AlbumCard({ album, onOpen, showArtist }: {
  album: any;
  onOpen: (id: number) => void;
  showArtist?: boolean;
}) {
  const subtitle = showArtist ? album.artist : (album.year || null);
  const tint = useAlbumColor(album.id);
  return (
    <button className="album-card" onClick={() => onOpen(album.id)}
      onContextMenu={e => openMenuAt(e, { album: { id: album.id, title: album.title, artist: album.artist }, onOpen })}>
      <div className="album-art" style={tint ? { ["--tint" as string]: tint } : undefined}>
        <img ref={fadeInRef} className="fade-img" src={api.coverUrl(album.id, 300)} alt="" loading="lazy" decoding="async" onError={e => (e.currentTarget.style.visibility = "hidden")} />
        {album.lossless ? <span className="art-badge">LOSSLESS</span> : null}
        <span className="album-play"><PlayIcon size={18} /></span>
      </div>
      <MarqueeText className="album-title" text={album.title} />
      {subtitle ? <div className="album-year">{subtitle}</div> : null}
    </button>
  );
}

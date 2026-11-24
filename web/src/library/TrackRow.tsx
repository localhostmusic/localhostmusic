import { useRef, useState } from "react";
import { PlayIcon, HeartIcon, QueueIcon, NextIcon, RadioIcon, AlbumIcon, EditIcon, TrashIcon } from "../ui/icons";
import { openMenuAt, openMenuFrom, type MenuSpec } from "../ui/ContextMenu";
import { useRowSelect, selectionMenu, toggleSelected } from "../ui/selection";
import { MarqueeText } from "../ui/MarqueeText";
import { Stars } from "../ui/Stars";
import { TRACK_DND } from "../ui/Sidebar";
import { usePlayer } from "../player/PlayerProvider";
import { toast } from "../ui/toast";

// Row-glow colours for the confirm flash.
const FLASH_QUEUE = "var(--accent)";
const FLASH_FAV = "#ff4d6d";

function fmt(d?: number) {
  if (!d) return "";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface Props {
  tracks: any[];
  i: number;
  onPlay: (tracks: any[], i: number) => void;
  onOpenAlbum?: (id: number) => void;
  isCurrent?: boolean;
  isPlaying?: boolean;
  isFav: boolean;
  onToggleFav: (id: number) => void;
  rating?: number;
  onRate?: (id: number, rating: number) => void;
  playlists: any[];
  onAddToPlaylist: (playlistId: number, trackId: number) => void;
  hideAlbum?: boolean;
  onEditMeta?: (t: any) => void;
  onDeleteTrack?: (t: any) => void;
  // Featured artists are kept out of the artists grid, so their name on the row is
  // the main way to reach them. Given this, each credit renders as a link.
  onOpenArtist?: (id: number, name: string) => void;
}

export function TrackRow({ tracks, i, onPlay, onOpenAlbum, isCurrent, isPlaying, isFav, onToggleFav, rating, onRate, hideAlbum, onEditMeta, onDeleteTrack, onOpenArtist }: Props) {
  const t = tracks[i];
  const player = usePlayer();
  const pick = useRowSelect(tracks, i);

  // Touch swipe actions (phone). Swipe left past the threshold queues the track,
  // swipe right toggles favorite. The row follows the finger, rubber-bands past
  // the max and springs back on release.
  const MAX = 92, TRIGGER = 66;
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const g = useRef<{ x: number; y: number; dir: "" | "h" | "v"; moved: boolean } | null>(null);
  const dxRef = useRef(0);
  const suppressClick = useRef(false);

  const setOffset = (v: number) => { dxRef.current = v; setDx(v); };
  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0];
    g.current = { x: p.clientX, y: p.clientY, dir: "", moved: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = g.current; if (!s) return;
    const p = e.touches[0];
    const ddx = p.clientX - s.x, ddy = p.clientY - s.y;
    if (!s.dir) {
      if (Math.abs(ddx) < 10 && Math.abs(ddy) < 10) return;
      s.dir = Math.abs(ddx) > Math.abs(ddy) ? "h" : "v";
      if (s.dir === "h") setDragging(true);
    }
    if (s.dir !== "h") return;
    s.moved = true;
    const clamped = Math.max(-MAX, Math.min(MAX, ddx));
    setOffset(clamped + (ddx - clamped) * 0.18); // rubber-band past the max
  };
  const onTouchEnd = () => {
    const s = g.current; g.current = null;
    setDragging(false);
    if (s?.dir === "h") {
      const x = dxRef.current;
      if (x <= -TRIGGER) actQueue();
      else if (x >= TRIGGER) actFav();
      if (s.moved) suppressClick.current = true; // eat the tap that ends the swipe
    }
    setOffset(0);
  };
  // A horizontal swipe ends in a synthetic click. Swallow it so it doesn't play.
  const guardPlay = (fn: () => void) => () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    fn();
  };
  const favProg = dx > 0 ? Math.min(1, dx / TRIGGER) : 0;
  const queueProg = dx < 0 ? Math.min(1, -dx / TRIGGER) : 0;

  // Every add/queue/favorite path (swipe, menus, heart button) goes through these,
  // so the confirmation (toast + row glow) is the same everywhere. `flash` re-keys
  // on each call to restart the glow animation.
  const [flash, setFlash] = useState<{ color: string; n: number } | null>(null);
  const flashN = useRef(0);
  const flashRow = (color: string) => setFlash({ color, n: flashN.current++ });
  const actQueue = () => { player.addToQueue(t); flashRow(FLASH_QUEUE); toast("Added to queue", "＋"); };
  const actNext = () => { player.playNext(t); flashRow(FLASH_QUEUE); toast("Playing next", "＋"); };
  const actFav = () => { const wasFav = isFav; onToggleFav(t.id); flashRow(FLASH_FAV); toast(wasFav ? "Removed from Favorites" : "Added to Favorites", "♥"); };

  // Every credited artist, not only the primary. Views that don't send the credit
  // list fall back to the primary name as plain text.
  const credits = t.artists as { id: number; name: string }[] | undefined;

  const menuSpec = (): MenuSpec => ({
    header: { title: t.title, sub: credits?.map(a => a.name).join(", ") || t.artist, albumId: t.albumId },
    rating: onRate ? { value: rating ?? 0, onRate: n => onRate(t.id, n) } : undefined,
    sections: [
      [
        { label: "Play", icon: <PlayIcon size={16} />, onSelect: () => onPlay(tracks, i) },
        { label: "Play next", icon: <NextIcon size={16} />, onSelect: actNext },
        { label: "Add to queue", icon: <QueueIcon size={16} />, onSelect: actQueue },
        { label: "Start radio", icon: <RadioIcon size={16} />, onSelect: () => player.startRadio(t) },
      ],
      [
        { label: isFav ? "Remove from Favorites" : "Add to Favorites", icon: <HeartIcon size={16} filled={isFav} />, onSelect: actFav },
        ...(t.albumId != null && onOpenAlbum && !hideAlbum
          ? [{ label: "Go to album", icon: <AlbumIcon size={16} />, onSelect: () => onOpenAlbum(t.albumId) }] : []),
        { label: "Select", icon: <span className="ctx-check">✓</span>, onSelect: () => toggleSelected(tracks, i) },
      ],
      [
        ...(onEditMeta ? [{ label: "Fix metadata", icon: <EditIcon size={16} />, onSelect: () => onEditMeta(t) }] : []),
        ...(onDeleteTrack ? [{ label: "Delete track", icon: <TrashIcon size={16} />, danger: true, onSelect: () => onDeleteTrack(t) }] : []),
      ],
    ],
    playlist: { ids: async () => [t.id], defaultName: t.title, onAdded: () => flashRow(FLASH_QUEUE) },
  });

  return (
    <li
      className={`trk${isCurrent ? " playing" : ""}${pick.selected ? " selected" : ""}${pick.selecting ? " selecting" : ""}`}
      onClickCapture={pick.onClickCapture}
      onContextMenu={e => openMenuAt(e, pick.selected ? selectionMenu(player) : menuSpec())}
      style={dragging ? { overflow: "hidden" } : undefined}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData(TRACK_DND, String(t.id));
        e.dataTransfer.setData("text/plain", t.title ?? "");
        e.dataTransfer.effectAllowed = "copy";
        document.body.classList.add("dragging-track");
      }}
      onDragEnd={() => document.body.classList.remove("dragging-track")}
      onDoubleClick={() => onPlay(tracks, i)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <span className="trk-swipe fav" aria-hidden="true" style={{ opacity: favProg, transform: `scale(${0.7 + favProg * 0.3})` }}>
        <HeartIcon size={18} filled />
      </span>
      <span className="trk-swipe queue" aria-hidden="true" style={{ opacity: queueProg, transform: `scale(${0.7 + queueProg * 0.3})` }}>
        <QueueIcon size={18} />
      </span>
      {flash && (
        <span
          key={flash.n}
          className="trk-flash"
          aria-hidden="true"
          style={{ ["--flash" as any]: flash.color }}
          onAnimationEnd={() => setFlash(null)}
        />
      )}
      <div
        className="trk-fg"
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? "none" : "transform 0.28s cubic-bezier(0.2,0.9,0.3,1)" }}
      >
      <button className="row-play" onClick={guardPlay(() => onPlay(tracks, i))} aria-label={`Play ${t.title}`}>
        {isCurrent
          ? <span className={`eq${isPlaying ? "" : " paused"}`} aria-label="Now playing"><i /><i /><i /></span>
          : <span className="num">{i + 1}</span>}
        <span className="row-check" aria-hidden="true">{pick.selected ? "✓" : ""}</span>
        <span className="row-play-icon"><PlayIcon size={14} /></span>
      </button>

      <div className="trk-main" onClick={guardPlay(() => onPlay(tracks, i))}>
        <MarqueeText className="trk-title" text={t.title} />
        {credits?.length && onOpenArtist ? (
          <span className="trk-artist">
            {credits.map((a, n) => (
              <span key={a.id}>
                {n > 0 && ", "}
                <button
                  className="trk-artist-link"
                  onClick={e => { e.stopPropagation(); onOpenArtist(a.id, a.name); }}
                >
                  {a.name}
                </button>
              </span>
            ))}
          </span>
        ) : (
          (credits?.map(a => a.name).join(", ") || t.artist) &&
            <span className="trk-artist">{credits?.map(a => a.name).join(", ") || t.artist}</span>
        )}
      </div>

      {!hideAlbum && t.album && (
        <button className="trk-album" onClick={() => t.albumId != null && onOpenAlbum?.(t.albumId)} title={t.album}>
          {t.album}
        </button>
      )}

      {t.lossless ? <span className="lossless-badge sm">LOSSLESS</span> : null}

      {onRate && (
        <span className={`trk-rating${rating ? " rated" : ""}`}>
          <Stars value={rating ?? 0} onRate={(n) => onRate(t.id, n)} />
        </span>
      )}

      <button className={`trk-act fav-act${isFav ? " on" : ""}`} onClick={actFav} aria-label="Favorite">
        <HeartIcon size={16} filled={isFav} />
      </button>

      <div className="trk-add">
        <button className="trk-act" onClick={e => openMenuFrom(e.currentTarget, menuSpec())} aria-label="More actions">⋯</button>
      </div>

      {/* Phone layout: the heart is hidden there, the menu has it. */}
      <div className="trk-more">
        <button className="trk-act" onClick={e => openMenuFrom(e.currentTarget, menuSpec())} aria-label="More actions">⋯</button>
      </div>

      <span className="dur">{fmt(t.duration)}</span>
      </div>
    </li>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { usePlayer } from "../player/PlayerProvider";
import { Stars } from "./Stars";
import { toast } from "./toast";
import { AlbumIcon, ChevronDownIcon, NextIcon, PlayIcon, PlaylistIcon, QueueIcon, RadioIcon } from "./icons";

// One menu for the whole app: right-click on a song or album, and the "more" button
// on a row. Callers describe what to show; <ContextMenuHost> (mounted once) draws it.

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuSpec {
  header?: { title: string; sub?: string; albumId?: number | null };
  rating?: { value: number; onRate: (n: number) => void };
  sections: MenuItem[][];
  // Adds the "Add to playlist" step. `ids` may fetch (an album's tracks).
  playlist?: { ids: () => Promise<number[]>; defaultName: string; onAdded?: (playlistName: string) => void };
}

type Target = MenuSpec | { album: { id: number; title: string; artist?: string }; onOpen?: (id: number) => void };
type Place = { x: number; y: number } | DOMRect;

let show: ((place: Place, target: Target) => void) | null = null;

// Mouse only. A long-press on a phone keeps its normal behaviour.
const finePointer = () => !window.matchMedia("(pointer: coarse)").matches;

export function openMenuAt(e: React.MouseEvent, target: Target) {
  if (!show || !finePointer()) return;
  e.preventDefault();
  e.stopPropagation();
  show({ x: e.clientX, y: e.clientY }, target);
}

// Anchored under a button (the "more" button), on any device.
export function openMenuFrom(el: Element, target: Target) {
  show?.(el.getBoundingClientRect(), target);
}

export const PLAYLISTS_CHANGED = "lhm-playlists-changed";

export function ContextMenuHost() {
  const player = usePlayer();
  const [open, setOpen] = useState<{ place: Place; spec: MenuSpec } | null>(null);
  const [step, setStep] = useState<"main" | "playlists">("main");
  const [playlists, setPlaylists] = useState<{ id: number; name: string; smart?: number }[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [rated, setRated] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = () => setOpen(null);

  useEffect(() => {
    show = (place, target) => {
      const spec = "album" in target ? albumSpec(target.album, target.onOpen) : target;
      setStep("main"); setNaming(null); setPlaylists(null); setPos(null);
      setRated(spec.rating?.value ?? 0);
      setOpen({ place, spec });
    };
    return () => { show = null; };
  });

  // An album's actions need its track list, fetched when one is chosen.
  function albumSpec(album: { id: number; title: string; artist?: string }, onOpen?: (id: number) => void): MenuSpec {
    const tracks = () => api.getAlbum(album.id).then((a: any) => (a.tracks ?? []) as any[]);
    const withTracks = (fn: (t: any[]) => void) => () => { tracks().then(t => { if (t.length) fn(t); }).catch(() => toast("Could not load that album")); };
    return {
      header: { title: album.title, sub: album.artist, albumId: album.id },
      sections: [
        [
          { label: "Play", icon: <PlayIcon size={16} />, onSelect: withTracks(t => player.playNow(t, 0)) },
          { label: "Play next", icon: <NextIcon size={16} />, onSelect: withTracks(t => { [...t].reverse().forEach(x => player.playNext(x)); toast("Playing next", "＋"); }) },
          { label: "Add to queue", icon: <QueueIcon size={16} />, onSelect: withTracks(t => { t.forEach(x => player.addToQueue(x)); toast("Added to queue", "＋"); }) },
          { label: "Start radio", icon: <RadioIcon size={16} />, onSelect: withTracks(t => player.startRadio(t[0])) },
        ],
        onOpen ? [{ label: "Go to album", icon: <AlbumIcon size={16} />, onSelect: () => onOpen(album.id) }] : [],
      ],
      playlist: { ids: () => tracks().then(t => t.map(x => x.id)), defaultName: album.title },
    };
  }

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!panel.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    document.addEventListener("touchstart", away, { capture: true, passive: true });
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("wheel", away, true);
      document.removeEventListener("touchstart", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  // Keep the panel on screen. Runs again when the step changes its size.
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const { width, height } = panel.current.getBoundingClientRect();
    const m = 8, p = open.place;
    let left = "x" in p && !("width" in p) ? p.x : (p as DOMRect).right - width;
    let top = "x" in p && !("width" in p) ? p.y : (p as DOMRect).bottom + 6;
    if (left + width > window.innerWidth - m) left = window.innerWidth - m - width;
    if (top + height > window.innerHeight - m) {
      const above = ("width" in p ? (p as DOMRect).top - 6 : top) - height;
      top = above >= m ? above : window.innerHeight - m - height;
    }
    setPos({ left: Math.max(m, left), top: Math.max(m, top) });
  }, [open, step, playlists, naming]);

  if (!open) return null;
  const { spec } = open;
  const pl = spec.playlist;

  const openPlaylists = () => {
    setStep("playlists");
    api.getPlaylists().then((all: any[]) => setPlaylists(all.filter(p => !p.smart))).catch(() => setPlaylists([]));
  };

  const addTo = async (id: number, name: string) => {
    close();
    try {
      const ids = await pl!.ids();
      if (!ids.length) return;
      await api.addTracksToPlaylist(id, ids);
      toast(`Added to ${name}`, "＋");
      pl!.onAdded?.(name);
      window.dispatchEvent(new Event(PLAYLISTS_CHANGED));
    } catch { toast("Could not add to the playlist"); }
  };

  const createAndAdd = async () => {
    const name = (naming ?? "").trim();
    if (!name) return;
    try {
      const made = await api.createPlaylist(name);
      await addTo(made.id, name);
    } catch { close(); toast("Could not create the playlist"); }
  };

  const sections = spec.sections.filter(s => s.length);

  return createPortal(
    <div
      className="ctx-menu" ref={panel} role="menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={e => e.preventDefault()}
    >
      {step === "main" ? (
        <>
          {spec.header && (
            <div className="ctx-head">
              {spec.header.albumId != null && <img src={api.coverUrl(spec.header.albumId, 96)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />}
              <div>
                <div className="ctx-title">{spec.header.title}</div>
                {spec.header.sub && <div className="ctx-sub">{spec.header.sub}</div>}
              </div>
            </div>
          )}
          {spec.rating && (
            <div className="ctx-rate">
              <span>Rate</span>
              <Stars value={rated} size={17} onRate={n => { setRated(n); spec.rating!.onRate(n); }} />
            </div>
          )}
          {sections.map((items, n) => (
            <div className="ctx-group" key={n}>
              {items.map(it => (
                <button key={it.label} role="menuitem" className={it.danger ? "danger" : ""} onClick={() => { close(); it.onSelect(); }}>
                  <span className="ctx-icon">{it.icon}</span>{it.label}
                </button>
              ))}
            </div>
          ))}
          {pl && (
            <div className="ctx-group">
              <button role="menuitem" onClick={openPlaylists}>
                <span className="ctx-icon"><PlaylistIcon size={16} /></span>Add to playlist
                <span className="ctx-chevron"><ChevronDownIcon size={16} /></span>
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="ctx-group">
            <button className="ctx-back" onClick={() => { setStep("main"); setNaming(null); }}>
              <span className="ctx-chevron back"><ChevronDownIcon size={16} /></span>Add to playlist
            </button>
          </div>
          <div className="ctx-group">
            {naming === null ? (
              <button role="menuitem" onClick={() => setNaming(pl!.defaultName)}>
                <span className="ctx-icon ctx-plus">+</span>New playlist
              </button>
            ) : (
              <form className="ctx-new" onSubmit={e => { e.preventDefault(); createAndAdd(); }}>
                <input autoFocus value={naming} onChange={e => setNaming(e.target.value)} onFocus={e => e.currentTarget.select()}
                  placeholder="Playlist name" aria-label="Playlist name" maxLength={120} />
                <button type="submit" className="btn primary" disabled={!naming.trim()}>Create</button>
              </form>
            )}
          </div>
          <div className="ctx-group ctx-scroll">
            {playlists === null && <div className="ctx-empty">Loading…</div>}
            {playlists?.length === 0 && <div className="ctx-empty">No playlists yet</div>}
            {playlists?.map(p => (
              <button key={p.id} role="menuitem" onClick={() => addTo(p.id, p.name)}>
                <span className="ctx-icon"><PlaylistIcon size={16} /></span>{p.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

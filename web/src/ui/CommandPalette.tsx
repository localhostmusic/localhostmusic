import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "../player/PlayerProvider";
import type { ViewName } from "./Sidebar";
import {
  HomeIcon, ArtistIcon, AlbumIcon, GenreIcon, RadioIcon, PlaylistIcon, HeartIcon, PodcastIcon, BookIcon,
  CompassIcon, ChartIcon, DownloadIcon, GearIcon, PlayIcon, NextIcon, PrevIcon, LyricsIcon, QueueIcon,
  ShuffleIcon, SearchIcon, MusicIcon,
} from "./icons";

// Ctrl/Cmd+K: with no query it lists the actions. Typing filters them and adds
// library matches underneath.

interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  art?: string;          // cover/photo URL for library results
  round?: boolean;
  run: () => void;
}

export function CommandPalette({ isAdmin, onNavigate, onOpenAlbum, onOpenArtist, onTogglePanel, onOpenPlayer, disabled }: {
  isAdmin: boolean;
  onNavigate: (v: ViewName) => void;
  onOpenAlbum: (id: number) => void;
  onOpenArtist: (id: number, name: string) => void;
  onTogglePanel: (p: "lyrics" | "queue") => void;
  onOpenPlayer: () => void;
  disabled?: boolean;
}) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [res, setRes] = useState<any | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        if (disabled && !open) return;
        e.preventDefault();
        if (open) { setOpen(false); return; }
        setQ(""); setSel(0); setRes(null); setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, open]);

  // Library matches, debounced; only once there's something worth searching for.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => api.search(term).then(r => { if (live) { setRes(r); setSel(0); } }).catch(() => {}), 140);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const close = () => setOpen(false);
  const go = (v: ViewName) => () => onNavigate(v);

  // Rebuilt every render: the callbacks close over App's current navigation state,
  // and a memoised copy would push onto a stale stack.
  const actions: Item[] = (() => {
    const a: Item[] = [
      { key: "home", label: "Home", hint: "Go to", icon: <HomeIcon size={18} />, run: go("home") },
      { key: "artists", label: "Artists", hint: "Go to", icon: <ArtistIcon size={18} />, run: go("artists") },
      { key: "albums", label: "Albums", hint: "Go to", icon: <AlbumIcon size={18} />, run: go("albums") },
      { key: "genres", label: "Genres", hint: "Go to", icon: <GenreIcon size={18} />, run: go("genres") },
      { key: "radio", label: "Radio", hint: "Go to", icon: <RadioIcon size={18} />, run: go("radio") },
      { key: "playlists", label: "Playlists", hint: "Go to", icon: <PlaylistIcon size={18} />, run: go("playlists") },
      { key: "favorites", label: "Liked Songs", hint: "Go to", icon: <HeartIcon size={18} />, run: go("favorites") },
      { key: "podcasts", label: "Podcasts", hint: "Go to", icon: <PodcastIcon size={18} />, run: go("podcasts") },
      { key: "audiobooks", label: "Audiobooks", hint: "Go to", icon: <BookIcon size={18} />, run: go("audiobooks") },
      { key: "discover", label: "Discover", hint: "Go to", icon: <CompassIcon size={18} />, run: go("discover") },
      { key: "stats", label: "Your Listening", hint: "Go to", icon: <ChartIcon size={18} />, run: go("stats") },
      { key: "downloads", label: "Downloads", hint: "Go to", icon: <DownloadIcon size={18} />, run: go("downloads") },
      { key: "toggle", label: player.isPlaying ? "Pause" : "Play", hint: "Playback", icon: <PlayIcon size={16} />, run: () => player.toggle() },
      { key: "next", label: "Next track", hint: "Playback", icon: <NextIcon size={16} />, run: () => player.next() },
      { key: "prev", label: "Previous track", hint: "Playback", icon: <PrevIcon size={16} />, run: () => player.prev() },
      {
        key: "shuffle-liked", label: "Shuffle Liked Songs", hint: "Playback", icon: <ShuffleIcon size={16} />,
        run: () => {
          api.getFavorites().then((rows: any[]) => {
            const tracks: Track[] = rows.map(r => ({ ...r, albumId: r.albumId ?? r.album_id }));
            for (let i = tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; }
            if (tracks.length) player.playNow(tracks, 0);
          }).catch(() => {});
        },
      },
      { key: "nowplaying", label: "Now Playing", hint: "Show", icon: <MusicIcon size={18} />, run: onOpenPlayer },
      { key: "lyrics", label: "Lyrics", hint: "Show", icon: <LyricsIcon size={18} />, run: () => onTogglePanel("lyrics") },
      { key: "queue", label: "Queue", hint: "Show", icon: <QueueIcon size={18} />, run: () => onTogglePanel("queue") },
    ];
    if (isAdmin) a.push({ key: "settings", label: "Settings", hint: "Go to", icon: <GearIcon size={18} />, run: go("settings") });
    return a;
  })();

  const items: Item[] = (() => {
    const term = q.trim().toLowerCase();
    const matched = term ? actions.filter(a => `${a.hint ?? ""} ${a.label}`.toLowerCase().includes(term)) : actions;
    if (!res || term.length < 2) return matched; // a stale result set from a longer query
    const lib: Item[] = [
      ...(res.artists ?? []).slice(0, 4).map((a: any) => ({
        key: `ar${a.id}`, label: a.name, hint: "Artist", icon: <ArtistIcon size={18} />,
        art: api.artistImageUrl(a.id, 96), round: true, run: () => onOpenArtist(a.id, a.name),
      })),
      ...(res.albums ?? []).slice(0, 4).map((a: any) => ({
        key: `al${a.id}`, label: a.title, hint: a.artist ? `Album · ${a.artist}` : "Album", icon: <AlbumIcon size={18} />,
        art: api.coverUrl(a.id, 96), run: () => onOpenAlbum(a.id),
      })),
      ...(res.tracks ?? []).slice(0, 6).map((t: any) => ({
        key: `tr${t.id}`, label: t.title, hint: t.artist ? `Song · ${t.artist}` : "Song", icon: <PlayIcon size={16} />,
        art: (t.albumId ?? t.album_id) ? api.coverUrl(t.albumId ?? t.album_id, 96) : undefined,
        run: () => player.playNow([{ ...t, albumId: t.albumId ?? t.album_id }], 0),
      })),
    ];
    return [...matched, ...lib];
  })();

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const runAt = (i: number) => { const it = items[i]; if (!it) return; close(); it.run(); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(sel); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  return (
    <div className="modal-backdrop cmdk-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="cmdk" role="dialog" aria-label="Command bar">
        <div className="cmdk-input-row">
          <SearchIcon size={18} />
          <input
            ref={input} autoFocus className="cmdk-input" value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKeyDown}
            placeholder="Go to, play, or search your library…" aria-label="Command"
            role="combobox" aria-expanded aria-controls="cmdk-list" aria-activedescendant={`cmdk-${sel}`}
          />
          <kbd className="cmdk-kbd">esc</kbd>
        </div>
        <ul className="cmdk-list" id="cmdk-list" role="listbox" ref={list}>
          {items.map((it, i) => (
            <li key={it.key} id={`cmdk-${i}`} data-i={i} role="option" aria-selected={i === sel}
              className={`cmdk-item${i === sel ? " sel" : ""}`}
              onMouseMove={() => { if (sel !== i) setSel(i); }} onClick={() => runAt(i)}>
              <span className={`cmdk-icon${it.round ? " round" : ""}`}>
                {it.art ? <img src={it.art} alt="" loading="lazy" onError={e => (e.currentTarget.style.display = "none")} /> : it.icon}
              </span>
              <span className="cmdk-label">{it.label}</span>
              {it.hint && <span className="cmdk-hint">{it.hint}</span>}
            </li>
          ))}
          {!items.length && <li className="cmdk-empty">No matches{q.trim().length < 2 ? "" : ` for “${q.trim()}”`}</li>}
        </ul>
      </div>
    </div>
  );
}

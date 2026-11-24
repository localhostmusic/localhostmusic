import { useEffect, useReducer, useRef } from "react";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { openMenuFrom, type MenuSpec } from "./ContextMenu";
import { NextIcon, PlayIcon, PlaylistIcon, QueueIcon } from "./icons";
import { toast } from "./toast";

// Multi-select for track lists. Ctrl/Cmd-click toggles a row, Shift-click selects a
// range, and once anything is selected a plain click toggles too (the mouse-only
// path, entered from "Select" in the row menu). Selected tracks keep list order.

const picked = new Map<number, Track>();
let anchor: { list: Track[]; index: number } | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const selectedTracks = () => [...picked.values()];
export const selectionCount = () => picked.size;

export function clearSelection() {
  if (!picked.size && !anchor) return;
  picked.clear(); anchor = null; changed();
}

export function toggleSelected(list: Track[], index: number) {
  const t = list[index];
  if (picked.has(t.id)) picked.delete(t.id); else picked.set(t.id, t);
  anchor = { list, index };
  changed();
}

function selectRange(list: Track[], index: number) {
  const from = anchor && anchor.list === list ? anchor.index : index;
  const [a, b] = from < index ? [from, index] : [index, from];
  for (let i = a; i <= b; i++) picked.set(list[i].id, list[i]);
  changed();
}

export function useSelection() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { listeners.add(force); return () => { listeners.delete(force); }; }, []);
  return { count: picked.size, has: (id: number) => picked.has(id) };
}

// Row wiring. `onClickCapture` goes on the row element so a selecting click never
// reaches the play handlers underneath.
export function selectClick(e: React.MouseEvent, list: Track[], index: number) {
  const el = e.target as HTMLElement;
  if (el.closest(".trk-add, .trk-more, .pl-actions, .trk-rating, input")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && !e.shiftKey && !picked.size) return;
  e.preventDefault(); e.stopPropagation();
  window.getSelection()?.removeAllRanges();
  if (e.shiftKey) selectRange(list, index); else toggleSelected(list, index);
}

export function useRowSelect(list: Track[], index: number) {
  const sel = useSelection();
  return {
    selected: sel.has(list[index]?.id), selecting: sel.count > 0,
    onClickCapture: (e: React.MouseEvent) => selectClick(e, list, index),
  };
}

// The menu for a right-click on a selected row: acts on the whole selection.
export function selectionMenu(player: ReturnType<typeof usePlayer>): MenuSpec {
  const tracks = selectedTracks();
  const done = (msg: string) => { toast(msg, "＋"); clearSelection(); };
  return {
    header: { title: `${tracks.length} ${tracks.length === 1 ? "song" : "songs"} selected` },
    sections: [
      [
        { label: "Play", icon: <PlayIcon size={16} />, onSelect: () => { player.playNow(tracks, 0); clearSelection(); } },
        { label: "Play next", icon: <NextIcon size={16} />, onSelect: () => { [...tracks].reverse().forEach(t => player.playNext(t)); done("Playing next"); } },
        { label: "Add to queue", icon: <QueueIcon size={16} />, onSelect: () => { tracks.forEach(t => player.addToQueue(t)); done("Added to queue"); } },
      ],
      [{ label: "Clear selection", onSelect: clearSelection }],
    ],
    playlist: { ids: async () => tracks.map(t => t.id), defaultName: tracks[0]?.album || "New playlist", onAdded: clearSelection },
  };
}

// Bar shown while anything is selected.
export function SelectionBar() {
  const { count } = useSelection();
  const player = usePlayer();
  const plBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!count) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") clearSelection(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [count > 0]);

  if (!count) return null;
  const menu = selectionMenu(player);
  const [play, next, queue] = menu.sections[0];
  return (
    <div className="select-bar" role="toolbar" aria-label="Selected songs">
      <span className="select-count">{count} selected</span>
      <button className="btn" onClick={play.onSelect}><PlayIcon size={15} /> Play</button>
      <button className="btn" onClick={next.onSelect}><NextIcon size={15} /> Play next</button>
      <button className="btn" onClick={queue.onSelect}><QueueIcon size={15} /> Add to queue</button>
      <button className="btn" ref={plBtn}
        onClick={() => plBtn.current && openMenuFrom(plBtn.current, { sections: [], playlist: menu.playlist, startAt: "playlists" })}>
        <PlaylistIcon size={15} /> Add to playlist
      </button>
      <button className="btn select-clear" onClick={clearSelection} aria-label="Clear selection">✕</button>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { toast } from "../ui/toast";

// The list shown by the help panel. Keep it in step with the handler below and
// with the search shortcuts (CommandPalette, SearchBar, useTypeToSearch).
export const SHORTCUTS: { group: string; items: [keys: string[], what: string][] }[] = [
  { group: "Playback", items: [
    [["Space"], "Play or pause"],
    [["←"], "Back 5 seconds"],
    [["→"], "Forward 5 seconds"],
    [["Shift", "←"], "Previous song"],
    [["Shift", "→"], "Next song"],
    [["↑"], "Volume up"],
    [["↓"], "Volume down"],
  ] },
  // Letters search the library everywhere else, so these two only work here.
  { group: "In the full-screen player", items: [
    [["M"], "Mute or unmute"],
    [["L"], "Like the current song"],
  ] },
  { group: "Finding things", items: [
    [["Ctrl", "K"], "Search from anywhere"],
    [["/"], "Jump to the search box"],
    [["A–Z"], "Start typing on a library page to search"],
  ] },
  { group: "Lists", items: [
    [["Ctrl", "click"], "Add a song to the selection"],
    [["Shift", "click"], "Select a range of songs"],
    [["Right-click"], "Menu for a song or album"],
  ] },
  { group: "General", items: [
    [["?"], "Show this list"],
    [["Esc"], "Close a menu or panel"],
  ] },
];

const OPEN = "lhm-open-shortcuts";
export const openShortcuts = () => window.dispatchEvent(new Event(OPEN));

// Global playback shortcuts. Ignored while typing in a field or when a modal /
// the lyrics-sync tool is open (those handle their own keys).
export function KeyboardShortcuts({ playerOpen = false }: { playerOpen?: boolean }) {
  const p = usePlayer();
  const t = usePlayerTime();
  const [help, setHelp] = useState(false);
  const beforeMute = useRef(0.8);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (help && e.key === "Escape") { setHelp(false); return; }
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector(".syncl, .modal-backdrop:not(.shortcuts-backdrop)")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") { e.preventDefault(); setHelp(h => !h); return; }
      if (help) return;
      switch (e.key) {
        case " ": e.preventDefault(); p.toggle(); break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) p.next();
          else p.seek(Math.min(p.duration || Infinity, t.currentTime + 5));
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) p.prev();
          else p.seek(Math.max(0, t.currentTime - 5));
          break;
        case "ArrowUp": e.preventDefault(); p.setVolume(Math.min(1, p.volume + 0.05)); break;
        case "ArrowDown": e.preventDefault(); p.setVolume(Math.max(0, p.volume - 0.05)); break;
        case "m": case "M":
          if (!playerOpen) break;
          if (p.volume > 0) { beforeMute.current = p.volume; p.setVolume(0); toast("Muted"); }
          else { p.setVolume(beforeMute.current || 0.8); toast("Unmuted"); }
          break;
        case "l": case "L":
          if (playerOpen && p.current) { toast(p.currentFav ? "Removed from Liked Songs" : "Added to Liked Songs", "♥"); p.toggleCurrentFav(); }
          break;
      }
    };
    const open = () => setHelp(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN, open);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN, open); };
  });

  if (!help) return null;
  return createPortal(
    <div className="modal-backdrop shortcuts-backdrop" onClick={() => setHelp(false)}>
      <div className="modal shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button className="btn sm" onClick={() => setHelp(false)}>Close</button>
        </div>
        <div className="shortcuts-grid">
          {SHORTCUTS.map(g => (
            <section key={g.group}>
              <h3>{g.group}</h3>
              <dl>
                {g.items.map(([keys, what]) => (
                  <div key={what}>
                    <dt>{keys.map((k, i) => <span key={k}>{i > 0 && <i>+</i>}<kbd>{k}</kbd></span>)}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

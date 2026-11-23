import { useEffect } from "react";
import { usePlayer, usePlayerTime } from "./PlayerProvider";

// Global playback shortcuts. Ignored while typing in a field or when a modal /
// the lyrics-sync tool is open (those handle their own keys).
export function KeyboardShortcuts() {
  const p = usePlayer();
  const t = usePlayerTime();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector(".syncl, .modal-backdrop")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return null;
}

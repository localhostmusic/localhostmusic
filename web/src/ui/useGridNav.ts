import { useEffect } from "react";
import { pickNeighbor, type Dir } from "../tv/useSpatialNav";

// Desktop arrow-key browsing: once a card has focus, the arrows move between
// album/artist cards (across rows, and between shelves on Home) and Enter opens it.
// Otherwise the arrows stay seek/volume (KeyboardShortcuts). Registered in the capture
// phase so a focused card's arrow does not also seek.
const CARD = ".album-card, .artist-card, .quick-tile";
const DIRS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

export function useGridNav() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = DIRS[e.key];
      const cur = document.activeElement as HTMLElement | null;
      if (!cur?.matches(CARD)) return;
      if (e.key === "Escape") { cur.blur(); return; }
      if (!dir || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Visible cards only: kept-alive pages are display:none (no offsetParent).
      const scope = cur.closest(".content-inner") ?? document;
      const items = Array.from(scope.querySelectorAll<HTMLElement>(CARD)).filter(el => el.offsetParent !== null);
      const next = pickNeighbor(items, cur, dir);
      if (!next) return;
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}

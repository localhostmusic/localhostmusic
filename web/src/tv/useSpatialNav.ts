import { useEffect } from "react";

// D-pad spatial navigation for the TV UI. Remotes send arrow keys, Enter for OK and
// Escape/Backspace for Back. Focus moves to the nearest `.tv-focusable` in the
// pressed direction, Enter clicks it, Back calls onBack.

export type Dir = "up" | "down" | "left" | "right";

function focusables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".tv-focusable"))
    .filter(el => el.offsetParent !== null && !el.hasAttribute("disabled"));
}

// Distance of a candidate from the origin, split into the pressed axis
// (`primary`) and the perpendicular drift (`cross`). null if not in `dir`.
function metrics(o: DOMRect, c: DOMRect, dir: Dir): { primary: number; cross: number } | null {
  const ocx = o.left + o.width / 2, ocy = o.top + o.height / 2;
  const ccx = c.left + c.width / 2, ccy = c.top + c.height / 2;
  const dx = ccx - ocx, dy = ccy - ocy;
  const EPS = 4;
  switch (dir) {
    case "up":    return dy > -EPS ? null : { primary: -dy, cross: Math.abs(dx) };
    case "down":  return dy <  EPS ? null : { primary:  dy, cross: Math.abs(dx) };
    case "left":  return dx > -EPS ? null : { primary: -dx, cross: Math.abs(dy) };
    case "right": return dx <  EPS ? null : { primary:  dx, cross: Math.abs(dy) };
    default:      return null;
  }
}

// scrollIntoView is not used: it scrolls every ancestor and can move the page sideways.
// Horizontal scroll touches only the card's rail, vertical only the nearest scroller.
function centerInRail(el: HTMLElement) {
  const rail = el.closest<HTMLElement>(".tv-rail");
  if (!rail) return;
  const er = el.getBoundingClientRect();
  const rr = rail.getBoundingClientRect();
  const delta = (er.left + er.width / 2) - (rr.left + rr.width / 2);
  rail.scrollTo({ left: rail.scrollLeft + delta, behavior: "smooth" });
}
function ensureVisibleY(el: HTMLElement) {
  let sc = el.parentElement;
  while (sc) {
    const ov = getComputedStyle(sc).overflowY;
    if ((ov === "auto" || ov === "scroll" || ov === "hidden") && sc.scrollHeight > sc.clientHeight + 1) break;
    sc = sc.parentElement;
  }
  if (!sc) return;
  const er = el.getBoundingClientRect();
  const cr = sc.getBoundingClientRect();
  const padT = 90, padB = 56;
  if (er.top < cr.top + padT) sc.scrollTo({ top: sc.scrollTop + er.top - cr.top - padT, behavior: "smooth" });
  else if (er.bottom > cr.bottom - padB) sc.scrollTo({ top: sc.scrollTop + er.bottom - cr.bottom + padB, behavior: "smooth" });
}
// preventScroll: the two helpers above do all the scrolling.
function focusInView(el: HTMLElement) {
  el.focus({ preventScroll: true });
  centerInRail(el);
  ensureVisibleY(el);
}

// Nudge the rail when pressing past its first or last card.
function edgeBounce(el: HTMLElement, dir: Dir) {
  const rail = el.closest<HTMLElement>(".tv-rail");
  if (!rail) return;
  const cls = dir === "right" ? "bounce-r" : "bounce-l";
  rail.classList.remove(cls);
  void rail.offsetWidth; // restart the animation
  rail.classList.add(cls);
  setTimeout(() => rail.classList.remove(cls), 320);
}

// Best item to move to from `cur` in `dir`, or null at an edge. Takes the nearest
// band along the axis (the next row or column), then the closest item across it.
// Horizontal moves stay within the current row, so a rail's edge doesn't leak
// focus into another rail. Shared with ui/useGridNav.ts.
export function pickNeighbor(items: HTMLElement[], cur: HTMLElement, dir: Dir): HTMLElement | null {
  const horizontal = dir === "left" || dir === "right";
  const o = cur.getBoundingClientRect();
  const cands = items
    .filter(el => el !== cur)
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .map(({ el, r }) => ({ el, r, m: metrics(o, r, dir) }))
    .filter((x): x is { el: HTMLElement; r: DOMRect; m: { primary: number; cross: number } } => x.m !== null)
    .filter(x => !horizontal || (x.r.top < o.bottom - 4 && x.r.bottom > o.top + 4));
  if (!cands.length) return null;
  const minP = Math.min(...cands.map(c => c.m.primary));
  const band = minP + Math.max(70, minP * 0.5);
  return cands
    .filter(c => c.m.primary <= band)
    .sort((a, b) => a.m.cross - b.m.cross || a.m.primary - b.m.primary)[0]?.el ?? null;
}

function move(dir: Dir) {
  const items = focusables();
  if (!items.length) return;
  const horizontal = dir === "left" || dir === "right";
  const active = document.activeElement as HTMLElement | null;
  const cur = active && items.includes(active) ? active : items[0];
  if (!active || !items.includes(active)) { focusInView(cur); return; }
  const best = pickNeighbor(items, cur, dir);
  if (!best) { if (horizontal) edgeBounce(cur, dir); return; }
  focusInView(best);
}

// A focused element with data-keycapture="lr" (e.g. a seek bar) gets left/right as
// a `tv-seek` event instead of a focus move. Returns true if captured.
function seekCapture(dir: -1 | 1): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (a && a.dataset.keycapture?.includes("lr")) {
    a.dispatchEvent(new CustomEvent("tv-seek", { detail: dir }));
    return true;
  }
  return false;
}

export function useSpatialNav(onBack: () => void, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A text field owns the keys while typing. Escape blurs out of it.
      const a = document.activeElement as HTMLElement | null;
      // A read-only input still navigates with the d-pad (OK enters edit mode).
      const typing = !!a && (
        (a.tagName === "INPUT" && !(a as HTMLInputElement).readOnly) ||
        a.tagName === "TEXTAREA" || a.isContentEditable
      );
      if (typing) {
        if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack") {
          e.preventDefault();
          a!.blur();
          // Focus the first non-input. Landing on the field reopens the keyboard.
          const next = focusables().find(el => el !== a && el.tagName !== "INPUT");
          if (next) focusInView(next);
        }
        return;
      }
      switch (e.key) {
        case "ArrowUp":    e.preventDefault(); move("up"); break;
        case "ArrowDown":  e.preventDefault(); move("down"); break;
        case "ArrowLeft":  e.preventDefault(); if (!seekCapture(-1)) move("left"); break;
        case "ArrowRight": e.preventDefault(); if (!seekCapture(1)) move("right"); break;
        case "Enter": {
          const a = document.activeElement as HTMLElement | null;
          if (a && a.classList.contains("tv-focusable")) { e.preventDefault(); a.click(); }
          break;
        }
        case "Backspace": case "Escape": case "GoBack": case "BrowserBack":
          e.preventDefault(); onBack(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// Focus the first item after a screen renders. Keeps an existing content focus,
// but moves off the exit button.
export function focusFirst() {
  requestAnimationFrame(() => {
    const items = focusables();
    if (!items.length) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && a.classList.contains("tv-focusable") && !a.classList.contains("tv-exit")) return;
    items[0].focus({ preventScroll: true });
  });
}

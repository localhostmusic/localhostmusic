import { useRef } from "react";

type Handlers = {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
};

type Opts = {
  threshold?: number;
  // Ignore swipes that start within this many px of the left/right screen edge,
  // so they're left to the OS back/forward gesture instead.
  edgeExclude?: number;
};

// Does the touch start inside something that scrolls sideways (a shelf rail, the
// tab strip)? Then a horizontal drag is that element's scroll, not a swipe.
// Checked up to the element the handlers are attached to.
export function inHorizontalScroller(target: EventTarget | null, boundary: Element | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== boundary; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

// Lightweight discrete swipe detector for touch surfaces. Returns spreadable
// touch handlers plus a `moved` ref so callers can suppress a tap/click that was
// actually the start of a swipe.
export function useSwipe(h: Handlers, opts: Opts = {}) {
  const threshold = opts.threshold ?? 45;
  const edge = opts.edgeExclude ?? 0;
  const start = useRef<{ x: number; y: number; ok: boolean; inRail: boolean } | null>(null);
  const moved = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const w = window.innerWidth;
    const ok = edge === 0 || (t.clientX > edge && t.clientX < w - edge);
    start.current = { x: t.clientX, y: t.clientY, ok, inRail: inHorizontalScroller(e.target, e.currentTarget) };
    moved.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) moved.current = true;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || !s.ok) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < threshold && ay < threshold) return; // a tap, not a swipe
    if (ax > ay) { if (!s.inRail) (dx < 0 ? h.onSwipeLeft : h.onSwipeRight)?.(); }
    else (dy < 0 ? h.onSwipeUp : h.onSwipeDown)?.();
  };

  return { handlers: { onTouchStart, onTouchMove, onTouchEnd }, moved };
}

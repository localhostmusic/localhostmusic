import { useCallback, useEffect, useRef, useState } from "react";
import { dlog } from "./debugLog";

// Render a long grid only as far as the reader has scrolled. Building 800+ cards at
// once blocks a phone for seconds, so the list starts with a screenful or two and grows
// when the sentinel after it comes within a few screens of view. The count reached is
// remembered per `key` for the session, so a remounted view can restore its scroll.
const reached = new Map<string, number>();

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

export function useProgressive<T>(items: T[], key: string, first = 30, step = 60): {
  visible: T[]; more: boolean; sentinel: (el: HTMLElement | null) => void;
} {
  const canObserve = typeof IntersectionObserver === "function";
  const [count, setCount] = useState(() => Math.max(first, reached.get(key) ?? 0));
  const total = items.length;
  const more = canObserve && count < total;
  const observer = useRef<IntersectionObserver | null>(null);

  useEffect(() => { reached.set(key, Math.max(count, reached.get(key) ?? 0)); }, [key, count]);
  useEffect(() => () => observer.current?.disconnect(), []);

  // Callback ref: the sentinel unmounts when the list is complete and comes back if
  // the list grows, and each time it needs a fresh observer rooted at the element that scrolls.
  const sentinel = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || !canObserve) return;
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      const t = performance.now();
      setCount(c => c + step);
      // After the commit and a paint: how long one batch costs on this device.
      requestAnimationFrame(() => setTimeout(() => dlog(`grid ${key} +${step} in ${Math.round(performance.now() - t)}ms`), 0));
    }, { root: scrollParent(el), rootMargin: "0px 0px 2400px 0px" });
    io.observe(el);
    observer.current = io;
  }, [canObserve, key, step]);

  // The observer only reports changes. If a batch leaves the sentinel still in
  // range, nothing changes, so re-arm it.
  const sentinelEl = useRef<HTMLElement | null>(null);
  const setSentinel = useCallback((el: HTMLElement | null) => { sentinelEl.current = el; sentinel(el); }, [sentinel]);
  useEffect(() => { if (more && sentinelEl.current) sentinel(sentinelEl.current); }, [count, more, sentinel]);

  return { visible: more ? items.slice(0, count) : items, more, sentinel: setSentinel };
}

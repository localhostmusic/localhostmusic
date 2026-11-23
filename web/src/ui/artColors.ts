import { useSyncExternalStore } from "react";
import { api } from "../api";

// Cover colours (albumId to "#rrggbb") for painting a tile before its image loads.
// Fetched once per session on first use. The server computes them in the background,
// so a new album has no colour until the next load.
let colors: Record<number, string> = {};
let requested = false;
const subs = new Set<() => void>();

function subscribe(fn: () => void) {
  subs.add(fn);
  if (!requested) {
    requested = true;
    api.getAlbumColors()
      .then((c: Record<number, string>) => { colors = c ?? {}; subs.forEach(s => s()); })
      .catch(() => { /* offline or old server: tiles keep the neutral placeholder */ });
  }
  return () => { subs.delete(fn); };
}

// Called once at app start so the map is usually in hand before the first grid paints.
export function preloadAlbumColors() { subscribe(() => {})(); }

export function useAlbumColor(albumId: number | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () => (albumId == null ? undefined : colors[albumId]));
}

// For images with no stored colour (artist photos): a soft, stable hue from the name.
export function nameTint(name: string | undefined): string {
  let h = 0;
  for (const ch of name ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 28% 24%)`;
}

// Fade an image in once it has decoded. A cached image is already complete when
// React attaches the ref, so it skips the fade instead of flashing.
export function fadeInRef(img: HTMLImageElement | null) {
  if (!img) return;
  if (img.complete && img.naturalWidth > 0) img.classList.add("is-loaded");
  else img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
}

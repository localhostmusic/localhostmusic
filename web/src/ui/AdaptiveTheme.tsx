import { useEffect, useRef } from "react";
import { usePlayer } from "../player/PlayerProvider";
import { api } from "../api";
import { coverPalette, nightcorePalette, rgbaFromHex, type Palette } from "./colors";

// Default theme (Apple-Music pink-red) restored when nothing is playing.
const DEFAULTS: Record<string, string> = {
  "--accent": "#ff375f",
  "--accent-contrast": "#ffffff",
  "--accent-soft": "rgba(255, 55, 95, 0.16)",
  "--aurora-1": "#ff375f",
  "--aurora-2": "#7b2ff7",
  "--aurora-3": "#1f8cff",
};

// Nightcore idle theme, used before/without album colors.
const NIGHT_DEFAULTS: Record<string, string> = {
  "--accent": "#ff2ec4",
  "--accent-contrast": "#ffffff",
  "--accent-soft": "rgba(255, 46, 196, 0.18)",
  "--aurora-1": "#ff2ec4",
  "--aurora-2": "#00e5ff",
  "--aurora-3": "#8b5cf6",
};

function applyPalette(root: HTMLElement, p: Palette) {
  root.style.setProperty("--accent", p.accent);
  root.style.setProperty("--accent-contrast", p.contrast);
  root.style.setProperty("--accent-soft", rgbaFromHex(p.accent, 0.16));
  root.style.setProperty("--aurora-1", p.aurora[0]);
  root.style.setProperty("--aurora-2", p.aurora[1]);
  root.style.setProperty("--aurora-3", p.aurora[2]);
}

// Album-art adaptive accent: when the current album changes, sample its cover and
// animate the accent + aurora CSS variables toward its colors. In nightcore mode the
// palette is pulled toward magenta/cyan first, and the `nightcore` class on <html>
// turns on the restyle.
export function AdaptiveTheme() {
  const { current, nightcore } = usePlayer();
  const albumId = current?.albumId;
  // Keyed by album and mode, so toggling nightcore re-applies the same album.
  const lastApplied = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("nightcore", nightcore);
  }, [nightcore]);

  useEffect(() => {
    const root = document.documentElement;
    const applyDefaults = () => {
      for (const [k, v] of Object.entries(nightcore ? NIGHT_DEFAULTS : DEFAULTS)) root.style.setProperty(k, v);
    };

    if (albumId == null) {
      const key = nightcore ? "ndefault" : "default";
      if (lastApplied.current !== key) { applyDefaults(); lastApplied.current = key; }
      return;
    }
    const key = `${nightcore ? "n" : ""}${albumId}`;
    if (lastApplied.current === key) return;

    let cancelled = false;
    coverPalette(api.coverUrl(albumId, 160)).then(p => {
      if (cancelled) return;
      if (!p) {
        // Extraction failed: reset to the default instead of keeping the previous album's colour.
        applyDefaults();
        return;
      }
      applyPalette(root, nightcore ? nightcorePalette(p) : p);
      lastApplied.current = key;
    });
    return () => { cancelled = true; };
  }, [albumId, nightcore]);

  return null;
}

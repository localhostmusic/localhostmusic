// Crossfade length in seconds for track-to-track transitions. 0 = off (gapless),
// the default. Only sequential (natural end / next) transitions crossfade; manual
// jumps and seeks are hard cuts.

const KEY = "lhm_crossfade";
export const CROSSFADE_MAX = 12;

export function loadCrossfade(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isFinite(v) && v >= 0 && v <= CROSSFADE_MAX) return v;
  } catch { /* */ }
  return 0;
}

export function saveCrossfade(seconds: number) {
  try { localStorage.setItem(KEY, String(Math.max(0, Math.min(CROSSFADE_MAX, seconds)))); } catch { /* */ }
}

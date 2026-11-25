// Nightcore / slowed mode: one "vibe" dial for music playback, 1 = normal.
// Above 1 the track speeds up with pitch following (preservesPitch off). Below 1
// it slows down and reverb fades in. Audiobooks and podcasts are not affected.
// The mode toggle and the vibe value persist separately.

const KEY_ON = "lhm_nightcore";
const KEY_VIBE = "lhm_nightcore_vibe";

// Desktop only. Touch devices have no Web Audio graph (see
// WebAudioEngine.graphDisabled), so no reverb, and the rate change breaks playback
// on iOS. Gated here, not just in the UI, so a stored value can't leave a phone
// at rate != 1 with no control to turn it off.
export function nightcoreSupported(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export const VIBE_MIN = 0.7;
// Up to double speed. osu!'s Nightcore mod rate, 1.5, is one of the snap presets.
export const VIBE_MAX = 2;
// Dial position when the mode is first switched on.
export const VIBE_DEFAULT = 1.25;

export function loadNightcore(): boolean {
  if (!nightcoreSupported()) return false; // stored value is left intact
  try { return localStorage.getItem(KEY_ON) === "1"; } catch { /* */ }
  return false;
}
export function saveNightcore(on: boolean) {
  try { localStorage.setItem(KEY_ON, on ? "1" : "0"); } catch { /* */ }
}

export function loadVibe(): number {
  try {
    const v = Number(localStorage.getItem(KEY_VIBE));
    if (Number.isFinite(v) && v >= VIBE_MIN && v <= VIBE_MAX) return v;
  } catch { /* */ }
  return VIBE_DEFAULT;
}
export function saveVibe(vibe: number) {
  try { localStorage.setItem(KEY_VIBE, String(Math.max(VIBE_MIN, Math.min(VIBE_MAX, vibe)))); } catch { /* */ }
}

// Reverb wet mix for a vibe value: 0 at or above 1x, rising to ~0.55 at VIBE_MIN.
export function vibeReverb(vibe: number): number {
  if (vibe >= 1) return 0;
  return ((1 - vibe) / (1 - VIBE_MIN)) * 0.55;
}

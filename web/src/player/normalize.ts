// Volume normalization (ReplayGain-style). The server measures each track's
// integrated loudness (LUFS) and loud tracks are turned down toward a reference.
// Off by default. Attenuate-only: an <audio> element can't go above volume 1.0.

const KEY = "lhm_normalize";
// ReplayGain 2.0 reference level. Tracks louder than this get attenuated to match.
export const NORM_TARGET_LUFS = -18;

export function loadNormalize(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function saveNormalize(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
}

// Multiplier (0..1) for the track's playback volume. 1 = no change (off, unknown
// loudness, or a track already at/below the target).
export function normFactor(loudnessLufs: number | null | undefined, on: boolean): number {
  if (!on || loudnessLufs == null || !isFinite(loudnessLufs)) return 1;
  const gainDb = NORM_TARGET_LUFS - loudnessLufs; // < 0 when the track is louder than target
  if (gainDb >= 0) return 1; // quieter than target: no boost
  return Math.max(0, Math.min(1, Math.pow(10, gainDb / 20)));
}

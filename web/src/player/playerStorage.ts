// Saving and restoring the player across reloads.
// Two keys: the queue blob can be hundreds of KB and the position changes every
// few seconds, so the position has its own key to avoid re-serializing the queue.

import { buildOrder, type RepeatMode } from "./queueModel";
import type { Track } from "./PlayerProvider";

const LS_KEY = "lhm_player";
const TIME_KEY = "lhm_player_time";

// Parsed once, then merged in memory. `lastWritten` is what we believe is in
// storage: if the raw string differs, something else wrote the key (another tab),
// so re-parse instead of overwriting with a stale view.
let snapshot: Record<string, unknown> | null = null;
let lastWritten: string | null = null;

export function savePlayer(patch: Record<string, unknown>): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (snapshot === null || raw !== lastWritten) snapshot = JSON.parse(raw || "{}");
    snapshot = { ...snapshot, ...patch };
    lastWritten = JSON.stringify(snapshot);
    localStorage.setItem(LS_KEY, lastWritten);
  } catch { /* storage unavailable or full */ }
}

export function savePlayerTime(t: number): void {
  try { localStorage.setItem(TIME_KEY, String(t)); } catch { /* */ }
}

export interface RestoredPrefs {
  autoDJMode?: string;
  autoDJUnit?: string;
  autoDJSongCount?: number;
  autoDJAlbumCount?: number;
  weightedShuffle?: boolean;
}

export interface RestoredQueue {
  queue: Track[];
  order: number[];
  pos: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  currentTime: number;
}

const AUTO_DJ_MODES = ["similar-artists", "similar-songs", "favorites", "random"];
const AUTO_DJ_UNITS = ["songs", "albums"];
const REPEATS: RepeatMode[] = ["off", "all", "one"];

/**
 * Preferences restored even when there is no queue. Every field is validated:
 * storage is user-editable and may hold older formats.
 */
export function restorePrefs(): RestoredPrefs {
  const out: RestoredPrefs = {};
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!s) return out;
    if (AUTO_DJ_MODES.includes(s.autoDJMode)) out.autoDJMode = s.autoDJMode;
    if (AUTO_DJ_UNITS.includes(s.autoDJUnit)) out.autoDJUnit = s.autoDJUnit;
    if (Number.isFinite(s.autoDJSongCount)) out.autoDJSongCount = Math.max(5, Math.min(50, s.autoDJSongCount));
    if (Number.isFinite(s.autoDJAlbumCount)) out.autoDJAlbumCount = Math.max(1, Math.min(8, s.autoDJAlbumCount));
    if (typeof s.weightedShuffle === "boolean") out.weightedShuffle = s.weightedShuffle;
  } catch { /* corrupt or absent, use defaults */ }
  return out;
}

/**
 * The queue as it was left, or null if there is nothing to restore. The saved
 * order is used when valid (it carries removals and reorders), else rebuilt.
 */
export function restoreQueue(): RestoredQueue | null {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!s?.queue?.length) return null;
    const shuffle = !!s.shuffle;
    const saved: unknown = s.order;
    const orderValid = Array.isArray(saved) && saved.length > 0 &&
      saved.every((i) => Number.isInteger(i) && i >= 0 && i < s.queue.length);
    const { order, pos } = orderValid
      ? { order: saved as number[], pos: Math.min(Math.max(0, s.pos ?? 0), (saved as number[]).length - 1) }
      : buildOrder(s.queue.length, s.queueIndex || 0, shuffle);
    const savedT = Number(localStorage.getItem(TIME_KEY) ?? NaN);
    return {
      queue: s.queue as Track[],
      order,
      pos,
      shuffle,
      repeat: REPEATS.includes(s.repeat) ? s.repeat : "off",
      volume: typeof s.volume === "number" ? s.volume : 1,
      currentTime: Number.isFinite(savedT) ? savedT : (s.currentTime || 0),
    };
  } catch { return null; }
}

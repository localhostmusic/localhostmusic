// Streaming-quality preference: play the original file or a transcode at a chosen
// bitrate. Downloaded tracks always play at the bitrate they were downloaded at.

export type StreamQuality = "auto" | "lossless" | "high" | "normal" | "saver";

export const QUALITY_OPTIONS: { value: StreamQuality; label: string; hint: string }[] = [
  { value: "auto",     label: "Automatic",   hint: "High on fast networks, lighter on slow/cellular (never lossless)" },
  { value: "lossless", label: "Lossless",    hint: "Original files, highest bandwidth" },
  { value: "high",     label: "High",        hint: "320 kbps" },
  { value: "normal",   label: "Normal",      hint: "256 kbps" },
  { value: "saver",    label: "Data Saver",  hint: "128 kbps" },
];

const KEY = "lhm_stream_quality";
const VALID: StreamQuality[] = ["auto", "lossless", "high", "normal", "saver"];

export function loadStreamQuality(): StreamQuality {
  try {
    const v = localStorage.getItem(KEY) as StreamQuality | null;
    if (v && VALID.includes(v)) return v;
  } catch { /* */ }
  return "auto";
}

export function saveStreamQuality(q: StreamQuality) {
  try { localStorage.setItem(KEY, q); } catch { /* */ }
}

// Resolve a quality to a stream bitrate. 0 = original (no transcode).
export function resolveBitrate(q: StreamQuality): number {
  switch (q) {
    case "lossless": return 0;
    case "high":     return 320;
    case "normal":   return 256;
    case "saver":    return 128;
    case "auto": {
      // Auto never streams lossless. Safari has no navigator.connection, so the
      // default below must not be lossless either.
      const c = (navigator as any).connection;
      if (c) {
        if (c.saveData) return 128;
        if (c.effectiveType === "slow-2g" || c.effectiveType === "2g") return 128;
        if (c.effectiveType === "3g") return 256;
      }
      return 320; // 4g / wifi / unknown (incl. Safari)
    }
    default: return 0;
  }
}

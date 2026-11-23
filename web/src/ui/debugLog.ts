// Bounded diagnostics survive a PWA reload, so the last failure can be inspected
// from ?debug=1. Callers log state/IDs, never cookies, tokens, or media URLs.
export type DebugEntry = { t: number; msg: string };
const KEY = "lhm-diagnostics";
let t0 = Date.now();
let buf: DebugEntry[] = [];
try {
  const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
  if (saved && Array.isArray(saved.entries)) {
    buf = saved.entries.filter((e: DebugEntry) => Number.isFinite(e.t) && typeof e.msg === "string").slice(-200);
    t0 = Number(saved.started) || t0;
  }
} catch { /* private mode */ }
const subs = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  clearTimeout(saveTimer); saveTimer = undefined;
  try { sessionStorage.setItem(KEY, JSON.stringify({ started: t0, entries: buf })); } catch { /* quota */ }
};
if (typeof document !== "undefined") document.addEventListener("visibilitychange", save);
export function dlog(msg: string) {
  buf.push({ t: Date.now() - t0, msg: msg.slice(0, 240) });
  if (buf.length > 200) buf.shift();
  if (saveTimer === undefined) saveTimer = setTimeout(save, 2000);
  subs.forEach(fn => fn());
}
export function dlogEntries(): DebugEntry[] { return buf; }
export function dlogSubscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; }
export function dlogClear() { buf = []; t0 = Date.now(); save(); subs.forEach(fn => fn()); }

// Imperative toast bus: `toast("Added to queue")` shows a transient pill above the
// play bar. Module-level store (like notifications.ts), so it works without context.
export type Toast = { id: number; msg: string; icon?: string };

let items: Toast[] = [];
let seq = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach(fn => fn());

export function getToasts() { return items; }
export function subscribeToasts(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; }

export function toast(msg: string, icon?: string) {
  const id = seq++;
  // Collapse a repeat of the same message into one fresh pill.
  items = [...items.filter(t => t.msg !== msg), { id, msg, icon }];
  emit();
  window.setTimeout(() => { items = items.filter(t => t.id !== id); emit(); }, 2400);
}

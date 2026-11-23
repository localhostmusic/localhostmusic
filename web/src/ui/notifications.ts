import { api } from "../api";

export type Notif = { id: number; type: string; title: string; body: string | null; read: number; created_at: number };

// Module-level store so the sidebar bell and the mobile bell share one poll and
// one unread count (only one is visible at a time, but state stays consistent).
let state: { items: Notif[]; unread: number; loaded: boolean } = { items: [], unread: 0, loaded: false };
const subs = new Set<() => void>();
const emit = () => subs.forEach(fn => fn());

export function getNotifications() { return state; }
export function subscribeNotifications(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; }

export async function refreshNotifications() {
  try {
    const d: any = await api.getNotifications();
    state = { items: d.items ?? [], unread: d.unread ?? 0, loaded: true };
    emit();
  } catch { /* offline / not logged in: keep last state */ }
}

export async function markAllRead() {
  if (!state.unread) return;
  state = { items: state.items.map(n => ({ ...n, read: 1 })), unread: 0, loaded: true };
  emit();
  try { await api.markNotificationsRead(); } catch { /* will reconcile on next poll */ }
}

// Poll for new notifications: on start, on an interval, and when the tab refocuses.
let started = false;
export function startNotificationPolling() {
  if (started) return () => {};
  started = true;
  refreshNotifications();
  const t = window.setInterval(refreshNotifications, 45_000);
  const onFocus = () => refreshNotifications();
  window.addEventListener("focus", onFocus);
  return () => {
    started = false;
    window.clearInterval(t);
    window.removeEventListener("focus", onFocus);
  };
}

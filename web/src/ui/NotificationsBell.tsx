import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellIcon } from "./icons";
import { getNotifications, subscribeNotifications, markAllRead, refreshNotifications } from "./notifications";
import { api } from "../api";
import { UpdateNotice, updatePending, useDesktopUpdate } from "./desktopUpdate";

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Bell with an unread badge + a dropdown of recent notifications. The panel is
// portaled to <body> and fixed-positioned to the bell so no ancestor overflow
// (e.g. the scrolling sidebar) can clip it. Shared store keeps the desktop +
// mobile instances in sync.
export function NotificationsBell({ align = "left" }: { align?: "left" | "right" }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeNotifications(force), []);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const [seenUnread, setSeenUnread] = useState<Set<number>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { items, unread: unreadItems } = getNotifications();
  useDesktopUpdate();
  const unread = unreadItems + (updatePending() ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function toggle() {
    if (open) { setOpen(false); return; }
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) {
      setPos(align === "right"
        ? { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }
        : { top: r.bottom + 8, left: Math.max(8, r.left) });
    }
    // Snapshot which are unread so they stay highlighted while open, then clear.
    setSeenUnread(new Set(items.filter(n => !n.read).map(n => n.id)));
    refreshNotifications().then(() => {
      // Anything that just arrived in the refresh also counts as new, or it is
      // marked read below without getting the highlight.
      setSeenUnread(prev => {
        const merged = new Set(prev);
        for (const n of getNotifications().items) if (!n.read) merged.add(n.id);
        return merged;
      });
      return markAllRead();
    });
    setOpen(true);
  }

  async function remove(id: number) {
    try { await api.deleteNotification(id); } catch { /* */ }
    refreshNotifications();
  }

  return (
    <div className="notif" ref={wrapRef}>
      <button className="notif-bell" onClick={toggle} aria-label="Notifications" aria-expanded={open}>
        <BellIcon size={20} />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && createPortal(
        <div
          className="notif-panel" ref={panelRef} role="menu"
          style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right }}
        >
          <div className="notif-head">Notifications</div>
          <UpdateNotice />
          {items.length === 0 ? (
            updatePending() ? null : <div className="notif-empty">You're all caught up.</div>
          ) : (
            <ul className="notif-list">
              {items.map(n => (
                <li key={n.id} className={seenUnread.has(n.id) ? "unread" : ""}>
                  <div className="notif-item-main">
                    <div className="notif-item-title">{n.title}</div>
                    {n.body && <div className="notif-item-body">{n.body}</div>}
                    <div className="notif-item-time">{ago(n.created_at)}</div>
                  </div>
                  <button className="notif-item-x" onClick={() => remove(n.id)} aria-label="Dismiss">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

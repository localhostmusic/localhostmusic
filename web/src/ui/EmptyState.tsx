import type { ReactNode } from "react";

// What a page shows when it has nothing to list yet: an icon, one line saying so,
// and one line saying what to do. Spans the whole row inside a card grid.
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      {icon && <span className="empty-state-icon" aria-hidden>{icon}</span>}
      <p className="empty-state-title">{title}</p>
      {children && <p className="empty-state-hint">{children}</p>}
    </div>
  );
}

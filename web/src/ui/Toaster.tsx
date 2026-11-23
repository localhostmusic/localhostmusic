import { useSyncExternalStore } from "react";
import { getToasts, subscribeToasts } from "./toast";

// Renders the transient toast pills. Mounted once, near the app root.
export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (!items.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className="toast">
          {t.icon && <span className="toast-ic" aria-hidden="true">{t.icon}</span>}
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

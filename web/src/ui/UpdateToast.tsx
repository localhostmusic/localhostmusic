import { useEffect, useState } from "react";
import { applyUpdate } from "../sw-update";

// Non-disruptive "a new version is live" prompt. Appears when sw-update detects a
// fresh deploy; tapping Refresh applies it (never auto-reloads mid-playback).
export function UpdateToast() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(true);
    window.addEventListener("sw:update", on);
    return () => window.removeEventListener("sw:update", on);
  }, []);
  if (!show) return null;
  return (
    <div className="update-toast" role="status">
      <span>New version available</span>
      <button onClick={applyUpdate}>Refresh</button>
      <button className="update-dismiss" onClick={() => setShow(false)} aria-label="Dismiss">✕</button>
    </div>
  );
}

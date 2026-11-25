import { useEffect, useRef, useState } from "react";
import { api } from "../api";

// "I just added music": any user can ask the server to look for new files. The
// server scans by itself on a schedule too, so this is for when you don't want to wait.
export function LibraryRescan() {
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const watch = () => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const s = await api.scanStatus();
        if (!s.scanning) { clearInterval(timer.current); setScanning(false); setMsg("Done. New music is in your library."); }
      } catch { clearInterval(timer.current); setScanning(false); }
    }, 2000);
  };
  useEffect(() => {
    api.scanStatus().then(s => { if (s.scanning) { setScanning(true); watch(); } }).catch(() => {});
    return () => clearInterval(timer.current);
  }, []);

  async function rescan() {
    setMsg("");
    try {
      await api.requestRescan();
      setScanning(true); watch();
    } catch (e: any) {
      setMsg(e?.status === 429 ? "The library was scanned a moment ago. Try again in a few minutes." : "Could not start a scan.");
    }
  }

  return (
    <>
      <p className="muted library-rescan-note">Added music and don't see it yet? The library checks for new files by itself, or you can check now.</p>
      <div className="update-actions">
        <button className="btn" onClick={rescan} disabled={scanning}>{scanning ? "Scanning…" : "Check for new music"}</button>
      </div>
      {msg && <p className="ok-msg">{msg}</p>}
    </>
  );
}

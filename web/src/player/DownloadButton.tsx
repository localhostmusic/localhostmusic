import { useEffect, useState } from "react";
import { toast } from "../ui/toast";
import { DownloadIcon } from "../ui/icons";
import { downloadGroup, removeGroup, groupDownloaded, groupBitrate, onDownloadsChange, type DlTrack } from "./downloads";

const QUALITIES = [
  { label: "Original (lossless)", v: 0 },
  { label: "320 kbps", v: 320 },
  { label: "256 kbps", v: 256 },
  { label: "192 kbps", v: 192 },
  { label: "128 kbps", v: 128 },
];
const BR_KEY = "lhm-dl-bitrate";
// A missing key must fall back to 256, not Number(null) === 0 (lossless).
const defaultBitrate = () => { const raw = localStorage.getItem(BR_KEY); const n = raw == null ? NaN : Number(raw); return Number.isFinite(n) ? n : 256; };

// Download / remove an album or playlist for offline playback. A compact icon
// button that opens a quality / manage menu.
export function DownloadButton({ kind, id, name, tracks }: {
  kind: "album" | "playlist"; id: number; name: string; tracks: DlTrack[];
}) {
  const [downloaded, setDownloaded] = useState(() => groupDownloaded(kind, id));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => onDownloadsChange(() => setDownloaded(groupDownloaded(kind, id))), [kind, id]);
  useEffect(() => { setDownloaded(groupDownloaded(kind, id)); }, [kind, id]);

  async function start(bitrate: number) {
    setMenu(false);
    localStorage.setItem(BR_KEY, String(bitrate));
    setProgress({ done: 0, total: tracks.length });
    try {
      await downloadGroup({ kind, id, name }, tracks, bitrate, (done, total) => setProgress({ done, total }));
    } catch (error) { toast(error instanceof Error ? error.message : "Download failed. Please retry."); }
    finally { setProgress(null); }
  }

  if (progress) {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <button className="dl-icon downloading" disabled title={`Downloading ${progress.done}/${progress.total}`} aria-label="Downloading">
        <span className="dl-ring" style={{ ["--p" as any]: `${pct}%` }} />
        <span className="dl-icon-num">{progress.done}</span>
      </button>
    );
  }

  return (
    <div className="dl-wrap">
      <button
        className={`dl-icon${downloaded ? " done" : ""}`}
        onClick={() => setMenu(m => !m)}
        disabled={tracks.length === 0}
        aria-label={downloaded ? "Downloaded, manage" : "Download for offline"}
        title={downloaded ? "Downloaded" : "Download for offline"}
      >
        <DownloadIcon size={18} />
      </button>
      {menu && (<>
        <div className="dl-backdrop" onClick={() => setMenu(false)} />
        <ul className="dl-menu">
          {downloaded ? (<>
            <li className="dl-menu-head">Downloaded</li>
            <li><button onClick={() => { setMenu(false); start(groupBitrate(kind, id) ?? defaultBitrate()); }}>Re-download</button></li>
            <li><button className="danger" onClick={() => { setMenu(false); removeGroup(kind, id).catch(e => toast(e instanceof Error ? e.message : "Could not remove download")); }}>Remove download</button></li>
          </>) : (<>
            <li className="dl-menu-head">Download quality</li>
            {QUALITIES.map(q => <li key={q.v}><button onClick={() => start(q.v)}>{q.label}</button></li>)}
          </>)}
        </ul>
      </>)}
    </div>
  );
}

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";

function fmt(d?: number | null) {
  if (!d) return "";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Preview the tracklist of a release not in the library (fetched from MusicBrainz),
// with a Request button so you can ask the admin to acquire it.
export function DiscoTracksModal({ item, requested, onRequest, onClose }: {
  item: any; requested: boolean; onRequest: (i: any) => void; onClose: () => void;
}) {
  const [tracks, setTracks] = useState<any[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getDiscoTracks(item.rgid)
      .then((d: any) => { if (alive) setTracks(d.tracks ?? []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [item.rgid]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal disco-modal" onClick={e => e.stopPropagation()}>
        <div className="disco-modal-head">
          <img className="disco-modal-art" src={api.discoCoverUrl(item.rgid)} alt=""
            onError={e => (e.currentTarget.style.visibility = "hidden")} />
          <div className="disco-modal-meta">
            <p className="eyebrow">{item.type ?? "Release"} · Not in library</p>
            <h2>{item.title}</h2>
            {item.year ? <p className="muted">{item.year}</p> : null}
            <button className="btn primary" disabled={requested} onClick={() => onRequest(item)}>
              {requested ? "Requested ✓" : "Request this"}
            </button>
          </div>
        </div>

        <div className="disco-modal-tracks">
          {tracks === null && !failed && <p className="muted">Loading tracklist…</p>}
          {failed && <p className="muted">Couldn't load the tracklist right now.</p>}
          {tracks && tracks.length === 0 && <p className="muted">No tracklist available.</p>}
          {tracks && tracks.map((t, i) => (
            <div key={i} className="disco-track">
              <span className="disco-track-num">{t.position ?? i + 1}</span>
              <span className="disco-track-title">{t.title}</span>
              <span className="disco-track-dur">{fmt(t.duration)}</span>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

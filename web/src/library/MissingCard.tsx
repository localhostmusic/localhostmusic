import { useState } from "react";
import { api } from "../api";
import { MarqueeText } from "../ui/MarqueeText";

// A release that isn't in the library: dimmed cover (from the Cover Art Archive).
// Click to preview the tracklist; the inline button requests it from the admin.
export function MissingCard({ item, requested, onRequest, onOpen }: {
  item: any; requested: boolean; onRequest: (i: any) => void; onOpen: (i: any) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`album-card disco-missing${requested ? " requested" : ""}`} onClick={() => onOpen(item)}>
      <div className="album-art">
        {!failed
          ? <img src={api.discoCoverUrl(item.rgid)} alt="" loading="lazy" onError={() => setFailed(true)} />
          : <div className="disco-noart">♪</div>}
        <span className="disco-tag">Not in library</span>
        <button className="disco-req" disabled={requested} onClick={e => { e.stopPropagation(); onRequest(item); }}>
          {requested ? "Requested ✓" : "Request"}
        </button>
      </div>
      <MarqueeText className="album-title disco-title" text={item.title} />
      {item.year ? <div className="album-year">{item.year}</div> : null}
    </div>
  );
}

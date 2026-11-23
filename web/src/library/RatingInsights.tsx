import { useLibraryRevision } from "../library/useLibraryRevision";
import { useEffect, useState } from "react";
import { api } from "../api";

type Insights = {
  total: number;
  average: number;
  counts: number[]; // index 0 = 1 star, up to 5 stars
  topArtists: { id: number; name: string; rated: number; avg: number }[];
};

// A compact read on how you rate: average, distribution, and the artists you rate
// highest. Renders nothing until you've rated at least one song.
export function RatingInsights({ onOpenArtist }: { onOpenArtist: (id: number, name: string) => void }) {
  const libraryVersion = useLibraryRevision();
  const [ins, setIns] = useState<Insights | null>(null);
  useEffect(() => { api.getRatingInsights().then(setIns).catch(() => {}); }, [libraryVersion]);
  if (!ins || ins.total === 0) return null;
  const max = Math.max(1, ...ins.counts);

  return (
    <div className="insights">
      <div className="insights-head">
        <span className="insights-avg">{ins.average.toFixed(1)}<span className="insights-star">★</span></span>
        <span className="insights-sub">{ins.total} song{ins.total === 1 ? "" : "s"} rated</span>
      </div>
      <div className="insights-dist">
        {[5, 4, 3, 2, 1].map(star => (
          <div key={star} className="insights-row">
            <span className="insights-rlabel">{star}★</span>
            <span className="insights-bar"><span className="insights-fill" style={{ width: `${(ins.counts[star - 1] / max) * 100}%` }} /></span>
            <span className="insights-n">{ins.counts[star - 1]}</span>
          </div>
        ))}
      </div>
      {ins.topArtists.length > 0 && (
        <div className="insights-top">
          <span className="insights-top-label">You rate highest</span>
          <div className="insights-artists">
            {ins.topArtists.map(a => (
              <button key={a.id} className="insights-artist" onClick={() => onOpenArtist(a.id, a.name)}>
                {a.name} <span className="insights-artist-avg">{a.avg.toFixed(1)}★</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

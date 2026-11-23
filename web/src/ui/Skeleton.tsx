// Reusable loading placeholders that mirror the real markup, so a page holds its
// layout while data loads and content snaps in with no reflow or flash.

export function SkeletonCards({ count = 12, kind = "album" }: { count?: number; kind?: "album" | "artist" | "playlist" }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => kind === "artist" ? (
        <div key={i} className="artist-card skel" aria-hidden>
          <div className="artist-avatar skeleton" />
          <div className="skeleton skel-line" style={{ width: "70%", margin: "10px auto 0" }} />
        </div>
      ) : kind === "playlist" ? (
        <div key={i} className="pl-card skel" aria-hidden>
          <div className="pl-cover skeleton" />
          <div className="skeleton skel-line" style={{ width: "72%", marginTop: 10 }} />
        </div>
      ) : (
        <div key={i} className="album-card skel" aria-hidden>
          <div className="album-art skeleton" />
          <div className="skeleton skel-line" style={{ width: "82%" }} />
          <div className="skeleton skel-line" style={{ width: "50%" }} />
        </div>
      ))}
    </>
  );
}

export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="track-skel" aria-hidden>
          <div className="skeleton track-skel-art" />
          <div className="track-skel-text">
            <div className="skeleton skel-line" style={{ width: "55%" }} />
            <div className="skeleton skel-line" style={{ width: "32%" }} />
          </div>
        </li>
      ))}
    </>
  );
}

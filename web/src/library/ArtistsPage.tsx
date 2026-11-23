import { useEffect, useState } from "react";
import { api } from "../api";
import { ArtistAvatar } from "./ArtistAvatar";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonCards } from "../ui/Skeleton";
import { useProgressive } from "../ui/useProgressive";
import { DownloadedFilter, useDownloadFilter } from "../downloads/DownloadedFilter";

export function ArtistsPage({ onOpenArtist }: { onOpenArtist: (id: number, name: string) => void }) {
  const [artists, setArtists] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { on: dlOnly, artistNames } = useDownloadFilter();

  useEffect(() => { api.getArtists().then(setArtists).finally(() => setLoaded(true)); }, []);

  const shown = dlOnly ? artists.filter(a => artistNames.has(String(a.name).trim().toLowerCase())) : artists;
  const { visible, more, sentinel } = useProgressive(shown, "artists");

  return (
    <div className="page">
      <header className="page-head">
      </header>
      <DownloadedFilter />

      <div className="artist-grid">
        {visible.map(a => (
          <button key={a.id} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
            <ArtistAvatar id={a.id} name={a.name} />
            <MarqueeText className="artist-name" text={a.name} />
          </button>
        ))}
        {!loaded && shown.length === 0 && <SkeletonCards count={12} kind="artist" />}
        {loaded && shown.length === 0 && (
          <p className="muted">
            {dlOnly ? "Nothing downloaded on this device yet. Open an album and hit Download to keep it here."
              : "No music found yet. Add files to your music folder and rescan in Settings."}
          </p>
        )}
      </div>
      {more && <div ref={sentinel} className="grid-sentinel" aria-hidden />}
    </div>
  );
}

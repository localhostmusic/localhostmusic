import { useEffect, useState } from "react";
import { api } from "../api";
import { AlbumCard } from "./AlbumCard";
import { SkeletonCards } from "../ui/Skeleton";
import { dlog } from "../ui/debugLog";
import { useProgressive } from "../ui/useProgressive";
import { downloadedAlbums } from "../player/downloads";
import { DownloadedFilter, useDownloadFilter } from "../downloads/DownloadedFilter";

export function AlbumsPage({ onOpenAlbum }: { onOpenAlbum: (id: number) => void }) {
  const [albums, setAlbums] = useState<any[]>([]);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { on: dlOnly, albumIds } = useDownloadFilter();

  // Offline: fall back to whatever you've downloaded so your library still works.
  useEffect(() => {
    const t = performance.now();
    api.getAlbums().then(a => { dlog(`albums list ${a.length} in ${Math.round(performance.now() - t)}ms`); setAlbums(a); }).catch(() => { setAlbums(downloadedAlbums()); setOffline(true); }).finally(() => setLoaded(true));
  }, []);

  // Offline, the list is already the downloaded set, so this filter is a no-op.
  const shown = dlOnly ? albums.filter(al => albumIds.has(al.id)) : albums;
  const { visible, more, sentinel } = useProgressive(shown, "albums");

  return (
    <div className="page">
      {/* Badge for the offline subset. */}
      {offline && (
        <header className="page-head">
          <span className="page-badge">Offline: showing downloaded albums</span>
        </header>
      )}
      <DownloadedFilter />
      <div className="album-grid">
        {visible.map(al => <AlbumCard key={al.id} album={al} onOpen={onOpenAlbum} showArtist />)}
        {!loaded && shown.length === 0 && <SkeletonCards count={12} kind="album" />}
        {loaded && shown.length === 0 && (
          <p className="muted">
            {dlOnly ? "No downloaded albums on this device yet. Open an album and hit Download to keep it here."
              : offline ? "No downloaded albums on this device."
              : "No albums yet. Add music and rescan in Settings."}
          </p>
        )}
      </div>
      {more && <div ref={sentinel} className="grid-sentinel" aria-hidden />}
    </div>
  );
}

import { BookIcon } from "../ui/icons";
import { EmptyState } from "../ui/EmptyState";
import { useEffect, useState } from "react";
import { api } from "../api";
import { AlbumCard } from "./AlbumCard";
import { SkeletonCards } from "../ui/Skeleton";

// Audiobooks browse: the album grid, limited to spoken-word albums (flagged by the
// server, see /api/audiobooks). Author = artist, book = album, chapters = tracks.
export function AudiobooksPage({ onOpenAudiobook }: { onOpenAudiobook: (id: number) => void }) {
  const [books, setBooks] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.getAudiobooks().then(setBooks).catch(() => setBooks([])).finally(() => setLoaded(true));
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Audiobooks</h1>
      </header>
      <div className="album-grid">
        {books.map(al => <AlbumCard key={al.id} album={al} onOpen={onOpenAudiobook} showArtist />)}
        {!loaded && books.length === 0 && <SkeletonCards count={8} kind="album" />}
        {loaded && books.length === 0 && (
          <EmptyState icon={<BookIcon size={26} />} title="No audiobooks yet">
            Add spoken-word files (a <code>.m4b</code>, a folder named “Audiobooks”, or an
            “Audiobook” genre tag), then rescan in Settings.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

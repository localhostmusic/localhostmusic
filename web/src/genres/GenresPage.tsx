import { GenreIcon } from "../ui/icons";
import { EmptyState } from "../ui/EmptyState";
import { useEffect, useState } from "react";
import { api } from "../api";

// Deterministic hue per genre so each tile has a stable colour.
function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Browse the library by genre (tags from artist metadata).
export function GenresPage({ onOpenGenre }: { onOpenGenre: (genre: string) => void }) {
  const [genres, setGenres] = useState<any[] | null>(null);
  useEffect(() => { api.getGenres().then(setGenres).catch(() => setGenres([])); }, []);

  return (
    <div className="page">
      {genres === null ? (
        <p className="muted">Loading…</p>
      ) : genres.length === 0 ? (
        <EmptyState icon={<GenreIcon size={26} />} title="No genres yet">They fill in automatically as artist info is fetched.</EmptyState>
      ) : (
        <div className="genre-grid">
          {genres.map(g => {
            const h = hue(g.genre);
            return (
              <button
                key={g.genre}
                className="genre-tile"
                style={{ background: `linear-gradient(135deg, hsl(${h} 58% 34%), hsl(${(h + 40) % 360} 62% 22%))` }}
                onClick={() => onOpenGenre(g.genre)}
              >
                <span className="genre-tile-name">{g.genre}</span>
                <span className="genre-tile-meta">
                  {g.artists} artist{g.artists !== 1 ? "s" : ""} · {g.albums} album{g.albums !== 1 ? "s" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import { usePlayer } from "../player/PlayerProvider";
import { AlbumCard } from "../library/AlbumCard";
import { ArtistAvatar } from "../library/ArtistAvatar";
import { MarqueeText } from "../ui/MarqueeText";
import { PlayIcon, ShuffleIcon } from "../ui/icons";

function shuffled<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

// One genre: play or shuffle all of it, save it as a real playlist, and browse its
// albums + artists.
export function GenrePage({ genre, onOpenAlbum, onOpenArtist, onBack }: {
  genre: string;
  onOpenAlbum: (id: number) => void;
  onOpenArtist: (id: number, name: string) => void;
  onBack: () => void;
}) {
  const player = usePlayer();
  const [data, setData] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setData(null); setSaved(false);
    api.getGenre(genre).then(setData).catch(() => setData({ artists: [], albums: [], tracks: [] }));
  }, [genre]);

  const tracks: any[] = data?.tracks ?? [];
  const play = (shuffle: boolean) => { if (tracks.length) player.playNow(shuffle ? shuffled(tracks) : tracks, 0); };

  async function saveAsPlaylist() {
    if (!tracks.length || saved || saving) return;
    setSaving(true);
    try {
      const pl: any = await api.createPlaylist(genre);
      await api.addTracksToPlaylist(pl.id, tracks.map(t => t.id));
      setSaved(true);
    } catch { /* leave the button enabled to retry */ }
    finally { setSaving(false); }
  }

  return (
    <div className="page">
      <button className="link-btn back-btn" onClick={onBack}>‹ Back</button>
      <header className="genre-hero">
        <h1>{genre}</h1>
        <p className="muted">
          {data ? `${data.artists.length} artists · ${data.albums.length} albums · ${tracks.length} songs` : "…"}
        </p>
        <div className="genre-actions">
          <button className="btn primary" onClick={() => play(false)} disabled={!tracks.length}><PlayIcon size={16} /> Play</button>
          <button className="btn" onClick={() => play(true)} disabled={!tracks.length}><ShuffleIcon size={16} /> Shuffle</button>
          <button className="btn" onClick={saveAsPlaylist} disabled={!tracks.length || saved || saving}>
            {saved ? "Saved ✓" : saving ? "Saving…" : "Save as playlist"}
          </button>
        </div>
      </header>

      {data?.albums?.length > 0 && (
        <>
          <h3 className="section-title">Albums</h3>
          <div className="album-grid">
            {data.albums.map((al: any) => <AlbumCard key={al.id} album={al} onOpen={onOpenAlbum} showArtist />)}
          </div>
        </>
      )}

      {data?.artists?.length > 0 && (
        <>
          <h3 className="section-title">Artists</h3>
          <div className="artist-grid">
            {data.artists.map((a: any) => (
              <button key={a.id} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
                <ArtistAvatar id={a.id} name={a.name} />
                <MarqueeText className="artist-name" text={a.name} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

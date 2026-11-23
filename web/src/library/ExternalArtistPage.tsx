import { useEffect, useState } from "react";
import { api } from "../api";
import { MissingCard } from "./MissingCard";
import { DiscoTracksModal } from "./DiscoTracksModal";
import { TYPE_ORDER, TYPE_LABELS } from "./discoTypes";

// Discovery view for an artist not in the library (reached from external search).
// Shows their full discography from MusicBrainz; every release is requestable.
export function ExternalArtistPage({ artistName, image, onBack }: {
  artistName: string;
  image?: string;
  onBack: () => void;
}) {
  const [albums, setAlbums] = useState<any[] | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [typeF, setTypeF] = useState<string>("all");
  const [preview, setPreview] = useState<any | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setAlbums(null); setRequested(new Set()); setTypeF("all"); setPreview(null); setImgFailed(false);
    api.getDiscographyByName(artistName).then((d: any) => {
      setAlbums(d.albums);
      setRequested(new Set(d.albums.filter((a: any) => a.requested).map((a: any) => a.rgid)));
    }).catch(() => setAlbums([]));
  }, [artistName]);

  async function requestAlbum(item: any) {
    setRequested(s => new Set(s).add(item.rgid));
    try { await api.requestAlbum(item.title, artistName, item.year, item.rgid); }
    catch { setRequested(s => { const n = new Set(s); n.delete(item.rgid); return n; }); }
  }

  const base = albums ?? [];
  const types = [...new Set(base.map((it: any) => it.type))];
  const filtered = base.filter((it: any) => typeF === "all" || it.type === typeF);

  return (
    <div className="page artist-page">
      <div className={`artist-banner${imgFailed || !image ? " no-img" : ""}`}>
        {image && !imgFailed && (
          <>
            <img className="artist-banner-blur" src={image} alt="" aria-hidden />
            <img className="artist-banner-img" src={image} alt="" onError={() => setImgFailed(true)} />
          </>
        )}
        <div className="artist-banner-scrim" />
        <button className="artist-back" onClick={onBack} aria-label="Back">‹</button>
        <h1 className="artist-banner-name">{artistName}</h1>
      </div>

      <div className="artist-body">
        <p className="artist-sub">Not in your library · discover &amp; request</p>

        <h2 className="section-title">Discography</h2>
        {albums === null && <p className="muted">Loading discography…</p>}
        {albums && albums.length === 0 && <p className="muted">Couldn't find a discography for this artist.</p>}

        {base.length > 0 && types.length > 1 && (
          <div className="disco-filters">
            <div className="chip-row">
              <button className={`chip${typeF === "all" ? " active" : ""}`} onClick={() => setTypeF("all")}>All types</button>
              {TYPE_ORDER.filter(t => types.includes(t)).map(t => (
                <button key={t} className={`chip${typeF === t ? " active" : ""}`} onClick={() => setTypeF(t)}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
          </div>
        )}

        {base.length > 0 && (
          <div className="album-grid">
            {filtered.map((it: any) => (
              <MissingCard key={it.rgid} item={it} requested={requested.has(it.rgid)} onRequest={requestAlbum} onOpen={setPreview} />
            ))}
          </div>
        )}
      </div>

      {preview && (
        <DiscoTracksModal
          item={preview}
          requested={requested.has(preview.rgid)}
          onRequest={requestAlbum}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

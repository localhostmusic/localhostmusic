import { useEffect, useState } from "react";
import { api } from "../api";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonCards } from "../ui/Skeleton";
import { ArtistAvatar } from "../library/ArtistAvatar";
import { DiscoTracksModal } from "../library/DiscoTracksModal";

// "Not interested". Stops the click from reaching the card underneath.
function DismissButton({ onDismiss, what }: { onDismiss: () => void; what: string }) {
  return (
    <button
      className="disco-dismiss"
      title={`Not interested in ${what}`}
      aria-label={`Not interested in ${what}`}
      onClick={e => { e.stopPropagation(); onDismiss(); }}
    >×</button>
  );
}

// Round avatar for an external artist (Deezer image, monogram fallback).
function ExtAvatar({ name, image }: { name: string; image?: string }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) return <span className="artist-avatar">{(name || "?").slice(0, 1).toUpperCase()}</span>;
  return <img className="artist-avatar img" src={image} alt="" onError={() => setFailed(true)} />;
}

interface Props {
  onOpenArtist: (id: number, name: string) => void;
  onOpenExternalArtist: (name: string, image?: string) => void;
}

// Discovery seeded from your most-played artists: similar artists and new
// releases from artists you already have.
export function DiscoverPage({ onOpenArtist, onOpenExternalArtist }: Props) {
  const [feed, setFeed] = useState<any>(null);
  const [forYou, setForYou] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<any | null>(null);       // release-info modal
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());   // hidden locally, at once
  const [undo, setUndo] = useState<{ key: string; label: string } | null>(null);
  // Count from the server, so restore is still offered after a reload.
  const [hiddenCount, setHiddenCount] = useState(0);

  // Hide it immediately, then tell the server. The feed filters dismissals on read,
  // so it stays gone on the next load without waiting for a rebuild.
  async function dismiss(key: string, label: string) {
    if (!key) return;
    setDismissed(d => new Set(d).add(key));
    setUndo({ key, label });
    try { await api.dismissDiscover(key); setHiddenCount(n => n + 1); }
    catch { setDismissed(d => { const n = new Set(d); n.delete(key); return n; }); setUndo(null); }
  }
  async function restoreAll() {
    setUndo(null);
    try { await api.restoreDiscoverDismissed(); setDismissed(new Set()); setHiddenCount(0); load(true); } catch { /* keep as is */ }
  }
  const gone = (key?: string) => !!key && dismissed.has(key);

  async function requestAlbum(item: any) {
    setRequested(s => new Set(s).add(item.rgid));
    try { await api.requestAlbum(item.title, item.artistName || "", item.year, item.rgid); }
    catch { setRequested(s => { const n = new Set(s); n.delete(item.rgid); return n; }); }
  }

  const load = (refresh?: boolean) => {
    setLoading(true);
    api.getDiscoverFeed(refresh).then(setFeed).catch(() => setFeed({ recommendations: [], newReleases: [] })).finally(() => setLoading(false));
    if (refresh) api.getForYou(true).then(setForYou).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { api.getForYou().then(setForYou).catch(() => {}); }, []);
  useEffect(() => { api.getDiscoverDismissed().then((d: any) => setHiddenCount(d.keys?.length ?? 0)).catch(() => {}); }, []);

  const empty = feed && !feed.recommendations?.length && !feed.newReleases?.length && !feed.relatedNew?.length;

  return (
    <div className="page">
      <header className="page-head">
        <button className="btn" onClick={() => load(true)} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        {hiddenCount > 0 && (
          <button className="link-btn disco-restore" onClick={restoreAll}>
            {undo ? `Hid ${undo.label}. Undo` : `Bring back ${hiddenCount} hidden`}
          </button>
        )}
      </header>


      {/* Personalized recs from the connected scrobble service (richer than local plays). */}
      {forYou?.connected && forYou.inLibrary?.length > 0 && (
        <>
          <h3 className="section-title">More from your library</h3>
          <div className="artist-grid">
            {forYou.inLibrary.map((a: any) => (
              <button key={`lib${a.id}`} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
                <ArtistAvatar id={a.id} name={a.name} />
                <MarqueeText className="artist-name" text={a.name} />
              </button>
            ))}
          </div>
        </>
      )}
      {forYou?.connected && forYou.discover?.length > 0 && (
        <>
          <h3 className="section-title">Recommended for you{forYou.provider ? ` · from ${forYou.provider === "lastfm" ? "Last.fm" : "ListenBrainz"}` : ""}</h3>
          <div className="artist-grid">
            {forYou.discover.filter((a: any) => !gone(a.key)).map((a: any, i: number) => (
              <div key={`dc${i}`} className="disco-cell">
                <button className="artist-card" onClick={() => onOpenExternalArtist(a.name, a.image)}>
                  <ExtAvatar name={a.name} image={a.image} />
                  <MarqueeText className="artist-name" text={a.name} />
                </button>
                <DismissButton what={a.name} onDismiss={() => dismiss(a.key, a.name)} />
              </div>
            ))}
          </div>
        </>
      )}
      {forYou && !forYou.connected && (
        <p className="muted">Connect Last.fm or ListenBrainz (Account, Scrobbling) to get recommendations from your full listening history.</p>
      )}

      {loading && !feed && (
        <>
          <h3 className="section-title">Finding music based on what you listen to…</h3>
          <div className="album-grid"><SkeletonCards count={8} /></div>
        </>
      )}

      {empty && (
        <p className="muted">Play some music first. Your recommendations are built from what you listen to.</p>
      )}

      {feed?.newReleases?.length > 0 && (
        <>
          <h3 className="section-title">New releases for you</h3>
          <div className="album-grid">
            {feed.newReleases.filter((al: any) => !gone(al.key)).map((al: any, i: number) => (
              <div key={i} className="disco-cell">
              <button className="album-card" onClick={() => setPreview(al)}>
                <div className="album-art">
                  <img src={api.discoCoverUrl(al.rgid)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                  <span className="disco-tag">New{al.year ? ` · ${al.year}` : ""}</span>
                </div>
                <MarqueeText className="album-title" text={al.title} />
                <div className="album-year">{al.artistName}</div>
              </button>
              <DismissButton what={al.title} onDismiss={() => dismiss(al.key, al.title)} />
              </div>
            ))}
          </div>
        </>
      )}

      {feed?.relatedNew?.length > 0 && (
        <>
          <h3 className="section-title">New from artists you might like</h3>
          <div className="album-grid">
            {feed.relatedNew.filter((al: any) => !gone(al.key)).map((al: any, i: number) => (
              <div key={i} className="disco-cell">
              <button className="album-card" onClick={() => onOpenExternalArtist(al.artistName, al.artistImage)}>
                <div className="album-art">
                  {al.cover
                    ? <img src={al.cover} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                    : <div className="disco-noart">♪</div>}
                  <span className="disco-tag">New{al.year ? ` · ${al.year}` : ""}</span>
                </div>
                <MarqueeText className="album-title" text={al.title} />
                <div className="album-year">{al.artistName}</div>
              </button>
              <DismissButton what={al.title} onDismiss={() => dismiss(al.key, al.title)} />
              </div>
            ))}
          </div>
        </>
      )}

      {feed?.recommendations?.map((row: any, i: number) => (
        <div key={i}>
          <h3 className="section-title">Because you listen to {row.seed}</h3>
          <div className="artist-grid">
            {row.artists.filter((a: any) => !gone(a.key)).map((a: any) => (
              <div key={a.deezerId} className="disco-cell">
                <button className="artist-card" onClick={() => onOpenExternalArtist(a.name, a.image)}>
                  <ExtAvatar name={a.name} image={a.image} />
                  <MarqueeText className="artist-name" text={a.name} />
                </button>
                <DismissButton what={a.name} onDismiss={() => dismiss(a.key, a.name)} />
              </div>
            ))}
          </div>
        </div>
      ))}

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

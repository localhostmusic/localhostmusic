import { useLibraryRevision } from "../library/useLibraryRevision";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { AlbumCard } from "./AlbumCard";
import { MissingCard } from "./MissingCard";
import { DiscoTracksModal } from "./DiscoTracksModal";
import { ArtistImagePicker } from "./ArtistImagePicker";
import { TYPE_ORDER, TYPE_LABELS } from "./discoTypes";
import { StarIcon, PlayIcon, ShuffleIcon } from "../ui/icons";

interface Props {
  artistId: number;
  artistName?: string;
  isAdmin?: boolean;
  onOpenAlbum: (id: number) => void;
  onBack: () => void;
}

interface Info {
  bio?: string | null;
  type?: string | null;
  area?: string | null;
  begin?: string | null;
  ended?: string | null;
  genres?: string | null;
  imageV?: number;   // when the photo last changed, used as the ?v= cache key
  stats?: { albums: number; tracks: number; duration: number; plays: number };
}

function years(begin?: string | null, ended?: string | null): string | null {
  if (!begin) return null;
  const b = begin.slice(0, 4);
  const e = ended ? ended.slice(0, 4) : "present";
  return b === e ? b : `${b}-${e}`;
}
function listen(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function ArtistPage({ artistId, artistName, isAdmin, onOpenAlbum, onBack }: Props) {
  const player = usePlayer();
  const libraryVersion = useLibraryRevision();
  const [albums, setAlbums] = useState<any[]>([]);
  const [tracks, setTracks] = useState<any[]>([]);
  const [appearsOn, setAppearsOn] = useState<{ albums: any[]; tracks: any[] }>({ albums: [], tracks: [] });
  const [disco, setDisco] = useState<any[] | null>(null);
  const [discoDone, setDiscoDone] = useState(false); // discography fetch settled (gates the empty message)
  const [discoArtist, setDiscoArtist] = useState("");
  const [requested, setRequested] = useState<Set<string>>(new Set());
  // Owned releases only by default.
  const [ownedOnly, setOwnedOnly] = useState(true);
  const [preview, setPreview] = useState<any | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [bannerReady, setBannerReady] = useState(false); // banner image decoded (paints in one frame)
  // Landscape banners get the full-bleed hero. Small square photos keep the avatar
  // and blurred wash.
  const [wide, setWide] = useState(false);
  const [imgVersion, setImgVersion] = useState(0);
  const [bioOpen, setBioOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [starred, setStarred] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  // The photo URL is versioned by when the photo changed, so it can be cached hard.
  // imgVersion overrides it right after picking a new one.
  const imgV = imgVersion || info?.imageV || 0;
  const bannerSrc = `${api.artistImageUrl(artistId)}${imgV ? `?v=${imgV}` : ""}`;

  useEffect(() => {
    setInfo(null); setImgFailed(false); setBioOpen(false); setStarred(false); setImgVersion(0);
    setDisco(null); setDiscoDone(false); setRequested(new Set()); setOwnedOnly(true); setPreview(null);
    setAppearsOn({ albums: [], tracks: [] }); setTracks([]);
    api.getArtistTracks(artistId).then((d: any) => setTracks(d.tracks ?? [])).catch(() => {});

    api.getArtistAlbums(artistId).then(setAlbums);
    api.getArtistAppearsOn(artistId).then(setAppearsOn).catch(() => {});
    api.getArtistInfo(artistId).then(setInfo).catch(() => {});
    // Full discography (library + MusicBrainz). The library-only albums stand in
    // if MusicBrainz can't be reached.
    api.getDiscography(artistId).then((d: any) => {
      setDisco(d.albums); setDiscoArtist(d.artist);
      setRequested(new Set(d.albums.filter((a: any) => a.requested).map((a: any) => a.rgid)));
    }).catch(() => {}).finally(() => setDiscoDone(true));
  }, [artistId]);

  useEffect(() => {
    api.getLibraryState().then((s: any) => setStarred((s.starredArtists || []).includes(artistId))).catch(() => {});
  }, [artistId, libraryVersion]);

  // Decode the banner before rendering it, so the <img> paints in the frame it mounts.
  // decoding="sync" and background-image still decode async on iOS Safari.
  useEffect(() => {
    setBannerReady(false);
    let alive = true;
    const im = new Image();
    im.src = bannerSrc;
    im.decode().then(() => {
      if (!alive) return;
      setWide(im.naturalWidth >= 1200 && im.naturalWidth / im.naturalHeight >= 1.6);
      setBannerReady(true);
    })
      .catch(() => { if (alive) setImgFailed(true); });
    return () => { alive = false; };
  }, [bannerSrc]);

  async function requestAlbum(item: any) {
    setRequested(s => new Set(s).add(item.rgid));
    try { await api.requestAlbum(item.title, discoArtist || artistName || "", item.year, item.rgid); }
    catch { setRequested(s => { const n = new Set(s); n.delete(item.rgid); return n; }); }
  }

  // The picker (candidates / upload) applies the change; just refresh the banner.
  function onPicked() {
    setImgFailed(false);
    setImgVersion(Date.now());                                  // bust the cache now
    api.getArtistInfo(artistId).then(setInfo).catch(() => {});   // then pick up the server's version
  }
  async function refreshInfo() {
    setBusy(true); setMsg("");
    try { setInfo(await api.refreshArtistInfo(artistId)); }
    catch { setMsg("Couldn't refresh info."); }
    finally { setBusy(false); }
  }

  function playAll() { if (tracks.length) player.playNow(tracks as Track[], 0); }
  function shuffleAll() {
    if (!tracks.length) return;
    const q = tracks.slice();
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    player.playNow(q as Track[], 0);
  }

  // Only shown when tracks have plays or there is more than one release to rank across.
  const topSongs = useMemo(() => {
    const played = tracks.some(t => (t.plays ?? 0) > 0);
    const releases = new Set(tracks.map(t => t.albumId)).size;
    if (tracks.length < 4 || (!played && releases < 2)) return [];
    return tracks.slice().sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0)).slice(0, 6);
  }, [tracks]);

  const s = info?.stats;
  // Kicker: the leading genres only. The full list is in the facts below.
  const GENRES_IN_KICKER = 3;
  const genreList = (info?.genres ?? "").split(",").map(g => g.trim()).filter(Boolean);
  const sub = genreList.slice(0, GENRES_IN_KICKER).join(", ");
  // Meta: what the library holds.
  const statBits = s
    ? [
        `${s.albums} album${s.albums === 1 ? "" : "s"}`,
        `${s.tracks} song${s.tracks === 1 ? "" : "s"}`,
        s.plays > 0 ? `${s.plays.toLocaleString()} play${s.plays === 1 ? "" : "s"}` : null,
        s.duration > 0 ? listen(s.duration) : null,
      ].filter(Boolean).join(" · ")
    : "";
  // Facts: one row each. Genre is listed in full here.
  const facts = [
    info?.area ? { key: "from", label: "From", value: info.area } : null,
    years(info?.begin, info?.ended) ? { key: "active", label: "Active", value: years(info?.begin, info?.ended)! } : null,
    genreList.length ? { key: "genre", label: "Genre", value: genreList.join(", ") } : null,
  ].filter(Boolean) as { key: string; label: string; value: string }[];

  const bioLong = (info?.bio?.length ?? 0) > 280;

  return (
    <div className="page artist-page">
      {/* Wide photos become the banner. Others show as an avatar over a blurred wash. */}
      <header className={`artist-head2${wide && bannerReady && !imgFailed ? " has-banner" : ""}`}>
        {!imgFailed && bannerReady && (wide
          ? <img className="artist-banner" src={bannerSrc} alt="" aria-hidden decoding="sync" />
          : <img className="artist-wash" src={bannerSrc} alt="" aria-hidden decoding="sync" />
        )}
        <div className="artist-wash-scrim" />
        <button className="artist-back" onClick={onBack} aria-label="Back">‹</button>
        <div className="artist-head-row">
          <div className="artist-avatar-xl">
            {!imgFailed && bannerReady
              ? <img src={bannerSrc} alt="" decoding="sync" onError={() => setImgFailed(true)} />
              : imgFailed
                ? <span>{(artistName ?? "?").slice(0, 1)}</span>
                : <div className="skeleton" style={{ width: "100%", height: "100%" }} />}
          </div>
          <div className="artist-head-text">
            {sub && <p className="artist-kicker">{sub}</p>}
            <h1 className="artist-hero-name">{artistName ?? "Artist"}</h1>
            {/* Counts only. */}
            {statBits && <p className="artist-hero-meta">{statBits}</p>}
            <div className="artist-hero-actions">
              <button className="btn primary" onClick={playAll} disabled={!tracks.length}>
                <PlayIcon size={15} /> Play
              </button>
              <button className="btn" onClick={shuffleAll} disabled={!tracks.length}>
                <ShuffleIcon size={15} /> Shuffle
              </button>
              <button
                className={`btn icon-only${starred ? " on" : ""}`}
                onClick={async () => {
                  const on = !starred; setStarred(on);
                  try { await api.starArtist(artistId, on); } catch { setStarred(!on); }
                }}
                aria-label={starred ? "Remove star" : "Star artist"}
                title={starred ? "Starred" : "Star artist"}
              >
                <StarIcon size={16} filled={starred} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="artist-body">
        {(info?.bio || info?.area || info?.genres || isAdmin) && (
          <section className="about">
            <h2>About {artistName}</h2>
            <div className="about-grid">
              <div className="about-bio">
                {info?.bio
                  ? <>
                      <p className={bioLong && !bioOpen ? "clamped" : ""}>{info.bio}</p>
                      {bioLong && (
                        <button className="link-btn" onClick={() => setBioOpen(o => !o)}>
                          {bioOpen ? "Less" : "More"}
                        </button>
                      )}
                    </>
                  : <p className="muted">No biography yet.</p>}
              </div>
              {facts.length > 0 && (
                <dl className="about-facts">
                  {facts.map(f => (
                    <Fragment key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
          </section>
        )}

        {/* Skeleton until the info fetch resolves. */}
        {!info && (
          <div className="artist-skel-info">
            <div className="skeleton skel-line" style={{ width: "55%" }} />
            <div className="skeleton skel-line" style={{ width: "38%" }} />
          </div>
        )}

        {topSongs.length > 0 && (
          <section className="shelf">
            <div className="shelf-head"><h2>Top Songs</h2></div>
            <ol className="top-songs">
              {topSongs.map((t, i) => (
                <li key={t.id}>
                  <button
                    className="top-song"
                    onClick={() => player.playNow(topSongs as Track[], i)}
                    aria-label={`Play ${t.title}`}
                  >
                    <img src={api.coverUrl(t.albumId, 96)} alt="" loading="lazy"
                      onError={e => (e.currentTarget.style.visibility = "hidden")} />
                    <span className="top-song-text">
                      <span className="top-song-title">{t.title}</span>
                      <span className="top-song-sub">{[t.album, t.year].filter(Boolean).join(" · ")}</span>
                    </span>
                    {t.plays > 0 && (
                      <span className="top-song-plays">{t.plays.toLocaleString()} {t.plays === 1 ? "play" : "plays"}</span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}

        {(() => {
          const base = disco ?? albums.map(a => ({ ...a, inLibrary: true, albumId: a.id, type: "Album" }));

          // A guest-only artist has no discography of their own, so skip the section.
          if (discoDone && base.length === 0 && appearsOn.albums.length > 0) return null;

          if (!discoDone && base.length === 0) {
            return (
              <section className="shelf">
                <div className="shelf-head"><h2>Albums</h2></div>
                <div className="shelf-rail">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={"sk" + i} className="album-card skel">
                      <div className="album-art skeleton" />
                      <div className="skeleton skel-line" style={{ width: "80%" }} />
                      <div className="skeleton skel-line" style={{ width: "50%" }} />
                    </div>
                  ))}
                </div>
              </section>
            );
          }
          if (base.length === 0) return null;

          const missing = base.filter((it: any) => !it.inLibrary).length;

          // One shelf per release type, in TYPE_ORDER.
          const types = [...new Set(base.map((it: any) => it.type))]
            .sort((a: any, b: any) => {
              const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
              return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
            });

          // The toggle goes on the first shelf that renders. The first type may have
          // nothing owned and so no shelf.
          const shown = types.filter((type: any) =>
            base.some((it: any) => it.type === type && (!ownedOnly || it.inLibrary)));

          const shelves = shown.map((type: any, shelfIdx: number) => {
            const items = base
              .filter((it: any) => it.type === type && (!ownedOnly || it.inLibrary))
              .sort((a: any, b: any) => (b.year ?? 0) - (a.year ?? 0));
            const all = base.filter((it: any) => it.type === type);
            const owned = all.filter((it: any) => it.inLibrary).length;
            return (
              <section className="shelf" key={type}>
                <div className="shelf-head">
                  <h2>{TYPE_LABELS[type] ?? type}</h2>
                  {/* Owned count out of all known releases. */}
                  {disco && all.length > owned && (
                    <span className="shelf-count">{owned} of {all.length} in library</span>
                  )}
                  {/* Applies to every shelf, so it sits on the first heading. */}
                  {shelfIdx === 0 && missing > 0 && (
                    <button
                      className={`chip shelf-toggle${ownedOnly ? " active" : ""}`}
                      onClick={() => setOwnedOnly(o => !o)}
                      aria-pressed={ownedOnly}
                    >
                      {/* No count here, the shelves carry the numbers. */}
                      {ownedOnly ? "Show all releases" : "Show only my library"}
                    </button>
                  )}
                </div>
                <div className="shelf-rail">
                  {items.map((it: any) =>
                    it.inLibrary
                      ? <AlbumCard key={"l" + it.albumId} album={{ id: it.albumId, title: it.title, year: it.year, lossless: it.lossless }} onOpen={onOpenAlbum} />
                      : <MissingCard key={"m" + it.rgid} item={it} requested={requested.has(it.rgid)} onRequest={requestAlbum} onOpen={setPreview} />
                  )}
                </div>
              </section>
            );
          });

          // Nothing owned: no shelf renders, so the toggle would be gone too.
          if (!shown.length) {
            return (
              <section className="shelf">
                <div className="shelf-head">
                  <h2>Albums</h2>
                  <span className="shelf-count">0 of {base.length} in library</span>
                </div>
                <p className="muted shelf-empty">
                  Nothing by {artistName} in your library yet.{" "}
                  <button className="link-btn" onClick={() => setOwnedOnly(false)}>
                    Show {base.length} release{base.length === 1 ? "" : "s"} you don't own
                  </button>
                </p>
              </section>
            );
          }

          return (
            <>
              {shelves}
            </>
          );
        })()}

        {/* Albums the artist is credited on but doesn't own. */}
        {appearsOn.albums.length > 0 && (
          <section className="shelf">
            <div className="shelf-head"><h2>Appears On</h2></div>
            <div className="shelf-rail">
              {appearsOn.albums.map((al: any) => {
                const on = appearsOn.tracks.filter((t: any) => t.albumId === al.id);
                return (
                  <div className="appears-item" key={al.id}>
                    <AlbumCard
                      album={{ id: al.id, title: al.title, year: al.year, lossless: al.lossless, artist: al.artist }}
                      onOpen={onOpenAlbum}
                      showArtist
                    />
                    {/* Name the tracks this artist is on. */}
                    {on.length > 0 && (
                      <p className="appears-note">
                        {on.slice(0, 2).map((t: any) => t.title).join(", ")}
                        {on.length > 2 ? ` +${on.length - 2}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {isAdmin && (
          <div className="artist-admin-foot">
              <button className="link-btn" onClick={() => setShowPicker(true)} disabled={busy}>Change photo</button>
              <button className="link-btn" onClick={refreshInfo} disabled={busy}>Refresh info</button>
              {msg && <span className="muted">{msg}</span>}
          </div>
            )}

        {showPicker && (
          <ArtistImagePicker
            artistId={artistId}
            artistName={artistName || "this artist"}
            onClose={() => setShowPicker(false)}
            onPicked={onPicked}
          />
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

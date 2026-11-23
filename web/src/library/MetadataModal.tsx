import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";

interface Candidate { mbid: string; title: string; artist: string; album: string; year?: number; trackNo?: number; discNo?: number; note?: string; }

// Clean a filename-ish title into a search term (drop extension + separators).
function cleanTitle(title: string) {
  return title.replace(/\.(flac|mp3|m4a|ogg|opus|wav)$/i, "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function MetadataModal({ track, onClose, onApplied }: {
  track: { id: number; title: string; artist?: string; album?: string };
  onClose: () => void;
  onApplied: () => void;
}) {
  const [qTitle, setQTitle] = useState(cleanTitle(track.title));
  const [qArtist, setQArtist] = useState(track.artist ?? "");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [sel, setSel] = useState<number>(-1);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState("");

  // Editable fields (what actually gets applied), prefilled from the selection.
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist ?? "");
  const [album, setAlbum] = useState(track.album ?? "");
  const [year, setYear] = useState("");
  const [trackNo, setTrackNo] = useState("");
  const [discNo, setDiscNo] = useState("");

  // Library artists/albums for autocomplete, so the track can join an existing one.
  const [libAlbums, setLibAlbums] = useState<any[]>([]);
  const [libArtists, setLibArtists] = useState<any[]>([]);
  useEffect(() => {
    api.getAlbums().then(setLibAlbums).catch(() => {});
    api.getArtists().then(setLibArtists).catch(() => {});
  }, []);
  const artistSuggestions = [...new Set(libArtists.map(a => a.name))];
  const albumSuggestions = [...new Set(
    libAlbums
      .filter(a => !artist || (a.artist ?? "").toLowerCase() === artist.toLowerCase())
      .map(a => a.title)
  )];

  async function search() {
    setLoading(true); setErr(""); setResults(null); setSel(-1);
    try {
      const r = await api.searchMetadata({ title: qTitle.trim(), artist: qArtist.trim() });
      setResults(r);
      if (r.length) choose(r, 0);
    } catch { setErr("Search failed. Try again."); }
    finally { setLoading(false); }
  }

  function choose(list: Candidate[], i: number) {
    setSel(i);
    const c = list[i];
    setTitle(c.title); setArtist(c.artist); setAlbum(c.album); setYear(c.year ? String(c.year) : "");
    setTrackNo(c.trackNo ? String(c.trackNo) : ""); setDiscNo(c.discNo ? String(c.discNo) : "");
  }

  async function apply() {
    if (!title.trim() || !artist.trim() || !album.trim()) { setErr("Title, artist and album are required."); return; }
    setApplying(true); setErr("");
    try {
      const res: any = await api.applyMetadata(track.id, {
        title: title.trim(), artist: artist.trim(), album: album.trim(),
        year: year ? Number(year) : undefined,
        trackNo: trackNo ? Number(trackNo) : undefined,
        discNo: discNo ? Number(discNo) : undefined,
      });
      if (res && res.fileUpdated === false) {
        // DB updated, but the file couldn't be written (e.g. read-only music dir).
        setErr(`Saved to library, but couldn't write tags into the file${res.fileError ? `: ${res.fileError}` : ""}.`);
      } else {
        onApplied();
      }
    } catch { setErr("Couldn't apply. Try again."); }
    finally { setApplying(false); }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Fix track metadata</h2>
          <button className="link-btn" onClick={onClose}>Close</button>
        </header>
        <p className="muted modal-current">Current: {track.title}</p>

        <div className="field-row">
          <input
            value={qTitle} onChange={e => setQTitle(e.target.value)} autoFocus
            onKeyDown={e => { if (e.key === "Enter") search(); }}
            placeholder="Song title"
          />
          <input
            value={qArtist} onChange={e => setQArtist(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") search(); }}
            placeholder="Artist"
          />
          <button className="btn" onClick={search} disabled={loading}>{loading ? "Searching…" : "Search"}</button>
        </div>

        {results && results.length === 0 && <p className="muted">No matches found.</p>}
        {results && results.length > 0 && (
          <ul className="meta-results">
            {results.map((c, i) => (
              <li key={c.mbid + i} className={i === sel ? "selected" : ""} onClick={() => choose(results, i)}>
                <span className="meta-radio">{i === sel ? "●" : "○"}</span>
                <div className="meta-info">
                  <span className="meta-title">{c.title}</span>
                  <span className="meta-sub">
                    {c.artist} · {c.album || "-"}{c.trackNo ? ` · #${c.trackNo}` : ""}{c.note ? ` [${c.note}]` : ""}{c.year ? ` (${c.year})` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Editable before applying, e.g. to set the album to one you already have. */}
        <div className="meta-edit">
          <label>Title<input value={title} onChange={e => setTitle(e.target.value)} /></label>
          <label>
            Artist
            <input value={artist} onChange={e => setArtist(e.target.value)} list="lib-artists" />
            <datalist id="lib-artists">
              {artistSuggestions.map(a => <option key={a} value={a} />)}
            </datalist>
          </label>
          <label>
            Album
            <input value={album} onChange={e => setAlbum(e.target.value)} list="lib-albums" />
            <datalist id="lib-albums">
              {albumSuggestions.map(a => <option key={a} value={a} />)}
            </datalist>
          </label>
          <label className="year-field">Track #<input value={trackNo} onChange={e => setTrackNo(e.target.value)} inputMode="numeric" /></label>
          <label className="year-field">Disc #<input value={discNo} onChange={e => setDiscNo(e.target.value)} inputMode="numeric" /></label>
          <label className="year-field">Year<input value={year} onChange={e => setYear(e.target.value)} inputMode="numeric" /></label>
        </div>

        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={apply} disabled={applying}>
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

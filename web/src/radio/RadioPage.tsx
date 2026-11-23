import { EmptyState } from "../ui/EmptyState";
import { useEffect, useState } from "react";
import { api } from "../api";
import { usePlayer } from "../player/PlayerProvider";
import { stationTrack, type Station } from "../player/radioStation";
import { PlayIcon, PauseIcon, TrashIcon, SearchIcon, RadioIcon } from "../ui/icons";

type SearchResult = { name: string; url: string; favicon?: string; homepage?: string; tags?: string; country?: string; bitrate?: number; codec?: string };

// A few known-good starter stations (SomaFM: HTTPS + open CORS).
const PRESETS: { name: string; streamUrl: string }[] = [
  { name: "SomaFM · Groove Salad", streamUrl: "https://ice1.somafm.com/groovesalad-128-mp3" },
  { name: "SomaFM · Drone Zone", streamUrl: "https://ice1.somafm.com/dronezone-128-mp3" },
  { name: "SomaFM · Deep Space One", streamUrl: "https://ice1.somafm.com/deepspaceone-128-mp3" },
  { name: "SomaFM · Lush", streamUrl: "https://ice1.somafm.com/lush-128-mp3" },
  { name: "SomaFM · Indie Pop Rocks", streamUrl: "https://ice1.somafm.com/indiepop-128-mp3" },
];

function StationLogo({ favicon, size = 40 }: { favicon?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!favicon || failed) return <span className="radio-logo radio-logo-empty" style={{ width: size, height: size }}><RadioIcon size={size * 0.5} /></span>;
  return <img className="radio-logo" src={favicon} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />;
}

export function RadioPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const p = usePlayer();

  const load = () => api.getRadioStations().then(setStations).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function addStation(s: { name: string; streamUrl: string; homepageUrl?: string; favicon?: string }) {
    setBusy(true); setErr("");
    try { await api.addRadioStation(s); load(); }
    catch { setErr("Couldn't add the station."); }
    finally { setBusy(false); }
  }
  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setErr("");
    try { setResults(await api.searchRadio(q.trim())); }
    catch { setErr("The station directory is unavailable right now."); setResults([]); }
    finally { setSearching(false); }
  }
  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const u = url.trim(), nm = name.trim();
    if (!u) return;
    setBusy(true); setErr(""); setStatus("Checking the stream…");
    try {
      const r: any = await api.resolveRadio(u);
      if (!r?.ok) { setErr(r?.error || "That doesn't look like a valid station."); setStatus(""); return; }
      await api.addRadioStation({ name: nm || r.name || u, streamUrl: r.streamUrl });
      setName(""); setUrl(""); setStatus("Added ✓"); load();
      setTimeout(() => setStatus(s => (s === "Added ✓" ? "" : s)), 1800);
    } catch { setErr("Couldn't add the station."); setStatus(""); }
    finally { setBusy(false); }
  }
  async function del(id: number) {
    if (!confirm("Remove this station?")) return;
    try { await api.deleteRadioStation(id); load(); } catch { /* */ }
  }
  const isCurrent = (s: Station) => p.current?.isRadio && p.current.radioStationId === s.id;
  const toggle = (s: Station) => (isCurrent(s) ? p.toggle() : p.playNow([stationTrack(s)], 0));
  const have = (streamUrl: string) => stations.some(s => s.streamUrl === streamUrl);

  return (
    <div className="page">

      <form className="radio-search" onSubmit={search}>
        <SearchIcon size={18} />
        <input placeholder="Search stations" value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn primary" disabled={searching || !q.trim()}>{searching ? "Searching…" : "Search"}</button>
      </form>
      {err && <p className="err radio-status">{err}</p>}

      {results != null && (
        <>
          <h2 className="radio-sub">Results {results.length ? `(${results.length})` : ""}</h2>
          <div className="radio-list">
            {results.length === 0 && !searching && <p className="muted">No stations found for “{q}”.</p>}
            {results.map((r, i) => (
              <div key={i} className="radio-item">
                <StationLogo favicon={r.favicon} />
                <div className="radio-meta">
                  <span className="radio-name">{r.name}</span>
                  <span className="radio-url">{[r.country, r.tags?.split(",")[0], r.bitrate ? `${r.bitrate}k ${r.codec}` : ""].filter(Boolean).join(" · ")}</span>
                </div>
                {have(r.url)
                  ? <span className="muted" style={{ fontSize: 13, paddingRight: 8 }}>Added ✓</span>
                  : <button className="btn" disabled={busy} onClick={() => addStation({ name: r.name, streamUrl: r.url, homepageUrl: r.homepage, favicon: r.favicon })}>Add</button>}
              </div>
            ))}
          </div>
        </>
      )}

      <button className="link-btn radio-manual-toggle" onClick={() => setShowManual(v => !v)}>
        {showManual ? "− Hide" : "+ Add a stream URL manually"}
      </button>
      {showManual && (
        <section className="radio-add-card">
          <form className="radio-add" onSubmit={submitManual}>
            <label className="radio-field"><span>Station name</span>
              <input placeholder="e.g. My favourite station" value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="radio-field radio-field-wide"><span>Stream / .pls URL</span>
              <input placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} /></label>
            <button className="btn primary radio-add-btn" disabled={busy || !url.trim()}>{busy ? "Adding…" : "Add"}</button>
          </form>
          {status && <p className="ok-msg radio-status">{status}</p>}
        </section>
      )}

      {results == null && PRESETS.some(pr => !have(pr.streamUrl)) && (
        <>
          <h2 className="radio-sub">Popular stations</h2>
          <div className="radio-presets">
            {PRESETS.filter(pr => !have(pr.streamUrl)).map(pr => (
              <button key={pr.streamUrl} className="radio-preset" onClick={() => addStation(pr)} disabled={busy}>+ {pr.name}</button>
            ))}
          </div>
        </>
      )}

      <h2 className="radio-sub">Your stations</h2>
      <div className="radio-list">
        {stations.map(s => (
          <div key={s.id} className={`radio-item${isCurrent(s) ? " current" : ""}`}>
            <button className="radio-play radio-play-logo" onClick={() => toggle(s)} aria-label={isCurrent(s) ? "Pause" : `Play ${s.name}`}>
              {isCurrent(s) ? (p.isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />) : <StationLogo favicon={s.favicon} size={38} />}
            </button>
            <div className="radio-meta">
              <span className="radio-name">{s.name}</span>
              <span className="radio-url">{isCurrent(s) && p.radioTitle ? p.radioTitle : s.streamUrl}</span>
            </div>
            <button className="trk-act" onClick={() => del(s.id)} aria-label="Remove station"><TrashIcon size={16} /></button>
          </div>
        ))}
        {!loaded && <p className="muted">Loading…</p>}
        {loaded && stations.length === 0 && <EmptyState icon={<RadioIcon size={26} />} title="No stations yet">Search above, or pick a preset.</EmptyState>}
      </div>
    </div>
  );
}

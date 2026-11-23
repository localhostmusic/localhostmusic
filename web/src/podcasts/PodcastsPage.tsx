import { EmptyState } from "../ui/EmptyState";
import { useEffect, useState } from "react";
import { api } from "../api";
import { SkeletonCards } from "../ui/Skeleton";
import { SearchIcon, PodcastIcon } from "../ui/icons";

type PodResult = { title: string; author: string; feedUrl: string; artwork?: string; genre?: string; episodes?: number };

// Subscribed podcasts plus a directory search (Apple Podcasts). Manual RSS is a fallback.
export function PodcastsPage({ onOpen }: { onOpen: (id: number) => void }) {
  const [channels, setChannels] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PodResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [subbing, setSubbing] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => api.getPodcasts().then(setChannels).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setErr("");
    try { setResults(await api.searchPodcasts(q.trim())); }
    catch { setErr("Podcast search is unavailable right now."); setResults([]); }
    finally { setSearching(false); }
  }
  async function subscribe(feedUrl: string) {
    setSubbing(feedUrl); setErr("");
    try {
      const r: any = await api.subscribePodcast(feedUrl);
      load();
      if (r?.id) onOpen(r.id);
    } catch (e: any) { setErr(e?.message || "Couldn't subscribe to that feed."); }
    finally { setSubbing(null); }
  }
  async function subscribeManual(e: React.FormEvent) {
    e.preventDefault();
    const u = url.trim(); if (!u) return;
    setBusy(true); setErr("");
    try {
      const r: any = await api.subscribePodcast(u);
      setUrl(""); load();
      if (r?.id) onOpen(r.id);
    } catch (e: any) { setErr(e?.message || "Couldn't subscribe to that feed."); }
    finally { setBusy(false); }
  }
  const norm = (u?: string) => (u || "").trim().replace(/\/+$/, "").toLowerCase();
  const subscribed = (feedUrl: string) => channels.find(c => norm(c.feedUrl) === norm(feedUrl));

  return (
    <div className="page">
      <header className="page-head"><h1>Podcasts</h1></header>

      <form className="radio-search" onSubmit={search}>
        <SearchIcon size={18} />
        <input placeholder="Search podcasts by name" value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn primary" disabled={searching || !q.trim()}>{searching ? "Searching…" : "Search"}</button>
      </form>
      {err && <p className="err radio-status">{err}</p>}

      {results != null && (
        <>
          <h2 className="radio-sub">Results {results.length ? `(${results.length})` : ""}</h2>
          <div className="radio-list">
            {results.length === 0 && !searching && <p className="muted">No podcasts found for “{q}”.</p>}
            {results.map((r, i) => (
              <div key={i} className="radio-item">
                {r.artwork ? <img className="radio-logo" src={r.artwork} alt="" width={48} height={48} loading="lazy" />
                  : <span className="radio-logo radio-logo-empty" style={{ width: 48, height: 48 }} />}
                <div className="radio-meta">
                  <span className="radio-name">{r.title}</span>
                  <span className="radio-url">{[r.author, r.genre, r.episodes ? `${r.episodes} episodes` : ""].filter(Boolean).join(" · ")}</span>
                </div>
                {(() => {
                  const sub = subscribed(r.feedUrl);
                  return sub
                    ? <button className="btn done" onClick={() => onOpen(sub.id)} title="Open (you're subscribed)">Subscribed ✓</button>
                    : <button className="btn" disabled={subbing === r.feedUrl} onClick={() => subscribe(r.feedUrl)}>{subbing === r.feedUrl ? "Subscribing…" : "Subscribe"}</button>;
                })()}
              </div>
            ))}
          </div>
        </>
      )}

      <button className="link-btn radio-manual-toggle" onClick={() => setShowManual(v => !v)}>
        {showManual ? "− Hide" : "+ Subscribe with an RSS feed URL"}
      </button>
      {showManual && (
        <section className="radio-add-card">
          <form className="radio-add" onSubmit={subscribeManual}>
            <label className="radio-field radio-field-wide"><span>Podcast RSS feed URL</span>
              <input placeholder="https://…/feed.xml" value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} /></label>
            <button className="btn primary radio-add-btn" disabled={busy || !url.trim()}>{busy ? "Subscribing…" : "Subscribe"}</button>
          </form>
        </section>
      )}

      <h2 className="radio-sub">Subscribed</h2>
      <div className="pod-grid">
        {channels.map(c => (
          <button key={c.id} className="pod-card" onClick={() => onOpen(c.id)}>
            <div className="pod-cover">
              {c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" onError={e => (e.currentTarget.style.visibility = "hidden")} /> : <span className="pod-cover-empty" />}
              {c.unplayed > 0 && <span className="pod-badge">{c.unplayed}</span>}
            </div>
            <span className="pod-title">{c.title}</span>
            {c.author && <span className="pod-author">{c.author}</span>}
          </button>
        ))}
        {!loaded && channels.length === 0 && <SkeletonCards count={8} kind="album" />}
        {loaded && channels.length === 0 && <EmptyState icon={<PodcastIcon size={26} />} title="No podcasts yet">Search for a show above and subscribe. New episodes will show up here.</EmptyState>}
      </div>
    </div>
  );
}

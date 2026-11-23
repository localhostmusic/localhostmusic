import { useEffect, useState } from "react";
import { api } from "../api";
import { usePlayer } from "../player/PlayerProvider";
import { episodeTrack } from "../player/podcastEpisode";
import { PlayIcon, PauseIcon, DownloadIcon, Spinner } from "../ui/icons";
import { SkeletonRows } from "../ui/Skeleton";

const stripHtml = (s?: string) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function fmtDur(sec?: number) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}
function fmtDate(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function PodcastChannelPage({ channelId, onBack, onOpenEpisode }: { channelId: number; onBack?: () => void; onOpenEpisode?: (id: number) => void }) {
  const [ch, setCh] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dling, setDling] = useState<number | null>(null);
  const [dlPct, setDlPct] = useState<number | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const p = usePlayer();

  async function toggleDownload(ep: any) {
    setDling(ep.id); setDlPct(null);
    if (ep.downloaded) {
      try { await api.deleteEpisodeDownload(ep.id); load(); } catch { /* */ } finally { setDling(null); }
      return;
    }
    // Video episodes can be several GB, so poll progress for the button.
    const poll = setInterval(async () => {
      try { const pr: any = await api.episodeDownloadProgress(ep.id); if (pr?.downloading) setDlPct(pr.pct); } catch { /* */ }
    }, 1500);
    try { await api.downloadEpisode(ep.id); load(); }
    catch { /* */ } finally { clearInterval(poll); setDling(null); setDlPct(null); }
  }

  const load = () => api.getPodcast(channelId).then(setCh).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { load(); }, [channelId]);

  const isCurrent = (ep: any) => p.current?.isPodcast && p.current.podcastEpisodeId === ep.id;
  const play = (ep: any) => (isCurrent(ep) ? p.toggle() : p.playNow([episodeTrack(ep, ch.title, ch.imageUrl, ch.id)], 0, (ep.position || 0) / 1000));
  async function refresh() { setBusy(true); try { await api.refreshPodcast(channelId); load(); } catch { /* */ } finally { setBusy(false); } }
  async function unsub() { if (!confirm("Unsubscribe from this podcast? Its episodes will be removed.")) return; try { await api.deletePodcast(channelId); onBack?.(); } catch { /* */ } }

  if (!loaded && !ch) return <div className="page"><SkeletonRows count={8} /></div>;
  if (!ch) return <div className="page"><p className="muted">Podcast not found.</p></div>;

  return (
    <div className="page">
      {onBack && <button className="link-btn" onClick={onBack} style={{ marginBottom: 12 }}>‹ Back</button>}
      <div className="pod-panel">
      <div className="pod-head">
        {ch.imageUrl
          ? <img className="pod-head-cover" src={ch.imageUrl} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
          : <div className="pod-head-cover pod-cover-empty" />}
        <div className="pod-head-meta">
          <h1 style={{ margin: "0 0 4px" }}>{ch.title}</h1>
          {ch.author && <p className="muted" style={{ margin: "0 0 8px" }}>{ch.author}</p>}
          {ch.description && <>
            <p className={`muted pod-desc${descOpen ? " open" : ""}`}>{stripHtml(ch.description)}</p>
            {stripHtml(ch.description).length > 180 &&
              <button className="pod-desc-toggle" onClick={() => setDescOpen(v => !v)}>
                {descOpen ? "Show less" : "Show more"}<span className="pod-desc-caret">{descOpen ? "▴" : "▾"}</span>
              </button>}
          </>}
          <div className="pod-head-actions">
            <button className="btn" onClick={refresh} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
            <button className="link-btn" onClick={unsub}>Unsubscribe</button>
          </div>
        </div>
      </div>

      <div className="pod-eps">
        {ch.episodes.map((ep: any) => {
          const cur = isCurrent(ep);
          const pct = ep.duration && ep.position > 0 ? Math.min(100, (ep.position / 1000 / ep.duration) * 100) : 0;
          const status = ep.played ? "Played" : ep.position > 0 ? `Resume · ${fmtDur(Math.max(0, ep.duration - ep.position / 1000))} left` : fmtDur(ep.duration);
          return (
            <div key={ep.id} className={`pod-ep${ep.played ? " played" : ""}${cur ? " current" : ""}`}>
              <button className="pod-ep-play" onClick={() => play(ep)} aria-label={cur && p.isPlaying ? "Pause" : `Play ${ep.title}`}>
                {cur && p.isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
              </button>
              <button className="pod-ep-meta" onClick={() => onOpenEpisode?.(ep.id)} title="Episode details">
                <span className="pod-ep-title">{ep.title}</span>
                <span className="pod-ep-sub">{[ep.isVideo ? "▸ Video" : "", fmtDate(ep.pubDate), status, ep.downloaded ? "Downloaded" : ""].filter(Boolean).join(" · ")}</span>
                {pct > 0 && !ep.played && <span className="pod-ep-bar"><span style={{ width: `${pct}%` }} /></span>}
              </button>
              <button className={`pod-ep-dl${ep.downloaded ? " done" : ""}`} onClick={() => toggleDownload(ep)}
                title={ep.downloaded ? "Downloaded. Remove from device" : ep.isVideo ? "Download for offline (video, large)" : "Download for offline"} aria-label="Download episode">
                {dling === ep.id ? (dlPct != null ? <span className="pod-ep-dlpct">{dlPct}%</span> : <Spinner size={16} />) : ep.downloaded ? "✓" : <DownloadIcon size={16} />}
              </button>
            </div>
          );
        })}
        {ch.episodes.length === 0 && <p className="muted">No episodes found in this feed.</p>}
      </div>
      </div>
    </div>
  );
}

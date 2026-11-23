import { useEffect, useState } from "react";
import { api } from "../api";
import { usePlayer } from "../player/PlayerProvider";
import { episodeTrack } from "../player/podcastEpisode";
import { PlayIcon, PauseIcon, DownloadIcon, Spinner } from "../ui/icons";
import { SkeletonRows } from "../ui/Skeleton";

// Show notes are arbitrary feed HTML. Strip the dangerous bits and tidy common
// junk (dash-line separators, empty paragraphs).
function sanitize(html?: string): string {
  return (html || "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"')
    .replace(/<p>\s*[-–—_=*.·•]{5,}\s*<\/p>/gi, "<hr>")   // separator lines become a real divider
    .replace(/<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "")        // drop empty paragraphs
    .replace(/(<hr>\s*){2,}/gi, "<hr>");                     // collapse repeated dividers
}
const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "");
function fmtDur(sec?: number) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}

export function EpisodePage({ episodeId, onBack, onOpenChannel }: {
  episodeId: number; onBack?: () => void; onOpenChannel?: (id: number) => void;
}) {
  const [ep, setEp] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [dling, setDling] = useState(false);
  const [dlPct, setDlPct] = useState<number | null>(null);
  const p = usePlayer();

  const load = () => api.getEpisode(episodeId).then(setEp).catch(() => {}).finally(() => setLoaded(true));
  useEffect(() => { load(); }, [episodeId]);

  const current = p.current?.isPodcast && p.current.podcastEpisodeId === episodeId;
  const play = () => {
    if (current) return p.toggle();
    p.playNow([episodeTrack(ep, ep.channelTitle, ep.imageUrl || ep.channelImage, ep.channelId)], 0, (ep.position || 0) / 1000);
  };
  async function toggleDownload() {
    setDling(true); setDlPct(null);
    if (ep.downloaded) {
      try { await api.deleteEpisodeDownload(episodeId); load(); } catch { /* */ } finally { setDling(false); }
      return;
    }
    const poll = setInterval(async () => {
      try { const pr: any = await api.episodeDownloadProgress(episodeId); if (pr?.downloading) setDlPct(pr.pct); } catch { /* */ }
    }, 1500);
    try { await api.downloadEpisode(episodeId); load(); }
    catch { /* */ } finally { clearInterval(poll); setDling(false); setDlPct(null); }
  }

  if (!loaded && !ep) return <div className="page"><SkeletonRows count={6} /></div>;
  if (!ep) return <div className="page"><p className="muted">Episode not found.</p></div>;

  const img = ep.imageUrl || ep.channelImage;
  const remain = ep.duration && ep.position > 0 ? Math.max(0, ep.duration - ep.position / 1000) : 0;
  const status = ep.played ? "Played" : ep.position > 0 ? `${fmtDur(remain)} left` : "";

  return (
    <div className="page ep-page">
      {onBack && <button className="back-btn" onClick={onBack}>‹ Back</button>}
      <div className="ep-head">
        {img ? <img className="ep-cover" src={img} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
          : <div className="ep-cover pod-cover-empty" />}
        <div className="ep-head-meta">
          <button className="link-btn ep-show" onClick={() => onOpenChannel?.(ep.channelId)}>{ep.channelTitle}</button>
          <h1 className="ep-title">{ep.title}</h1>
          <span className="muted">{[ep.isVideo ? "▸ Video" : "", fmtDate(ep.pubDate), fmtDur(ep.duration), status].filter(Boolean).join(" · ")}</span>
          <div className="ep-actions">
            <button className="btn primary" onClick={play}>
              {current && p.isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
              {current && p.isPlaying ? "Pause" : ep.position > 0 && !ep.played ? "Resume" : "Play"}
            </button>
            <button className={`btn${ep.downloaded ? " done" : ""}`} onClick={toggleDownload} disabled={dling}>
              {dling ? <Spinner size={15} /> : <DownloadIcon size={15} />}
              {dling ? (dlPct != null ? `Downloading ${dlPct}%` : "Downloading…") : ep.downloaded ? "Downloaded" : ep.isVideo ? "Download (large)" : "Download"}
            </button>
            {ep.hasTranscript ? <span className="muted ep-transcript-note">Transcript available in the player</span> : null}
          </div>
        </div>
      </div>
      {ep.description
        ? <div className="ep-desc" dangerouslySetInnerHTML={{ __html: sanitize(ep.description) }} />
        : <p className="muted">No description for this episode.</p>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import { usePlayer, type Track } from "../player/PlayerProvider";
import { AlbumCard } from "../library/AlbumCard";
import { ArtistAvatar } from "../library/ArtistAvatar";
import { MarqueeText } from "../ui/MarqueeText";
import { SkeletonCards, SkeletonRows } from "../ui/Skeleton";
import { PlayIcon } from "../ui/icons";

function fmtDur(d?: number) {
  if (!d) return "";
  const m = Math.floor(d / 60), s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function listenTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return h ? `${h}h ${m}m` : `${m}m`;
}

const PERIODS = [
  { v: "7day", label: "Week" }, { v: "1month", label: "Month" },
  { v: "3month", label: "3 mo" }, { v: "12month", label: "Year" }, { v: "overall", label: "All time" },
];

interface Props {
  onOpenArtist: (id: number, name: string) => void;
  onOpenAlbum: (id: number) => void;
  onOpenGenre: (genre: string) => void;
}

export function StatsPage({ onOpenArtist, onOpenAlbum, onOpenGenre }: Props) {
  const player = usePlayer();
  const [s, setS] = useState<any>(null);
  const [range, setRange] = useState("1month");
  const [scrob, setScrob] = useState<any>(null);
  useEffect(() => { api.getStats().then(setS).catch(() => {}); }, []);
  useEffect(() => { api.getScrobbleStats(range).then(setScrob).catch(() => setScrob(null)); }, [range]);

  if (!s) return (
    <div className="page">
      <header className="page-head"><h1>Your Listening</h1></header>
      <div className="stat-tiles">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="stat-tile">
            <div className="skeleton skel-line" style={{ width: "60%", height: 20, margin: "2px auto" }} />
            <div className="skeleton skel-line" style={{ width: "45%", height: 9, margin: "8px auto 0" }} />
          </div>
        ))}
      </div>
      <h3 className="section-title">Top artists</h3>
      <div className="artist-grid"><SkeletonCards count={6} kind="artist" /></div>
      <h3 className="section-title">Top songs</h3>
      <ol className="track-list"><SkeletonRows count={6} /></ol>
    </div>
  );

  const t = s.totals ?? {};
  const playList = (rows: Track[], i: number) => player.playNow(rows, i);

  const trackList = (rows: any[], showPlays?: boolean) => (
    <ol className="track-list">
      {rows.map((r: any, i: number) => (
        <li key={`${r.id}-${i}`} className={`trk${player.current?.id === r.id ? " playing" : ""}`} onDoubleClick={() => playList(rows, i)}>
          <button className="row-play" onClick={() => playList(rows, i)} aria-label={`Play ${r.title}`}>
            <span className="num">{i + 1}</span>
            <span className="row-play-icon"><PlayIcon size={14} /></span>
          </button>
          <div className="trk-main" onClick={() => playList(rows, i)}>
            <MarqueeText className="trk-title" text={r.title} />
            {r.artist && <span className="trk-artist">{r.artist}</span>}
          </div>
          {showPlays && r.plays != null && <span className="trk-album">{r.plays} play{r.plays === 1 ? "" : "s"}</span>}
          <span className="dur">{fmtDur(r.duration)}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="page">
      <header className="page-head"><h1>Your Listening</h1></header>

      <div className="stat-tiles">
        <div className="stat-tile"><span className="stat-num">{Number(t.plays).toLocaleString()}</span><span className="stat-label">Plays</span></div>
        <div className="stat-tile"><span className="stat-num">{listenTime(t.seconds || 0)}</span><span className="stat-label">Listening time</span></div>
        <div className="stat-tile"><span className="stat-num">{Number(t.tracks).toLocaleString()}</span><span className="stat-label">Songs</span></div>
        <div className="stat-tile"><span className="stat-num">{Number(t.artists).toLocaleString()}</span><span className="stat-label">Artists</span></div>
      </div>

      {scrob?.connected && <>
        <div className="listen-service-head">
          <h3 className="section-title">Over time · {scrob.provider === "lastfm" ? "Last.fm" : "ListenBrainz"}</h3>
          <div className="period-tabs">
            {PERIODS.map(p => (
              <button key={p.v} className={`period-tab${range === p.v ? " on" : ""}`} onClick={() => setRange(p.v)}>{p.label}</button>
            ))}
          </div>
        </div>
        {scrob.total != null && <p className="muted listen-total">{Number(scrob.total).toLocaleString()} scrobbles all-time</p>}
        <div className="listen-cols">
          <div className="listen-col">
            <h4 className="listen-col-h">Top artists</h4>
            <ol className="rank-list">
              {(scrob.topArtists ?? []).map((a: any, i: number) => (
                <li key={i}><span className="rank">{i + 1}</span><span className="rank-name">{a.name}</span><span className="rank-plays">{a.plays}</span></li>
              ))}
            </ol>
          </div>
          <div className="listen-col">
            <h4 className="listen-col-h">Top songs</h4>
            <ol className="rank-list">
              {(scrob.topTracks ?? []).map((tr: any, i: number) => (
                <li key={i}><span className="rank">{i + 1}</span><span className="rank-name">{tr.name}{tr.artist ? <span className="rank-sub"> · {tr.artist}</span> : null}</span><span className="rank-plays">{tr.plays}</span></li>
              ))}
            </ol>
          </div>
        </div>
      </>}

      {s.topGenres?.length > 0 && <>
        <h3 className="section-title">Top genres</h3>
        <div className="genre-chips">
          {s.topGenres.map((g: any) => (
            <button key={g.genre} className="genre-chip" onClick={() => onOpenGenre(g.genre)}>
              {g.genre}<span className="genre-chip-plays">{g.plays}</span>
            </button>
          ))}
        </div>
      </>}

      {s.topArtists?.length > 0 && <>
        <h3 className="section-title">Top artists</h3>
        <div className="artist-grid">
          {s.topArtists.map((a: any) => (
            <button key={a.id} className="artist-card" onClick={() => onOpenArtist(a.id, a.name)}>
              <ArtistAvatar id={a.id} name={a.name} />
              <MarqueeText className="artist-name" text={a.name} />
              <div className="album-year">{a.plays} play{a.plays === 1 ? "" : "s"}</div>
            </button>
          ))}
        </div>
      </>}

      {s.topAlbums?.length > 0 && <>
        <h3 className="section-title">Top albums</h3>
        <div className="album-grid">
          {s.topAlbums.map((al: any) => <AlbumCard key={al.id} album={al} onOpen={onOpenAlbum} showArtist />)}
        </div>
      </>}

      {s.topTracks?.length > 0 && <>
        <h3 className="section-title">Top songs</h3>
        {trackList(s.topTracks, true)}
      </>}

      {s.recent?.length > 0 && <>
        <h3 className="section-title">Recently played</h3>
        {trackList(s.recent)}
      </>}
    </div>
  );
}

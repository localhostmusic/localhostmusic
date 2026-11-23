import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { usePlayer, usePlayerTime, type Track } from "../player/PlayerProvider";
import { stripChapterNum, type Chapter } from "../player/audiobook";
import { PlayIcon, PauseIcon } from "../ui/icons";
import { SkeletonRows } from "../ui/Skeleton";

// "1h 03m" for long spans, "3:07" for short ones.
function dur(sec?: number | null) {
  if (!sec || sec < 0) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}:${s.toString().padStart(2, "0")}`;
}

// Audiobook view: header, a resume play control and a chapter list. Single-file .m4b
// books use ffprobe chapters (seeking within the one file), multi-file books use
// their tracks as chapters.
export function AudiobookPage({ albumId, onBack, onOpenArtist, isAdmin }: {
  albumId: number; onBack?: () => void; onOpenArtist?: (id: number, name: string) => void; isAdmin?: boolean;
}) {
  const [book, setBook] = useState<{ id: number; title: string; artist?: string; artist_id?: number; tracks: Track[] } | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [bookmarks, setBookmarks] = useState<Record<number, number>>({}); // ms by trackId
  const [loaded, setLoaded] = useState(false);
  const player = usePlayer();
  const { currentTime } = usePlayerTime();

  useEffect(() => {
    setChapters([]); setLoaded(false);
    api.getAlbum(albumId).then((a: any) => {
      setBook(a);
      if (a?.tracks?.length === 1) api.getChapters(a.tracks[0].id).then(setChapters).catch(() => {});
    }).catch(() => {}).finally(() => setLoaded(true));
  }, [albumId]);
  useEffect(() => {
    api.getBookmarks().then((bs: any[]) =>
      setBookmarks(Object.fromEntries(bs.map(b => [b.trackId, b.position])))).catch(() => {});
  }, [albumId]);

  const tracks = book?.tracks ?? [];
  const single = tracks.length === 1;
  // Tag tracks as audiobook so the player UI adapts, and add album/albumId/artist
  // (getAlbum's tracks omit them). Same shape AlbumPage plays.
  const playTracks = useMemo(() => tracks.map(t => ({
    ...t, isAudiobook: true, albumId: book?.id, album: book?.title, artist: t.artist ?? book?.artist,
  })), [tracks, book]);
  const bookTrackIds = useMemo(() => new Set(tracks.map(t => t.id)), [tracks]);
  const activeInBook = player.current && bookTrackIds.has(player.current.id);

  // Total duration and resume position, in seconds. A single-file book resumes from
  // the bookmark on its one track, or from the live playhead once it is the active track.
  const totalSec = tracks.reduce((n, t) => n + (t.duration ?? 0), 0);
  const bookmarkSec = single ? (bookmarks[tracks[0]?.id] ?? 0) / 1000 : 0;
  const posSec = activeInBook ? currentTime : bookmarkSec;
  const started = posSec > 1;

  // Chapters to render: ffprobe chapters for a single file, else the track list.
  const rows: Chapter[] = single && chapters.length
    ? chapters
    : tracks.map((t, i) => ({ idx: i, title: t.title, startMs: 0, endMs: (t.duration ?? 0) * 1000 }));
  const usingFileChapters = single && chapters.length > 0;

  const currentRow = usingFileChapters
    ? rows.reduce((best, c) => (posSec * 1000 >= c.startMs ? c.idx : best), -1)
    : (activeInBook ? tracks.findIndex(t => t.id === player.current!.id) : -1);

  function playChapter(c: Chapter) {
    if (usingFileChapters) player.playNow([playTracks[0]], 0, c.startMs / 1000);
    else player.playNow(playTracks, c.idx);
  }
  function resumeOrStart() {
    if (activeInBook) return player.toggle(); // already this book: play/pause
    if (usingFileChapters) player.playNow([playTracks[0]], 0, started ? bookmarkSec : 0);
    else {
      // multi-file: resume the furthest bookmarked chapter, else start at 0.
      let idx = 0, bestMs = -1;
      tracks.forEach((t, i) => { const ms = bookmarks[t.id]; if (ms != null && ms > bestMs) { bestMs = ms; idx = i; } });
      player.playNow(playTracks, idx, bestMs > 0 ? bestMs / 1000 : 0);
    }
  }

  if (!loaded && !book) return <div className="page"><SkeletonRows count={8} /></div>;
  if (!book) return <div className="page"><p className="muted">Audiobook not found.</p></div>;

  const playing = activeInBook && player.isPlaying;
  const remainSec = Math.max(0, totalSec - posSec);
  const pct = totalSec ? Math.min(100, (posSec / totalSec) * 100) : 0;

  return (
    <div className="page">
      {onBack && <button className="link-btn" onClick={onBack} style={{ marginBottom: 12 }}>‹ Back</button>}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
        <img src={api.coverUrl(book.id, 300)} alt="" width={200} height={200}
          style={{ borderRadius: 12, objectFit: "cover", boxShadow: "0 8px 30px rgba(0,0,0,.35)" }} />
        <div style={{ minWidth: 240, flex: 1 }}>
          <div className="muted" style={{ letterSpacing: ".08em", fontSize: 12 }}>AUDIOBOOK</div>
          <h1 style={{ margin: "4px 0 6px" }}>{book.title}</h1>
          {book.artist && (
            <p style={{ margin: 0, fontSize: 16 }}>
              {book.artist_id && onOpenArtist
                ? <button className="link-btn" onClick={() => onOpenArtist(book.artist_id!, book.artist!)}>{book.artist}</button>
                : book.artist}
            </p>
          )}
          <p className="muted" style={{ margin: "6px 0 14px" }}>
            {rows.length} chapter{rows.length === 1 ? "" : "s"} · {dur(totalSec)}
            {started && ` · ${dur(remainSec)} left`}
          </p>
          {started && (
            <div style={{ height: 4, background: "rgba(128,128,128,.25)", borderRadius: 2, maxWidth: 360, marginBottom: 14 }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", borderRadius: 2 }} />
            </div>
          )}
          <button className="btn primary" onClick={resumeOrStart} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            {playing ? "Pause" : started ? `Resume · ${dur(posSec)}` : "Play"}
          </button>
          {isAdmin && (
            <button className="link-btn" style={{ marginLeft: 14 }} onClick={async () => {
              if (!confirm("Move this out of Audiobooks and back into your music library?")) return;
              try { await api.setAlbumAudiobook(albumId, false); onBack?.(); } catch { alert("Couldn't update."); }
            }}>Not an audiobook</button>
          )}
        </div>
      </div>

      <h2 style={{ marginTop: 26, marginBottom: 8 }}>Chapters</h2>
      <div className="chapter-list">
        {rows.map(c => {
          const isCur = c.idx === currentRow;
          return (
            <button key={c.idx} className={`chapter-row${isCur ? " active" : ""}`} onClick={() => playChapter(c)}>
              <span className="chapter-num">{isCur && playing ? <PauseIcon size={14} /> : (isCur ? <PlayIcon size={14} /> : c.idx + 1)}</span>
              <span className="chapter-title">{usingFileChapters ? stripChapterNum(c.title) : c.title}</span>
              {usingFileChapters && <span className="chapter-time muted">{dur(c.startMs / 1000)}</span>}
              {!usingFileChapters && <span className="chapter-time muted">{dur(tracks[c.idx]?.duration)}</span>}
            </button>
          );
        })}
        {!loaded && rows.length === 0 && <SkeletonRows count={6} />}
      </div>
    </div>
  );
}

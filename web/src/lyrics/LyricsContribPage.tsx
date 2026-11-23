import { useEffect, useState } from "react";
import { api } from "../api";

type Row = { trackId: number; title: string; albumId: number | null; artist: string | null; album: string | null; synced: boolean; published: boolean };

// The contribution queue: lyrics you created by hand, split into those shared to
// LRCLIB and those only on this server. Publishing solves a proof-of-work
// server-side (a few seconds each), so "Publish all" goes one at a time.
export function LyricsContribPage({ onOpenAlbum }: { onOpenAlbum: (id: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [errs, setErrs] = useState<Record<number, string>>({});
  const [allRunning, setAllRunning] = useState(false);

  useEffect(() => { api.myLyrics().then(setRows).catch(() => setRows([])); }, []);

  async function publishOne(trackId: number): Promise<boolean> {
    setBusy(s => new Set(s).add(trackId));
    setErrs(e => { const n = { ...e }; delete n[trackId]; return n; });
    try {
      await api.publishLyrics(trackId);
      setRows(rs => rs?.map(r => r.trackId === trackId ? { ...r, published: true } : r) ?? rs);
      return true;
    } catch (e: any) {
      setErrs(er => ({ ...er, [trackId]: e?.message || "Publishing failed." }));
      return false;
    } finally {
      setBusy(s => { const n = new Set(s); n.delete(trackId); return n; });
    }
  }

  async function publishAll() {
    if (!rows) return;
    setAllRunning(true);
    for (const r of rows.filter(r => !r.published)) await publishOne(r.trackId);
    setAllRunning(false);
  }

  if (!rows) return <div className="page"><p className="muted" style={{ padding: 16 }}>Loading…</p></div>;

  const unpublished = rows.filter(r => !r.published);
  const published = rows.filter(r => r.published);

  const rowEl = (r: Row) => (
    <li key={r.trackId} className="lyrq-row">
      <button className="lyrq-meta" onClick={() => r.albumId && onOpenAlbum(r.albumId)} title={r.album ? `Open ${r.album}` : undefined}>
        <span className="lyrq-title">{r.title}</span>
        <span className="lyrq-sub">{[r.artist, r.album].filter(Boolean).join(" · ") || "Unknown"}</span>
      </button>
      <span className={"lyrq-chip" + (r.synced ? " synced" : "")}>{r.synced ? "Synced" : "Plain"}</span>
      {r.published ? (
        <span className="lyrq-done">✓ Shared</span>
      ) : (
        <button className="btn primary lyrq-pub" onClick={() => publishOne(r.trackId)} disabled={busy.has(r.trackId) || allRunning}>
          {busy.has(r.trackId) ? "Publishing…" : "Publish"}
        </button>
      )}
      {errs[r.trackId] && <span className="lyrq-err">{errs[r.trackId]}</span>}
    </li>
  );

  return (
    <div className="page lyrq-page">
      {rows.length === 0 ? (
        <p className="muted lyrq-empty">You haven't created any lyrics yet. Open a song's lyrics and use <strong>Sync</strong> or <strong>Add lyrics</strong>. They'll show up here, ready to share with LRCLIB.</p>
      ) : (
        <>
          <section className="lyrq-section">
            <div className="lyrq-head">
              <h2>Only on this server <span className="lyrq-count">{unpublished.length}</span></h2>
              {unpublished.length > 0 && (
                <button className="btn" onClick={publishAll} disabled={allRunning || busy.size > 0}>
                  {allRunning ? "Publishing all…" : "Publish all to LRCLIB"}
                </button>
              )}
            </div>
            {unpublished.length === 0
              ? <p className="muted">All your lyrics are shared.</p>
              : <>
                  <p className="muted lyrq-blurb">These lyrics you made haven't been contributed yet. Publishing them to LRCLIB means the next listener (in Localhost Music or any other app) finds them automatically.</p>
                  <ul className="lyrq-list">{unpublished.map(rowEl)}</ul>
                </>}
          </section>

          {published.length > 0 && (
            <section className="lyrq-section">
              <div className="lyrq-head"><h2>Shared to LRCLIB <span className="lyrq-count">{published.length}</span></h2></div>
              <ul className="lyrq-list">{published.map(rowEl)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

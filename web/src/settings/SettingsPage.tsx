import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { AppUpdateSettings, inDesktopApp } from "../ui/desktopUpdate";
import { KIND_LABELS } from "../reports/RequestsPage";

function parseAlbumDetail(detail?: string): { year?: number | null; rgid?: string | null } {
  if (!detail) return {};
  try { return JSON.parse(detail); } catch { return {}; }
}

// Album requests, grouped by album (multiple users asking for the same one are
// merged), with cover art and one-click "Mark acquired".
function AlbumRequests({ reports, onChange }: { reports: any[]; onChange: () => void }) {
  const albums = reports.filter(r => r.kind === "add_album");
  if (albums.length === 0) return null;

  // Group by subject: { ids, requesters, rgid, year, anyOpen }.
  const groups = new Map<string, any>();
  for (const r of albums) {
    const g = groups.get(r.subject) ?? { subject: r.subject, ids: [], requesters: new Set<string>(), ...parseAlbumDetail(r.detail), anyOpen: false };
    g.ids.push(r.id);
    if (r.username) g.requesters.add(r.username);
    if (r.status === "open") g.anyOpen = true;
    const d = parseAlbumDetail(r.detail);
    if (d.rgid && !g.rgid) g.rgid = d.rgid;
    if (d.year && !g.year) g.year = d.year;
    groups.set(r.subject, g);
  }
  const rows = [...groups.values()].sort((a, b) => Number(b.anyOpen) - Number(a.anyOpen));

  async function setAll(ids: number[], status: string) { for (const id of ids) await api.setReportStatus(id, status); onChange(); }
  async function delAll(ids: number[]) { for (const id of ids) await api.deleteReport(id); onChange(); }

  const openCount = rows.filter(r => r.anyOpen).length;
  return (
    <section className="card">
      <h2>Album requests {openCount > 0 && <span className="badge">{openCount} to get</span>}</h2>
      <p className="muted">Albums people want added. Mark acquired once you've added them and rescanned.</p>
      <div className="albumreq-list">
        {rows.map(g => (
          <div key={g.subject} className={`albumreq${g.anyOpen ? "" : " done"}`}>
            <div className="albumreq-art">
              {g.rgid
                ? <img src={api.discoCoverUrl(g.rgid)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />
                : <div className="disco-noart">♪</div>}
            </div>
            <div className="albumreq-body">
              <div className="albumreq-title">{g.subject}</div>
              <div className="albumreq-meta">
                {g.year ? `${g.year} · ` : ""}{g.requesters.size} request{g.requesters.size === 1 ? "" : "s"}
                {g.requesters.size > 0 && ` · ${[...g.requesters].join(", ")}`}
              </div>
            </div>
            <div className="albumreq-actions">
              <a className="link-btn" href={`https://duckduckgo.com/?q=${encodeURIComponent(g.subject + " album")}`} target="_blank" rel="noreferrer">Find ↗</a>
              {g.anyOpen
                ? <>
                    <button className="btn sm" onClick={() => setAll(g.ids, "resolved")}>Mark acquired</button>
                    <button className="link-btn" onClick={() => setAll(g.ids, "dismissed")} title="Notify the requester it can't be added">Can’t add</button>
                  </>
                : <button className="link-btn" onClick={() => setAll(g.ids, "open")}>Reopen</button>}
              <button className="albumreq-del" onClick={() => delAll(g.ids)} title="Delete silently (no notification)" aria-label="Delete request">✕</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function fmtBytes(n?: number) {
  if (!n) return "";
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

const TIERS = [320, 256, 128] as const;
const TIER_HINTS: Record<number, string> = {
  320: "Best quality, largest files",
  256: "High quality, balanced size",
  128: "Smaller files, builds fastest",
};

// Paths + pre-transcoded tiers. Each tier toggle keeps a ready-to-serve MP3 of
// the whole library at that bitrate, so first plays never wait on ffmpeg.
// Present only inside the desktop app, where a native folder picker exists.
const pickFolder = (window as any).lhmDesktop?.pickFolder as (() => Promise<string | null>) | undefined;

function StorageSettings() {
  const [s, setS] = useState<any>(null);
  const [musicDir, setMusicDir] = useState("");
  const [audiobookDir, setAudiobookDir] = useState("");
  const [transcodeDir, setTranscodeDir] = useState("");
  const [streamMbps, setStreamMbps] = useState("");
  const [diag, setDiag] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pathMsg, setPathMsg] = useState("");
  const [pathErr, setPathErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const inited = useRef(false);

  const load = () => api.getAdminSettings().then((d: any) => {
    setS(d);
    // Seed the editable fields once. After that a background poll must not overwrite
    // what the user typed, including a field they cleared.
    if (!inited.current) {
      inited.current = true;
      setMusicDir(d.musicDir ?? "");
      setAudiobookDir(d.audiobookDir ?? "");
      setTranscodeDir(d.transcodeDir ?? "");
      // Shown in Mbps (nicer than kbps); 0/empty = unlimited.
      setStreamMbps(d.streamKbps ? String(d.streamKbps / 1000) : "");
    }
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  // Live progress while the pre-warm job runs.
  const running = !!s?.prewarm?.running || !!s?.scanning;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [running]);

  async function savePaths(over: { musicDir?: string; audiobookDir?: string; background?: boolean } = {}) {
    setBusy(true); setPathMsg(""); setPathErr("");
    try {
      const r = await api.saveAdminSettings({ musicDir: musicDir.trim(), audiobookDir: audiobookDir.trim(), transcodeDir: transcodeDir.trim(), ...over });
      // Reflect the server's saved values back into the fields so "unsaved" clears.
      if (r.settings) { setMusicDir(r.settings.musicDir ?? ""); setAudiobookDir(r.settings.audiobookDir ?? ""); setTranscodeDir(r.settings.transcodeDir ?? ""); }
      if (r.settings) setS((prev: any) => prev && { ...prev, ...r.settings, scanning: !!r.scanning });
      setPathMsg(r.scanning ? "Scan finished." : r.rescan ? `Saved ✓ Rescanned: +${r.rescan.added} tracks, +${r.rescan.books ?? 0} audiobooks.` : "Saved ✓");
      load();
    } catch (e: any) { setPathErr(e?.message ?? "Could not save. Check the path exists on the server."); }
    finally { setBusy(false); }
  }

  // "Open" launches a file manager on the Localhost Music host, so it is no use from a
  // remote browser. "Copy" always works.
  async function openFolder(which: "music" | "audiobooks") {
    setMsg(""); setErr("");
    try { await api.openFolder(which); setMsg("Opened on the Localhost Music host."); }
    catch (e: any) { setErr(e?.message ?? "Could not open the folder on the host."); }
  }
  async function copyPath(path: string, which: string) {
    try { await navigator.clipboard.writeText(path); setCopied(which); setTimeout(() => setCopied(""), 1500); }
    catch { /* clipboard blocked */ }
  }

  async function saveRate() {
    setBusy(true); setMsg(""); setErr("");
    try {
      const mbps = parseFloat(streamMbps);
      const kbps = streamMbps.trim() === "" || !Number.isFinite(mbps) ? 0 : Math.max(0, Math.round(mbps * 1000));
      await api.saveAdminSettings({ streamKbps: kbps });
      setMsg(kbps ? `Streams capped at ${mbps} Mbps each.` : "Stream rate is now unlimited.");
      load();
    } catch (e: any) { setErr(e?.message ?? "Could not save."); }
    finally { setBusy(false); }
  }

  // Ask the service worker whether it is caching audio on this device. A
  // MessageChannel gets the reply back regardless of which client is controlled.
  async function runDiag() {
    setDiag("Checking…");
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) { setDiag("✗ Service worker is NOT controlling this page, so nothing can cache. Fully close and reopen the app, then retry."); return; }
    try {
      const res: any = await new Promise((resolve, reject) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = e => resolve(e.data);
        ctrl.postMessage("cacheDiag", [ch.port2]);
        setTimeout(() => reject(new Error("timeout (SW didn't reply)")), 8000);
      });
      const mb = (n: number) => (n / 1048576).toFixed(0);
      setDiag(
        `✓ SW v${res.swVersion} controlling · cached tracks: ${res.audioCount} · ` +
        `test put(4MB): ${res.putOk ? "OK ✓" : "FAILED ✗"} · ` +
        `storage: ${mb(res.usage)} / ${mb(res.quota)} MB · inflight: ${res.inflight}` +
        (res.err ? ` · err: ${res.err}` : "")
      );
    } catch (e: any) { setDiag("Diagnostic failed: " + (e?.message ?? e)); }
  }

  async function toggleTier(b: number) {
    setErr("");
    try { await api.saveAdminSettings({ [`keep${b}`]: !s?.[`keep${b}`] }); load(); }
    catch (e: any) { setErr(e?.message ?? "Could not save."); }
  }

  async function clearTier(b: number) {
    setErr("");
    try { const r = await api.clearTranscodes(b); setMsg(`Cleared ${r.removed} ${b} kbps files.`); load(); }
    catch (e: any) { setErr(e?.message ?? "Could not clear."); }
  }

  if (!s) return null;
  const pathsDirty = musicDir.trim() !== (s.musicDir ?? "")
    || audiobookDir.trim() !== (s.audiobookDir ?? "")
    || transcodeDir.trim() !== (s.transcodeDir ?? "");
  const foldersDirty = musicDir.trim() !== (s.musicDir ?? "") || audiobookDir.trim() !== (s.audiobookDir ?? "");
  return (
    <section className="card">
      <h2>Storage &amp; transcoding</h2>
      <p className="muted">
        Where things live on disk. The transcode cache holds ready-to-serve MP3 versions.
        Keep it <em>next to</em> your library, never inside it.
      </p>

      <label className="field-label">Music library path</label>
      <div className="field-row">
        <input value={musicDir} onChange={e => setMusicDir(e.target.value)} placeholder={s.defaults?.musicDir} spellCheck={false} />
        {pickFolder && <button className="btn" disabled={busy} onClick={async () => { const dir = await pickFolder(); if (dir) setMusicDir(dir); }}>Browse…</button>}
        <button className="btn" onClick={() => openFolder("music")} disabled={!s.musicDir} title="Open in the file manager on the machine running Localhost Music">Open</button>
        <button className="btn" onClick={() => copyPath(musicDir || s.musicDir, "music")}>{copied === "music" ? "Copied" : "Copy"}</button>
      </div>
      <label className="field-label">Audiobooks path (optional)</label>
      <div className="field-row">
        <input value={audiobookDir} onChange={e => setAudiobookDir(e.target.value)} placeholder="e.g. /media/audiobooks" spellCheck={false} />
        {pickFolder && <button className="btn" disabled={busy} onClick={async () => { const dir = await pickFolder(); if (dir) setAudiobookDir(dir); }}>Browse…</button>}
        <button className="btn" onClick={() => openFolder("audiobooks")} disabled={!audiobookDir.trim()} title="Open in the file manager on the machine running Localhost Music">Open</button>
        <button className="btn" onClick={() => copyPath(audiobookDir, "audiobooks")} disabled={!audiobookDir.trim()}>{copied === "audiobooks" ? "Copied" : "Copy"}</button>
      </div>
      <p className="field-note">A separate root: everything under it is treated as an audiobook. Leave blank to keep books in the music library.</p>
      <label className="field-label">Transcode cache path</label>
      <div className="field-row">
        <input value={transcodeDir} onChange={e => setTranscodeDir(e.target.value)} placeholder={s.defaults?.transcodeDir} spellCheck={false} />
        <button className="btn primary" onClick={() => savePaths(foldersDirty ? { background: true } : {})} disabled={busy || !pathsDirty}>
          {busy ? "Saving…" : pathsDirty ? "Save paths" : "Saved ✓"}
        </button>
      </div>
      {foldersDirty && !busy && (
        <div className="folder-change" role="status">
          <div>
            <strong>Folder change detected.</strong>
            <span>Scan {musicDir.trim() !== (s.musicDir ?? "") ? musicDir.trim() : audiobookDir.trim() || "the library"} now?</span>
          </div>
          <button className="btn primary" onClick={() => savePaths({ background: true })}>Scan now</button>
          <button className="btn" onClick={() => { setMusicDir(s.musicDir ?? ""); setAudiobookDir(s.audiobookDir ?? ""); }}>Keep current</button>
        </div>
      )}
      {pathsDirty && !foldersDirty && !busy && <p className="muted" style={{ color: "var(--accent)" }}>Unsaved path changes. Click “Save paths” to apply.</p>}
      {s.scanning && <p className="ok-msg">Scanning your library… {s.trackCount} tracks so far.</p>}
      {pathMsg && !s.scanning && <p className="ok-msg">{pathMsg}</p>}
      {pathErr && <p className="err">{pathErr}</p>}
      <p className="muted">Type a folder path that exists on the server, then <strong>Save paths</strong> (it rescans automatically). <strong>Open</strong> launches the file manager on the machine hosting Localhost Music. It won’t do anything from a phone or remote browser, so use <strong>Copy</strong> there. The database itself stays in DATA_DIR (service config).</p>

      <h3 className="health-sub">Pre-transcoded versions</h3>
      <p className="muted">
        Keep an MP3 of all {s.trackCount} tracks ready at a bitrate so playback at that quality
        never buffers on first listen. Built in the background; new music is added after each scan.
      </p>
      <ul className="tier-list">
        {TIERS.map(b => {
          const c = s.cache?.[b] ?? { count: 0, bytes: 0 };
          const kept = !!s[`keep${b}`];
          const total = s.trackCount || 0;
          const buildingThis = running && s.prewarm.bitrate === b;
          const complete = total > 0 && c.count >= total;

          let kind = "empty";
          let text = "Not built";
          if (buildingThis) { kind = "building"; text = `Building… ${c.count}/${total}`; }
          else if (complete) { kind = "ready"; text = `${c.count} files · ${fmtBytes(c.bytes)}`; }
          else if (c.count > 0) { kind = "partial"; text = `${c.count}/${total} files · ${fmtBytes(c.bytes)}`; }
          else if (kept) { kind = "partial"; text = "Queued to build"; }

          return (
            <li key={b} className="tier-row">
              <div className="tier-row-main">
                <button
                  type="button" role="switch" aria-checked={kept} aria-label={`Keep ${b} kbps ready`}
                  className={`tier-switch${kept ? " on" : ""}`} onClick={() => toggleTier(b)}
                >
                  <span className="tier-switch-knob" />
                </button>
                <span className="tier-text">
                  <span className="tier-label">{b} kbps</span>
                  <span className="tier-hint">{TIER_HINTS[b]}</span>
                </span>
                <span className={`tier-status ${kind}`}><span className="tier-dot" />{text}</span>
                {c.count > 0 && !buildingThis && <button className="link-btn danger" onClick={() => clearTier(b)}>Clear</button>}
              </div>
              {buildingThis && total > 0 && (
                <div className="tier-row-bar">
                  <div className="tier-row-bar-fill" style={{ width: `${Math.min(100, Math.round((c.count / total) * 100))}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <h3 className="health-sub">Streaming rate limit</h3>
      <p className="muted">
        Cap how fast each stream is sent, so remote playback can't burst to a device's
        full download speed and hog your home upload. A track still starts instantly
        (the first ~1&nbsp;MB is sent at full speed); only the tail is paced. Leave blank
        for unlimited. ~1&nbsp;Mbps is plenty for one 320&nbsp;kbps stream; 5-10&nbsp;Mbps
        keeps prefetch and skips snappy while still clipping the spikes.
      </p>
      <div className="field-row">
        <input
          type="number" min="0" step="0.5" inputMode="decimal"
          value={streamMbps} onChange={e => setStreamMbps(e.target.value)}
          placeholder="unlimited" style={{ maxWidth: "10rem" }}
        />
        <span className="tier-hint" style={{ alignSelf: "center" }}>Mbps per stream</span>
        <button className="btn" onClick={saveRate} disabled={busy}>{busy ? "Saving…" : "Save limit"}</button>
      </div>

      <h3 className="health-sub">Audio cache health</h3>
      <p className="muted">
        Skips are only instant when tracks cache on-device. Tap to check whether this
        device's service worker is actually storing audio (iOS is finicky about it).
      </p>
      <div className="field-row">
        <button className="btn" onClick={runDiag}>Diagnose audio cache</button>
      </div>
      {diag && <p className="muted" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{diag}</p>}

      {running && s.prewarm.errors > 0 && (
        <p className="err">{s.prewarm.errors} file{s.prewarm.errors === 1 ? "" : "s"} failed to transcode this run.</p>
      )}
      {msg && !running && <p className="ok-msg">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </section>
  );
}

// Library health: duplicate tracks (deletable) and incomplete albums.
function LibraryHealth() {
  const [dupes, setDupes] = useState<any[]>([]);
  const [incomplete, setIncomplete] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = () => Promise.all([
    api.getDuplicates().then((d: any) => setDupes(d.groups ?? [])).catch(() => {}),
    api.getIncompleteAlbums().then((d: any) => setIncomplete(d.albums ?? [])).catch(() => {}),
  ]).finally(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  async function del(id: number) { await api.deleteTrack(id); load(); }

  return (
    <section className="card">
      <h2>Library health</h2>
      <p className="muted">Possible duplicates and albums that look like they're missing tracks.</p>
      {!loaded && <p className="muted">Checking…</p>}

      {dupes.length > 0 && (
        <>
          <h3 className="health-sub">Duplicate tracks ({dupes.length})</h3>
          <ul className="report-list admin">
            {dupes.map((g, i) => (
              <li key={i} className="dupe-group">
                <div className="report-main">
                  <span className="report-subject">{g.title} · {g.artist}</span>
                  {g.tracks.map((t: any) => (
                    <div key={t.id} className="dupe-row">
                      <span className="report-detail">{t.album || "-"} · {fmtBytes(t.size)}</span>
                      <button className="link-btn danger" onClick={() => del(t.id)}>Delete</button>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {incomplete.length > 0 && (
        <>
          <h3 className="health-sub">Incomplete albums ({incomplete.length})</h3>
          <ul className="report-list admin">
            {incomplete.map(al => (
              <li key={al.id}>
                <div className="report-main">
                  <span className="report-subject">{al.title} · {al.artist}</span>
                  <span className="report-detail">have {al.owned} · missing ~{al.missing}</span>
                </div>
                <div className="report-ctl">
                  <a className="link-btn" href={`https://duckduckgo.com/?q=${encodeURIComponent(`${al.title} ${al.artist} album`)}`} target="_blank" rel="noreferrer">Find ↗</a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {loaded && dupes.length === 0 && incomplete.length === 0 && <p className="muted">No issues found.</p>}
    </section>
  );
}

function ReportsAdmin() {
  const [reports, setReports] = useState<any[]>([]);
  const load = () => api.getReports().then(setReports).catch(() => {});
  useEffect(() => { load(); }, []);

  async function setStatus(id: number, status: string) { await api.setReportStatus(id, status); load(); }
  async function remove(id: number) { await api.deleteReport(id); load(); }

  // Album requests get their own richer section; everything else lists here.
  const other = reports.filter(r => r.kind !== "add_album");
  const open = other.filter(r => r.status === "open").length;
  return (
    <>
      <AlbumRequests reports={reports} onChange={load} />
      <section className="card">
        <h2>Requests &amp; Reports {open > 0 && <span className="badge">{open} open</span>}</h2>
        <p className="muted">What users have flagged as missing/wrong.</p>
        {other.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="report-list admin">
          {other.map(r => (
            <li key={r.id}>
              <div className="report-main">
                <span className="report-kind">{KIND_LABELS[r.kind] ?? r.kind}</span>
                <span className="report-subject">{r.subject}</span>
                {r.detail && <span className="report-detail">{r.detail}</span>}
                <span className="report-meta">from {r.username ?? "unknown"}</span>
              </div>
              <div className="report-ctl">
                <span className={`status-badge ${r.status}`}>{r.status}</span>
                {r.status !== "resolved" && <button className="link-btn" onClick={() => setStatus(r.id, "resolved")}>Resolve</button>}
                {r.status !== "dismissed" && <button className="link-btn" onClick={() => setStatus(r.id, "dismissed")}>Dismiss</button>}
                {r.status !== "open" && <button className="link-btn" onClick={() => setStatus(r.id, "open")}>Reopen</button>}
                <button className="link-btn danger" onClick={() => remove(r.id)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

// Toggles for the external enrichment features (discography extras, Discover,
// web-fetched artist info and photos).
function EnrichmentSettings() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const load = () => api.getAdminSettings().then(setS).catch(() => {});
  useEffect(() => { load(); }, []);

  async function save(patch: Record<string, unknown>) {
    setS((p: any) => ({ ...p, ...patch })); // optimistic
    setBusy(true);
    try { await api.saveAdminSettings(patch); } catch { load(); }
    finally { setBusy(false); }
  }
  const toggle = (key: string, val: boolean) => save({ [key]: val });

  const rows = [
    { key: "showMissingAlbums", label: "Show albums you don't own", hint: "List missing albums in an artist's full discography (to request). Off shows only what's in your library." },
    { key: "onlineDiscovery", label: "Online discovery & recommendations", hint: "The Discover feed: similar artists, new releases and “For You”. Off hides them (browse by Genres instead)." },
    { key: "onlineArtistMeta", label: "Artist info & photos from the web", hint: "Bios, genres and artist images from MusicBrainz / Last.fm / Deezer / etc. Off keeps only what you set by hand." },
  ];

  return (
    <section className="card">
      <h2>Discovery &amp; online info</h2>
      <p className="muted">Turn off anything you find noisy. This also stops the related external lookups.</p>
      {s ? (
        <ul className="tier-list">
          {rows.map(r => {
            const on = !!s[r.key];
            return (
              <li key={r.key} className="tier-row">
                <div className="tier-row-main">
                  <button
                    type="button" role="switch" aria-checked={on} aria-label={r.label}
                    className={`tier-switch${on ? " on" : ""}`} disabled={busy} onClick={() => toggle(r.key, !on)}
                  >
                    <span className="tier-switch-knob" />
                  </button>
                  <span className="tier-text">
                    <span className="tier-label">{r.label}</span>
                    <span className="tier-hint">{r.hint}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted">Loading…</p>}

      {s && (() => {
        const PRESETS = [24, 168, 720, 0];
        const custom = customOpen || !PRESETS.includes(s.discoverRefreshHours);
        return (
          <div className="enrich-refresh">
            <span className="enrich-refresh-label">Auto-refresh Discover</span>
            <select
              className="enrich-select" disabled={busy}
              value={custom ? "custom" : String(s.discoverRefreshHours)}
              onChange={e => {
                if (e.target.value === "custom") setCustomOpen(true);
                else { setCustomOpen(false); save({ discoverRefreshHours: Number(e.target.value) }); }
              }}
            >
              <option value="24">Daily</option>
              <option value="168">Weekly</option>
              <option value="720">Monthly</option>
              <option value="0">Manual only</option>
              <option value="custom">Custom…</option>
            </select>
            {custom && (
              <span className="enrich-custom">
                <input
                  type="number" min={0} className="enrich-num" defaultValue={s.discoverRefreshHours}
                  onBlur={e => save({ discoverRefreshHours: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                /> hours
              </span>
            )}
          </div>
        );
      })()}
      <p className="muted enrich-hint">
        Discover recommendations are cached, so they don't re-fetch every visit. "Manual only" keeps them until you hit Refresh on the Discover page.
      </p>
    </section>
  );
}

// Off by default: it hands every username to anyone who can open the sign-in page.
function SignInListSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { api.getAdminSettings().then((s: any) => setOn(!!s.showUsersOnSignIn)).catch(() => {}); }, []);
  if (on === null) return null;
  const flip = () => { const next = !on; setOn(next); api.saveAdminSettings({ showUsersOnSignIn: next }).catch(() => setOn(!next)); };
  return (
    <div className="tier-row signin-list-setting">
      <div className="tier-row-main">
        <button type="button" role="switch" aria-checked={on} aria-label="Show all users on the sign-in page"
          className={`tier-switch${on ? " on" : ""}`} onClick={flip}>
          <span className="tier-switch-knob" />
        </button>
        <span className="tier-text">
          <span className="tier-label">Show all users on the sign-in page</span>
          <span className="tier-hint">
            People pick their name and type only a password, even on a new device. Anyone who can reach this server will see
            the names, so leave it off if the server is open to the internet. Devices always remember who has signed in on them.
          </span>
        </span>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [scanErr, setScanErr] = useState("");

  const [resetFor, setResetFor] = useState<number | null>(null);
  const [resetPass, setResetPass] = useState("");
  const [me, setMe] = useState("");

  const load = () => api.getUsers().then(setUsers).catch(() => {});
  useEffect(() => { load(); api.me().then((u: any) => setMe(u.username)).catch(() => {}); }, []);

  async function resetPassword(u: { id: number; username: string }) {
    setErr(""); setMsg("");
    try {
      await api.resetUserPassword(u.id, resetPass);
      setMsg(`New password set for ${u.username}. They were signed out everywhere.`);
      setResetFor(null); setResetPass("");
    } catch (e: any) { setErr(e?.message || "Could not set the password."); }
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    if (!name.trim() || !pass) { setErr("Username and password required."); return; }
    try {
      await api.createUser(name.trim(), pass);
      setMsg(`Created “${name.trim()}”.`);
      setName(""); setPass("");
      load();
    } catch {
      setErr("Could not create user (name may already exist).");
    }
  }

  async function rescan() {
    setScanning(true); setScanMsg(""); setScanErr("");
    try {
      const r = await api.rescan();
      setScanMsg(`Rescan complete: +${r.added ?? 0} tracks, ${r.issues ?? 0} issues.`);
    } catch {
      setScanErr("Rescan failed.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      {inDesktopApp && (
        <section className="card">
          <h2>Desktop app</h2>
          <AppUpdateSettings />
        </section>
      )}

      <section className="card">
        <h2>Library</h2>
        <p className="muted">Re-scan your music folder to pick up newly added files.</p>
        <button className="btn" onClick={rescan} disabled={scanning}>
          {scanning ? "Scanning…" : "Rescan library"}
        </button>
        {scanMsg && <p className="ok-msg">{scanMsg}</p>}
        {scanErr && <p className="err">{scanErr}</p>}
      </section>

      <StorageSettings />
      <EnrichmentSettings />

      <section className="card">
        <h2>Users</h2>
        <p className="muted">Create accounts for people you want to share your library with.</p>
        <form className="field-row" onSubmit={addUser}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Username" />
          <input value={pass} onChange={e => setPass(e.target.value)} type="password" placeholder="Password" />
          <button className="btn" type="submit">Add user</button>
        </form>
        {msg && <p className="ok-msg">{msg}</p>}
        {err && <p className="err">{err}</p>}
        <ul className="user-list">
          {users.map(u => (
            <li key={u.id}>
              <span>{u.username}</span>
              {u.is_admin ? <span className="badge">admin</span> : null}
              {resetFor === u.id ? (
                <form className="user-reset" onSubmit={e => { e.preventDefault(); resetPassword(u); }}>
                  <input type="password" autoFocus autoComplete="new-password" placeholder="New password (8 or more characters)"
                    value={resetPass} onChange={e => setResetPass(e.target.value)} />
                  <button className="btn" type="submit" disabled={resetPass.length < 8}>Set</button>
                  <button className="btn" type="button" onClick={() => setResetFor(null)}>Cancel</button>
                </form>
              ) : u.username !== me && (
                <button className="btn user-reset-open" onClick={() => { setResetFor(u.id); setResetPass(""); setMsg(""); setErr(""); }}>Reset password</button>
              )}
            </li>
          ))}
        </ul>
        <SignInListSetting />
      </section>

      <LibraryHealth />
      <ReportsAdmin />
    </div>
  );
}

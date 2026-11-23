import { useEffect, useReducer, useState } from "react";
import { usePlayer, usePlayerTime } from "../player/PlayerProvider";
import { api } from "../api";
import { downloadedBitrate } from "../player/downloads";
import { useOnline } from "./useOnline";
import { dlogEntries, dlogSubscribe, dlogClear } from "./debugLog";

const AUDIO_CACHE = "lhm-audio-v1";
const DL_CACHE = "lhm-downloads";
const idFromUrl = (u: string) => Number(/\/api\/stream\/(\d+)/.exec(u)?.[1]) || null;

// Dev overlay (enable with ?debug=1) to watch prefetch + the offline audio cache.
export function DebugPanel() {
  const p = usePlayer();
  const t = usePlayerTime();
  const online = useOnline();
  const [cached, setCached] = useState<number[]>([]);
  const [downloaded, setDownloaded] = useState<number[]>([]);
  const [swVer, setSwVer] = useState<string>("?");
  const [curSize, setCurSize] = useState(0);
  const [diag, setDiag] = useState({ src: "", error: 0, ready: 0, net: 0, skip: 0 });
  const [conn, setConn] = useState<{ downlink?: number; rtt?: number; type?: string }>({});
  const [hidden, setHidden] = useState(false);
  // Live navigation / cache-timing log (newest first).
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => dlogSubscribe(bump), []);

  useEffect(() => {
    const t = setInterval(() => setDiag(p.getAudioDiag()), 700);
    return () => clearInterval(t);
  }, []);

  // Connection estimate from the browser (no extra traffic).
  useEffect(() => {
    const c = (navigator as any).connection;
    if (!c) return;
    const upd = () => setConn({ downlink: c.downlink, rtt: c.rtt, type: c.effectiveType });
    upd();
    c.addEventListener?.("change", upd);
    return () => c.removeEventListener?.("change", upd);
  }, []);

  // Seconds of audio buffered ahead of the playhead. Shrinking toward 0 means
  // about to stall.
  const bufAhead = (() => {
    const ct = t.currentTime;
    for (const [s, e] of t.buffered) if (ct >= s - 0.5 && ct <= e + 0.5) return Math.max(0, e - ct);
    return 0;
  })();
  const NET_STATE = ["empty", "idle", "loading", "no-source"];

  // Size of the current track's cached download (0 = not stored / empty).
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!p.current) { setCurSize(0); return; }
      const b = downloadedBitrate(p.current.id);
      if (b === undefined) { if (alive) setCurSize(0); return; }
      try {
        const d = await caches.open(DL_CACHE);
        const key = b > 0 ? api.streamUrl(p.current.id, b) : api.streamUrl(p.current.id);
        const r = await d.match(key);
        const size = r ? (Number(r.headers.get("content-length")) || (await r.arrayBuffer()).byteLength) : 0;
        if (alive) setCurSize(size);
      } catch { if (alive) setCurSize(0); }
    })();
    return () => { alive = false; };
  }, [p.current?.id, downloaded.length]);

  // Ask the active service worker which version it is (catches stale SWs on iOS).
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw?.controller) return;
    const onMsg = (e: MessageEvent) => { if ((e.data as any)?.swVersion) setSwVer(String((e.data as any).swVersion)); };
    sw.addEventListener("message", onMsg);
    sw.controller.postMessage("version");
    return () => sw.removeEventListener("message", onMsg);
  }, []);
  // Remember track titles by id across sessions, so cached tracks not in the
  // current queue still show a name.
  const [titles, setTitles] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("lhm-titles") || "{}"); } catch { return {}; }
  });
  useEffect(() => {
    setTitles(prev => {
      const next = { ...prev }; let changed = false;
      for (const t of p.queue) if (t?.id != null && next[t.id] !== t.title) { next[t.id] = t.title; changed = true; }
      if (changed) { try { localStorage.setItem("lhm-titles", JSON.stringify(next)); } catch { /* */ } return next; }
      return prev;
    });
  }, [p.queue]);
  const swControlling = typeof navigator !== "undefined" && "serviceWorker" in navigator && !!navigator.serviceWorker.controller;

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const c = await caches.open(AUDIO_CACHE);
        const ids = (await c.keys()).map(r => idFromUrl(r.url)).filter((x): x is number => x != null);
        if (alive) setCached(ids);
      } catch { /* caches unavailable */ }
      try {
        const d = await caches.open(DL_CACHE);
        const ids = (await d.keys()).map(r => idFromUrl(r.url)).filter((x): x is number => x != null);
        if (alive) setDownloaded(ids);
      } catch { /* */ }
    };
    read();
    const t = setInterval(read, 1500);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const next = (() => {
    let ni = p.pos + 1;
    if (ni >= p.order.length) { if (p.repeat === "all") ni = 0; else return undefined; }
    return p.queue[p.order[ni]];
  })();
  const cachedSet = new Set(cached);
  const dlSet = new Set(downloaded);
  const titleOf = (id?: number | null) => (id == null ? undefined : (p.queue.find(t => t.id === id)?.title ?? titles[id]));

  const mark = (ok: boolean) => <span className={ok ? "dbg-ok" : "dbg-no"}>{ok ? "✓" : "✗"}</span>;

  async function clearCache() {
    try { await caches.delete(AUDIO_CACHE); setCached([]); } catch { /* */ }
  }
  function close() {
    try { localStorage.setItem("lhm-debug", "0"); } catch { /* */ }
    setHidden(true);
  }
  if (hidden) return null;

  return (
    <div className="dbg-panel">
      <div className="dbg-head">Localhost Music · debug <button className="dbg-close" onClick={close} aria-label="Close debug">✕</button></div>
      <div className="dbg-row">network {mark(online)} {online ? "online" : "offline"}{p.reconnecting ? " · reconnecting…" : ""}</div>
      <div className="dbg-row">service worker {mark(swControlling)} {swControlling ? `v${swVer}` : "not active"}</div>
      <div className="dbg-row">current downloaded {mark(!!p.current && dlSet.has(p.current.id))} · {curSize ? `${Math.round(curSize / 1024)} KB` : "0 (empty!)"} · total: {downloaded.length}</div>
      <div className="dbg-row">audio err:{diag.error} ready:{diag.ready} net:{diag.net} ({NET_STATE[diag.net] ?? "?"})</div>
      <div className="dbg-row">last skip to sound: <strong>{diag.skip ? `${diag.skip} ms` : "-"}</strong></div>
      <div className="dbg-row">buffered ahead: <strong>{bufAhead.toFixed(1)}s</strong>{p.buffering ? " · buffering…" : ""}{p.reconnecting ? " · reconnecting…" : ""}</div>
      <div className="dbg-row">conn: {conn.type ?? "?"} · ~{conn.downlink ?? "?"} Mbps · rtt {conn.rtt ?? "?"}ms · quality: {p.streamQuality}</div>
      <div className="dbg-row" style={{ fontSize: "10px", opacity: 0.7 }}>src: {diag.src || "-"}</div>
      <div className="dbg-row">connect: {p.connected ? "on" : "off"} · {p.isActiveDevice ? "active (this device)" : (p.activeDeviceId ? "remote" : "no active")}</div>
      <div className="dbg-row">current: {p.current ? `${p.current.title}` : "-"} {p.current && mark(cachedSet.has(p.current.id))}</div>
      <div className="dbg-row">next: {next ? next.title : "-"} {next && <>prefetch {mark(p.prefetchedId === next.id)} cache {mark(cachedSet.has(next.id))}</>}</div>
      <div className="dbg-row">cached tracks: {cached.length}</div>
      <ul className="dbg-list">
        {cached.map(id => <li key={id} className={id === p.current?.id ? "now" : ""}>{titleOf(id) ?? `#${id}`}</li>)}
        {cached.length === 0 && <li className="dbg-muted">nothing cached yet</li>}
      </ul>
      <button className="dbg-clear" onClick={clearCache}>clear cache</button>
      <div className="dbg-row" style={{ marginTop: 8 }}>nav log <button className="dbg-clear" style={{ marginLeft: 6, padding: "0 6px" }} onClick={dlogClear}>clear</button></div>
      <ul className="dbg-list">
        {dlogEntries().slice().reverse().map((e, i) => (
          <li key={i} className="dbg-muted" style={{ fontSize: "10px" }}>
            <span style={{ opacity: 0.6 }}>{(e.t / 1000).toFixed(2)}s</span> {e.msg}
          </li>
        ))}
        {dlogEntries().length === 0 && <li className="dbg-muted">navigate to record…</li>}
      </ul>
    </div>
  );
}

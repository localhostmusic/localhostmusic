import { useEffect, useRef, useState } from "react";
import type { ViewName } from "../ui/Sidebar";
import { DownloadIcon, ChartIcon, RequestIcon, GearIcon, LogoutIcon, ChevronDownIcon, LyricsIcon } from "../ui/icons";
import { usePlayer } from "../player/PlayerProvider";
import { QUALITY_OPTIONS } from "../player/streamQuality";
import { CROSSFADE_MAX } from "../player/crossfade";
import { MyAvatar, bumpAvatar } from "../ui/MyAvatar";
import { ScrobbleSettings } from "./ScrobbleSettings";
import { SubsonicSettings } from "./SubsonicSettings";
import { api } from "../api";
import { AppUpdateSettings, inDesktopApp } from "../ui/desktopUpdate";

type Storage = {
  totalSize: number; tracks: number; albums: number; artists: number;
  disk: { total: number; free: number; used: number } | null;
};

// Human-readable bytes (1000-based, matching how drives are marketed).
function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(n) / 3));
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// Downscale + center-crop a chosen image to a small square JPEG data URL, so we
// don't store or ship a giant avatar.
function toAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S = 256;
      const c = document.createElement("canvas");
      c.width = S; c.height = S;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      const scale = Math.max(S / img.width, S / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Full-screen account hub for phones.
export function AccountPage({ username, isAdmin, onNavigate, onLogout }: {
  username: string;
  isAdmin: boolean;
  onNavigate: (v: ViewName) => void;
  onLogout: () => void;
}) {
  const vpFill = (() => { try { return localStorage.getItem("lhm-vpfill") !== "0"; } catch { return true; } })();
  const debugPanel = (() => { try { return localStorage.getItem("lhm-debug") === "1"; } catch { return false; } })();
  const { streamQuality, setStreamQuality, crossfade, setCrossfade, normalize, setNormalize, weightedShuffle, setWeightedShuffle } = usePlayer();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<Storage | null>(null);
  useEffect(() => { api.getStorage().then(setStorage).catch(() => {}); }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadAvatar(await toAvatarDataUrl(file));
      bumpAvatar();
    } catch { alert("Couldn't update your photo."); }
    finally { setBusy(false); }
  }
  async function removePhoto() {
    setBusy(true);
    try { await api.removeAvatar(); bumpAvatar(); } catch { /* */ }
    finally { setBusy(false); }
  }
  const items: { view: ViewName; label: string; sub: string; icon: React.ReactNode }[] = [
    { view: "downloads", label: "Downloads", sub: "Saved for offline", icon: <DownloadIcon size={20} /> },
    { view: "stats", label: "Listening", sub: "Your top artists & songs", icon: <ChartIcon size={20} /> },
    { view: "lyrics", label: "Your Lyrics", sub: "Lyrics you made, to share with LRCLIB", icon: <LyricsIcon size={20} /> },
    { view: "requests", label: "Requests", sub: "Report missing or wrong info", icon: <RequestIcon size={20} /> },
  ];
  if (isAdmin) items.push({ view: "settings", label: "Settings", sub: "Library, users & reports", icon: <GearIcon size={20} /> });

  return (
    <div className="page account-page">
      <div className="account-hero">
        <button className="account-avatar-btn" onClick={() => fileRef.current?.click()} disabled={busy} title="Change photo" aria-label="Change photo">
          <MyAvatar username={username} size={68} />
          <span className="account-avatar-edit">{busy ? "…" : "Edit"}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        <div className="account-id">
          <h1>{username}</h1>
          <span className="account-role">{isAdmin ? "Admin" : "Listener"}</span>
          <div className="account-photo-actions">
            <button className="link-btn" onClick={() => fileRef.current?.click()} disabled={busy}>Change photo</button>
            <button className="link-btn" onClick={removePhoto} disabled={busy}>Remove</button>
          </div>
        </div>
      </div>

      <div className="account-list">
        {items.map(it => (
          <button key={it.view} className="account-row" onClick={() => onNavigate(it.view)}>
            <span className="account-row-icon">{it.icon}</span>
            <span className="account-row-text">
              <span className="account-row-label">{it.label}</span>
              <span className="account-row-sub">{it.sub}</span>
            </span>
            <span className="account-row-chev"><ChevronDownIcon size={18} /></span>
          </button>
        ))}
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Streaming quality</h2>
        <p className="account-section-sub">Applies to live playback (not downloads). Lower quality streams faster on cellular or when away from home.</p>
        <div className="quality-list">
          {QUALITY_OPTIONS.map(q => (
            <button
              key={q.value}
              className={`quality-row${streamQuality === q.value ? " selected" : ""}`}
              onClick={() => setStreamQuality(q.value)}
              role="radio" aria-checked={streamQuality === q.value}
            >
              <span className="quality-radio" />
              <span className="quality-text">
                <span className="quality-label">{q.label}</span>
                <span className="quality-hint">{q.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Crossfade</h2>
        <p className="account-section-sub">
          Blend the end of each song into the next. Off means gapless (songs run straight
          into each other with no silence). Only applies to normal track-to-track playback.
        </p>
        <div className="crossfade-row">
          <input
            type="range" min={0} max={CROSSFADE_MAX} step={1}
            value={crossfade} onChange={e => setCrossfade(Number(e.target.value))}
            aria-label="Crossfade seconds"
          />
          <span className="crossfade-value">{crossfade === 0 ? "Off" : `${crossfade}s`}</span>
        </div>
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Volume normalization</h2>
        <label className="toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Even out loudness between tracks</span>
            <span className="toggle-hint">Turns louder tracks down toward a reference level so shuffle and queues don't jump from quiet to blaring. Freshly-added songs level out as the server analyzes them.</span>
          </span>
          <button
            type="button"
            className={`switch${normalize ? " on" : ""}`}
            role="switch" aria-checked={normalize}
            onClick={() => setNormalize(!normalize)}
            aria-label="Even out loudness between tracks"
          ><span className="switch-knob" /></button>
        </label>
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Shuffle</h2>
        <label className="toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Favor higher-rated songs</span>
            <span className="toggle-hint">When shuffling, play songs you've rated highly more often. Unrated songs still appear.</span>
          </span>
          <button
            type="button"
            className={`switch${weightedShuffle ? " on" : ""}`}
            role="switch" aria-checked={weightedShuffle}
            onClick={() => setWeightedShuffle(!weightedShuffle)}
            aria-label="Favor higher-rated songs when shuffling"
          ><span className="switch-knob" /></button>
        </label>
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Scrobbling</h2>
        <ScrobbleSettings />
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Connect apps</h2>
        <SubsonicSettings username={username} />
      </div>

      <div className="account-section">
        <h2 className="account-section-title">Library</h2>
        {storage ? (
          <>
            <p className="account-section-sub">
              {storage.tracks.toLocaleString()} songs · {storage.albums.toLocaleString()} albums · {storage.artists.toLocaleString()} artists
            </p>
            <div className="lib-total">{fmtBytes(storage.totalSize)} of music</div>
            {storage.disk && storage.disk.total > 0 && (() => {
              const pct = Math.min(100, Math.round((storage.disk.used / storage.disk.total) * 100));
              return (
                <div className="lib-disk">
                  <div className="lib-bar"><div className="lib-bar-fill" style={{ width: `${pct}%` }} /></div>
                  <div className="lib-legend">
                    {fmtBytes(storage.disk.used)} used · {fmtBytes(storage.disk.free)} free · {fmtBytes(storage.disk.total)} disk
                  </div>
                </div>
              );
            })()}
          </>
        ) : <p className="account-section-sub">Loading…</p>}
      </div>

      {inDesktopApp && (
        <div className="account-section">
          <h2 className="account-section-title">Desktop app</h2>
          <AppUpdateSettings />
        </div>
      )}

      <div className="account-section">
        <h2 className="account-section-title">Diagnostics</h2>
        <label className="toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Show the debug panel</span>
            <span className="toggle-hint">A floating log of what playback and the app shell are doing, for reporting problems. Same as opening the app with ?debug=1, which a home-screen app has no way to do. Reloads the app.</span>
          </span>
          <button
            type="button"
            className={`switch${debugPanel ? " on" : ""}`}
            role="switch" aria-checked={debugPanel}
            onClick={() => {
              try { localStorage.setItem("lhm-debug", debugPanel ? "0" : "1"); } catch { /* */ }
              location.reload();
            }}
            aria-label="Show the debug panel"
          ><span className="switch-knob" /></button>
        </label>
        <label className="toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Fill the bottom strip</span>
            <span className="toggle-hint">iPhone home-screen app only. Covers the blank strip that some launches leave under the navigation bar. Turn it off if the layout looks wrong. Reloads the app.</span>
          </span>
          <button
            type="button"
            className={`switch${vpFill ? " on" : ""}`}
            role="switch" aria-checked={vpFill}
            onClick={() => {
              try { localStorage.setItem("lhm-vpfill", vpFill ? "0" : "1"); } catch { /* */ }
              location.reload();
            }}
            aria-label="Fill the bottom strip"
          ><span className="switch-knob" /></button>
        </label>
      </div>

      <button className="account-signout" onClick={onLogout}>
        <LogoutIcon size={19} /> Sign out
      </button>
    </div>
  );
}

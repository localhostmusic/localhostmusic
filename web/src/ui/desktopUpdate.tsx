import { useEffect, useReducer, useState } from "react";

// App updates, only inside the desktop app. The shell (desktop/main.js) finds and
// downloads the update; this shows it and passes the user's choice back.

export interface UpdateState {
  status: "idle" | "available" | "downloading" | "ready" | "latest" | "error";
  current?: string;
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  // Changes when the user asks for updates again, to bring a hidden prompt back.
  asked?: number;
}

interface Bridge {
  state(): Promise<UpdateState>;
  download(): Promise<void>;
  install(): Promise<void>;
  check(): Promise<void>;
  onChange(cb: (s: UpdateState) => void): () => void;
}

const bridge = (window as any).lhmDesktop?.update as Bridge | undefined;
let state: UpdateState = { status: "idle" };
const listeners = new Set<() => void>();
const set = (s: UpdateState) => { state = s; for (const l of listeners) l(); };

if (bridge) {
  bridge.onChange(set);
  bridge.state().then(set).catch(() => {});
}

export const updatePending = () => state.status === "available" || state.status === "downloading" || state.status === "ready";

export function useDesktopUpdate(): UpdateState {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { listeners.add(force); return () => { listeners.delete(force); }; }, []);
  return state;
}

function Actions({ s, onLater }: { s: UpdateState; onLater?: () => void }) {
  if (s.status === "downloading") {
    const pct = Math.round(s.percent ?? 0);
    return (
      <div className="update-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
        <span>Downloading… {pct}%</span>
      </div>
    );
  }
  return (
    <div className="update-actions">
      {s.status === "ready"
        ? <button className="btn primary" onClick={() => bridge?.install()}>Restart to update</button>
        : <button className="btn primary" onClick={() => bridge?.download()}>Update</button>}
      {onLater && <button className="btn" onClick={onLater}>Later</button>}
    </div>
  );
}

const title = (s: UpdateState) =>
  s.status === "ready" ? `Version ${s.version} is ready to install`
  : s.status === "downloading" ? `Downloading version ${s.version}`
  : `Version ${s.version} is available`;

// Card in the corner. "Later" hides it for this run; the bell keeps the update.
export function UpdatePrompt() {
  const s = useDesktopUpdate();
  const [hidden, setHidden] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);
  useEffect(() => { setHidden(null); }, [s.asked]);

  if (s.status === "latest" || s.status === "error") {
    return (
      <div className="update-card update-brief" role="status">
        {s.status === "latest" ? `You're up to date (version ${s.current}).` : `Update failed: ${s.error}`}
      </div>
    );
  }
  // A new stage (downloaded, ready) shows again even after "Later".
  if (!updatePending() || hidden === s.status) return null;
  return (
    <div className="update-card" role="dialog" aria-label="App update">
      <div className="update-title">{title(s)}</div>
      {s.current && <div className="update-sub">You have {s.current}.</div>}
      {s.notes && (
        <>
          <button className="update-notes-toggle" onClick={() => setNotes(n => !n)} aria-expanded={notes}>
            {notes ? "Hide what's new" : "What's new"}
          </button>
          {notes && <div className="update-notes">{s.notes}</div>}
        </>
      )}
      <Actions s={s} onLater={() => setHidden(s.status)} />
    </div>
  );
}

// The desktop app's version, clickable to check for updates. Nothing in a browser.
export function AppVersion() {
  const s = useDesktopUpdate();
  if (!bridge || !s.current) return null;
  return (
    <button className="link-btn app-version" onClick={() => bridge.check()} title="Check for updates">
      Version {s.current}
    </button>
  );
}

// "Desktop app" block for the settings pages: version, a check button, and the
// update itself when there is one. Renders nothing in a browser.
export function AppUpdateSettings() {
  const s = useDesktopUpdate();
  const [checking, setChecking] = useState(false);
  useEffect(() => { setChecking(false); }, [s]);
  if (!bridge || !s.current) return null;

  const check = () => {
    setChecking(true);
    bridge.check();
    // No answer (offline, GitHub unreachable): give the button back.
    setTimeout(() => setChecking(false), 15000);
  };
  return (
    <>
      <p className="app-update-line">
        You have version {s.current}.{" "}
        {updatePending() ? title(s) + "."
          : s.status === "latest" ? "You're up to date."
          : s.status === "error" ? `Could not update: ${s.error}`
          : ""}
      </p>
      {s.notes && updatePending() && <div className="update-notes">{s.notes}</div>}
      {updatePending()
        ? <Actions s={s} />
        : <div className="update-actions"><button className="btn" onClick={check} disabled={checking}>{checking ? "Checking…" : "Check for updates"}</button></div>}
    </>
  );
}
export const inDesktopApp = !!bridge;
// True when the desktop app is showing its own built-in library. That account is
// signed in by the app, so signing out or changing its password makes no sense.
export const builtIn = !!(window as any).lhmDesktop?.builtIn;

// Row at the top of the notifications panel while an update is waiting.
export function UpdateNotice() {
  const s = useDesktopUpdate();
  if (!updatePending()) return null;
  return (
    <div className="update-notice">
      <div className="notif-item-title">{title(s)}</div>
      {s.notes && <div className="notif-item-body update-notes">{s.notes}</div>}
      <Actions s={s} />
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";

// Server version and whether a newer release exists. The server only reports it;
// updating restarts the server, so the owner runs that.
interface Info {
  current: string | null; latest: string | null; notes: string; url: string;
  available: boolean; checkedAt: number | null; enabled: boolean; error?: string;
}

// Release notes are Markdown. Shown as plain text, without the markup characters.
const plain = (md: string) => md
  .replace(/^#+\s*/gm, "")
  .replace(/\*\*(.+?)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/^[-*] /gm, "• ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export function ServerUpdate() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.serverUpdate().then(setInfo).catch(() => {}); }, []);
  if (!info) return null;

  const check = async () => {
    setBusy(true);
    try { setInfo(await api.checkServerUpdate()); } catch { /* keep what we have */ }
    finally { setBusy(false); }
  };
  const flip = async () => {
    const next = !info.enabled;
    setInfo({ ...info, enabled: next });
    try { await api.saveAdminSettings({ updateCheck: next }); setInfo(await api.serverUpdate()); }
    catch { setInfo(i => (i ? { ...i, enabled: !next } : i)); }
  };

  const status = !info.current ? "This build does not know its version, so it cannot compare."
    : info.available ? `Version ${info.latest} is available.`
    : info.latest ? "You're up to date."
    : !info.enabled ? "Update checks are off."
    : info.error ? "Could not reach GitHub to check."
    : "Not checked yet.";

  return (
    <section className="card">
      <h2>Server</h2>
      <p className="app-update-line">
        {info.current ? <>This server is on version {info.current}. </> : null}{status}
      </p>
      {info.available && (
        <>
          {info.notes && <div className="update-notes">{plain(info.notes)}</div>}
          <p className="muted server-update-how">To update with Docker, run this where your <code>docker-compose.yml</code> is:</p>
          <pre className="server-update-cmd"><code>docker compose pull && docker compose up -d</code></pre>
          <p className="muted server-update-how">
            The server restarts and keeps your library and accounts. Other setups: see the{" "}
            <a href="https://localhostmusic.github.io/localhostmusic/docs.html#updates" target="_blank" rel="noreferrer">update guide</a>.
          </p>
        </>
      )}
      <div className="update-actions">
        <button className="btn" onClick={check} disabled={busy || !info.enabled}>{busy ? "Checking…" : "Check for updates"}</button>
      </div>
      <div className="tier-row server-update-switch">
        <div className="tier-row-main">
          <button type="button" role="switch" aria-checked={info.enabled} aria-label="Check for new versions"
            className={`tier-switch${info.enabled ? " on" : ""}`} onClick={flip}>
            <span className="tier-switch-knob" />
          </button>
          <span className="tier-text">
            <span className="tier-label">Check for new versions</span>
            <span className="tier-hint">Once a day the server asks GitHub for the latest release and tells admins when there is one. Nothing is installed automatically.</span>
          </span>
        </div>
      </div>
    </section>
  );
}

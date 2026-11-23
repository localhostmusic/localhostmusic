import { useEffect, useState } from "react";
import { api } from "../api";

// "Connect apps" settings: generate, show or revoke the per-user Subsonic app
// password for third-party clients (Feishin, Amperfy, Symfonium). The token is not
// the login password, so it can be displayed and rotated.
export function SubsonicSettings({ username }: { username: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    api.getSubsonicPassword()
      .then((r: any) => setToken(r?.token ?? null))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const serverUrl = window.location.origin;

  async function generate() {
    setBusy(true);
    try { const r: any = await api.generateSubsonicPassword(); setToken(r.token); }
    catch { alert("Couldn't generate an app password."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm("Remove the app password? Connected apps will stop working until you generate a new one.")) return;
    setBusy(true);
    try { await api.clearSubsonicPassword(); setToken(null); }
    catch { /* */ }
    finally { setBusy(false); }
  }
  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1500); }
    catch { /* clipboard blocked */ }
  }

  if (!loaded) return <p className="account-section-sub">Loading…</p>;

  return (
    <>
      <p className="account-section-sub">
        Localhost Music speaks the <strong>Subsonic API</strong>, so you can play your whole library
        from third-party apps: <strong>Amperfy</strong> or <strong>play:Sub</strong> on iPhone,
        <strong> Symfonium</strong> or <strong>DSub</strong> on Android, <strong>Feishin</strong> on
        desktop, plus car head-units and more. In the app, choose <em>Subsonic</em> (or
        “Navidrome”) as the server type and enter the three values below. Your ratings,
        stars, and playlists stay in sync both ways. Sign in with the generated
        <strong> app password</strong>, not your login password, so you can revoke a single app
        without changing your account. It works anywhere the site does, including remotely over HTTPS.
      </p>
      {token ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          <Field label="Server" value={serverUrl} copied={copied === "server"} onCopy={() => copy(serverUrl, "server")} />
          <Field label="Username" value={username} copied={copied === "user"} onCopy={() => copy(username, "user")} />
          <Field label="App password" value={token} mono copied={copied === "token"} onCopy={() => copy(token, "token")} />
          <div className="account-photo-actions" style={{ marginTop: 2 }}>
            <button className="link-btn" onClick={generate} disabled={busy}>Regenerate</button>
            <button className="link-btn" onClick={remove} disabled={busy}>Remove</button>
          </div>
        </div>
      ) : (
        <button className="link-btn" onClick={generate} disabled={busy}>
          {busy ? "Generating…" : "Generate app password"}
        </button>
      )}
    </>
  );
}

function Field({ label, value, mono, copied, onCopy }: {
  label: string; value: string; mono?: boolean; copied: boolean; onCopy: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ minWidth: 92, opacity: 0.6, fontSize: 13 }}>{label}</span>
      <code style={{
        flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontFamily: mono ? "ui-monospace, monospace" : "inherit", fontSize: 13,
        background: "rgba(128,128,128,0.12)", padding: "4px 8px", borderRadius: 6,
      }}>{value}</code>
      <button className="link-btn" onClick={onCopy} style={{ minWidth: 52 }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

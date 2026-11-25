import { useEffect, useState } from "react";
import { api } from "../api";
import { Aurora } from "../ui/Aurora";
import { LogoMark } from "../ui/icons";
import { deviceToken, forgetProfile, profilePicture, rememberProfile, savedProfiles, setDeviceToken } from "./profiles";

// Sign-in. People who have signed in on this device before get a tile to click, so
// they only type a password. The tiles come from this browser's own storage; the
// server adds its full user list only when the admin has turned that setting on.
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [saved, setSaved] = useState(savedProfiles);
  const [listed, setListed] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [skip, setSkip] = useState(false); // "don't ask for my password on this device"

  useEffect(() => { api.signInUsers().then(setListed).catch(() => {}); }, []);

  // This device's profiles first, then any others the server lists.
  const seen = new Set(saved.map(n => n.toLowerCase()));
  const profiles = [...saved, ...listed.filter(n => !seen.has(n.toLowerCase()))];
  const listedSet = new Set(listed.map(n => n.toLowerCase()));
  const picking = profiles.length > 0 && !picked && !other;

  const reset = () => { setP(""); setErr(""); setForgot(false); };
  // A tile for someone who opted in on this device signs them straight in. If the
  // server no longer accepts the device (password changed, long unused), ask once more.
  async function pick(name: string) {
    reset();
    const token = deviceToken(name);
    if (token && !busy) {
      setBusy(true);
      try { await api.deviceLogin(name, token); rememberProfile(name); onLogin(); return; }
      catch (e: any) {
        if (e?.status === 401) setDeviceToken(name, null);
        setErr(e?.status === 401 ? "Type your password once more for this device." : e?.status === 429 ? "Too many attempts. Wait a moment and try again." : "Could not reach the server.");
      } finally { setBusy(false); }
    }
    setPicked(name);
  }
  function remove(name: string) {
    const token = deviceToken(name);
    if (token) { api.dropDeviceToken(token).catch(() => {}); setDeviceToken(name, null); }
    setSaved(forgetProfile(name));
  }
  const back = () => { setPicked(null); setOther(false); setU(""); setSkip(false); reset(); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const me = await api.login(picked ?? u, p);
      const name = me?.username ?? picked ?? u.trim();
      rememberProfile(name);
      if (skip) {
        // Best effort: signing in already worked, so a failure here only means the password is asked next time.
        try { setDeviceToken(name, (await api.createDeviceToken()).token); } catch { /* */ }
      }
      onLogin();
    } catch (e: any) {
      setErr(e?.status === 429 ? "Too many attempts. Wait a moment and try again." : picked ? "That password is not right." : "Invalid login");
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <Aurora />
      <form onSubmit={submit} className="login glass">
        <h1 className="brand"><span className="logo-mark brand-mark"><LogoMark size={44} /></span>localhost<span className="logo-accent">music</span></h1>

        {picking ? (
          <>
            <p className="tagline">Who's listening?</p>
            <ul className="profile-grid">
              {profiles.map(name => (
                <li key={name}>
                  <button type="button" className="profile-tile" disabled={busy} onClick={() => pick(name)}>
                    <Avatar name={name} listed={listedSet.has(name.toLowerCase())} />
                    <span className="profile-name">{name}</span>
                  </button>
                  {seen.has(name.toLowerCase()) && (
                    <button type="button" className="profile-remove" aria-label={`Remove ${name} from this device`} title="Remove from this device"
                      onClick={() => remove(name)}>×</button>
                  )}
                </li>
              ))}
            </ul>
            {/* Keyed so React never turns this node into the submit button mid-click, which would submit the form. */}
            <button key="other" type="button" className="link-btn login-link" onClick={() => { setOther(true); reset(); }}>Use another account</button>
          </>
        ) : (
          <>
            {picked ? (
              <div className="profile-picked">
                <Avatar name={picked} listed={listedSet.has(picked.toLowerCase())} />
                <span className="profile-name">{picked}</span>
              </div>
            ) : (
              <>
                <p className="tagline">your music, your server</p>
                <input placeholder="Username" autoFocus={other} autoComplete="username" value={u} onChange={e => setU(e.target.value)} />
              </>
            )}
            <input placeholder="Password" type="password" autoFocus={!!picked} autoComplete="current-password" value={p} onChange={e => setP(e.target.value)} />
            <label className="login-skip">
              <input type="checkbox" checked={skip} onChange={e => setSkip(e.target.checked)} />
              <span>Don't ask for my password on this device</span>
            </label>
            <button key="submit" type="submit" disabled={busy}>Sign in</button>
            {err && <p className="err">{err}</p>}
            <div className="login-links">
              <button type="button" className="link-btn login-link" onClick={() => setForgot(f => !f)} aria-expanded={forgot}>
                Forgot your password?
              </button>
              {profiles.length > 0 && <button type="button" className="link-btn login-link" onClick={back}>Back</button>}
            </div>
            {forgot && (
              <div className="login-help">
                <p>Passwords live only on this server, so there is no email reset.</p>
                <p>Ask whoever runs it to set a new one for you under Settings, Users.</p>
                <p>If you run it and lost the admin password: start the server once with <code>RESET_ADMIN_PASSWORD</code> set to a new password, sign in, then remove that setting.</p>
              </div>
            )}
          </>
        )}
      </form>
    </div>
  );
}

// The person's picture when there is one: this device's saved copy, or, for names
// the server lists, the server's. Otherwise a letter on a colour picked from the
// name, so each person keeps the same one.
function Avatar({ name, listed = false }: { name: string; listed?: boolean }) {
  const [broken, setBroken] = useState(false);
  const src = profilePicture(name) ?? (listed ? `/api/auth/avatar/${encodeURIComponent(name)}` : null);
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="profile-avatar" style={{ background: `linear-gradient(140deg, hsl(${h} 70% 56%), hsl(${(h + 40) % 360} 65% 40%))` }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
      {src && !broken && <img src={src} alt="" onError={() => setBroken(true)} />}
    </span>
  );
}

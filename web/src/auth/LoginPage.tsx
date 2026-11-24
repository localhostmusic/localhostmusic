import { useState } from "react";
import { api } from "../api";
import { Aurora } from "../ui/Aurora";
import { LogoMark } from "../ui/icons";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [forgot, setForgot] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api.login(u, p); onLogin(); } catch { setErr("Invalid login"); }
  }
  return (
    <div className="login-wrap">
      <Aurora />
      <form onSubmit={submit} className="login glass">
        <h1 className="brand"><span className="logo-mark brand-mark"><LogoMark size={44} /></span>localhost<span className="logo-accent">music</span></h1>
        <p className="tagline">your music, your server</p>
        <input placeholder="Username" value={u} onChange={e => setU(e.target.value)} />
        <input placeholder="Password" type="password" value={p} onChange={e => setP(e.target.value)} />
        <button type="submit">Sign in</button>
        {err && <p className="err">{err}</p>}
        <button type="button" className="link-btn login-forgot" onClick={() => setForgot(f => !f)} aria-expanded={forgot}>
          Forgot your password?
        </button>
        {forgot && (
          <div className="login-help">
            <p>Passwords live only on this server, so there is no email reset.</p>
            <p>Ask whoever runs it to set a new one for you under Settings, Users.</p>
            <p>If you run it and lost the admin password: start the server once with <code>RESET_ADMIN_PASSWORD</code> set to a new password, sign in, then remove that setting.</p>
          </div>
        )}
      </form>
    </div>
  );
}

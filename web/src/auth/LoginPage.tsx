import { useState } from "react";
import { api } from "../api";
import { Aurora } from "../ui/Aurora";
import { LogoMark } from "../ui/icons";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
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
      </form>
    </div>
  );
}

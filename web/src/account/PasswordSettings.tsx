import { useState } from "react";
import { api } from "../api";

// Change your own password. The server signs out every other device.
export function PasswordSettings() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(""); setErr("");
    if (next.length < 8) { setErr("Use at least 8 characters."); return; }
    if (next !== again) { setErr("The two new passwords don't match."); return; }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent(""); setNext(""); setAgain("");
      setMsg("Password changed. Your other devices were signed out.");
    } catch (e: any) {
      setErr(e?.message || "Could not change the password.");
    } finally { setBusy(false); }
  }

  return (
    <form className="password-form" onSubmit={submit}>
      <input type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password"
        value={current} onChange={e => setCurrent(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder="New password (8 or more characters)" aria-label="New password"
        value={next} onChange={e => setNext(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder="New password again" aria-label="New password again"
        value={again} onChange={e => setAgain(e.target.value)} />
      <div><button className="btn" type="submit" disabled={busy || !current || !next || !again}>{busy ? "Saving…" : "Change password"}</button></div>
      {msg && <p className="ok-msg">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </form>
  );
}

import { useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "./PlayerProvider";
import { SessionsIcon } from "../ui/icons";

// "Listen together" control: start a session (get a shareable code) or join one,
// then see who's listening. The host drives, guests mirror.
export function SessionPicker({ size = 18, className = "" }: { size?: number; className?: string }) {
  const p = usePlayer();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  if (!p.connected) return null; // needs the realtime channel
  const s = p.session;

  const copy = async () => {
    if (!s) return;
    try { await navigator.clipboard.writeText(s.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };
  const join = () => { if (code.trim()) { p.joinSession(code); setCode(""); } };

  const popover = open && createPortal(
    <>
      <div className="dp-backdrop" onClick={() => setOpen(false)} />
      <div className="dp-pop" role="menu">
        <div className="dp-head"><span>Listen together</span></div>

        {!s && (
          <>
            <button className="dp-device" onClick={() => p.startSession()} role="menuitem">
              <span className="dp-dot" />
              <span className="dp-name">Start a session</span>
              <span className="dp-status">Host</span>
            </button>
            <div className="session-join">
              <input
                className="session-code-in" placeholder="Enter code" value={code} maxLength={6}
                onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))}
                onKeyDown={e => { if (e.key === "Enter") join(); }}
              />
              <button className="btn" disabled={!code.trim()} onClick={join}>Join</button>
            </div>
            {p.sessionError && <p className="session-error">{p.sessionError}</p>}
          </>
        )}

        {s && (
          <>
            {s.role === "host" ? (
              <button className="session-code" onClick={copy} title="Copy code">
                <span className="session-code-label">Share this code</span>
                <span className="session-code-val">{s.code}</span>
                <span className="session-copy">{copied ? "Copied" : "Copy"}</span>
              </button>
            ) : (
              <div className="session-guest">Listening with <strong>{s.host || "host"}</strong> · <span className="session-code-val sm">{s.code}</span></div>
            )}
            {s.hostAway && <div className="session-away">Host disconnected. Waiting for them to reconnect…</div>}
            <div className="session-members">
              {s.members.map((m, i) => (
                <div key={i} className="session-member">
                  <span className="dp-dot" /><span className="dp-name">{m.name}</span>
                  {m.isHost && <span className="dp-tag">Host</span>}
                </div>
              ))}
            </div>
            <button className="dp-device danger" onClick={() => { p.leaveSession(); setOpen(false); }} role="menuitem">
              <span className="dp-name">{s.role === "host" ? "End session" : "Leave session"}</span>
            </button>
          </>
        )}

        {p.online.length > 0 && (
          <div className="presence">
            <div className="dp-subhead">Online now</div>
            {p.online.map(u => {
              // Ask to listen: I'm not in a session (if they aren't hosting,
              // accepting starts one). Invite: I'm hosting and they're not in my roster.
              const canAsk = !s;
              const canInvite = s?.role === "host" && !s.members.some(m => m.name === u.name);
              return (
                <div key={u.userId} className="presence-user">
                  <span className={`dp-dot${u.playing ? " on" : ""}`} />
                  <div className="presence-meta">
                    <span className="dp-name">{u.name}</span>
                    {u.track ? (
                      <span className="presence-track">{u.track.title}{u.track.artist ? ` · ${u.track.artist}` : ""}</span>
                    ) : (
                      <span className="presence-idle">Not playing</span>
                    )}
                  </div>
                  {u.isHost && !canAsk && <span className="dp-tag">Hosting</span>}
                  {canAsk && <button className="presence-act" onClick={() => p.askToJoin(u.userId)}>{u.isHost ? "Ask to join" : "Listen together"}</button>}
                  {canInvite && <button className="presence-act" onClick={() => p.inviteUser(u.userId)}>Invite</button>}
                </div>
              );
            })}
          </div>
        )}

        <label className="presence-toggle" title="When off, others can't see you online or ask you to listen">
          <input type="checkbox" checked={p.shareActivity} onChange={e => p.setShareActivity(e.target.checked)} />
          <span>Share my activity</span>
          {!p.shareActivity && <span className="presence-toggle-hint">You're invisible</span>}
        </label>
      </div>
    </>,
    document.body,
  );

  return (
    <>
      <button
        className={`ctl-toggle${s ? " active" : ""} ${className}`}
        onClick={() => setOpen(o => !o)}
        aria-label="Listen together" aria-pressed={!!s}
        title={s ? `Session ${s.code}` : "Listen together"}
      >
        <SessionsIcon size={size} />
      </button>
      {popover}
    </>
  );
}

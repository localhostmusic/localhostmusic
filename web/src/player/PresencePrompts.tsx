import { createPortal } from "react-dom";
import { usePlayer } from "./PlayerProvider";

// Toasts for listen-together prompts: join requests, invites, and transient notes
// (declined / error). Mounted once near the app root.
export function PresencePrompts() {
  const p = usePlayer();
  if (!p.joinRequest && !p.invite && !p.presenceNote) return null;
  return createPortal(
    <div className="presence-toasts">
      {p.joinRequest && (
        <div className="presence-toast">
          <span><strong>{p.joinRequest.fromName}</strong> wants to {p.session ? "join your session" : "listen together"}</span>
          <div className="presence-toast-actions">
            <button className="btn" onClick={() => p.respondJoin(p.joinRequest!.fromUserId, true)}>Accept</button>
            <button className="btn ghost" onClick={() => p.respondJoin(p.joinRequest!.fromUserId, false)}>Decline</button>
          </div>
        </div>
      )}
      {p.invite && (
        <div className="presence-toast">
          <span><strong>{p.invite.fromName}</strong> invited you to listen together</span>
          <div className="presence-toast-actions">
            <button className="btn" onClick={p.acceptInvite}>Join</button>
            <button className="btn ghost" onClick={p.dismissInvite}>Dismiss</button>
          </div>
        </div>
      )}
      {p.presenceNote && (
        <div className="presence-toast note" onClick={p.dismissPresenceNote}>{p.presenceNote}</div>
      )}
    </div>,
    document.body,
  );
}

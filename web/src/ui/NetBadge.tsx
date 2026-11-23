import { usePlayer } from "../player/PlayerProvider";
import { useOnline } from "./useOnline";

// Small status pill: shows when the device is offline, or when a stalled stream
// is being auto-resumed. Hidden when everything's healthy.
export function NetBadge() {
  const online = useOnline();
  const { reconnecting, playbackError, play } = usePlayer();
  if (online && !reconnecting && !playbackError) return null;
  return (
    <div className={`net-badge${online ? " reconnecting" : ""}`} role="status">
      <span className="net-dot" />
      {playbackError || (online ? "Reconnecting…" : "Offline")}
      {playbackError && <button onClick={play}>Play</button>}
    </div>
  );
}

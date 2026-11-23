import { useEffect, useState } from "react";

// The current user's profile picture, with a monogram fallback. A shared version
// (bumped on upload/removal) cache-busts the image URL so every instance updates at once.
let version = 0;
try { version = Number(localStorage.getItem("lhm-avatar-v") || "0"); } catch { /* */ }
const subs = new Set<() => void>();

export function bumpAvatar() {
  version = Date.now();
  try { localStorage.setItem("lhm-avatar-v", String(version)); } catch { /* */ }
  subs.forEach(f => f());
}

function useAvatarVersion() {
  const [v, setV] = useState(version);
  useEffect(() => {
    const f = () => setV(version);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return v;
}

export function MyAvatar({ username, size = 32, className = "" }: {
  username: string;
  size?: number;
  className?: string;
}) {
  const v = useAvatarVersion();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [v]); // re-try the image whenever it changes
  const initial = (username || "?").slice(0, 1).toUpperCase();
  return (
    <span className={`my-avatar ${className}`} style={{ width: size, height: size }}>
      {!failed && <img src={`/api/me/avatar?v=${v}`} alt="" onError={() => setFailed(true)} />}
      {failed && <span className="my-avatar-i" style={{ fontSize: Math.round(size * 0.42) }}>{initial}</span>}
    </span>
  );
}

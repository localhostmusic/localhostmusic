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
  // Re-try the image when it changes, and when a different person signs in.
  useEffect(() => { setFailed(false); }, [v, username]);
  const initial = (username || "?").slice(0, 1).toUpperCase();
  // The address names the user. The server answers for whoever is signed in, so one
  // shared address let the browser show the previous person's picture after a switch.
  const src = `/api/me/avatar?u=${encodeURIComponent(username)}&v=${v}`;
  return (
    <span className={`my-avatar ${className}`} style={{ width: size, height: size }}>
      {!failed && <img key={src} src={src} alt="" onError={() => setFailed(true)} />}
      {failed && <span className="my-avatar-i" style={{ fontSize: Math.round(size * 0.42) }}>{initial}</span>}
    </span>
  );
}

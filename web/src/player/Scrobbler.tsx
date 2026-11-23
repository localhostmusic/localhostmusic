import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { ListeningClock } from "./listening";

export function Scrobbler() {
  const p = usePlayer();
  const t = usePlayerTime();
  const [enabled, setEnabled] = useState(false);
  const play = useRef({ key: "", clock: new ListeningClock(), started: 0, announced: false, sent: false, pending: false, retryAt: 0 });
  useEffect(() => {
    let live = true;
    const refresh = () => api.scrobbleAccounts().then(r => { if (live) setEnabled((r?.accounts?.length ?? 0) > 0); }).catch(() => {});
    refresh();
    window.addEventListener("lhm-scrobble-changed", refresh);
    return () => { live = false; window.removeEventListener("lhm-scrobble-changed", refresh); };
  }, []);
  useEffect(() => {
    const cur = p.current;
    const key = `${cur?.id}:${p.playbackInstance}`;
    if (play.current.key !== key) play.current = { key, clock: new ListeningClock(), started: Date.now(), announced: false, sent: false, pending: false, retryAt: 0 };
    const state = play.current;
    const playing = enabled && p.isActiveDevice && p.isPlaying && !p.buffering;
    const heard = state.clock.tick(t.currentTime, Date.now(), playing, p.effectiveRate);
    if (!playing || !cur || cur.id < 0 || state.pending || Date.now() < state.retryAt) return;
    const duration = t.duration || cur.duration || 0;
    const listen = duration >= 30 && heard >= Math.max(30, Math.min(duration / 2, 240)) && !state.sent;
    if (state.announced && !listen) return;
    state.pending = true;
    const request = listen ? api.scrobbleListen(cur.id, state.started) : api.scrobbleNowPlaying(cur.id);
    request.then(result => {
      if (!result?.ok) throw new Error("Scrobble was not accepted");
      if (listen) state.sent = true; else state.announced = true;
    }).catch(() => { state.retryAt = Date.now() + 15_000; }).finally(() => { state.pending = false; });
  }, [enabled, p.current?.id, p.playbackInstance, p.isActiveDevice, p.isPlaying, p.buffering, p.effectiveRate, t.currentTime, t.duration]);
  return null;
}

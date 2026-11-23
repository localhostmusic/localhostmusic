import { useEffect, useRef } from "react";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { api } from "../api";
import { dlog } from "../ui/debugLog";

// OS controls follow the transport directly: background media events can arrive
// without a React commit. React ticks still refresh a remotely controlled player.
export function MediaSession() {
  const p = usePlayer();
  const t = usePlayerTime();
  const live = useRef(p);
  live.current = p;
  const syncRef = useRef<() => void>(() => {});
  const supported = typeof navigator !== "undefined" && "mediaSession" in navigator;

  useEffect(() => {
    if (!supported) return;
    const ms = navigator.mediaSession;
    let metadataKey: string | undefined;
    let previousState: MediaSessionPlaybackState | undefined;
    let positionKey: string | undefined;
    let positionAt = 0;
    let lastPosition = 0;
    let presentationAt = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshAfterEvent = () => {
      if (refreshTimer !== undefined) return;
      // Media events and the OS action itself can update WebKit's presentation
      // after our synchronous handler. Re-read the transport in the next task.
      refreshTimer = setTimeout(() => { refreshTimer = undefined; sync(true); }, 0);
    };
    const sync = (force = false) => {
      const now = Date.now();
      const s = live.current.getMediaSessionState();
      const current = s.current;
      const state = current ? (s.playing ? "playing" : "paused") : "none";
      const changed = state !== previousState;
      const resumed = changed && state === "playing";
      const title = current?.isAudiobook ? (current.album || current.title) : current?.title;
      const key = JSON.stringify([current?.id, title, current?.artist, current?.album, current?.albumId, current?.artUrl]);
      const trackChanged = key !== metadataKey;
      // iOS can lose the lock-screen card while JS metadata/playbackState look
      // intact, so republish every 10s of playback. Reassigning metadata notifies
      // WebKit even when setting an identical playbackState is a no-op.
      const refreshPresentation = trackChanged || force || resumed || ms.playbackState !== state
        || (!!current && !ms.metadata) || (state === "playing" && now - presentationAt >= 10_000);
      // Re-register the action handlers with every republish. WebKit only forwards
      // setActionHandler to iOS while its remote-command listener exists. That
      // listener is created once media plays and torn down, with every registered
      // command, whenever the page briefly has no media session.
      if (refreshPresentation) bindHandlers();
      if (changed || refreshPresentation) {
        try { ms.playbackState = state; previousState = state; }
        catch { dlog("media session playback update failed"); }
      }
      if (refreshPresentation) {
        try {
          if (!current) ms.metadata = null;
          else {
            const src = current.albumId != null ? api.coverUrl(current.albumId, 512) : current.artUrl;
            const artwork = src ? [96, 256, 512].map(size => ({
              src: new URL(src, location.origin).href, sizes: `${size}x${size}`, type: "image/jpeg",
            })) : [];
            ms.metadata = new MediaMetadata({ title, artist: current.artist ?? "", album: current.album ?? "", artwork });
          }
          metadataKey = key;
          presentationAt = now;
        } catch { dlog("media session metadata update failed"); }
        document.title = current ? `${title}${current.artist ? " - " + current.artist : ""} · Localhost Music` : "Localhost Music";
      }
      const duration = s.duration;
      const position = Math.max(0, Math.min(s.currentTime, duration));
      const rate = Number.isFinite(s.effectiveRate) && s.effectiveRate > 0 ? s.effectiveRate : 1;
      const nextPositionKey = JSON.stringify([current?.id, duration, rate]);
      // Event-driven, at most once a second for ordinary progress. Seek, pause,
      // resume, new metadata and lifecycle events publish immediately.
      if (refreshPresentation || changed || nextPositionKey !== positionKey || now - positionAt >= 1000 || Math.abs(position - lastPosition) > 2) {
        try {
          if (!current || !Number.isFinite(duration) || duration <= 0) ms.setPositionState?.();
          else ms.setPositionState?.({ duration, position, playbackRate: rate });
          positionKey = nextPositionKey; positionAt = now; lastPosition = position;
        } catch { dlog("media session position update failed"); }
      }
      if (changed || trackChanged || force) dlog(`media session track=${current?.id ?? "none"} state=${state} at=${s.currentTime.toFixed(1)} visibility=${document.visibilityState}`);
      if (changed || trackChanged) refreshAfterEvent();
    };
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { ms.setActionHandler(action, handler); } catch { /* unsupported action */ }
    };
    const refresh = () => { sync(true); refreshAfterEvent(); };
    // Stable handler identities, so re-binding them is a no-op for the browser.
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ["play", () => { dlog("media session action play"); live.current.play(); refresh(); }],
      ["pause", () => { dlog("media session action pause"); live.current.pause(); refresh(); }],
      ["previoustrack", () => { dlog("media session action previoustrack"); live.current.prev(); refresh(); }],
      ["nexttrack", () => { dlog("media session action nexttrack"); live.current.next(); refresh(); }],
      ["seekto", d => { if (d.seekTime != null) { live.current.seek(d.seekTime); refresh(); } }],
      // iOS gives time-skip actions precedence over previous/next track buttons.
      // Keep the scrubber, but expose only track navigation beside play/pause.
      ["seekbackward", null],
      ["seekforward", null],
    ];
    function bindHandlers() { for (const [action, handler] of handlers) set(action, handler); }
    bindHandlers();
    const onTransport = () => sync();
    const unsubscribe = live.current.subscribeTransport(onTransport);
    // Flush before suspension as well as restoring on return (including bfcache).
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("pagehide", refresh);
    syncRef.current = onTransport;
    sync(true);
    return () => {
      syncRef.current = () => {};
      unsubscribe();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("pagehide", refresh);
      (["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as MediaSessionAction[]).forEach(a => set(a, null));
    };
  }, [supported]);

  useEffect(() => { syncRef.current(); }, [p, t.currentTime]);
  return null;
}

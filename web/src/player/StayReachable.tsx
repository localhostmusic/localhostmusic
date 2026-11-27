import { useEffect, useRef } from "react";
import { usePlayer } from "./PlayerProvider";
import { dlog } from "../ui/debugLog";

// Keeps a locked phone reachable for a while after its music stops.
//
// A locked phone only keeps a web app running while the app is producing sound.
// About fifteen seconds after a pause, or after the queue runs out, the app is
// frozen and its connection drops, so a song picked on another device has nowhere
// to go and that device starts playing it itself. While this device is the one
// playing, this plays silence for a few minutes after the music stops, which keeps
// the app (and the connection) alive so another device can start the next song here.
//
// Off unless switched on in Account > Diagnostics (localStorage lhm-stay-reachable).

const KEEP_MS = 10 * 60 * 1000;

export const stayReachableOn = () => {
  try { return localStorage.getItem("lhm-stay-reachable") === "1"; } catch { return false; }
};

/** Ten seconds of silence: 8 kHz, 8-bit, mono WAV. */
function silenceUrl(): string {
  const rate = 8000, samples = rate * 10;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + samples, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  text(36, "data"); v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(0x80); // 8-bit silence is the midpoint, not zero
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export function StayReachable() {
  const on = useRef(stayReachableOn()).current;
  const { isPlaying, isActiveDevice, current } = usePlayer();
  const elRef = useRef<HTMLAudioElement | null>(null);
  const ours = useRef(false); // true while a pause of the element is our own doing

  // The element, made once. A phone only lets a page start sound by itself on an
  // element the user has already started with a tap, so the first tap anywhere
  // starts it and stops it straight away.
  useEffect(() => {
    if (!on) return;
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.src = silenceUrl();
    elRef.current = el;
    const bless = () => {
      if (!el.paused) return;
      ours.current = true;
      el.play().then(() => { el.pause(); }, () => { /* tried again on the next tap */ })
        .finally(() => { ours.current = false; });
    };
    window.addEventListener("pointerdown", bless, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", bless, { capture: true });
      try { el.pause(); } catch { /* */ }
      URL.revokeObjectURL(el.src);
      elRef.current = null;
    };
  }, [on]);

  // Silence runs while this device holds the session with its music stopped.
  const want = on && isActiveDevice && !isPlaying && !!current;
  useEffect(() => {
    const el = elRef.current;
    if (!el || !want) return;
    let stopped = false;
    const stop = (why: string) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      el.removeEventListener("pause", onPause);
      ours.current = true;
      try { el.pause(); } catch { /* */ }
      ours.current = false;
      dlog(`reachable stop (${why})`);
    };
    // Something else took the phone's sound (a call, another app): let it.
    const onPause = () => { if (!ours.current) stop("interrupted"); };
    const timer = setTimeout(() => stop("timeout"), KEEP_MS);
    el.addEventListener("pause", onPause);
    el.play().then(() => dlog("reachable start"), e => { dlog(`reachable refused: ${e?.name ?? e}`); stop("refused"); });
    return () => stop("not needed");
  }, [want]);

  return null;
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api";

// Decodes a small transcoded copy of the track to draw a static waveform, with a
// playhead and click-to-seek.
export function Waveform({ trackId, currentTime, duration, onSeek }: {
  trackId: number;
  currentTime: number;
  duration: number;
  onSeek: (t: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    (async () => {
      // Close the context even when decode fails: browsers cap the number of
      // live AudioContexts.
      let ctx: AudioContext | null = null;
      try {
        const res = await fetch(api.streamUrl(trackId, 96), { credentials: "include" });
        const buf = await res.arrayBuffer();
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        ctx = new AC();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const N = 480;
        const block = Math.max(1, Math.floor(data.length / N));
        const pk: number[] = new Array(N);
        for (let i = 0; i < N; i++) {
          let max = 0;
          const start = i * block;
          for (let j = 0; j < block; j += 32) {
            const v = Math.abs(data[start + j] || 0);
            if (v > max) max = v;
          }
          pk[i] = max;
        }
        if (!cancelled) setPeaks(pk);
      } catch {
        if (!cancelled) setPeaks([]);
      } finally {
        try { ctx?.close(); } catch { /* */ }
      }
    })();
    return () => { cancelled = true; };
  }, [trackId]);

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !peaks || !peaks.length) return;
    const draw = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const c = canvas.getContext("2d");
      if (!c) return;
      c.scale(dpr, dpr);
      c.clearRect(0, 0, w, h);
      c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#888";
      const n = peaks.length, bw = w / n;
      for (let i = 0; i < n; i++) {
        const bh = Math.max(2, peaks[i] * h * 0.92);
        c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw * 0.55), bh);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [peaks]);

  const pct = duration ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  function onClick(e: React.MouseEvent) {
    const wrap = wrapRef.current;
    if (!wrap || !duration) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(duration, ratio * duration)));
  }

  return (
    <div className="waveform" ref={wrapRef} onClick={onClick} title="Click to scrub">
      {peaks === null && <span className="waveform-loading">Loading waveform…</span>}
      <canvas ref={canvasRef} className="waveform-canvas" />
      <div className="waveform-playhead" style={{ left: `${pct}%` }} />
    </div>
  );
}

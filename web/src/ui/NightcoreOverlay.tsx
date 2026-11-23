import { useEffect, useRef } from "react";
import { usePlayer } from "../player/PlayerProvider";
import { accentTriad, triadCss, type Triad } from "../player/vizCommon";

// Full-screen dressing for nightcore mode: CSS CRT scanlines plus a canvas that follows
// the vibe dial. At 1x and above: light beams, a bass floor-wash and rising glitter, driven
// by the analyser's bass energy (or a synthetic pulse without an audio graph). Below 1x:
// falling sakura petals. No full-screen strobes; nothing animates under prefers-reduced-motion.

interface Particle {
  kind: "petal" | "dust";
  x: number; y: number;      // position (px)
  vy: number;                // vertical speed (px/s); petals fall (+), dust rises (-)
  drift: number;             // horizontal sway amplitude (px)
  phase: number;             // sway/twinkle phase offset
  spin: number;              // rotation speed (rad/s)
  rot: number;
  size: number;              // draw scale
  alpha: number;
}

const PARTICLE_COUNT = 30;
// Moving heads: pivot x (fraction of width), sweep half-range (rad), speed, phase.
const BEAMS = [
  { px: 0.12, range: 0.42, speed: 0.55, phase: 0.0 },
  { px: 0.38, range: 0.34, speed: 0.72, phase: 2.1 },
  { px: 0.62, range: 0.34, speed: 0.64, phase: 4.2 },
  { px: 0.88, range: 0.42, speed: 0.5, phase: 1.2 },
];

function makePetalSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 24; c.height = 24;
  const ctx = c.getContext("2d")!;
  // A soft pink teardrop: two quadratic lobes with a lighter core.
  const g = ctx.createRadialGradient(12, 10, 1, 12, 12, 12);
  g.addColorStop(0, "rgba(255, 214, 236, 0.95)");
  g.addColorStop(0.7, "rgba(255, 150, 214, 0.85)");
  g.addColorStop(1, "rgba(255, 110, 196, 0.0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(12, 2);
  ctx.quadraticCurveTo(22, 8, 12, 22);
  ctx.quadraticCurveTo(2, 8, 12, 2);
  ctx.fill();
  return c;
}

function makeDustSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const ctx = c.getContext("2d")!;
  // Glitter mote: a tiny soft glow disc (catchlights in the haze).
  const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, "rgba(255, 255, 255, 0.9)");
  g.addColorStop(0.4, "rgba(220, 240, 255, 0.4)");
  g.addColorStop(1, "rgba(200, 230, 255, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return c;
}

export function NightcoreOverlay() {
  const p = usePlayer();
  const { nightcore, vibe } = p;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The loop reads these each frame through refs, so dragging the dial retunes
  // speed/scene live and the analyser hookup survives re-renders.
  const vibeRef = useRef(vibe);
  vibeRef.current = vibe;
  const getAnalyserRef = useRef(p.getAnalyser);
  getAnalyserRef.current = p.getAnalyser;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!nightcore || !canvas) return;
    if (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const petalSprite = makePetalSprite();
    const dustSprite = makeDustSprite();
    // Cap DPR: everything here is soft-edged glow, extra resolution is invisible.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0, h = 0;
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const spawn = (offscreen: boolean): Particle => {
      return vibeRef.current >= 1 ? {
        kind: "dust",
        x: rnd(-20, w + 20),
        y: offscreen ? rnd(h + 10, h + 40) : rnd(0, h),
        vy: -rnd(70, 160), // glitter rises fast
        drift: rnd(3, 12),
        phase: rnd(0, Math.PI * 2),
        spin: 0,
        rot: 0,
        size: rnd(0.3, 1.0),
        alpha: rnd(0.3, 0.8),
      } : {
        kind: "petal",
        x: rnd(-30, w + 30),
        y: offscreen ? rnd(-40, -10) : rnd(0, h),
        vy: rnd(28, 70),
        drift: rnd(12, 44),
        phase: rnd(0, Math.PI * 2),
        spin: rnd(-1.2, 1.2),
        rot: rnd(0, Math.PI * 2),
        size: rnd(0.45, 1.1),
        alpha: rnd(0.35, 0.8),
      };
    };
    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => spawn(false));

    // Beat detection (desktop: real bass, fallback: synthetic pulse)
    let analyser: AnalyserNode | null = null;
    let freq: Uint8Array | null = null;
    let analyserRetry = 0;
    let bassAvg = 0.22; // slow-moving energy baseline the beats poke above
    let flash = 0;      // beat envelope, decays fast
    const bassPulse = (t: number, dt: number, speed: number): number => {
      if (!analyser && analyserRetry-- <= 0) {
        analyserRetry = 120; // ~2s between attempts; graph may not exist yet
        try { analyser = getAnalyserRef.current(); } catch { analyser = null; }
        if (analyser) freq = new Uint8Array(analyser.frequencyBinCount);
      }
      let bass: number;
      if (analyser && freq) {
        analyser.getByteFrequencyData(freq as Uint8Array<ArrayBuffer>);
        let s = 0;
        for (let i = 1; i <= 24; i++) s += freq[i];
        bass = s / 24 / 255;
        bassAvg = bassAvg * 0.99 + bass * 0.01;
        if (bass > bassAvg * 1.22 && bass > 0.25 && flash < 0.35) flash = 1;
      } else {
        // No analyser (mobile / graph not built): breathe at about 2 beats/sec times the dial.
        bass = 0.45 + 0.3 * Math.sin(t * 4.2 * speed);
        bassAvg = 0.45;
      }
      flash = Math.max(0, flash - dt * 3.2);
      const lift = Math.max(0, Math.min(1, (bass - bassAvg) / (bassAvg + 0.05) * 2));
      return Math.min(1, lift * 0.7 + flash * 0.6);
    };

    // Accent triad for the beams, refreshed ~1/s so it follows palette transitions.
    let triad: Triad = accentTriad();
    let triadAge = 0;

    const drawClub = (t: number, speed: number, pulse: number) => {
      // Moving-head beams from above the top edge, additive so crossings bloom.
      ctx.globalCompositeOperation = "lighter";
      const len = h * 1.45;
      for (let i = 0; i < BEAMS.length; i++) {
        const b = BEAMS[i];
        const ang = Math.sin(t * b.speed * (0.7 + speed * 0.55) + b.phase) * b.range;
        const col = triad[i % 3];
        ctx.save();
        ctx.translate(b.px * w, -40);
        ctx.rotate(ang);
        const grad = ctx.createLinearGradient(0, 0, 0, len);
        grad.addColorStop(0, triadCss(col, 0.34));
        grad.addColorStop(0.75, triadCss(col, 0.07));
        grad.addColorStop(1, triadCss(col, 0));
        ctx.fillStyle = grad;
        ctx.globalAlpha = 0.28 + 0.5 * pulse;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-w * 0.055, len);
        ctx.lineTo(w * 0.055, len);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      // Bass floor-wash: the glow off the dance floor.
      const wash = ctx.createRadialGradient(w / 2, h * 1.05, 0, w / 2, h * 1.05, h * 0.75);
      wash.addColorStop(0, triadCss(triad[0], 0.10 + 0.16 * pulse));
      wash.addColorStop(1, triadCss(triad[0], 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const speed = vibeRef.current;
      const t = now / 1000;
      ctx.clearRect(0, 0, w, h);

      if ((triadAge += dt) > 1) { triadAge = 0; triad = accentTriad(); }
      const club = speed >= 1;
      const pulse = club ? bassPulse(t, dt, speed) : 0;
      if (club) drawClub(t, speed, pulse);

      for (let i = 0; i < particles.length; i++) {
        let p2 = particles[i];
        // Dust rises at 2.5x the dial's pace, petals drift at 1x.
        const mult = p2.kind === "dust" ? speed * 2.5 : speed;
        p2.y += p2.vy * mult * dt;
        p2.rot += p2.spin * speed * dt;
        // Wrong-side particles (dial crossed 1x) fade out over about 3s and respawn as
        // the other kind. Drifting offscreen could take a minute at slow rates.
        const mismatched = (p2.kind === "dust") !== club;
        if (mismatched) p2.alpha -= dt * 0.3;
        if (p2.y > h + 30 || p2.y < -40 || p2.alpha <= 0.05) { particles[i] = p2 = spawn(true); }
        const x = p2.x + Math.sin(t * 0.9 + p2.phase) * p2.drift;
        // Dust twinkles with the beat lighting; petals hold steady.
        const a = p2.kind === "dust"
          ? p2.alpha * (0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3 * speed + p2.phase * 3)) + 0.25 * pulse)
          : p2.alpha;
        ctx.globalAlpha = Math.min(1, a);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(x, p2.y);
        ctx.rotate(p2.rot);
        ctx.scale(p2.size, p2.size);
        if (p2.kind === "dust") ctx.drawImage(dustSprite, -8, -8);
        else ctx.drawImage(petalSprite, -12, -12);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
    };
    const start = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    const onVis = () => { document.visibilityState === "visible" ? start() : stop(); };
    document.addEventListener("visibilitychange", onVis);
    start();

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [nightcore]);

  if (!nightcore) return null;
  return (
    <>
      <canvas ref={canvasRef} className="nc-petals" aria-hidden />
      <div className="nc-scanlines" aria-hidden />
    </>
  );
}

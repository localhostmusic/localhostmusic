import { useEffect, useRef, useState } from "react";
import { accentTriad, triadCss, shapeAmp, freqAvgAll, vissonanceBins } from "./vizCommon";

// bars / wave / radial. Shapes are drawn on a black offscreen 2D canvas in the
// album-accent triad, then composited through a bloom chain (half-res ping-pong
// Gaussian, tonemap).
// Bars/radial levels come from vissonanceBins over bins 4..1300 at fftSize 4096:
// absolute values, no auto-gain, the analyser's smoothing is the only envelope.

const QUAD_VERT = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const BLUR_FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_horizontal;
varying vec2 v_uv;
void main(){
  float w0 = 0.227027, w1 = 0.1945946, w2 = 0.1216216, w3 = 0.054054, w4 = 0.016216;
  vec2 dir = u_horizontal > 0.5 ? vec2(u_texel.x, 0.0) : vec2(0.0, u_texel.y);
  vec3 result = texture2D(u_tex, v_uv).rgb * w0;
  result += texture2D(u_tex, v_uv + dir * 1.0).rgb * w1;
  result += texture2D(u_tex, v_uv - dir * 1.0).rgb * w1;
  result += texture2D(u_tex, v_uv + dir * 2.0).rgb * w2;
  result += texture2D(u_tex, v_uv - dir * 2.0).rgb * w2;
  result += texture2D(u_tex, v_uv + dir * 3.0).rgb * w3;
  result += texture2D(u_tex, v_uv - dir * 3.0).rgb * w3;
  result += texture2D(u_tex, v_uv + dir * 4.0).rgb * w4;
  result += texture2D(u_tex, v_uv - dir * 4.0).rgb * w4;
  gl_FragColor = vec4(result, 1.0);
}
`;

const BLEND_FRAG = `
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_glow;   // bloom weight, pulsed by the music
varying vec2 v_uv;
void main(){
  vec3 color = texture2D(u_scene, v_uv).rgb + texture2D(u_bloom, v_uv).rgb * u_glow;
  vec3 result = vec3(1.0) - exp(-color * 1.6);
  result = pow(result, vec3(1.0 / 2.4));
  float luma = dot(result, vec3(0.299, 0.587, 0.114));
  result = clamp(mix(vec3(luma), result, 1.5), 0.0, 1.0);
  gl_FragColor = vec4(result, 1.0);
}
`;

export function GlowVisualizer({ analyser, style }: { analyser: AnalyserNode; style: "bars" | "wave" | "radial" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }
    const src = document.createElement("canvas");
    const ctx = src.getContext("2d");
    if (!ctx) { setStatus("Canvas unavailable"); return; }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // canvas uploads arrive right-side-up

    const compile = (vsSrc: string, fsSrc: string) => {
      const sh = (type: number, s: string) => {
        const o = gl.createShader(type)!;
        gl.shaderSource(o, s); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) { console.warn("glow shader:", gl.getShaderInfoLog(o)); return null; }
        return o;
      };
      const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
      if (!vs || !fs) return null;
      const p = gl.createProgram()!;
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, "a_pos");
      gl.linkProgram(p);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn("glow link:", gl.getProgramInfoLog(p)); return null; }
      return p;
    };
    const blurProg = compile(QUAD_VERT, BLUR_FRAG);
    const blendProg = compile(QUAD_VERT, BLEND_FRAG);
    if (!blurProg || !blendProg) { setStatus("Shader compile failed"); return; }

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const drawQuad = (prog: WebGLProgram) => {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const bu = {
      tex: gl.getUniformLocation(blurProg, "u_tex"),
      texel: gl.getUniformLocation(blurProg, "u_texel"),
      horizontal: gl.getUniformLocation(blurProg, "u_horizontal"),
    };
    const cu = {
      scene: gl.getUniformLocation(blendProg, "u_scene"),
      bloom: gl.getUniformLocation(blendProg, "u_bloom"),
      glow: gl.getUniformLocation(blendProg, "u_glow"),
    };

    const mkTex = (w: number, h: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t!;
    };
    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const blurFBOs = [gl.createFramebuffer(), gl.createFramebuffer()];
    const blurTexs: (WebGLTexture | null)[] = [null, null];
    let bw = 2, bh = 2;

    const resize = () => {
      const w = Math.max(2, Math.floor(canvas.clientWidth));
      const h = Math.max(2, Math.floor(canvas.clientHeight));
      canvas.width = w; canvas.height = h;
      src.width = w; src.height = h;
      bw = Math.max(2, Math.floor(w / 2)); bh = Math.max(2, Math.floor(h / 2));
      for (let i = 0; i < 2; i++) {
        if (blurTexs[i]) gl.deleteTexture(blurTexs[i]);
        blurTexs[i] = mkTex(bw, bh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFBOs[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blurTexs[i], 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Vissonance meters run fftSize 4096 (finer bass bins). Restore on unmount.
    let prevFft = 2048;
    try { prevFft = analyser.fftSize; analyser.fftSize = 4096; } catch { /* shared/locked */ }
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const time = new Uint8Array(analyser.fftSize);
    // Spectrum range 4..1300 of 2048 bins, scaled if the analyser stayed smaller.
    const fscale = analyser.frequencyBinCount / 2048;
    const binStart = Math.round(4 * fscale), binEnd = Math.round(1300 * fscale);
    const BARS = 64;
    const caps = new Float32Array(BARS);
    // Wave: slow AGC on the time-domain swing so quiet masters still fill the frame.
    let waveAmp = 0.5;
    let lastTick = 0;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      if (now - lastTick < 15) return; // 60Hz analysis cadence on any display
      lastTick = now;
      const w = src.width, h = src.height;
      const t = now / 1000;
      analyser.getByteFrequencyData(freq);
      const loud = freqAvgAll(freq); // raw 0..1 all-bin mean
      // Hue swings with loudness, anchored at the album accent.
      const triad = accentTriad(-loud * 256 * 2.2);
      // Glow drive: response curve over the all-bin average.
      const glowK = Math.min(1, shapeAmp(loud) * 1.6);

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);

      if (style === "bars") {
        const bins = vissonanceBins(freq, BARS, binStart, binEnd);
        // Loudness pedestal: every bar sits on a floor that rises with the whole mix.
        const lift = loud * 0.3;
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, triadCss(triad[0]));
        grad.addColorStop(0.5, triadCss(triad[1]));
        grad.addColorStop(1, triadCss(triad[2]));
        ctx.fillStyle = grad;
        const bwd = w / BARS;
        for (let i = 0; i < BARS; i++) {
          const amp = Math.min(1, Math.max(bins[i], 1 / 255) + lift);
          const bh2 = amp * h * 0.72;
          const x = i * bwd + bwd * 0.18, bwidth = bwd * 0.64, y = h * 0.82 - bh2;
          const r = Math.min(bwidth / 2, Math.max(1, bh2));
          ctx.beginPath();
          ctx.moveTo(x, h * 0.82);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.lineTo(x + bwidth - r, y);
          ctx.quadraticCurveTo(x + bwidth, y, x + bwidth, y + r);
          ctx.lineTo(x + bwidth, h * 0.82);
          ctx.closePath();
          ctx.fill();
          caps[i] = amp > caps[i] ? amp : Math.max(0, caps[i] - 0.02);
          const cy = h * 0.82 - caps[i] * h * 0.72;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, Math.max(1, cy - 3), bwidth, 2);
          ctx.globalAlpha = 1;
        }
        // Mirrored reflection below the baseline, fading out.
        ctx.save();
        ctx.translate(0, h * 1.64);
        ctx.scale(1, -1);
        ctx.globalAlpha = 0.16;
        for (let i = 0; i < BARS; i++) {
          const amp = Math.min(1, Math.max(bins[i], 1 / 255) + lift);
          ctx.fillRect(i * bwd + bwd * 0.18, h * 0.82 - amp * h * 0.24, bwd * 0.64, amp * h * 0.24);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      } else if (style === "wave") {
        analyser.getByteTimeDomainData(time);
        // Slow AGC on the swing.
        let swing = 0;
        for (let i = 0; i < time.length; i++) swing = Math.max(swing, Math.abs(time[i] - 128) / 128);
        waveAmp = swing > waveAmp ? waveAmp * 0.7 + swing * 0.3 : Math.max(0.12, waveAmp * 0.995 + swing * 0.005);
        const yGain = (h * 0.42) / waveAmp;
        // Two traces from the triad, the second mirrored around the center.
        const trace = (col: string, sign: 1 | -1, alpha: number, lw: number) => {
          ctx.strokeStyle = col; ctx.globalAlpha = alpha; ctx.lineWidth = lw;
          ctx.beginPath();
          for (let i = 0; i < time.length; i++) {
            const x = (i / time.length) * w;
            const y = h / 2 + sign * ((time[i] - 128) / 128) * yGain;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
          ctx.stroke();
        };
        trace(triadCss(triad[0]), 1, 1, 2.2);
        trace(triadCss(triad[1]), -1, 0.65, 1.6);
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = triadCss(triad[2]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        const RB = 48;
        const bins = vissonanceBins(freq, RB, binStart, binEnd);
        // Core radius follows raw loudness, the rim spikes with the spectrum.
        const cx = w / 2, cy = h / 2, R = Math.min(w, h) * (0.13 + loud * 0.10), n = 96;
        // Two mirrored-spectrum blobs, the second rotated so they interleave,
        // plus a faint outer ring in the third color.
        const blob = (col: [number, number, number], rot: number, scale: number, alpha: number, lw: number, fill: boolean) => {
          const pts: [number, number][] = [];
          for (let i = 0; i < n; i++) {
            const k = i <= n / 2 ? i : n - i;
            const amp = bins[Math.min(RB - 1, k)];
            const ang = (i / n) * Math.PI * 2 + rot;
            const rr = R * scale + amp * Math.min(w, h) * 0.3 * scale;
            pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
          }
          const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          ctx.strokeStyle = triadCss(col); ctx.globalAlpha = alpha; ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(...mid(pts[n - 1], pts[0]));
          for (let i = 0; i < n; i++) ctx.quadraticCurveTo(pts[i][0], pts[i][1], ...mid(pts[i], pts[(i + 1) % n]));
          ctx.closePath();
          // No fill: the composite's gamma lift turns any nonzero fill into a
          // solid disc.
          void fill;
          ctx.stroke();
        };
        blob(triad[0], t * 0.1, 1, 1, 2.4, false);
        blob(triad[1], t * -0.16 + Math.PI / n, 0.82, 0.7, 1.6, false);
        blob(triad[2], t * 0.05, 1.22, 0.3, 1, false);
        ctx.globalAlpha = 1;
      }

      // Bloom chain: upload 2D canvas, half-res ping-pong blur, composite.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

      gl.viewport(0, 0, bw, bh);
      gl.useProgram(blurProg);
      gl.uniform2f(bu.texel, 1 / bw, 1 / bh);
      gl.uniform1i(bu.tex, 0);
      let horizontal = 1, first = true;
      for (let i = 0; i < 6; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFBOs[horizontal]);
        gl.uniform1f(bu.horizontal, horizontal);
        gl.bindTexture(gl.TEXTURE_2D, first ? srcTex : blurTexs[1 - horizontal]);
        drawQuad(blurProg);
        horizontal = 1 - horizontal;
        first = false;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(blendProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, blurTexs[1 - horizontal]);
      gl.uniform1i(cu.scene, 0);
      gl.uniform1i(cu.bloom, 1);
      gl.uniform1f(cu.glow, 0.45 + glowK * 1.1); // bloom follows the music
      drawQuad(blendProg);
      gl.activeTexture(gl.TEXTURE0);
    };
    render();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      try { analyser.fftSize = prevFft; } catch { /* */ }
      gl.deleteProgram(blurProg); gl.deleteProgram(blendProg);
      gl.deleteBuffer(quadBuf); gl.deleteTexture(srcTex);
      blurTexs.forEach(tx => tx && gl.deleteTexture(tx));
      blurFBOs.forEach(f => gl.deleteFramebuffer(f));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [analyser, style]);

  return (
    <div className="viz-wrap">
      <canvas ref={canvasRef} className="viz-canvas" />
      {status && <div className="viz-status">{status}</div>}
    </div>
  );
}

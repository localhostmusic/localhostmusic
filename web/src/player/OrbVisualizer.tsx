import { useEffect, useRef, useState } from "react";
import { accentTriad, shapeAmp, freqAvgAll } from "./vizCommon";

// The "orb" visualizer, inspired by wayne-wu/webgl-music-visualizer (reimplemented,
// not their code): a sphere of soft points displaced by 3D simplex-noise FBM, with
// amplitude driven by the audio and additive blending for the glow.

// 3D simplex noise from webgl-noise, Copyright (C) 2011 Ashima Arts, MIT License
// (see THIRD-PARTY-NOTICES.md), into FBM, then displace, rotate, project.
const VERT = `
precision highp float;
attribute vec3 pos;
uniform mat4 u_proj;
uniform float u_time, u_rotY, u_rotX, u_dist, u_px, u_beat;
uniform float u_radius, u_freq, u_phase, u_disp, u_tscale, u_band; // per-layer (u_band = this layer's frequency band)
varying float v_f;
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm(vec3 p){ float f = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { f += a * snoise(p); p *= 2.0; a *= 0.5; } return f; }
mat3 rY(float a){ float s = sin(a), c = cos(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rX(float a){ float s = sin(a), c = cos(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
void main(){
  float f = fbm(pos * u_freq + vec3(u_phase) + vec3(0.0, 0.0, u_time * u_tscale));
  v_f = f;
  // Whole sphere BREATHES with its band (obvious reaction) + surface ripples.
  float scale = 1.0 + u_band * 0.4 + u_beat * 0.22;
  float d = u_radius * scale + f * (u_disp + u_band * 0.9);
  vec3 wp = pos * d;
  vec3 vp = rX(u_rotX) * rY(u_rotY) * wp;
  vp.z -= u_dist;
  gl_Position = u_proj * vec4(vp, 1.0);
  gl_PointSize = clamp(u_px * (1.3 + u_band * 2.2 + u_beat * 1.6) / (-vp.z), 1.0, 8.0);
}
`;

const FRAG = `
precision highp float;
uniform vec3 u_col;
uniform float u_bright;
varying float v_f;
void main(){
  vec2 pc = gl_PointCoord - 0.5;
  float d = length(pc);
  float a = smoothstep(0.5, 0.0, d); a *= a;      // soft round point
  vec3 col = u_col * u_bright * (0.5 + v_f * 0.7); // per-layer color, brighter when loud
  gl_FragColor = vec4(col * a, a);                 // additive-blended glow
}
`;

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function OrbVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("orb shader:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setStatus("Shader compile failed"); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("orb link:", gl.getProgramInfoLog(prog)); setStatus("Shader link failed"); return; }
    gl.useProgram(prog);

    // Fibonacci-sphere point cloud (even coverage). Drawn 3x per frame.
    const N = 6500;
    const pts = new Float32Array(N * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      pts[i * 3] = Math.cos(th) * r; pts[i * 3 + 1] = y; pts[i * 3 + 2] = Math.sin(th) * r;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uProj = u("u_proj"), uTime = u("u_time"), uRotY = u("u_rotY"),
      uRotX = u("u_rotX"), uDist = u("u_dist"), uPx = u("u_px");
    const uRadius = u("u_radius"), uFreq = u("u_freq"), uPhase = u("u_phase"), uDisp = u("u_disp"),
      uTscale = u("u_tscale"), uCol = u("u_col"), uBand = u("u_band"), uBeat = u("u_beat"), uBright = u("u_bright");

    let dpr = 1, pxBase = 4;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniformMatrix4fv(uProj, false, perspective(1.05, canvas.width / canvas.height, 0.1, 100));
      pxBase = canvas.height * 0.02; // point-size scale ~ resolution
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive, for the glow
    gl.disable(gl.DEPTH_TEST);

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const band = (lo: number, hi: number) => { let s = 0; for (let i = lo; i < hi; i++) s += freq[i]; return s / (hi - lo) / 255; };
    let bass = 0, mid = 0, treble = 0, rotY = 0, bassAvg = 0, lastBeat = 0, beat = 0, last = performance.now();
    let lastTick = 0;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      if (now - lastTick < 15) return; // 60Hz analysis cadence on any display
      lastTick = now;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      analyser.getByteFrequencyData(freq);
      const n = freq.length;
      const b = band(1, Math.max(2, Math.floor(n * 0.07)));
      const m = band(Math.floor(n * 0.07), Math.floor(n * 0.25));
      const tr = band(Math.floor(n * 0.25), Math.floor(n * 0.55));
      bass += (b - bass) * 0.3; mid += (m - mid) * 0.2; treble += (tr - treble) * 0.2;
      // beat punch (bass vs running average)
      bassAvg += (bass - bassAvg) * 0.05;
      const tSec = now / 1000;
      if (bass > bassAvg * 1.4 + 0.05 && bass > 0.18 && tSec - lastBeat > 0.25) { lastBeat = tSec; beat = 1; }
      beat *= 0.88;
      // Raw byte bands sit around 0.6-0.75 on loud music, so shape them through
      // the response curve to restore contrast.
      const sBass = shapeAmp(bass), sMid = shapeAmp(mid), sTre = shapeAmp(treble);
      const energy = Math.min(1.4, sBass * 0.8 + sMid * 0.55 + sTre * 0.45);
      rotY += dt * (0.08 + energy * 0.35); // slow base spin, faster with energy
      // Raw loudness swings the triad hue and pushes the camera in.
      const loud = freqAvgAll(freq);
      const triad = accentTriad(-loud * 256 * 2.2);
      // Three nested spheres, each driven by its own band (bass/mid/treble).
      const layers: { radius: number; freq: number; phase: number; disp: number; tscale: number; col: [number, number, number]; amp: number }[] = [
        { radius: 0.80, freq: 0.85, phase: 0.0, disp: 0.20, tscale: 0.25, col: triad[0], amp: sBass },
        { radius: 1.05, freq: 1.15, phase: 11.0, disp: 0.18, tscale: 0.33, col: triad[1], amp: sMid },
        { radius: 1.32, freq: 1.50, phase: 23.0, disp: 0.16, tscale: 0.18, col: triad[2], amp: sTre },
      ];

      gl.clearColor(0.02, 0.02, 0.045, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, now / 1000);
      gl.uniform1f(uRotY, rotY);
      gl.uniform1f(uRotX, 0.35 + 0.15 * Math.sin(now / 6000));
      gl.uniform1f(uDist, 3.4 - loud * 2.0);
      gl.uniform1f(uPx, pxBase);
      gl.uniform1f(uBeat, beat);
      for (const L of layers) {
        gl.uniform1f(uRadius, L.radius); gl.uniform1f(uFreq, L.freq); gl.uniform1f(uPhase, L.phase);
        gl.uniform1f(uDisp, L.disp); gl.uniform1f(uTscale, L.tscale); gl.uniform1f(uBand, L.amp);
        gl.uniform1f(uBright, 0.8 + L.amp * 1.7 + beat * 0.5); // shaped amps run lower than raw bands, so lift the base
        gl.uniform3f(uCol, L.col[0], L.col[1], L.col[2]);
        gl.drawArrays(gl.POINTS, 0, N);
      }
    };
    render();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [analyser]);

  return (
    <div className="viz-wrap">
      <canvas ref={canvasRef} className="viz-canvas" />
      {status && <div className="viz-status">{status}</div>}
    </div>
  );
}

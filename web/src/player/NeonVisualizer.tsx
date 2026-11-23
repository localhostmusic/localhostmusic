import { useEffect, useRef, useState } from "react";
import { accentTriad } from "./vizCommon";

// "neon": the look of wayne-wu/webgl-music-visualizer, reimplemented. Three nested
// wireframe icospheres displaced along their normals by Perlin FBM, amplitude driven
// by the audio. Brightness follows displacement, then scene FBO, Gaussian blur bloom,
// tonemapped composite. "Reference" below means that project.

const NOISE = `
float hash(vec3 p){
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
vec3 hash3(vec3 p){
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
vec3 quintic(vec3 t){ return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float grad(vec3 i, vec3 f, vec3 inc){ return dot(hash3(i + inc), f - inc); }
float perlin(vec3 x){
  vec3 i = floor(x);
  vec3 u = fract(x);
  vec3 q = quintic(u);
  float a = grad(i, u, vec3(0,0,0));
  float b = grad(i, u, vec3(1,0,0));
  float c = grad(i, u, vec3(0,1,0));
  float d = grad(i, u, vec3(1,1,0));
  float e = grad(i, u, vec3(0,0,1));
  float f = grad(i, u, vec3(1,0,1));
  float g = grad(i, u, vec3(0,1,1));
  float h = grad(i, u, vec3(1,1,1));
  return mix(mix(mix(a, b, q.x), mix(c, d, q.x), q.y),
             mix(mix(e, f, q.x), mix(g, h, q.x), q.y), q.z);
}
float fbm(vec3 pos){
  float total = 0.0, ampSum = 0.0;
  for (int i = 0; i < 5; i++) {
    if (float(i) >= u_octaves) break;
    float freq = pow(2.0, float(i));
    float amp = pow(u_pers, float(i));
    ampSum += amp;
    total += amp * perlin(freq * pos * u_nscale);
  }
  return total / max(ampSum, 0.0001);
}
`;

const LINE_VERT = `
precision highp float;
attribute vec3 a_pos;              // unit-sphere position == normal
uniform mat4 u_proj;
uniform mat3 u_rot;
uniform float u_dist, u_scale, u_time, u_amp;
uniform float u_nscale, u_pers, u_octaves, u_ospeed; // per-sphere FBM params
uniform vec3 u_oseed;                                // per-track noise phase
varying float v_disp;
varying float v_light;
${NOISE}
void main(){
  vec3 offset = vec3(u_ospeed) * u_time + u_oseed;
  float d = u_amp * fbm(a_pos + offset);
  // Reference verbatim: signed displacement mapped 0..5 -> brightness 0..1;
  // inward displacement goes black. At saturated amps most of the surface is
  // strongly displaced, so it reads lit with dark cavities, the original look.
  v_disp = clamp(d * 0.2, 0.0, 1.0);
  vec3 p = (a_pos + d * a_pos) * u_scale;
  vec3 vp = u_rot * p;
  // Lambert light fixed in view space, like the reference's (5,5,3) point light.
  vec3 n = normalize(u_rot * a_pos);
  v_light = dot(n, normalize(vec3(5.0, 5.0, 3.0))) + 0.5; // reference ambient
  vp.z -= u_dist;
  gl_Position = u_proj * vec4(vp, 1.0);
}
`;

const LINE_FRAG = `
precision highp float;
uniform vec3 u_col;
varying float v_disp;
varying float v_light;
float bias(float t, float b){ return t / ((((1.0 / b) - 2.0) * (1.0 - t)) + 1.0); }
float gain(float g, float t){
  if (t < 0.5) return bias(g, 2.0 * t) / 2.0;
  return bias(1.0 - g, 2.0 * t - 1.0) / 2.0 + 0.5;
}
void main(){
  // Reference: mix from pure black keyed on displacement, spikes glow, valleys
  // and silence vanish completely (no floor; the panel is black when quiet).
  vec3 color = mix(vec3(0.0), u_col, bias(v_disp, 0.75));
  gl_FragColor = vec4(color * gain(0.3, clamp(v_light, 0.0, 1.0)), 1.0);
}
`;

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
uniform float u_glow;
uniform float u_time;
uniform vec2 u_res;
varying vec2 v_uv;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main(){
  // Reference values verbatim: bloom at full weight, exposure 2.0. (Our blur is
  // half-res = wider halo than its full-res 10-pass, so this runs a bit hotter.)
  vec3 color = texture2D(u_scene, v_uv).rgb + texture2D(u_bloom, v_uv).rgb;
  vec3 result = vec3(1.0) - exp(-color * 2.0);     // exposure tonemap
  result = pow(result, vec3(1.0 / u_glow));        // "glow" gamma lift
  // The gamma lift bleaches hues toward white; re-saturate after it so the
  // album-derived palette survives the reference's bright look.
  float luma = dot(result, vec3(0.299, 0.587, 0.114));
  result = clamp(mix(vec3(luma), result, 1.7), 0.0, 1.0);
  // Sparse starfield added AFTER tonemap/gamma/bloom so stars stay tiny, round
  // and dim (inside the scene FBO the bloom+gamma turned them into blocky
  // white squares). Gaussian falloff, gentle twinkle.
  vec2 px = v_uv * u_res;
  vec2 cell = floor(px / 30.0);
  float rnd = h21(cell);
  vec2 sp = (0.2 + 0.6 * vec2(h21(cell + 7.3), h21(cell + 3.1))) * 30.0;
  float d = length(fract(px / 30.0) * 30.0 - sp);
  float star = exp(-d * d * 0.9) * pow(rnd, 16.0);
  star *= 0.6 + 0.4 * sin(u_time * (0.3 + rnd) + rnd * 40.0);
  result += mix(vec3(0.6, 0.72, 1.0), vec3(1.0), rnd) * star * 0.5;
  gl_FragColor = vec4(result, 1.0);
}
`;

// Icosphere wireframe: subdivide an icosahedron, normalize, extract unique edges.
function icosphereWire(subdiv: number): { verts: Float32Array; lines: Uint16Array } {
  const X = 0.525731112119133606, Z = 0.850650808352039932;
  const verts: number[][] = [
    [-X, 0, Z], [X, 0, Z], [-X, 0, -Z], [X, 0, -Z],
    [0, Z, X], [0, Z, -X], [0, -Z, X], [0, -Z, -X],
    [Z, X, 0], [-Z, X, 0], [Z, -X, 0], [-Z, -X, 0],
  ];
  let tris: number[][] = [
    [0, 4, 1], [0, 9, 4], [9, 5, 4], [4, 5, 8], [4, 8, 1],
    [8, 10, 1], [8, 3, 10], [5, 3, 8], [5, 2, 3], [2, 7, 3],
    [7, 10, 3], [7, 6, 10], [7, 11, 6], [11, 0, 6], [0, 1, 6],
    [6, 1, 10], [9, 0, 11], [9, 11, 2], [9, 2, 5], [7, 2, 11],
  ];
  const midCache = new Map<number, number>();
  const midpoint = (a: number, b: number) => {
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    const hit = midCache.get(key);
    if (hit !== undefined) return hit;
    const va = verts[a], vb = verts[b];
    let x = (va[0] + vb[0]) / 2, y = (va[1] + vb[1]) / 2, z = (va[2] + vb[2]) / 2;
    const len = Math.hypot(x, y, z);
    verts.push([x / len, y / len, z / len]);
    midCache.set(key, verts.length - 1);
    return verts.length - 1;
  };
  for (let s = 0; s < subdiv; s++) {
    const next: number[][] = [];
    for (const [a, b, c] of tris) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  const edges = new Set<number>();
  for (const [a, b, c] of tris) {
    edges.add(a < b ? a * 65536 + b : b * 65536 + a);
    edges.add(b < c ? b * 65536 + c : c * 65536 + b);
    edges.add(c < a ? c * 65536 + a : a * 65536 + c);
  }
  const flat = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => flat.set(v, i * 3));
  const lines = new Uint16Array(edges.size * 2);
  let i = 0;
  for (const e of edges) { lines[i++] = Math.floor(e / 65536); lines[i++] = e % 65536; }
  return { verts: flat, lines };
}

// Sphere colors come from the shared album-accent triad (see vizCommon.ts).
const accentPalette = accentTriad;

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function NeonVisualizer({ analyser, seed = 0 }: { analyser: AnalyserNode; seed?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");
  // Per-track noise phase, in a ref so the render loop reads it without a GL rebuild.
  const seedRef = useRef(seed);
  useEffect(() => { seedRef.current = seed; }, [seed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }

    const compile = (vsSrc: string, fsSrc: string) => {
      const sh = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("neon shader:", gl.getShaderInfoLog(s)); return null; }
        return s;
      };
      const vs = sh(gl.VERTEX_SHADER, vsSrc), fs = sh(gl.FRAGMENT_SHADER, fsSrc);
      if (!vs || !fs) return null;
      const p = gl.createProgram()!;
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, "a_pos");
      gl.linkProgram(p);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn("neon link:", gl.getProgramInfoLog(p)); return null; }
      return p;
    };

    const lineProg = compile(LINE_VERT, LINE_FRAG);
    const blurProg = compile(QUAD_VERT, BLUR_FRAG);
    const blendProg = compile(QUAD_VERT, BLEND_FRAG);
    if (!lineProg || !blurProg || !blendProg) { setStatus("Shader compile failed"); return; }

    // Three wireframe icospheres, densest innermost (subdivisions 5/4/3).
    const spheres = [5, 4, 3].map(s => icosphereWire(s));
    const sphereBufs = spheres.map(s => {
      const vb = gl.createBuffer(), ib = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, s.verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, s.lines, gl.STATIC_DRAW);
      return { vb, ib, count: s.lines.length };
    });

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const uL = (n: string) => gl.getUniformLocation(lineProg, n);
    const lu = {
      proj: uL("u_proj"), rot: uL("u_rot"), dist: uL("u_dist"), scale: uL("u_scale"),
      time: uL("u_time"), amp: uL("u_amp"), nscale: uL("u_nscale"), pers: uL("u_pers"),
      octaves: uL("u_octaves"), ospeed: uL("u_ospeed"), oseed: uL("u_oseed"), col: uL("u_col"),
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
      time: gl.getUniformLocation(blendProg, "u_time"),
      res: gl.getUniformLocation(blendProg, "u_res"),
    };

    // Offscreen targets: full-res scene (+depth), half-res ping-pong blur pair.
    const mkTex = (w: number, h: number, filter: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t!;
    };
    const sceneFBO = gl.createFramebuffer(), sceneDepth = gl.createRenderbuffer();
    let sceneTex: WebGLTexture | null = null;
    const blurFBOs = [gl.createFramebuffer(), gl.createFramebuffer()];
    const blurTexs: (WebGLTexture | null)[] = [null, null];
    let bw = 2, bh = 2;

    let proj = perspective(1.0, 1, 0.1, 100);
    const setupTargets = () => {
      const w = canvas.width, h = canvas.height;
      if (sceneTex) gl.deleteTexture(sceneTex);
      // LINEAR: the first blur pass samples this at half res, and NEAREST would drop
      // every other pixel of the 1px lines and make the bloom shimmer.
      sceneTex = mkTex(w, h, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, sceneDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sceneDepth);
      bw = Math.max(2, Math.floor(w / 2)); bh = Math.max(2, Math.floor(h / 2));
      for (let i = 0; i < 2; i++) {
        if (blurTexs[i]) gl.deleteTexture(blurTexs[i]);
        blurTexs[i] = mkTex(bw, bh, gl.LINEAR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFBOs[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blurTexs[i], 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      proj = perspective(1.0, w / h, 0.1, 100);
    };

    const resize = () => {
      // Cap dpr at 1: three passes + 8 blur taps are fillrate-heavy, and the bloom
      // hides the softness.
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      setupTargets();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Reference audio model: one drive value per frame, the mean of all frequency
    // bins, with the analyser's smoothing as the only envelope. No bands or gain
    // staging, so quiet masters barely move and loud ones run saturated.
    const freq = new Uint8Array(analyser.frequencyBinCount);
    let rotY = 0, rotXBase = 0.3, last = performance.now();
    let lastTick = 0;                  // 60Hz analysis gate
    let silent = 0;                    // consecutive near-silent frames
    let bassSlow = 0, beatP = 0, lastBeat = 0; // presentation-only beat pulse (camera push)
    const palCur = accentPalette();    // displayed palette, eased toward the target
    // Deterministic per-track offsets into the noise field (layer index varies it).
    const seedVec = (layer: number): [number, number, number] => {
      const s = seedRef.current * 127.1 + layer * 311.7;
      const r = (k: number) => (Math.abs(Math.sin(s * (k + 1) * 43758.5453)) % 1) * 100;
      return [r(1), r(2), r(3)];
    };

    const rotMat = (ry: number, rx: number) => {
      const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
      // rX(rx) * rY(ry), column-major mat3
      return new Float32Array([
        cy, sx * sy, -cx * sy,
        0, cx, sx,
        sy, -sx * cy, cx * cy,
      ]);
    };

    // Per-sphere FBM params (noise scale, persistence, octaves, offset drift per
    // second), taken from the reference. Shells are nearly coincident so they
    // interleave; the small scale offsets avoid z-fighting along shared seams.
    const layers = [
      { geo: 0, scale: 1.00, pal: 0, nscale: 2.0, pers: 0.50, oct: 4, ospeed: 0.30 },
      { geo: 1, scale: 1.08, pal: 1, nscale: 1.0, pers: 0.20, oct: 2, ospeed: -0.60 },
      { geo: 2, scale: 1.16, pal: 2, nscale: 1.0, pers: 1.0, oct: 3, ospeed: 0.60 },
    ];

    const drawQuad = (prog: WebGLProgram) => {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      // Analyser smoothing advances per getByteFrequencyData call, so gate to ~60Hz
      // (the rate the curves are tuned for) on high-refresh displays.
      if (now - lastTick < 15) return;
      lastTick = now;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const t = now / 1000;

      analyser.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 0; i < freq.length; i++) sum += freq[i];
      const freqAvg = sum / freq.length / 256; // mean of all bins
      // Reference response curve: quad ease, impulse, x20. Loud music saturates (amp 5-8).
      const h = 0.5 * freqAvg * freqAvg;
      let ampBase = h * Math.exp(1 - h) * 20;
      // After ~2s of silence (paused/stopped), fade in a faint slow breathing so the
      // panel isn't black. Any audio takes over.
      silent = freqAvg < 0.02 ? Math.min(silent + 1, 400) : 0;
      const breathe = Math.min(1, Math.max(0, (silent - 120) / 60)) * (0.5 + 0.2 * Math.sin(t * 0.5));
      ampBase = Math.max(ampBase, breathe);
      // Beat pulse: a small camera push on bass onsets. Does not feed the displacement amp.
      let bassSum = 0;
      const bassHi = Math.max(2, Math.floor(freq.length * 0.07));
      for (let i = 1; i < bassHi; i++) bassSum += freq[i];
      const bassNow = bassSum / (bassHi - 1) / 255;
      bassSlow += (bassNow - bassSlow) * 0.04;
      if (bassNow > bassSlow * 1.08 + 0.01 && bassNow > 0.2 && t - lastBeat > 0.28) { beatP = 1; lastBeat = t; }
      beatP *= 0.9;
      // Test hook, only active if a harness installs window.__neonDebug.
      if ((window as any).__neonDebug) (window as any).__neonDebug({ freqAvg, ampBase, beatP });

      rotY += dt * 0.1;
      const rot = rotMat(rotY, rotXBase + 0.12 * Math.sin(t * 0.15));
      // Ease the displayed palette toward the album's (~1s blend on track change).
      const palTarget = accentPalette();
      for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) palCur[i][c] += (palTarget[i][c] - palCur[i][c]) * 0.05;
      const pal = palCur;

      // Pass 1: wireframe spheres into the scene FBO.
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(lineProg);
      gl.uniformMatrix4fv(lu.proj, false, proj);
      gl.uniformMatrix3fv(lu.rot, false, rot);
      gl.uniform1f(lu.dist, 4.7 - beatP * 0.3); // beat pushes the camera in
      gl.uniform1f(lu.time, t);
      for (const L of layers) {
        // Same amp for all three spheres; only the FBM params differ.
        const buf = sphereBufs[L.geo];
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.vb);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.ib);
        gl.uniform1f(lu.scale, L.scale);
        gl.uniform1f(lu.amp, ampBase);
        gl.uniform1f(lu.nscale, L.nscale);
        gl.uniform1f(lu.pers, L.pers);
        gl.uniform1f(lu.octaves, L.oct);
        gl.uniform1f(lu.ospeed, L.ospeed);
        const sv = seedVec(L.pal);
        gl.uniform3f(lu.oseed, sv[0], sv[1], sv[2]);
        const c = pal[L.pal];
        gl.uniform3f(lu.col, c[0], c[1], c[2]);
        gl.drawElements(gl.LINES, buf.count, gl.UNSIGNED_SHORT, 0);
      }

      // Pass 2: ping-pong Gaussian blur at half res (the bloom).
      gl.disable(gl.DEPTH_TEST);
      gl.viewport(0, 0, bw, bh);
      gl.useProgram(blurProg);
      gl.uniform2f(bu.texel, 1 / bw, 1 / bh);
      gl.uniform1i(bu.tex, 0);
      gl.activeTexture(gl.TEXTURE0);
      let horizontal = 1, first = true;
      for (let i = 0; i < 8; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, blurFBOs[horizontal]);
        gl.uniform1f(bu.horizontal, horizontal);
        gl.bindTexture(gl.TEXTURE_2D, first ? sceneTex : blurTexs[1 - horizontal]);
        drawQuad(blurProg);
        horizontal = 1 - horizontal;
        first = false;
      }

      // Pass 3: composite scene + bloom with exposure tonemap and glow gamma.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(blendProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, blurTexs[1 - horizontal]);
      gl.uniform1i(cu.scene, 0);
      gl.uniform1i(cu.bloom, 1);
      gl.uniform1f(cu.time, t);
      gl.uniform2f(cu.res, canvas.width, canvas.height);
      // Glow gamma (reference default). It also desaturates, which is part of the look.
      gl.uniform1f(cu.glow, 4.5);
      drawQuad(blendProg);
      gl.activeTexture(gl.TEXTURE0);
    };
    render();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      gl.deleteProgram(lineProg); gl.deleteProgram(blurProg); gl.deleteProgram(blendProg);
      sphereBufs.forEach(b => { gl.deleteBuffer(b.vb); gl.deleteBuffer(b.ib); });
      gl.deleteBuffer(quadBuf);
      if (sceneTex) gl.deleteTexture(sceneTex);
      blurTexs.forEach(tx => tx && gl.deleteTexture(tx));
      gl.deleteFramebuffer(sceneFBO); gl.deleteRenderbuffer(sceneDepth);
      blurFBOs.forEach(f => gl.deleteFramebuffer(f));
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

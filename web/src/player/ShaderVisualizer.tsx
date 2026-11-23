import { useEffect, useRef, useState } from "react";
import { accentTriad, shapeAmp } from "./vizCommon";

// The "trip" visualizer: a ride through a morphing neon tunnel. The camera follows
// a curving track and banks into turns while the tunnel crossfades between scenes.
// Bass drives the speed, beats trigger events, and a frame-feedback pass leaves
// trails. Colors come from the album-accent triad.

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FEED = `
precision highp float;
uniform sampler2D u_prev;
uniform vec2 u_res;
uniform float u_flow, u_spin, u_bass, u_mid, u_treble, u_beat, u_sides, u_scene;
uniform vec3 u_c0, u_c1, u_c2;
mat2 rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
// Palette walks the album-accent triad (shared with every other visualizer).
vec3 pal(float t) {
  float p = fract(t);
  return p < 0.333 ? mix(u_c0, u_c1, p * 3.0)
       : p < 0.666 ? mix(u_c1, u_c2, (p - 0.333) * 3.0)
       : mix(u_c2, u_c0, (p - 0.666) * 3.0);
}
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float asp = u_res.x / u_res.y;
  vec2 p = uv - 0.5; p.x *= asp;

  // --- rollercoaster camera: the tunnel mouth follows a curving track and the
  // view BANKS into the turns like a cart. u_flow = distance along the track.
  float z = u_flow;
  vec2 c  = 0.15 * vec2(sin(z * 0.31), cos(z * 0.23));
  vec2 c2 = 0.15 * vec2(sin((z + 0.7) * 0.31), cos((z + 0.7) * 0.23));
  float bank = (c2.x - c.x) * 5.0;                 // roll into the upcoming turn
  p = rot(bank + u_spin * 0.25) * (p - c);

  // --- BREATHING: space itself swells and contracts (~0.1 Hz), the signature
  // "walls are breathing" of psychedelia. Radius-phased so it ripples outward.
  p *= 1.0 + 0.055 * sin(z * 0.45) + 0.04 * sin(length(p) * 7.0 - z * 0.9);
  // melt: low-frequency domain warp, straight lines refuse to stay straight,
  // amount rides the mids so the world liquefies when the music thickens.
  float melt = 0.02 + u_mid * 0.035;
  p += melt * vec2(sin(p.y * 6.0 + z * 0.8), sin(p.x * 6.0 - z * 0.6));

  float r = max(length(p), 1e-3);
  float ang = atan(p.y, p.x);
  // Soft kaleidoscope: the fold amount itself drifts in and out, mirror-world
  // comes and goes instead of being permanently on.
  float sect = 6.28318 / u_sides;
  float folded = abs(mod(ang + u_spin, sect) - sect * 0.5);
  float kmix = 0.5 + 0.5 * sin(z * 0.17);
  float ka = mix(abs(ang), folded, kmix);
  float depth = 1.2 / r + z * 2.0;                       // rings fly at the camera

  // --- six scenes crossfaded on a ring by u_scene (0..6 wraps): tunnel ribs,
  // honeycomb, hyperspace, fractal flower, spiral vortex, cobweb lattice , 
  // the last two are classic Kluver form constants.
  float w0 = clamp(1.0 - abs(mod(u_scene - 0.0 + 3.0, 6.0) - 3.0), 0.0, 1.0);
  float w1 = clamp(1.0 - abs(mod(u_scene - 1.0 + 3.0, 6.0) - 3.0), 0.0, 1.0);
  float w2 = clamp(1.0 - abs(mod(u_scene - 2.0 + 3.0, 6.0) - 3.0), 0.0, 1.0);
  float w3 = clamp(1.0 - abs(mod(u_scene - 3.0 + 3.0, 6.0) - 3.0), 0.0, 1.0);
  float w4 = clamp(1.0 - abs(mod(u_scene - 4.0 + 3.0, 6.0) - 3.0), 0.0, 1.0);
  float w5 = clamp(1.0 - abs(mod(u_scene - 5.0 + 3.0, 6.0) - 3.0), 0.0, 1.0);

  float lines = 0.0;
  // s0: kaleidoscope ribs, spokes woven with depth rings
  if (w0 > 0.001) {
    lines += smoothstep(0.72, 0.97, sin(depth * 2.0) * sin(ka * u_sides * 2.0 + z)) * w0;
  }
  // s1: honeycomb wormhole, glowing cell borders in (angle, depth) space
  if (w1 > 0.001) {
    vec2 g = abs(fract(vec2(ka * 5.0, depth * 0.7)) - 0.5);
    lines += smoothstep(0.34, 0.46, max(g.x, g.y)) * 0.8 * w1;
  }
  // s2: warp streaks, long star-streaks racing past (hyperspace)
  if (w2 > 0.001) {
    float lane = floor(ang * 28.0);
    float star = h21(vec2(lane, 7.0));
    float dash = fract(depth * (0.35 + star * 0.4) + star * 9.0);
    lines += smoothstep(0.55, 0.95, star) * smoothstep(0.5, 0.05, dash) * 1.2 * w2;
  }
  // s3: orbit-trap flower, the abstract fractal contour
  if (w3 > 0.001) {
    vec2 zz = rot(u_spin) * vec2(cos(ka), sin(ka)) * r * 2.0;
    float trap = 1e9;
    for (int i = 0; i < 4; i++) {
      zz = abs(zz) / max(dot(zz, zz), 0.07) - vec2(0.62, 0.5 + 0.25 * u_mid);
      zz = rot(0.2 + u_treble * 0.4) * zz;
      trap = min(trap, length(zz));
    }
    lines += smoothstep(0.5, 0.38, trap) * w3;
  }
  // s4: spiral vortex (form constant), glowing arms swirling into the center
  if (w4 > 0.001) {
    float sp = fract(ang * 0.95493 + log(r) * (1.5 + 0.7 * sin(z * 0.12)) - z * 0.6);
    lines += smoothstep(0.38, 0.5, sp) * smoothstep(0.62, 0.5, sp) * 1.15 * w4;
  }
  // s5: cobweb lattice (form constant), concentric threads + radial spokes
  if (w5 > 0.001) {
    float ring = fract(depth * 0.8);
    float spoke = fract(ang * 2.228);
    float web = max(
      smoothstep(0.42, 0.5, ring) * smoothstep(0.58, 0.5, ring),
      smoothstep(0.44, 0.5, spoke) * smoothstep(0.56, 0.5, spoke) * 0.8
    );
    lines += web * (0.9 + 0.3 * sin(depth * 9.0 + z * 3.0) * u_treble) * w5;
  }

  float glow = lines * (0.45 + u_mid * 1.1 + u_treble * 0.4)
             + smoothstep(0.05, 0.0, r) * (0.25 + u_bass * 1.1 + u_beat * 0.7);
  // Fog: the far end of the tunnel falls to BLACK, keeps the ride dark and deep.
  float fog = smoothstep(0.015, 0.30, r);
  // Hue drift: color washes slowly cycle through the triad, never static.
  vec3 col = pal(depth * 0.05 + ka * 0.25 + u_scene * 0.22 + z * 0.03) * glow * fog;

  // feedback: motion smear with CHROMATIC trails, each channel re-samples
  // at a slightly different zoom, so movement leaves rainbow-fringed tracers.
  vec2 f1 = rot(0.008 + u_treble * 0.02) * (p * 0.965) + c; f1.x /= asp;
  vec2 f2 = rot(0.008) * (p * 0.972) + c; f2.x /= asp;
  vec2 f3 = rot(0.008) * (p * 0.957) + c; f3.x /= asp;
  vec3 fb;
  fb.g = texture2D(u_prev, f1 + 0.5).g;
  fb.r = texture2D(u_prev, f2 + 0.5).r;
  fb.b = texture2D(u_prev, f3 + 0.5).b;
  fb = max(vec3(0.0), fb * 0.84 - 0.010);

  gl_FragColor = vec4(fb + col * 0.5, 1.0);
}
`;

const SCREEN = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_invert, u_time;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // Heat-haze shimmer: the image itself gently wobbles, like looking through
  // warm air, subtle but constant.
  uv += 0.0022 * vec2(sin(uv.y * 34.0 + u_time * 0.9), sin(uv.x * 30.0 - u_time * 0.7));
  vec3 c = texture2D(u_tex, uv).rgb;
  c = c / (1.0 + 0.5 * c);           // gentle tone-map
  c = pow(c, vec3(0.88));            // lift midtones (less than before, keep darks)
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = clamp(mix(vec3(luma), c, 1.3), 0.0, 1.0); // saturation lift
  c = mix(c, vec3(1.0) - c, u_invert); // occasional negative flash
  float r = length(uv - 0.5);
  c *= 0.6 + 0.55 * smoothstep(0.9, 0.15, r); // vignette
  gl_FragColor = vec4(c, 1.0);
}
`;


export function ShaderVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("viz shader:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const link = (fs: string) => {
      const v = sh(gl.VERTEX_SHADER, VERT), f = sh(gl.FRAGMENT_SHADER, fs);
      if (!v || !f) return null;
      const p = gl.createProgram()!;
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn("viz link:", gl.getProgramInfoLog(p)); return null; }
      gl.deleteShader(v); gl.deleteShader(f);
      return p;
    };
    const feedP = link(FEED), scrP = link(SCREEN);
    if (!feedP || !scrP) { setStatus("Shader compile failed"); return; }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const bindQuad = (p: WebGLProgram) => {
      gl.useProgram(p);
      const loc = gl.getAttribLocation(p, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };

    // ping-pong render targets
    let W = 0, H = 0;
    let tex: WebGLTexture[] = [], fbo: WebGLFramebuffer[] = [];
    const mkTex = (w: number, h: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const freeTargets = () => { tex.forEach(t => gl.deleteTexture(t)); fbo.forEach(f => gl.deleteFramebuffer(f)); };
    const alloc = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      W = Math.max(2, Math.floor((canvas.clientWidth || 640) * dpr));
      H = Math.max(2, Math.floor((canvas.clientHeight || 360) * dpr));
      canvas.width = W; canvas.height = H;
      freeTargets(); tex = []; fbo = [];
      for (let i = 0; i < 2; i++) {
        const t = mkTex(W, H);
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        tex.push(t); fbo.push(f);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    alloc();
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      if (Math.floor((canvas.clientWidth || 640) * dpr) !== W) alloc();
    });
    ro.observe(canvas);

    const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
    const uPrev = u(feedP, "u_prev"), uResF = u(feedP, "u_res"), uFlow = u(feedP, "u_flow"), uSpin = u(feedP, "u_spin"),
      uBass = u(feedP, "u_bass"), uMid = u(feedP, "u_mid"), uTreble = u(feedP, "u_treble"),
      uC0 = u(feedP, "u_c0"), uC1 = u(feedP, "u_c1"), uC2 = u(feedP, "u_c2"),
      uBeat = u(feedP, "u_beat"), uSides = u(feedP, "u_sides"), uScene = u(feedP, "u_scene");
    const uTex = u(scrP, "u_tex"), uResS = u(scrP, "u_res"), uInvert = u(scrP, "u_invert"), uTimeS = u(scrP, "u_time");

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const band = (lo: number, hi: number) => { let s = 0; for (let i = lo; i < hi; i++) s += freq[i]; return s / (hi - lo) / 255; };
    let bass = 0, mid = 0, treble = 0, flow = 0, spin = 0, last = performance.now(), read = 0;
    // evolving/beat state
    let bassAvg = 0, lastBeat = 0, beat = 0, invert = 0;
    let sides = 6, sidesTarget = 6, spinDir = 1, scene = 0;
    const SIDES = [3, 4, 5, 6, 8];
    const rnd = () => Math.random();

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
      const b = band(1, Math.max(2, Math.floor(n * 0.06)));
      const m = band(Math.floor(n * 0.06), Math.floor(n * 0.25));
      const tr = band(Math.floor(n * 0.25), Math.floor(n * 0.6));
      bass += (b - bass) * 0.25; mid += (m - mid) * 0.18; treble += (tr - treble) * 0.18;

      // Beat detection, each beat triggers a random event.
      bassAvg += (bass - bassAvg) * 0.05;
      const tSec = now / 1000;
      if (bass > bassAvg * 1.45 + 0.06 && bass > 0.22 && tSec - lastBeat > 0.28) {
        lastBeat = tSec; beat = 1;
        const r = rnd();
        if (r < 0.10) invert = 1;                                  // negative flash
        else if (r < 0.32) sidesTarget = SIDES[(Math.floor(rnd() * SIDES.length))]; // change the fold
        else if (r < 0.44) spinDir = -spinDir;                     // reverse the spin
        else if (r < 0.58) scene += 0.35;                          // jump toward the next scene
      }
      beat *= 0.9; invert *= 0.8;                 // decay the punches
      sides += (sidesTarget - sides) * 0.05;       // ease the fold change
      scene += dt * 0.05;                          // scenes drift on their own (~20s each)

      // Shaped bands are for display only. Beat detection above uses the raw
      // smoothed values.
      const sB = shapeAmp(bass), sM = shapeAmp(mid), sTr = shapeAmp(treble);
      const energy = Math.min(1.5, sB * 0.95 + sM * 0.6 + sTr * 0.6);
      flow += dt * (0.7 + sB * 2.6 + energy * 0.8); // ride speed, mostly bass
      spin += dt * spinDir * (0.08 + sTr * 0.5);
      const triad = accentTriad();
      const write = 1 - read;

      // pass 1: feedback into the write target, sampling the read target
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[write]);
      gl.viewport(0, 0, W, H);
      bindQuad(feedP);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[read]); gl.uniform1i(uPrev, 0);
      gl.uniform2f(uResF, W, H); gl.uniform1f(uFlow, flow); gl.uniform1f(uSpin, spin);
      gl.uniform1f(uBass, sB); gl.uniform1f(uMid, sM); gl.uniform1f(uTreble, sTr);
      gl.uniform1f(uBeat, beat); gl.uniform1f(uSides, sides); gl.uniform1f(uScene, scene % 6);
      gl.uniform3f(uC0, triad[0][0], triad[0][1], triad[0][2]);
      gl.uniform3f(uC1, triad[1][0], triad[1][1], triad[1][2]);
      gl.uniform3f(uC2, triad[2][0], triad[2][1], triad[2][2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // pass 2: tone-map the write target to the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      bindQuad(scrP);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[write]); gl.uniform1i(uTex, 0);
      gl.uniform2f(uResS, W, H); gl.uniform1f(uInvert, invert); gl.uniform1f(uTimeS, now / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      read = write;
    };
    render();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      gl.deleteProgram(feedP); gl.deleteProgram(scrP); gl.deleteBuffer(buf); freeTargets();
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

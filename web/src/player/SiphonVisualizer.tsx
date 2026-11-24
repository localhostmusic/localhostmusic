import { useEffect, useRef, useState } from "react";
import { parseAccent, rgbHue, hslToRgb, freqAvgAll, vissonanceBins } from "./vizCommon";

// Vissonance is Copyright (c) 2020 Tariq Soliman, MIT License. See THIRD-PARTY-NOTICES.md.
// "siphon": port of the Siphon preset from tariqksoliman/Vissonance, in raw WebGL.
// A tube of 36 rings streams past the camera. Each ring that respawns at the back
// is stamped with that moment's spectrum (spikes pointing inward) and hue, so the
// tube is a rolling spectrogram. Radius shrinks with loudness; the clear color is
// the complementary hue. Hue is anchored at the album accent.

const RINGS = 36;
const SEG = 256;      // columns per ring (255 segments + seam)
const BARS = 128;     // spectrum bins; ring is two mirrored halves
const R = 100;        // cylinder radius
const GAP = 8;        // z spacing between rings
const SPAN = RINGS * GAP; // wrap cycle (288)
const DIST = Math.sqrt(R * R + 25); // |vertex| incl. the +/-5 row offset (100.125)

const VERT = `
precision highp float;
attribute vec3 a_pos;    // ring-local position (deformation baked in)
attribute float a_ring;  // 0..${RINGS - 1}
uniform mat4 u_proj;
uniform float u_z[${RINGS}];
uniform vec3 u_col[${RINGS}];
uniform float u_scale;   // tube constriction (group.scale.xy)
varying vec3 v_col;
void main(){
  vec3 p = vec3(a_pos.xy * u_scale, a_pos.z + u_z[int(a_ring)]);
  v_col = u_col[int(a_ring)];
  gl_Position = u_proj * vec4(p, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec3 v_col;
void main(){
  gl_FragColor = vec4(v_col, 1.0);  // reference: flat color, no depth fade
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

export function SiphonVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }
    let prevFft = 2048;
    try { prevFft = analyser.fftSize; analyser.fftSize = 4096; } catch { /* shared/locked */ }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("siphon shader:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setStatus("Shader compile failed"); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("siphon link:", gl.getProgramInfoLog(prog)); setStatus("Shader link failed"); return; }
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST); // camera is inside the tube, no culling

    // Ring-local base directions: vertex j sits at (R*sin(a), -R*cos(a), +/-5),
    // a = j/255 * 2PI. Layout per ring: verts 0..SEG-1 = near row (+5, fixed circle),
    // SEG..2SEG-1 = far row (-5, deformed), contiguous for bufferSubData.
    const dirX = new Float32Array(SEG), dirY = new Float32Array(SEG);
    for (let j = 0; j < SEG; j++) {
      const th = (j / (SEG - 1)) * Math.PI * 2;
      dirX[j] = Math.sin(th); dirY[j] = -Math.cos(th);
    }
    const STRIDE = 4;
    const verts = new Float32Array(RINGS * SEG * 2 * STRIDE);
    const idx = new Uint16Array(RINGS * (SEG - 1) * 6);
    let ii = 0;
    for (let r = 0; r < RINGS; r++) {
      const base = r * SEG * 2;
      for (let row = 0; row < 2; row++) {
        for (let j = 0; j < SEG; j++) {
          const o = (base + row * SEG + j) * STRIDE;
          verts[o] = dirX[j] * R; verts[o + 1] = dirY[j] * R;
          verts[o + 2] = row === 0 ? 5 : -5; verts[o + 3] = r;
        }
      }
      for (let j = 0; j < SEG - 1; j++) {
        const a = base + j, b = base + SEG + j;
        idx.set([a, a + 1, b, a + 1, b + 1, b], ii);
        ii += 6;
      }
    }
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const attr = (n: string, size: number, off: number) => {
      const loc = gl.getAttribLocation(prog, n);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
    };
    attr("a_pos", 3, 0); attr("a_ring", 1, 3);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uProj = u("u_proj"), uZ = u("u_z[0]"), uColArr = u("u_col[0]"), uScale = u("u_scale");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniformMatrix4fv(uProj, false, perspective(70 * Math.PI / 180, canvas.width / canvas.height, 0.1, 2000));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const f = analyser.frequencyBinCount / 2048;
    const binStart = Math.round(4 * f), binEnd = Math.round(1300 * f);
    const zs = new Float32Array(RINGS);
    const prevZs = new Float32Array(RINGS);
    const cols = new Float32Array(RINGS * 3);
    const stamp = new Float32Array(SEG * STRIDE); // far-row scratch for the current band
    // Init ring colors at the accent hue.
    {
      const [ar, ag, ab] = parseAccent();
      const c0 = hslToRgb(rgbHue(ar, ag, ab), 1.0, 0.5);
      for (let r = 0; r < RINGS; r++) cols.set(c0, r * 3);
    }
    let scrollS = 0, lastLoud = 0, lastTick = 0, currentBand = 0;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      if (now - lastTick < 15) return; // cap at ~60Hz
      lastTick = now;

      analyser.getByteFrequencyData(freq);
      let loud = freqAvgAll(freq) * 256;
      loud = (loud + lastLoud) / 2;
      lastLoud = loud;
      const bins = vissonanceBins(freq, BARS, binStart, binEnd);

      if (loud > 1) scrollS = (scrollS + (Math.pow(loud / 8192 + 1, 2) - 1) * loud * 4) % SPAN;
      for (let r = 0; r < RINGS; r++) {
        const z = ((-GAP * r + scrollS + SPAN + 278) % SPAN) - 278;
        if (z < prevZs[r] - 1) currentBand = r; // this ring just respawned at the back
        prevZs[r] = z;
        zs[r] = z;
      }

      // Stamp the current band with this frame's spectrum and hue. The other
      // rings keep their buffers, which is the history.
      const [ar, ag, ab] = parseAccent();
      const hueDeg = rgbHue(ar, ag, ab) * 360 - loud * 7;
      const h = (((hueDeg % 360) + 360) % 360);
      cols.set(hslToRgb(h / 360, 1.0, 0.5), currentBand * 3);
      const bg = hslToRgb(((h + 180) % 360) / 360, 1.0, 0.97);
      for (let j = 0; j < SEG; j++) {
        // segment j <= 127 carries bin j, the other half mirrors (bin at 255-j)
        const v = Math.max(bins[j < BARS ? j : (SEG - 1) - j] * 255, 1);
        const target = R - v / 3.5 - loud / 7; // spikes point inward
        const s = target / DIST;
        const o = j * STRIDE;
        stamp[o] = dirX[j] * R * s; stamp[o + 1] = dirY[j] * R * s;
        stamp[o + 2] = -5 * s; // the whole vertex vector is scaled
        stamp[o + 3] = currentBand;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, (currentBand * SEG * 2 + SEG) * STRIDE * 4, stamp);

      gl.clearColor(bg[0], bg[1], bg[2], 1); // complementary pastel, per frame
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1fv(uZ, zs);
      gl.uniform3fv(uColArr, cols);
      gl.uniform1f(uScale, 1 - Math.min(loud / 255, 0.80)); // tube narrows with loudness
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    };
    render();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      try { analyser.fftSize = prevFft; } catch { /* */ }
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
      gl.deleteBuffer(vb); gl.deleteBuffer(ib);
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

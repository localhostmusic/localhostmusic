import { useEffect, useRef, useState } from "react";
import { parseAccent, rgbHue, hslToRgb, freqAvgAll, vissonanceBins } from "./vizCommon";

// "fracture": port of the Fracture preset from tariqksoliman/Vissonance, in raw
// WebGL. A corridor between a jagged floor and a mirrored ceiling on a white
// background. 64 strips per side stream toward the camera at a speed driven by
// loudness, each carrying the current spectrum. Hue is anchored at the album accent.

const BARS = 128;   // spectrum bins across each strip
const BANDS = 64;   // strips per side
const COLS = BARS * 2; // 256 columns per strip (reference: widthSegments 255)
const GAP = 10;     // z spacing between strips
const SPAN = BANDS * GAP; // wrap cycle length (640)

const VERT = `
precision highp float;
attribute float a_xi;    // column 0..${COLS - 1}
attribute float a_row;   // 0 = far edge (bumpy), 1 = near edge (flat)
attribute float a_strip; // 0..${BANDS - 1}
attribute float a_bin;   // spectrum bin for this column, or -1 (flat half)
uniform mat4 u_proj;
uniform float u_h[${BARS}];  // visual/10
uniform float u_scroll;      // accumulated forward motion (mod ${SPAN})
uniform float u_gy;          // floor base y: -20 + loudness lift (group -10+lift, PLUS plane.position.y = -10)
uniform float u_flip;        // +1 floor, -1 ceiling (reference group2 rotZ π)
uniform float u_roll;        // accumulated camera roll
varying float v_z;
void main(){
  float x = -150.0 + a_xi * (300.0 / ${COLS - 1}.0);
  float h = (a_row < 0.5 && a_bin >= 0.0) ? u_h[int(a_bin)] : 0.0;
  float y = (u_gy + h) * u_flip;
  x *= u_flip;
  // strip z: base 10 - strip*GAP, streaming forward, respawning at the back
  float z = mod(10.0 - a_strip * ${GAP}.0 + u_scroll + ${SPAN - 10}.0, ${SPAN}.0) - ${SPAN - 10}.0;
  z += (a_row < 0.5) ? -5.0 : 5.0;
  float cr = cos(u_roll), sr = sin(u_roll);
  vec3 p = vec3(x * cr - y * sr, x * sr + y * cr, z);
  v_z = p.z;
  gl_Position = u_proj * vec4(p, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform vec3 u_col;
varying float v_z;
void main(){
  float b = -v_z / 500.0;  // near = black silhouette, horizon = full color
  gl_FragColor = vec4(u_col * b, 1.0);
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

export function FractureVisualizer({ analyser }: { analyser: AnalyserNode }) {
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
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("fracture shader:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setStatus("Shader compile failed"); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("fracture link:", gl.getProgramInfoLog(prog)); setStatus("Shader link failed"); return; }
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST);

    // One side's geometry (drawn twice with u_flip +1/-1): BANDS strips of
    // COLS columns x 2 rows. Per vertex: (xi, row, strip, bin).
    const STRIDE = 4;
    const verts = new Float32Array(BANDS * COLS * 2 * STRIDE);
    const idx = new Uint16Array(BANDS * (COLS - 1) * 6);
    let vi = 0, ii = 0;
    for (let c = 0; c < BANDS; c++) {
      const base = c * COLS * 2;
      for (let row = 0; row < 2; row++) {
        for (let j = 0; j < COLS; j++) {
          // Odd strips bump columns 0..127 (left half), even strips columns
          // 128..255 with the spectrum reversed (bin 0 at the outer right edge).
          const bin = c % 2 !== 0
            ? (j < BARS ? j : -1)
            : (j >= BARS ? (COLS - 1) - j : -1);
          verts.set([j, row, c, row === 0 ? bin : -1], vi * STRIDE);
          vi++;
        }
      }
      for (let j = 0; j < COLS - 1; j++) {
        const a = base + j, b = base + COLS + j;
        idx.set([a, a + 1, b, a + 1, b + 1, b], ii);
        ii += 6;
      }
    }
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const attr = (n: string, size: number, off: number) => {
      const loc = gl.getAttribLocation(prog, n);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
    };
    attr("a_xi", 1, 0); attr("a_row", 1, 1); attr("a_strip", 1, 2); attr("a_bin", 1, 3);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uProj = u("u_proj"), uH = u("u_h[0]"), uScroll = u("u_scroll"),
      uGy = u("u_gy"), uFlip = u("u_flip"), uRoll = u("u_roll"), uCol = u("u_col");

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
    // Reference range (-200..1300 of 2048 bins), scaled if the analyser stayed smaller.
    const f = analyser.frequencyBinCount / 2048;
    const binStart = Math.round(-200 * f), binEnd = Math.round(1300 * f);
    const heights = new Float32Array(BARS);
    let scroll = 0, roll = 0, lastLoud = 0, lastTick = 0;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const now = performance.now();
      if (now - lastTick < 15) return; // cap at ~60Hz
      lastTick = now;

      analyser.getByteFrequencyData(freq);
      let loud = freqAvgAll(freq) * 256;
      loud = (loud + lastLoud) / 2; // one-pole smoothing
      lastLoud = loud;
      const bins = vissonanceBins(freq, BARS, binStart, binEnd);
      for (let i = 0; i < BARS; i++) heights[i] = Math.max(bins[i] * 255, 1) / 10;
      // The reference's bin 0 is always flat (its negative spectrum start reads
      // out of range), so match that.
      heights[0] = 0.1;

      let lift = 0;
      if (loud > 1) {
        const k = Math.pow(loud / 8192 + 1, 2) - 1;
        scroll = (scroll + k * loud * 1.7) % SPAN;
        roll += k / 2;
        lift = Math.min((loud / 255) * 20, 9.8);
      }
      const [ar, ag, ab] = parseAccent();
      const hueDeg = rgbHue(ar, ag, ab) * 360 - loud * 2.2;
      const col = hslToRgb((((hueDeg % 360) + 360) % 360) / 360, 1.0, 0.5);

      gl.clearColor(1, 1, 1, 1); // white background
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1fv(uH, heights);
      gl.uniform1f(uScroll, scroll);
      gl.uniform1f(uGy, -20 + lift);
      gl.uniform1f(uRoll, roll);
      gl.uniform3f(uCol, col[0], col[1], col[2]);
      gl.uniform1f(uFlip, 1);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
      gl.uniform1f(uFlip, -1);
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

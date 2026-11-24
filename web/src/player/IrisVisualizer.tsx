import { useEffect, useRef, useState } from "react";
import { parseAccent, rgbHue, hslToRgb, freqAvgAll, vissonanceBins } from "./vizCommon";

// Vissonance is Copyright (c) 2020 Tariq Soliman, MIT License. See THIRD-PARTY-NOTICES.md.
// "iris": port of the Iris preset from tariqksoliman/Vissonance, in raw WebGL.
// Brightness is linear in view depth, with no bloom (MSAA only). The analyser's own
// smoothing is the only envelope. The hue is anchored at the album accent instead
// of the reference's fixed 250 degrees.

const BARS = 128; // 128 planes = 64 mirrored pairs, bass at top

// Reference plane: PlaneBufferGeometry(3, 500) rotateX(PI/1.8), translate y+60,
// camera at z=250 fov 70. Precomputed endpoints:
//   near edge: y = 250*cos(100deg) + 60 = 16.588, z = 250*sin(100deg) = 246.202
//   far edge:  z = -246.202, y animated per frame.
const NEAR_Y = 16.588;
const NEAR_Z = 246.202;
const FAR_Z = -246.202;
const CAM_Z = 250;

const VERT = `
precision highp float;
attribute float a_bin;   // 0..63, mirrored pair index into u_len
attribute vec2 a_rot;    // cos/sin of this plane's rotation.z
attribute float a_x;     // +/-1.5, local half-width (fixed 3 world units)
attribute float a_end;   // 0 = near edge (off-screen), 1 = far edge (the tip)
uniform mat4 u_proj;
uniform float u_len[${BARS / 2}];
varying float v_z;
void main(){
  float y = mix(${NEAR_Y}, u_len[int(a_bin)], a_end);
  float z = mix(${NEAR_Z}, ${FAR_Z}, a_end);
  // three.js rotation.z: x' = x*c - y*s, y' = x*s + y*c
  vec3 p = vec3(a_x * a_rot.x - y * a_rot.y, a_x * a_rot.y + y * a_rot.x, z - ${CAM_Z}.0);
  v_z = p.z;
  gl_Position = u_proj * vec4(p, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform vec3 u_col;
varying float v_z;
void main(){
  float b = -v_z / 180.0;  // reference depth fade: 0.02 off-screen -> 2.76 at the tip
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

export function IrisVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // No post-processing, so rely on MSAA for edges.
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }
    // Vissonance runs fftSize 4096 (2048 bins). Restore the engine default on unmount.
    let prevFft = 2048;
    try { prevFft = analyser.fftSize; analyser.fftSize = 4096; } catch { /* shared/locked */ }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("iris shader:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setStatus("Shader compile failed"); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("iris link:", gl.getProgramInfoLog(prog)); setStatus("Shader link failed"); return; }
    gl.useProgram(prog);

    // Static geometry: BARS quads, 4 verts each of (bin, cos, sin, x, end).
    // Plane j is pair i = j>>1 at rotation.z = +/-(i*2PI/BARS + PI/BARS): mirrored
    // left/right, bass at top, treble meeting at the bottom.
    const STRIDE = 5;
    const verts = new Float32Array(BARS * 4 * STRIDE);
    const idx = new Uint16Array(BARS * 6);
    for (let j = 0; j < BARS; j++) {
      const i = j >> 1;
      const sign = j % 2 === 0 ? 1 : -1;
      const theta = sign * (i * (Math.PI * 2 / BARS) + Math.PI / BARS);
      const c = Math.cos(theta), s = Math.sin(theta);
      const corners = [
        [i, c, s, -1.5, 0], [i, c, s, 1.5, 0], [i, c, s, -1.5, 1], [i, c, s, 1.5, 1],
      ];
      corners.forEach((v, k) => verts.set(v, (j * 4 + k) * STRIDE));
      const b = j * 4;
      idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], j * 6);
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
    attr("a_bin", 1, 0); attr("a_rot", 2, 1); attr("a_x", 1, 3); attr("a_end", 1, 4);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uProj = u("u_proj"), uLen = u("u_len[0]"), uCol = u("u_col");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      // fov 70 degrees, as in the reference.
      gl.uniformMatrix4fv(uProj, false, perspective(70 * Math.PI / 180, canvas.width / canvas.height, 0.1, 2000));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const freq = new Uint8Array(analyser.frequencyBinCount);
    // Reference spectrum range (bins 4..1300 of 2048), scaled if the analyser
    // stayed at a smaller fftSize.
    const binEnd = Math.min(1300, Math.floor(analyser.frequencyBinCount * 0.635));
    const lens = new Float32Array(BARS / 2);
    let lastTick = 0;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      // Cap at ~60Hz: analyser smoothing advances per call, so this keeps the
      // envelope the same on any display.
      const now = performance.now();
      if (now - lastTick < 15) return;
      lastTick = now;

      analyser.getByteFrequencyData(freq);
      const loud = freqAvgAll(freq) * 256; // raw byte mean, 0..255
      // 128 bins over the range, but only the first 64 are drawn, so the ring
      // covers roughly 43Hz..2.4kHz.
      const bins = vissonanceBins(freq, BARS, 4, binEnd);
      for (let i = 0; i < BARS / 2; i++) {
        // farY = visual/2 + 65 + loudness/1.5, visual floored at 1 (all 0..255).
        lens[i] = Math.max(bins[i] * 127.5, 0.5) + 65 + loud / 1.5;
      }
      // One full-saturation color per frame, hue = accent hue - loudness*2.2.
      const [ar, ag, ab] = parseAccent();
      const hueDeg = rgbHue(ar, ag, ab) * 360 - loud * 2.2;
      const col = hslToRgb((((hueDeg % 360) + 360) % 360) / 360, 1.0, 0.5);

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1fv(uLen, lens);
      gl.uniform3f(uCol, col[0], col[1], col[2]);
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

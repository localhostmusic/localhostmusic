import { useEffect, useRef, useState } from "react";
import { parseAccent, rgbHue, hslToRgb, freqAvgAll, vissonanceBins } from "./vizCommon";

// "silk": port of the Silk preset from tariqksoliman/Vissonance, in raw WebGL.
// Four mirrored streams of 512 hexagon dots, one per spectrum bin, each drifting
// vertically at a speed set by its bin's level and wrapping at +/-30.
// The framebuffer is never cleared: a 20%-alpha white wash behind each frame's
// dots fades the trail. Hue and lightness follow the bin level, anchored at the accent.

const N = 512;        // dots per stream
const STREAMS = 4;    // up/down x left/right
const X0 = 3, XGAP = 0.12, Z = -50, WRAP = 30, RAD = 10;
const BG = 0xfd / 255; // clear color 0xfdfdfd

const VERT = `
precision highp float;
attribute vec2 a_pos;
attribute vec3 a_col;
uniform mat4 u_proj;
uniform float u_zpos;
varying vec3 v_col;
void main(){
  v_col = a_col;
  gl_Position = u_proj * vec4(a_pos, u_zpos, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform float u_alpha;
varying vec3 v_col;
void main(){
  gl_FragColor = vec4(v_col, u_alpha);
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

export function SilkVisualizer({ analyser }: { analyser: AnalyserNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // preserveDrawingBuffer keeps the last frame so it can be washed, not cleared.
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    if (!gl) { setStatus("WebGL unavailable"); return; }
    let prevFft = 2048;
    try { prevFft = analyser.fftSize; analyser.fftSize = 4096; } catch { /* shared/locked */ }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("silk shader:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setStatus("Shader compile failed"); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("silk link:", gl.getProgramInfoLog(prog)); setStatus("Shader link failed"); return; }
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST);

    // Hex fan: 7 verts (center + 6 corners) per dot, rebuilt on CPU each frame.
    const VPH = 7, STRIDE = 5;
    const hexData = new Float32Array(STREAMS * N * VPH * STRIDE);
    const idx = new Uint16Array(STREAMS * N * 18);
    for (let hIdx = 0; hIdx < STREAMS * N; hIdx++) {
      const c = hIdx * VPH;
      for (let k = 0; k < 6; k++) {
        idx.set([c, c + 1 + k, c + 1 + ((k + 1) % 6)], hIdx * 18 + k * 3);
      }
    }
    const cos6: number[] = [], sin6: number[] = [];
    for (let k = 0; k < 6; k++) { cos6.push(Math.cos(k * Math.PI / 3)); sin6.push(Math.sin(k * Math.PI / 3)); }
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, hexData.byteLength, gl.DYNAMIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    // The fade quad (2000x2000 at z=-60, white, alpha 0.2).
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    const Q = 1000;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -Q, -Q, 1, 1, 1,  Q, -Q, 1, 1, 1,  -Q, Q, 1, 1, 1,
      Q, -Q, 1, 1, 1,   Q, Q, 1, 1, 1,   -Q, Q, 1, 1, 1,
    ]), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(prog, "a_pos");
    const locCol = gl.getAttribLocation(prog, "a_col");
    gl.enableVertexAttribArray(locPos);
    gl.enableVertexAttribArray(locCol);
    const bindBuf = (buf: WebGLBuffer) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, STRIDE * 4, 0);
      gl.vertexAttribPointer(locCol, 3, gl.FLOAT, false, STRIDE * 4, 8);
    };

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uProj = u("u_proj"), uZpos = u("u_zpos"), uAlpha = u("u_alpha");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(2, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(2, Math.floor(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniformMatrix4fv(uProj, false, perspective(70 * Math.PI / 180, canvas.width / canvas.height, 0.1, 2000));
      // resize wipes the accumulation buffer, so start from a blank page
      gl.clearColor(BG, BG, BG, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const f = analyser.frequencyBinCount / 2048;
    const binStart = Math.round(6 * f), binEnd = Math.round(1300 * f);
    const yOff = new Float32Array(STREAMS * N);
    let lastLoud = 0, lastTick = 0;

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
      const bins = vissonanceBins(freq, N, binStart, binEnd);
      const [ar, ag, ab] = parseAccent();
      const anchor = rgbHue(ar, ag, ab) * 360;

      for (let i = 0; i < N; i++) {
        const v = Math.max(bins[i] * 255, 1);
        const step = v <= 1 ? 0.0001 : 4 * Math.log10(1 + v / 255 / 7);
        const r = RAD * (v <= 1 ? 0.0001 : step);
        const hueDeg = anchor - v * 0.9;
        const h = (((hueDeg % 360) + 360) % 360) / 360;
        const col = hslToRgb(h, 0.9, 1 - Math.min(40, Math.floor(v)) / 100);
        const cx = X0 + XGAP * i;
        for (let s = 0; s < STREAMS; s++) {
          // streams: 0 = right/up, 1 = left/up*, 2 = left/down*, 3 = right/down
          // (*mirrored groups: rotation by PI flips both axes)
          const up = s < 2;
          let y = yOff[s * N + i] + (up ? step : -step);
          if (loud <= 1 || (up ? y > WRAP : y < -WRAP)) y = 0;
          yOff[s * N + i] = y;
          const flip = (s === 1 || s === 2) ? -1 : 1;
          const wx = cx * flip, wy = y * flip;
          const o = ((s * N + i) * VPH) * STRIDE;
          hexData[o] = wx; hexData[o + 1] = wy;
          hexData[o + 2] = col[0]; hexData[o + 3] = col[1]; hexData[o + 4] = col[2];
          for (let k = 0; k < 6; k++) {
            const ov = o + (1 + k) * STRIDE;
            hexData[ov] = wx + r * cos6[k]; hexData[ov + 1] = wy + r * sin6[k];
            hexData[ov + 2] = col[0]; hexData[ov + 3] = col[1]; hexData[ov + 4] = col[2];
          }
        }
      }

      // No color clear, the previous frame stays. Clear depth only.
      gl.clear(gl.DEPTH_BUFFER_BIT);
      // Dots: opaque, write depth.
      bindBuf(vb);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, hexData);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1f(uZpos, Z);
      gl.uniform1f(uAlpha, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
      // Fade wash: behind this frame's dots (depth test), 20% white.
      bindBuf(qb);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(uZpos, -60);
      gl.uniform1f(uAlpha, 0.2);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.depthMask(true);
    };
    render();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      try { analyser.fftSize = prevFft; } catch { /* */ }
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
      gl.deleteBuffer(vb); gl.deleteBuffer(ib); gl.deleteBuffer(qb);
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

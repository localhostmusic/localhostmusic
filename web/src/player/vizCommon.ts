// Shared visualizer helpers:
// - accentTriad(): colors derived from the album accent (base hue, +213deg, +90deg)
//   at full saturation.
// - shapeAmp(): audio response curve (quad ease, then impulse), 0..1 in and out.
// - freqAvgAll(): mean of all frequency bytes.

export type Triad = [[number, number, number], [number, number, number], [number, number, number]];

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (tc: number) => {
    tc = ((tc % 1) + 1) % 1;
    if (tc < 1 / 6) return p + (q - p) * 6 * tc;
    if (tc < 1 / 2) return q;
    if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export function rgbHue(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 349 / 360; // grayscale accent: fall back to pink
  let h;
  if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  return h / 6;
}

export function parseAccent(): [number, number, number] {
  const c = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff375f";
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = c.match(/(\d+(?:\.\d+)?)/g);
  if (rgb && rgb.length >= 3) return [Number(rgb[0]) / 255, Number(rgb[1]) / 255, Number(rgb[2]) / 255];
  return [1, 0.22, 0.37];
}

// hueShiftDeg rotates the whole triad (e.g. -loudness255 * 2.2 so hue swings
// with loudness).
export function accentTriad(hueShiftDeg = 0): Triad {
  const [r, g, b] = parseAccent();
  const h = rgbHue(r, g, b) + hueShiftDeg / 360;
  return [
    hslToRgb(h, 1.0, 0.52),             // core: the accent itself
    hslToRgb(h + 213 / 360, 1.0, 0.52), // "cyan" slot
    hslToRgb(h + 90 / 360, 1.0, 0.52),  // "yellow" slot
  ];
}

export function triadCss([r, g, b]: [number, number, number], alpha = 1): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

// Walk the triad as a continuous palette (t wraps at 1): c0, c1, c2, back to c0.
export function triadWalk(tr: Triad, t: number): [number, number, number] {
  t = ((t % 1) + 1) % 1;
  const seg = Math.min(2, Math.floor(t * 3));
  const a = tr[seg], b = tr[(seg + 1) % 3], k = t * 3 - seg;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// Spectrum bins, ported from tariqksoliman/Vissonance Spectrum.js: log-eased bin
// positions (pow 2.55), local max per band, neighbor-max averaging, then an
// exponent that slides from 5 (bass) to 3 (treble). Returns 0..1 per bar.
export function vissonanceBins(data: Uint8Array, n: number, start: number, end: number): Float32Array {
  const pts: number[] = [];
  let last = 0;
  for (let i = 0; i < n; i++) {
    let bin = Math.round(Math.pow(i / n, 2.55) * (end - start) + start);
    if (bin <= last) bin = last + 1;
    last = bin;
    pts.push(bin);
  }
  const maxSpots: number[] = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i], next = i + 1 < n ? pts[i + 1] : end;
    let m = data[cur] || 0, spot = cur;
    for (let j = cur + 1; j < next; j++) if ((data[j] || 0) > m) { m = data[j]; spot = j; }
    maxSpots.push(spot);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lastMax = data[i > 0 ? maxSpots[i - 1] : start] || 0;
    const nextMax = data[maxSpots[i]] || 0;
    const v = (lastMax + nextMax) / 2 / 255;
    const exp = 5 + (3 - 5) * (i / n);
    out[i] = Math.pow(v, exp);
  }
  return out;
}

// Response curve, ~0..1 (peaks at 1 when h=1).
export function shapeAmp(x: number): number {
  const h = 0.5 * x * x;
  return h * Math.exp(1 - h);
}

export function freqAvgAll(freq: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < freq.length; i++) s += freq[i];
  return s / freq.length / 256;
}

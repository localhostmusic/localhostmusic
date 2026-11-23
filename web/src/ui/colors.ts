// Extract a vibrant accent + three aurora colors from an album cover, by sampling
// the image on a small canvas. No dependencies. Same-origin images only (ours are),
// so the canvas stays untainted and getImageData works.

export interface Palette {
  accent: string;
  contrast: string; // readable text/icon color on top of accent
  aurora: [string, string, string];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

export function rgbaFromHex(h: string, a: number): string {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Nightcore palette: pull every hue most of the way toward the nearer pole (magenta
// or cyan), then raise saturation and lightness. A warm cover lands pink, a cool one blue.
function nightcoreHue(h: number): number {
  const poles = [315, 195]; // magenta, cyan
  let best = poles[0], bestD = 361;
  for (const p of poles) {
    const d = Math.min(Math.abs(h - p), 360 - Math.abs(h - p));
    if (d < bestD) { bestD = d; best = p; }
  }
  const diff = ((best - h + 540) % 360) - 180; // signed shortest arc toward the pole
  return (h + diff * 0.65 + 360) % 360;
}
function nightcoreHex(hexStr: string, lMin: number, lMax: number): { out: string; l: number } {
  const n = parseInt(hexStr.slice(1), 16);
  const [h, s, l] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const s2 = Math.max(0.85, Math.min(1, s * 1.35 + 0.15));
  const l2 = Math.max(lMin, Math.min(lMax, l * 1.1 + 0.08));
  const [r, g, b] = hslToRgb(nightcoreHue(h), s2, l2);
  return { out: hex(r, g, b), l: l2 };
}
export function nightcorePalette(p: Palette): Palette {
  const acc = nightcoreHex(p.accent, 0.55, 0.72);
  return {
    accent: acc.out,
    contrast: acc.l > 0.62 ? "#12131a" : "#ffffff", // same readability rule as coverPalette
    aurora: [
      nightcoreHex(p.aurora[0], 0.45, 0.75).out,
      nightcoreHex(p.aurora[1], 0.45, 0.75).out,
      nightcoreHex(p.aurora[2], 0.45, 0.75).out,
    ],
  };
}

export function coverPalette(url: string): Promise<Palette | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = url;
    // No crossOrigin: covers are same-origin (the canvas never taints), and it would
    // request a different cache mode than the displayed <img>, making the load fail.
    // decode() rather than onload: onload can fire before the image is fully decoded,
    // and drawImage() would then sample a partial frame.
    if (typeof img.decode !== "function") { resolve(null); return; }
    img.decode().then(() => {
      try {
        const N = 48;
        const c = document.createElement("canvas");
        c.width = N; c.height = N;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, N, N);
        const { data } = ctx.getImageData(0, 0, N, N);

        // Bucket quantized colors; track count + summed rgb per bucket.
        const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue; // skip transparent
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          e.n++; e.r += r; e.g += g; e.b += b;
          buckets.set(key, e);
        }

        // Weight each colour by count x saturation squared, so a large vivid area beats
        // both a dull background and a tiny neon speck.
        const scored = [...buckets.values()].map(e => {
          const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
          const [h, s, l] = rgbToHsl(r, g, b);
          return { r, g, b, h, s, l, w: e.n * s * s };
        }).sort((a, z) => z.w - a.w);

        if (!scored.length) return resolve(null);

        // Accent: the most dominant colourful tone (skip near-black/near-white), clamped
        // to stay readable on the dark UI.
        const vibrant = scored.find(c => c.l > 0.12 && c.l < 0.9) ?? scored[0];
        const accS = Math.min(1, Math.max(0.45, vibrant.s));
        const accL = Math.min(0.7, Math.max(0.5, vibrant.l));
        const [ar, ag, ab] = hslToRgb(vibrant.h, accS, accL);
        const accent = hex(ar, ag, ab);
        const contrast = accL > 0.62 ? "#12131a" : "#ffffff";

        // Aurora: pick distinct hues for variety; backfill with the accent.
        const picks: { r: number; g: number; b: number; h: number }[] = [];
        for (const cand of scored) {
          if (picks.every(p => Math.abs(p.h - cand.h) > 24 || picks.length === 0)) picks.push(cand);
          if (picks.length === 3) break;
        }
        while (picks.length < 3) picks.push(vibrant);
        const aurora: [string, string, string] = [
          hex(picks[0].r, picks[0].g, picks[0].b),
          hex(picks[1].r, picks[1].g, picks[1].b),
          hex(picks[2].r, picks[2].g, picks[2].b),
        ];

        resolve({ accent, contrast, aurora });
      } catch {
        resolve(null);
      }
    }).catch(() => resolve(null));
  });
}

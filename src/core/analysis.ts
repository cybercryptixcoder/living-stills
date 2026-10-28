// Pure image analysis. Runs in a Web Worker in the app and in Node for tests.
//
// The whole system rests on one fact (also used by LightLab, Magar et al. 2025):
// light is additive in linear RGB. If `off` is the scene with every light off and
// `on` the same scene with every light on, then  D = on - off  is the light the
// lights add. Any mix of lights is  off + sum_i  w_i * c_i * D_i,  and the D_i are
// recovered either by splitting D among the light sources (2 images total) or from
// one targeted edit per light (N + 1 images).

import type { GroupInfo, LayerData, LightInfo, Rect, SpriteData, Vec3 } from './types';

// ---------------------------------------------------------------- colour

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linToSrgbByte(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** RGBA bytes (sRGB) -> packed linear RGB floats. */
export function rgbaToLinear(rgba: Uint8ClampedArray | Uint8Array, n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const k = i * 4;
    out[j] = SRGB_TO_LIN[rgba[k]];
    out[j + 1] = SRGB_TO_LIN[rgba[k + 1]];
    out[j + 2] = SRGB_TO_LIN[rgba[k + 2]];
  }
  return out;
}

export function linearToRgba(lin: Float32Array, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const k = i * 4;
    out[k] = linToSrgbByte(lin[j]);
    out[k + 1] = linToSrgbByte(lin[j + 1]);
    out[k + 2] = linToSrgbByte(lin[j + 2]);
    out[k + 3] = 255;
  }
  return out;
}

export function luminance(lin: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) out[i] = 0.2126 * lin[j] + 0.7152 * lin[j + 1] + 0.0722 * lin[j + 2];
  return out;
}

// ---------------------------------------------------------------- helpers

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Separable box blur with running sums (edge-clamped). */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Three box passes approximate a Gaussian of the given sigma. */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.5) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

function sampleStride(n: number, target = 120000) {
  return Math.max(1, Math.floor(n / target));
}

export function median(values: Float32Array | number[]): number {
  const a = Float32Array.from(values as ArrayLike<number>).sort();
  if (!a.length) return 0;
  return a[a.length >> 1];
}

/** Robust standard deviation (1.4826 * MAD) from a strided sample. */
export function robustSigma(src: Float32Array, n = src.length): number {
  const step = sampleStride(n);
  const s: number[] = [];
  for (let i = 0; i < n; i += step) s.push(src[i]);
  const m = median(s);
  for (let i = 0; i < s.length; i++) s[i] = Math.abs(s[i] - m);
  return 1.4826 * median(s);
}

export function percentile(src: Float32Array, p: number, minValue = -Infinity): number {
  const step = sampleStride(src.length, 200000);
  const s: number[] = [];
  for (let i = 0; i < src.length; i += step) if (src[i] > minValue) s.push(src[i]);
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// ---------------------------------------------------------------- alignment

/** Integer translation (dx, dy) that best aligns `b` onto `a`, from gradient maps at half size. */
export function estimateShift(aLum: Float32Array, bLum: Float32Array, w: number, h: number, max = 3): [number, number] {
  const hw = w >> 1, hh = h >> 1;
  const grad = (src: Float32Array) => {
    const small = new Float32Array(hw * hh);
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < hw; x++) {
        const i = 2 * y * w + 2 * x;
        small[y * hw + x] = Math.sqrt(src[i] + src[i + 1] + src[i + w] + src[i + w + 1]); // perceptual-ish
      }
    const g = new Float32Array(hw * hh);
    for (let y = 1; y < hh - 1; y++)
      for (let x = 1; x < hw - 1; x++) {
        const i = y * hw + x;
        g[i] = Math.abs(small[i + 1] - small[i - 1]) + Math.abs(small[i + hw] - small[i - hw]);
      }
    return g;
  };
  const ga = grad(aLum), gb = grad(bLum);
  const m = Math.ceil(max / 2) + 1;
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -m; dy <= m; dy++)
    for (let dx = -m; dx <= m; dx++) {
      let acc = 0, cnt = 0;
      for (let y = m + 1; y < hh - m - 1; y += 2)
        for (let x = m + 1; x < hw - m - 1; x += 2) {
          acc += Math.abs(ga[y * hw + x] - gb[(y + dy) * hw + x + dx]);
          cnt++;
        }
      const score = acc / cnt + 1e-4 * (dx * dx + dy * dy);
      if (score < best) { best = score; bx = dx; by = dy; }
    }
  return [bx * 2, by * 2];
}

export function shiftRGB(src: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  if (!dx && !dy) return src;
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y + dy));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x + dx));
      const o = (y * w + x) * 3, s = (sy * w + sx) * 3;
      out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2];
    }
  }
  return out;
}

/** Exposure ratio between two renders of the same scene, from pixels the edit left alone. */
export function estimateGain(onLum: Float32Array, offLum: Float32Array): number {
  const step = sampleStride(onLum.length);
  const r: number[] = [];
  for (let i = 0; i < onLum.length; i += step) {
    const a = onLum[i], b = offLum[i];
    if (a > 0.004 && b > 0.004) {
      const q = a / b;
      if (q > 0.6 && q < 1.6) r.push(q);
    }
  }
  if (r.length < 100) return 1;
  return Math.min(1.25, Math.max(0.8, median(r)));
}

// ---------------------------------------------------------------- light change

export interface DeltaResult {
  D: Float32Array; // linear RGB, >= 0, cleaned
  lumD: Float32Array;
  noise: number; // robust sigma of the per-pixel luminance difference
}

/**
 * Light added between `off` and `on`, with re-rendering noise removed.
 * A change survives if it is coherent over a few pixels (blurred difference above the
 * noise floor) or very strong on its own (light cores).
 */
export function computeDelta(onLin: Float32Array, offLin: Float32Array, w: number, h: number, gain: number, cleanup = 1, feather?: (x: number, y: number) => number): DeltaResult {
  const n = w * h;
  const S = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const a = 0.2126 * onLin[j] + 0.7152 * onLin[j + 1] + 0.0722 * onLin[j + 2];
    const b = 0.2126 * offLin[j] + 0.7152 * offLin[j + 1] + 0.0722 * offLin[j + 2];
    S[i] = a - gain * b;
  }
  const sigma0 = Math.max(0.0015, robustSigma(S, n));
  const Sb = gaussBlur(S, w, h, 1.6);
  const sigmaB = Math.max(0.0009, robustSigma(Sb, n));
  const D = new Float32Array(n * 3);
  const lumD = new Float32Array(n);
  const a1 = 2.5 * cleanup * sigmaB, b1 = 6 * cleanup * sigmaB;
  const a2 = 7 * cleanup * sigma0, b2 = 14 * cleanup * sigma0;
  for (let y = 0, i = 0; y < h; y++)
    for (let x = 0; x < w; x++, i++) {
      const j = i * 3;
      const dr = Math.max(0, onLin[j] - gain * offLin[j]);
      const dg = Math.max(0, onLin[j + 1] - gain * offLin[j + 1]);
      const db = Math.max(0, onLin[j + 2] - gain * offLin[j + 2]);
      const l = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
      let m = Math.max(smoothstep(a1, b1, Sb[i]), smoothstep(a2, b2, l));
      if (feather) m *= feather(x, y);
      if (m <= 0) continue;
      D[j] = dr * m; D[j + 1] = dg * m; D[j + 2] = db * m;
      lumD[i] = l * m;
    }
  return { D, lumD, noise: sigma0 };
}

// ---------------------------------------------------------------- light cores

export function findCoreMask(lumD: Float32Array, onLum: Float32Array, noise: number, strictness = 1): Uint8Array {
  const p = percentile(lumD, 0.998, noise * 3);
  const tau = Math.max(0.3 * p * strictness, 9 * noise);
  const mask = new Uint8Array(lumD.length);
  for (let i = 0; i < lumD.length; i++) if (lumD[i] > tau && lumD[i] > 0.45 * onLum[i]) mask[i] = 1;
  return mask;
}

/** 8-connected component labelling (union-find). Returns labels (0 = background) and count. */
export function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  let next = 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const nb: number[] = [];
      if (x > 0 && labels[i - 1]) nb.push(labels[i - 1]);
      if (y > 0) {
        if (labels[i - w]) nb.push(labels[i - w]);
        if (x > 0 && labels[i - w - 1]) nb.push(labels[i - w - 1]);
        if (x < w - 1 && labels[i - w + 1]) nb.push(labels[i - w + 1]);
      }
      if (!nb.length) { labels[i] = next; parent.push(next); next++; }
      else {
        let m = nb[0];
        for (const v of nb) m = Math.min(m, v);
        labels[i] = m;
        for (const v of nb) union(m, v);
      }
    }
  const remap = new Int32Array(next);
  let count = 0;
  for (let l = 1; l < next; l++) {
    const r = find(l);
    if (!remap[r]) remap[r] = ++count;
    remap[l] = remap[r];
  }
  for (let i = 0; i < labels.length; i++) if (labels[i]) labels[i] = remap[labels[i]];
  return { labels, count };
}

interface Comp {
  pixels: number[];
  x0: number; y0: number; x1: number; y1: number;
  flux: number;
  cx: number; cy: number;
  rgb: Vec3;
  peak: number;
}

function compFromPixels(pixels: number[], w: number, lumD: Float32Array, D: Float32Array): Comp {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, flux = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0, peak = 0;
  for (const i of pixels) {
    const x = i % w, y = (i / w) | 0, l = lumD[i];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    flux += l; sx += x * l; sy += y * l;
    r += D[i * 3]; g += D[i * 3 + 1]; b += D[i * 3 + 2];
    if (l > peak) peak = l;
  }
  const f = Math.max(flux, 1e-9);
  const m = Math.max(r, g, b, 1e-9);
  return { pixels, x0, y0, x1, y1, flux, cx: sx / f, cy: sy / f, rgb: [r / m, g / m, b / m], peak };
}

/** Split a merged blob (a row of touching windows) at intensity valleys along its long axis. */
function splitComp(c: Comp, w: number, lumD: Float32Array, D: Float32Array, maxArea: number, depth = 0): Comp[] {
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
  const long = Math.max(bw, bh), short = Math.min(bw, bh);
  if (depth > 7 || long < 8 || (c.pixels.length <= maxArea && long / short < 3.2)) return [c];
  const alongX = bw >= bh;
  const L = alongX ? bw : bh;
  const prof = new Float32Array(L);
  for (const i of c.pixels) {
    const k = alongX ? (i % w) - c.x0 : ((i / w) | 0) - c.y0;
    prof[k] += lumD[i];
  }
  const sm = new Float32Array(L);
  for (let k = 0; k < L; k++) sm[k] = (prof[Math.max(0, k - 1)] + prof[k] + prof[Math.min(L - 1, k + 1)]) / 3;
  const leftMax = new Float32Array(L), rightMax = new Float32Array(L);
  for (let k = 0, m = 0; k < L; k++) { m = Math.max(m, sm[k]); leftMax[k] = m; }
  for (let k = L - 1, m = 0; k >= 0; k--) { m = Math.max(m, sm[k]); rightMax[k] = m; }
  let best = 1, bk = -1;
  for (let k = 2; k < L - 2; k++) {
    const ratio = sm[k] / Math.max(1e-9, Math.min(leftMax[k], rightMax[k]));
    if (ratio < best) { best = ratio; bk = k; }
  }
  if (bk < 0 || best > 0.62) return [c];
  const a: number[] = [], b: number[] = [];
  for (const i of c.pixels) {
    const k = alongX ? (i % w) - c.x0 : ((i / w) | 0) - c.y0;
    (k <= bk ? a : b).push(i);
  }
  if (!a.length || !b.length) return [c];
  return [
    ...splitComp(compFromPixels(a, w, lumD, D), w, lumD, D, maxArea, depth + 1),
    ...splitComp(compFromPixels(b, w, lumD, D), w, lumD, D, maxArea, depth + 1),
  ];
}

// ---------------------------------------------------------------- waterline

/**
 * Finds the water's edge in scenes with reflections: the first quiet band of rows under
 * the main body of lights, below which the light comes in vertical streaks that line up
 * with the lights above. Returns null when the scene does not look like that.
 */
export function suggestWaterline(lumD: Float32Array, w: number, h: number): { y: number; score: number } | null {
  const s = 4, sw = Math.floor(w / s), sh = Math.floor(h / s);
  const m = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let acc = 0;
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) acc += lumD[(y * s + yy) * w + x * s + xx];
      m[y * sw + x] = Math.sqrt(acc / (s * s));
    }
  const row = new Float32Array(sh);
  let total = 0;
  for (let y = 0; y < sh; y++) {
    let a = 0;
    for (let x = 0; x < sw; x++) a += m[y * sw + x];
    row[y] = a; total += a;
  }
  if (total <= 0) return null;
  let rmax = 0;
  const rs = new Float32Array(sh);
  for (let y = 0; y < sh; y++) {
    let a = 0, c = 0;
    for (let k = -1; k <= 1; k++) if (y + k >= 0 && y + k < sh) { a += row[y + k]; c++; }
    rs[y] = a / c; rmax = Math.max(rmax, rs[y]);
  }
  const blur1 = (a: Float32Array) => boxBlur(a, a.length, 1, 2);
  const corr = (a: Float32Array, b: Float32Array) => {
    const ab = blur1(a), bb = blur1(b);
    let ma = 0, mb = 0;
    for (let x = 0; x < sw; x++) { ma += ab[x]; mb += bb[x]; }
    ma /= sw; mb /= sw;
    let num = 0, da = 0, db = 0;
    for (let x = 0; x < sw; x++) { const p = ab[x] - ma, q = bb[x] - mb; num += p * q; da += p * p; db += q * q; }
    return num / Math.sqrt(Math.max(1e-12, da * db));
  };
  let cum = 0;
  for (let yw = 1; yw < sh - 2; yw++) {
    cum += row[yw - 1];
    const above = cum / total, below = 1 - above - row[yw] / total;
    if (yw < sh * 0.25 || above < 0.45 || below < 0.05) continue;
    if (rs[yw] > 0.08 * rmax) continue;
    // streakiness of the light below: strong left-right edges, weak up-down edges
    let gx = 0, gy = 0;
    const colA = new Float32Array(sw), colB = new Float32Array(sw);
    for (let y = 0; y < sh; y++) {
      const tgt = y < yw ? colA : colB;
      for (let x = 0; x < sw; x++) tgt[x] += m[y * sw + x];
      if (y <= yw || y >= sh - 1) continue;
      for (let x = 1; x < sw - 1; x++) {
        const i = y * sw + x;
        gx += Math.abs(m[i + 1] - m[i - 1]);
        gy += Math.abs(m[i + sw] - m[i - sw]);
      }
    }
    const streak = gx / Math.max(1e-9, gy);
    const c = corr(colA, colB);
    if (streak >= 1.25 && c >= 0.1) return { y: Math.round((yw + 0.5) * s), score: c * Math.min(2, streak) };
  }
  return null;
}

// ---------------------------------------------------------------- lights

export interface LightModel {
  lights: LightInfo[];
  coreLight: Uint8Array; // per pixel: light id whose core this pixel is in (0 = none)
}

export function detectLights(
  D: Float32Array, lumD: Float32Array, onLum: Float32Array, w: number, h: number,
  noise: number, opts: { strictness?: number; maxLights?: number; waterline?: number | null } = {},
): LightModel {
  const mask = findCoreMask(lumD, onLum, noise, opts.strictness ?? 1);
  const { labels, count } = labelComponents(mask, w, h);
  const buckets: number[][] = Array.from({ length: count + 1 }, () => []);
  for (let i = 0; i < labels.length; i++) if (labels[i]) buckets[labels[i]].push(i);
  const maxArea = Math.max(300, 0.0012 * w * h);
  let comps: Comp[] = [];
  for (let l = 1; l <= count; l++) {
    const px = buckets[l];
    const c = compFromPixels(px, w, lumD, D);
    if (px.length < 2 || (px.length < 4 && c.peak < 1.5 * (c.flux / px.length))) continue;
    comps.push(...splitComp(c, w, lumD, D, maxArea));
  }
  comps = comps.filter((c) => c.pixels.length >= 2);

  // Reflection highlights under a waterline belong to the lights above them.
  const yw = opts.waterline ?? null;
  if (yw != null) {
    const above = comps.filter((c) => c.cy < yw);
    comps = comps.filter((c) => {
      if (c.cy <= yw + 2) return true;
      const tol = Math.max(6, 0.6 * (c.x1 - c.x0 + 1));
      return !above.some((s) => s.x0 - tol <= c.x1 && c.x0 <= s.x1 + tol);
    });
  }

  // Keep the brightest when there are too many; the rest merge into the far-field remainder.
  const maxLights = Math.min(254, opts.maxLights ?? 240);
  comps.sort((a, b) => b.flux - a.flux);
  if (comps.length > maxLights) comps.length = maxLights;
  // Stable ids: reading order (top-left to bottom-right) feels natural in the UI.
  comps.sort((a, b) => (Math.round(a.cy / 24) - Math.round(b.cy / 24)) || a.cx - b.cx);

  const coreLight = new Uint8Array(w * h);
  const lights: LightInfo[] = comps.map((c, k) => {
    const id = k + 1;
    for (const i of c.pixels) coreLight[i] = id;
    return {
      id, x: c.cx, y: c.cy, bbox: [c.x0, c.y0, c.x1, c.y1], area: c.pixels.length,
      flux: c.flux, color: c.rgb, group: 0,
    };
  });
  return { lights, coreLight };
}

// ---------------------------------------------------------------- soft assignment

export interface ScoreCtx {
  lights: LightInfo[];
  w: number;
  h: number;
  waterline: number | null;
}

function bboxDist(px: number, py: number, b: [number, number, number, number]) {
  const dx = px < b[0] ? b[0] - px : px > b[2] ? px - b[2] : 0;
  const dy = py < b[1] ? b[1] - py : py > b[3] ? py - b[3] : 0;
  return [dx, dy];
}

/** Influence of light `L` on pixel (px, py) and the distance used for the far-field blend. */
export function lightScore(L: LightInfo, px: number, py: number, yw: number | null): [number, number] {
  const [dx, dy] = bboxDist(px, py, L.bbox);
  const rho = Math.max(1.5, 0.5 * Math.sqrt(L.area));
  const d2 = dx * dx + dy * dy;
  let s = L.flux / (d2 + rho * rho);
  let d = Math.sqrt(d2);
  if (yw != null && py > yw && L.y < yw) {
    // Reflection: a vertical streak under the light, loosely mirrored about the waterline.
    const ym = 2 * yw - L.y;
    const ry = (py - ym) / 6;
    const r2 = dx * dx + ry * ry;
    const sr = (0.85 * L.flux) / (r2 + rho * rho);
    if (sr > s) { s = sr; d = Math.min(d, Math.sqrt(r2)); }
  }
  return [s, d];
}

/**
 * Splits the light change D among the lights. Each pixel keeps its four strongest lights.
 * Pixels far from every light go to id 0, the far-field remainder (sky glow, haze).
 */
export function assignLights(lumD: Float32Array, model: LightModel, ctx: ScoreCtx): { ids: Uint8Array; weights: Uint8Array } {
  const { w, h, lights, waterline } = ctx;
  const n = w * h;
  const ids = new Uint8Array(n * 4);
  const weights = new Uint8Array(n * 4);
  if (!lights.length) {
    for (let i = 0; i < n; i++) if (lumD[i] > 0) weights[i * 4] = 255; // all to remainder (id 0)
    return { ids, weights };
  }
  const CELL = 24, K = Math.min(10, lights.length);
  const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
  const cand = new Int16Array(cw * ch * K).fill(-1);
  const hd = CELL * 0.75;
  const tmpS = new Float32Array(lights.length);
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      const px = (cx + 0.5) * CELL, py = (cy + 0.5) * CELL;
      for (let l = 0; l < lights.length; l++) {
        const L = lights[l];
        // optimistic: shrink distance by the cell half diagonal
        const [dx0, dy0] = bboxDist(px, py, L.bbox);
        const dx = Math.max(0, dx0 - hd), dy = Math.max(0, dy0 - hd);
        const rho = Math.max(1.5, 0.5 * Math.sqrt(L.area));
        let s = L.flux / (dx * dx + dy * dy + rho * rho);
        if (waterline != null && py + hd > waterline && L.y < waterline) {
          const ry = Math.max(0, Math.abs(py - (2 * waterline - L.y)) - hd) / 6;
          s = Math.max(s, (0.85 * L.flux) / (dx * dx + ry * ry + rho * rho));
        }
        tmpS[l] = s;
      }
      const base = (cy * cw + cx) * K;
      // partial selection of top K
      for (let k = 0; k < K; k++) {
        let bi = -1, bs = -1;
        for (let l = 0; l < lights.length; l++) if (tmpS[l] > bs) { bs = tmpS[l]; bi = l; }
        cand[base + k] = bi;
        if (bi >= 0) tmpS[bi] = -2;
      }
    }

  const farA = 0.12 * w, farB = 0.3 * w;
  const topId = [0, 0, 0, 0], topS = [0, 0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (lumD[i] <= 0) continue;
      const o = i * 4;
      const core = model.coreLight[i];
      if (core) { ids[o] = core; weights[o] = 255; continue; }
      topS[0] = topS[1] = topS[2] = topS[3] = 0;
      let dmin = Infinity;
      const base = (((y / CELL) | 0) * cw + ((x / CELL) | 0)) * K;
      for (let k = 0; k < K; k++) {
        const li = cand[base + k];
        if (li < 0) break;
        const [s, d] = lightScore(lights[li], x, y, waterline);
        if (d < dmin) dmin = d;
        // insert into top 4
        let m = 0;
        for (let q = 1; q < 4; q++) if (topS[q] < topS[m]) m = q;
        if (s > topS[m]) { topS[m] = s; topId[m] = lights[li].id; }
      }
      const sum = topS[0] + topS[1] + topS[2] + topS[3];
      const g = smoothstep(farA, farB, dmin);
      // write: slot 3 may become the remainder
      let acc = 0, maxQ = 0;
      const wq = [0, 0, 0, 0];
      for (let q = 0; q < 4; q++) {
        wq[q] = sum > 0 ? Math.round((topS[q] / sum) * (1 - g) * 255) : 0;
        if (wq[q] > wq[maxQ]) maxQ = q;
      }
      if (g > 0.004) {
        // replace the weakest slot with the remainder id 0
        let mq = 0;
        for (let q = 1; q < 4; q++) if (wq[q] < wq[mq]) mq = q;
        wq[mq] = Math.round(g * 255);
        topId[mq] = 0;
        if (wq[mq] > wq[maxQ]) maxQ = mq;
      }
      for (let q = 0; q < 4; q++) acc += wq[q];
      wq[maxQ] += 255 - acc;
      for (let q = 0; q < 4; q++) { ids[o + q] = wq[q] > 0 ? topId[q] : 0; weights[o + q] = Math.max(0, wq[q]); }
    }
  return { ids, weights };
}

// ---------------------------------------------------------------- groups

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function describeArea(x: number, y: number, w: number, h: number): string {
  const v = y < h * 0.36 ? 'upper' : y > h * 0.66 ? 'lower' : 'middle';
  const hz = x < w * 0.36 ? 'left' : x > w * 0.64 ? 'right' : 'centre';
  if (v === 'middle' && hz === 'centre') return 'centre';
  if (v === 'middle') return hz === 'left' ? 'left side' : 'right side';
  return `${v} ${hz}`;
}

/**
 * Clusters lights into a handful of spatial groups (a building, a street, a bank of the river)
 * with flux-weighted k-means. Rows matter more than columns in most scenes, so vertical distance
 * counts 1.6x. Initialisation is deterministic (farthest point), so groups are stable across loads.
 */
export function groupLights(lights: LightInfo[], _w: number, _h: number, maxGroups = 8): GroupInfo[] {
  if (!lights.length) return [];
  const k = Math.max(1, Math.min(maxGroups, lights.length, Math.round(lights.length / 20) + 1));
  const P = lights.map((L) => [L.x, L.y * 1.6] as [number, number]);
  const wt = lights.map((L) => Math.sqrt(L.flux) + 1e-6);
  // farthest-point init starting from the brightest light
  const centers: [number, number][] = [];
  let first = 0;
  for (let i = 1; i < lights.length; i++) if (wt[i] > wt[first]) first = i;
  centers.push([...P[first]] as [number, number]);
  while (centers.length < k) {
    let bi = 0, bd = -1;
    for (let i = 0; i < P.length; i++) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, (P[i][0] - c[0]) ** 2 + (P[i][1] - c[1]) ** 2);
      if (d > bd) { bd = d; bi = i; }
    }
    centers.push([...P[bi]] as [number, number]);
  }
  const assign = new Int32Array(lights.length);
  for (let iter = 0; iter < 40; iter++) {
    let moved = false;
    for (let i = 0; i < P.length; i++) {
      let bc = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (P[i][0] - centers[c][0]) ** 2 + (P[i][1] - centers[c][1]) ** 2;
        if (d < bd) { bd = d; bc = c; }
      }
      if (assign[i] !== bc) { assign[i] = bc; moved = true; }
    }
    const acc = centers.map(() => [0, 0, 0]);
    for (let i = 0; i < P.length; i++) { const a = acc[assign[i]]; a[0] += P[i][0] * wt[i]; a[1] += P[i][1] * wt[i]; a[2] += wt[i]; }
    acc.forEach((a, c) => { if (a[2] > 0) centers[c] = [a[0] / a[2], a[1] / a[2]]; });
    if (!moved && iter > 0) break;
  }
  const clusters = centers.map((_, c) => lights.map((_, i) => i).filter((i) => assign[i] === c)).filter((c) => c.length);
  const groups = clusters.map((c) => {
    let fx = 0, fy = 0, f = 0;
    for (const i of c) { const L = lights[i]; fx += L.x * L.flux; fy += L.y * L.flux; f += L.flux; }
    return { idx: c, x: fx / f, y: fy / f };
  });
  groups.sort((a, b) => a.x - b.x);
  return groups.map((g, gi) => {
    for (const i of g.idx) lights[i].group = gi;
    return {
      id: gi,
      name: LETTERS[gi] ?? String(gi + 1),
      lights: g.idx.map((i) => lights[i].id),
      x: g.x,
      y: g.y,
      kind: 'static' as const,
    };
  });
}

// ---------------------------------------------------------------- the split method

export interface SplitResult {
  layer: LayerData;
  lights: LightInfo[];
  groups: GroupInfo[];
  waterline: number | null;
  D: Float32Array;
  lumD: Float32Array;
  offLin: Float32Array;
  stats: { shift: [number, number]; gain: number; noise: number; cores: number };
}

export function analyzeSplit(
  onRGBA: Uint8ClampedArray, offRGBA: Uint8ClampedArray, w: number, h: number,
  opts: { cleanup?: number; strictness?: number; maxLights?: number; waterline?: number | null } = {},
): SplitResult {
  const n = w * h;
  const onLin = rgbaToLinear(onRGBA, n);
  let offLin = rgbaToLinear(offRGBA, n);
  const onLum = luminance(onLin, n);
  let offLum = luminance(offLin, n);
  const shift = estimateShift(onLum, offLum, w, h, 3);
  if (shift[0] || shift[1]) {
    offLin = shiftRGB(offLin, w, h, shift[0], shift[1]);
    offLum = luminance(offLin, n);
  }
  const gain = estimateGain(onLum, offLum);
  const { D, lumD, noise } = computeDelta(onLin, offLin, w, h, gain, opts.cleanup ?? 1);
  let waterline = opts.waterline === undefined ? suggestWaterline(lumD, w, h)?.y ?? null : opts.waterline;
  if (waterline != null) waterline = Math.round(waterline);
  const model = detectLights(D, lumD, onLum, w, h, noise, { strictness: opts.strictness, maxLights: opts.maxLights, waterline });
  const { ids, weights } = assignLights(lumD, model, { w, h, lights: model.lights, waterline });
  const groups = groupLights(model.lights, w, h);
  // Base = gain-matched, aligned lights-off image.
  const baseLin = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) baseLin[i] = Math.min(1, offLin[i] * gain);
  const delta = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    delta[i * 4] = D[i * 3]; delta[i * 4 + 1] = D[i * 3 + 1]; delta[i * 4 + 2] = D[i * 3 + 2]; delta[i * 4 + 3] = 1;
  }
  return {
    layer: { base: linearToRgba(baseLin, n), delta, ids, weights },
    lights: model.lights, groups, waterline, D, lumD, offLin: baseLin,
    stats: { shift, gain, noise, cores: model.lights.length },
  };
}

// ---------------------------------------------------------------- targeted edits (per light, grid)

export interface CropDelta {
  id: number; // light id this light belongs to
  crop: Rect;
  d: Float32Array; // crop-sized linear RGB, >= 0
}

/**
 * Light added by an edit of one crop. `resultRGBA` must already be resized to the crop size.
 * Edges of the crop are feathered so the pasted light never shows a seam.
 */
export function cropDelta(baseLin: Float32Array, w: number, h: number, crop: Rect, resultRGBA: Uint8ClampedArray, id: number, cleanup = 1, ownership?: (x: number, y: number) => number): CropDelta {
  const [cx, cy, cw, ch] = crop;
  const n = cw * ch;
  const res = rgbaToLinear(resultRGBA, n);
  const base = new Float32Array(n * 3);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const s = ((cy + y) * w + cx + x) * 3, o = (y * cw + x) * 3;
      base[o] = baseLin[s]; base[o + 1] = baseLin[s + 1]; base[o + 2] = baseLin[s + 2];
    }
  const gain = estimateGain(luminance(res, n), luminance(base, n));
  const fx = Math.max(4, 0.16 * cw), fy = Math.max(4, 0.16 * ch);
  const touchL = cx <= 0, touchT = cy <= 0, touchR = cx + cw >= w, touchB = cy + ch >= h;
  const feather = (x: number, y: number) => {
    let f = 1;
    if (!touchL) f *= smoothstep(0, fx, x);
    if (!touchR) f *= smoothstep(0, fx, cw - 1 - x);
    if (!touchT) f *= smoothstep(0, fy, y);
    if (!touchB) f *= smoothstep(0, fy, ch - 1 - y);
    if (ownership) f *= ownership(cx + x, cy + y);
    return f;
  };
  const { D } = computeDelta(res, base, cw, ch, gain, cleanup, feather);
  return { id, crop, d: D };
}

/**
 * Builds a light layer from per-light contributions. `split` (optional) provides the
 * estimated light for lights without their own edit.
 */
export function layerFromContributions(
  w: number, h: number, base: Uint8ClampedArray, crops: CropDelta[],
  split?: { D: Float32Array; ids: Uint8Array; weights: Uint8Array; replaced: Set<number> },
): LayerData {
  const n = w * h;
  const topId = new Uint8Array(n * 4);
  const topL = new Float32Array(n * 4);
  const sum = new Float32Array(n * 3);
  const insert = (i: number, id: number, l: number) => {
    const o = i * 4;
    for (let q = 0; q < 4; q++) if (topL[o + q] > 0 && topId[o + q] === id) { topL[o + q] += l; return; }
    let m = 0;
    for (let q = 1; q < 4; q++) if (topL[o + q] < topL[o + m]) m = q;
    if (l > topL[o + m]) { topL[o + m] = l; topId[o + m] = id; }
  };
  if (split) {
    for (let i = 0; i < n; i++) {
      const j = i * 3, o = i * 4;
      const l = 0.2126 * split.D[j] + 0.7152 * split.D[j + 1] + 0.0722 * split.D[j + 2];
      if (l <= 0) continue;
      let keep = 0;
      for (let q = 0; q < 4; q++) {
        const wq = split.weights[o + q] / 255;
        if (wq <= 0) continue;
        const id = split.ids[o + q];
        if (split.replaced.has(id)) continue;
        keep += wq;
        insert(i, id, l * wq);
      }
      sum[j] += split.D[j] * keep; sum[j + 1] += split.D[j + 1] * keep; sum[j + 2] += split.D[j + 2] * keep;
    }
  }
  for (const c of crops) {
    const [cx, cy, cw, ch] = c.crop;
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const s = (y * cw + x) * 3;
        const r = c.d[s], g = c.d[s + 1], b = c.d[s + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l <= 0) continue;
        const i = (cy + y) * w + cx + x, j = i * 3;
        sum[j] += r; sum[j + 1] += g; sum[j + 2] += b;
        insert(i, c.id, l);
      }
  }
  const delta = new Float32Array(n * 4);
  const ids = new Uint8Array(n * 4);
  const weights = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4, j = i * 3;
    delta[o] = sum[j]; delta[o + 1] = sum[j + 1]; delta[o + 2] = sum[j + 2]; delta[o + 3] = 1;
    const t = topL[o] + topL[o + 1] + topL[o + 2] + topL[o + 3];
    if (t <= 0) continue;
    let acc = 0, mq = 0;
    for (let q = 0; q < 4; q++) {
      const v = Math.round((topL[o + q] / t) * 255);
      weights[o + q] = v; ids[o + q] = v > 0 ? topId[o + q] : 0; acc += v;
      if (v > weights[o + mq]) mq = q;
    }
    weights[o + mq] += 255 - acc;
  }
  return { base, delta, ids, weights };
}

// ---------------------------------------------------------------- moving element (sprite)

/** Finds the moving element as the biggest region that differs between the scene and its empty plate. */
export function detectElementRect(onRGBA: Uint8ClampedArray, plateRGBA: Uint8ClampedArray, w: number, h: number): Rect | null {
  const n = w * h;
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    diff[i] = Math.max(Math.abs(onRGBA[k] - plateRGBA[k]), Math.abs(onRGBA[k + 1] - plateRGBA[k + 1]), Math.abs(onRGBA[k + 2] - plateRGBA[k + 2])) / 255;
  }
  const db = gaussBlur(diff, w, h, 1.2);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = db[i] > 0.09 ? 1 : 0;
  const { labels, count } = labelComponents(mask, w, h);
  if (!count) return null;
  const area = new Int32Array(count + 1);
  const bb = Array.from({ length: count + 1 }, () => [Infinity, Infinity, -1, -1]);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l) continue;
    area[l]++;
    const x = i % w, y = (i / w) | 0, b = bb[l];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  let best = 0;
  for (let l = 1; l <= count; l++) if (area[l] > area[best] || !best) best = l;
  if (area[best] < 0.002 * n) return null;
  const b = bb[best];
  const x0 = Math.max(0, b[0] - 3), y0 = Math.max(0, b[1] - 3);
  const x1 = Math.min(w - 1, b[2] + 3), y1 = Math.min(h - 1, b[3] + 3);
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

function dilate(mask: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r) && m < 1; yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (mask[yy * w + xx] > m) m = mask[yy * w + xx];
      out[y * w + x] = m;
    }
  return out;
}
function erode(mask: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r) && m > 0; yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (mask[yy * w + xx] < m) m = mask[yy * w + xx];
      out[y * w + x] = m;
    }
  return out;
}

/**
 * Cuts the moving element out as a sprite with two lighting states, plus the light it
 * casts around itself (window glow on the bridge, its reflection in the water).
 */
export function computeSprite(
  tOn: Uint8ClampedArray, tOff: Uint8ClampedArray, pOn: Uint8ClampedArray, pOff: Uint8ClampedArray,
  w: number, h: number, rect: Rect,
): SpriteData {
  const [rx, ry, rw, rh] = rect.map(Math.round) as Rect;
  const n = rw * rh;
  const take = (src: Uint8ClampedArray, x0: number, y0: number, cw: number, chh: number) => {
    const out = new Uint8ClampedArray(cw * chh * 4);
    for (let y = 0; y < chh; y++) out.set(src.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
    return out;
  };
  const TonC = take(tOn, rx, ry, rw, rh), TffC = take(tOff, rx, ry, rw, rh);
  const PonC = take(pOn, rx, ry, rw, rh), PffC = take(pOff, rx, ry, rw, rh);
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const a = Math.max(Math.abs(TonC[k] - PonC[k]), Math.abs(TonC[k + 1] - PonC[k + 1]), Math.abs(TonC[k + 2] - PonC[k + 2]));
    const b = Math.max(Math.abs(TffC[k] - PffC[k]), Math.abs(TffC[k + 1] - PffC[k + 1]), Math.abs(TffC[k + 2] - PffC[k + 2]));
    diff[i] = Math.max(a, b) / 255;
  }
  const db = gaussBlur(diff, rw, rh, 0.8);
  let alpha: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = smoothstep(0.05, 0.16, db[i]);
  // Close small holes (dark window frames, gaps between cars) so the body is solid.
  const bin = new Float32Array(n);
  for (let i = 0; i < n; i++) bin[i] = alpha[i] > 0.5 ? 1 : 0;
  const closed = erode(dilate(bin, rw, rh, 2), rw, rh, 2);
  for (let i = 0; i < n; i++) alpha[i] = Math.max(alpha[i], closed[i]);
  alpha = gaussBlur(alpha, rw, rh, 0.6);
  // Fade the matte at the rect border so nothing hard-edged travels with the sprite.
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const e = Math.min(x, y, rw - 1 - x, rh - 1 - y);
      if (e < 2) alpha[y * rw + x] *= e / 2;
    }
  const lin = (a: Uint8ClampedArray) => rgbaToLinear(a, n);
  const ton = lin(TonC), tof = lin(TffC), pon = lin(PonC), pof = lin(PffC);
  const lit = new Float32Array(n * 4), dark = new Float32Array(n * 4);
  let fr = 0, fg = 0, fb = 0, flux = 0;
  for (let i = 0; i < n; i++) {
    const a = alpha[i], j = i * 3, o = i * 4;
    const ia = 1 / Math.max(a, 0.05);
    for (let c = 0; c < 3; c++) {
      // decontaminate the edge: remove the background that bled into partially covered pixels
      const fOn = Math.max(0, (ton[j + c] - (1 - a) * pon[j + c]) * ia);
      const fOff = Math.max(0, (tof[j + c] - (1 - a) * pof[j + c]) * ia);
      lit[o + c] = Math.min(4, fOn) * a;
      dark[o + c] = Math.min(4, fOff) * a;
    }
    lit[o + 3] = a; dark[o + 3] = a;
    const dr = Math.max(0, lit[o] - dark[o]), dg = Math.max(0, lit[o + 1] - dark[o + 1]), dbb = Math.max(0, lit[o + 2] - dark[o + 2]);
    fr += dr; fg += dg; fb += dbb; flux += 0.2126 * dr + 0.7152 * dg + 0.0722 * dbb;
  }
  // Spill: light the element throws around itself, including into water below.
  const sx0 = Math.max(0, Math.round(rx - 0.5 * rw)), sx1 = Math.min(w, Math.round(rx + 1.5 * rw));
  const sy0 = Math.max(0, Math.round(ry - 0.6 * rh)), sy1 = Math.min(h, Math.round(ry + rh + Math.max(2.5 * rh, 0.25 * h)));
  const sw = sx1 - sx0, sh = sy1 - sy0, sn = sw * sh;
  const sOn = lin(take(tOn, sx0, sy0, sw, sh)), sP = lin(take(pOn, sx0, sy0, sw, sh));
  const gain = estimateGain(luminance(sOn, sn), luminance(sP, sn));
  const { D } = computeDelta(sOn, sP, sw, sh, gain, 1.2, (x, y) => {
    const X = x + sx0 - rx, Y = y + sy0 - ry;
    const inside = X >= 0 && Y >= 0 && X < rw && Y < rh ? alpha[Y * rw + X] : 0;
    const ex = Math.min(x, sw - 1 - x) / Math.max(4, 0.15 * sw), ey = Math.min(y, sh - 1 - y) / Math.max(4, 0.12 * sh);
    return (1 - inside) * Math.min(1, ex) * Math.min(1, ey);
  });
  const spill = new Float32Array(sn * 4);
  for (let i = 0; i < sn; i++) {
    spill[i * 4] = D[i * 3]; spill[i * 4 + 1] = D[i * 3 + 1]; spill[i * 4 + 2] = D[i * 3 + 2]; spill[i * 4 + 3] = 1;
  }
  const m = Math.max(fr, fg, fb, 1e-9);
  return {
    rect: [rx, ry, rw, rh], lit, dark, spillRect: [sx0, sy0, sw, sh], spill,
    flux, color: [fr / m, fg / m, fb / m],
  };
}

/** Composites the sprite over a linear base at x offset `dx` (used to build grid frames). */
export function compositeSprite(baseLin: Float32Array, w: number, h: number, sp: SpriteData, dx: number, lightLevel: number): Float32Array {
  const out = baseLin.slice();
  const [rx, ry, rw, rh] = sp.rect;
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const X = rx + x + Math.round(dx), Y = ry + y;
      if (X < 0 || X >= w || Y < 0 || Y >= h) continue;
      const o = (y * rw + x) * 4, j = (Y * w + X) * 3;
      const a = sp.lit[o + 3];
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const col = sp.dark[o + c] + lightLevel * (sp.lit[o + c] - sp.dark[o + c]);
        out[j + c] = col + (1 - a) * out[j + c];
      }
    }
  if (lightLevel > 0) {
    const [sx, sy, sw, sh] = sp.spillRect;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const X = sx + x + Math.round(dx), Y = sy + y;
        if (X < 0 || X >= w || Y < 0 || Y >= h) continue;
        const o = (y * sw + x) * 4, j = (Y * w + X) * 3;
        for (let c = 0; c < 3; c++) out[j + c] += lightLevel * sp.spill[o + c];
      }
  }
  return out;
}

/** Crop rectangle around a region, padded with context and fitted to an aspect ratio inside the image. */
export function contextCrop(region: Rect, w: number, h: number, aspect: number, pad = 2.2, minW = 192): Rect {
  const [x, y, rw, rh] = region;
  const cx = x + rw / 2, cy = y + rh / 2;
  let cw = Math.max(minW, rw * pad, rh * pad * aspect);
  let ch = cw / aspect;
  if (ch < rh * pad) { ch = rh * pad; cw = ch * aspect; }
  if (cw > w) { cw = w; ch = cw / aspect; }
  if (ch > h) { ch = h; cw = Math.min(w, ch * aspect); }
  cw = Math.round(cw); ch = Math.round(ch);
  const x0 = Math.round(Math.min(w - cw, Math.max(0, cx - cw / 2)));
  const y0 = Math.round(Math.min(h - ch, Math.max(0, cy - ch / 2)));
  return [x0, y0, cw, ch];
}

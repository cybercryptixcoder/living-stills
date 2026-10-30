// Turns a scene document plus its images into GPU-ready light layers.
// Runs inside the analysis worker; images arrive as decoded RGBA.

import {
  analyzeSplit, boxBlur, computeSprite, cropDelta, layerFromContributions, rgbaToLinear, smoothstep, type CropDelta,
} from './analysis';
import type { AnalysisResult, GroupInfo, LightInfo, Marker, Rect, SceneDoc, SpriteData } from './types';
import { DEFAULT_ANALYSIS } from './types';

export interface Decoded {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export type ImageGetter = (key: string, size?: [number, number]) => Promise<Decoded>;

interface PlateInfo {
  split: ReturnType<typeof analyzeSplit>;
  sprite?: SpriteData;
}

const plateCache = new Map<string, Promise<PlateInfo>>();

function plate(doc: SceneDoc, get: ImageGetter): Promise<PlateInfo> {
  const key = JSON.stringify([doc.id, doc.method, doc.images.plateOn ?? doc.images.on, doc.analysis ?? null, doc.waterline ?? 'auto', doc.motion?.rect ?? null]);
  let hit = plateCache.get(key);
  if (!hit) {
    hit = computePlate(doc, get);
    plateCache.set(key, hit);
    if (plateCache.size > 6) plateCache.delete(plateCache.keys().next().value!);
    hit.catch(() => plateCache.delete(key));
  }
  return hit;
}

async function computePlate(doc: SceneDoc, get: ImageGetter): Promise<PlateInfo> {
  const { width: w, height: h } = doc;
  const p = { ...DEFAULT_ANALYSIS, ...(doc.analysis ?? {}) };
  const layered = doc.method === 'layered';
  const onKey = layered ? 'plateOn' : 'on';
  const offKey = layered ? 'plateOff' : 'off';
  const [on, off] = await Promise.all([get(onKey, [w, h]), get(offKey, [w, h])]);
  const split = analyzeSplit(on.data, off.data, w, h, {
    cleanup: p.cleanup, strictness: p.coreStrictness, maxLights: p.maxLights,
    waterline: doc.waterline === undefined ? undefined : doc.waterline, signed: p.signed,
    focus: doc.markers?.length ? markerFocus(doc.markers, w) : undefined,
  });
  let sprite: SpriteData | undefined;
  if (layered && doc.motion) {
    const [tOn, tOff] = await Promise.all([get('on', [w, h]), get('off', [w, h])]);
    sprite = computeSprite(tOn.data, tOff.data, on.data, off.data, w, h, doc.motion.rect);
  }
  return { split, sprite };
}

/**
 * Where a refined light may add light: the area the split analysis gave to it, softened and widened a
 * little. Keeps an edit from leaking light the model invented elsewhere in the crop.
 */
function splitOwnership(layer: { ids: Uint8Array; weights: Uint8Array }, w: number, h: number, id: number, crop: Rect) {
  const [cx, cy, cw, ch] = crop;
  const m = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const X = cx + x, Y = cy + y;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const o = (Y * w + X) * 4;
      let v = 0;
      for (let q = 0; q < 4; q++) if (layer.ids[o + q] === id) v += layer.weights[o + q] / 255;
      m[y * cw + x] = v;
    }
  const r = Math.max(2, Math.round(0.012 * w));
  const b = boxBlur(boxBlur(m, cw, ch, r), cw, ch, r);
  return (X: number, Y: number) => {
    const x = X - cx, y = Y - cy;
    if (x < 0 || y < 0 || x >= cw || y >= ch) return 0;
    return smoothstep(0.03, 0.3, b[y * cw + x]);
  };
}

/**
 * Two-stage scenes: only change near the lights you placed counts as light. The rest of the
 * difference is the image model redrawing things (hatching, texture) and would become noise lights.
 * Glow is allowed to reach a good way past each object.
 */
export function markerFocus(markers: Marker[], w: number) {
  const boxes = markers.map((m) => m.box ?? [m.x - 0.05 * w, m.y - 0.05 * w, m.x + 0.05 * w, m.y + 0.05 * w]);
  const reach = 0.14 * w;
  return (x: number, y: number) => {
    let best = 0;
    for (const [x0, y0, x1, y1] of boxes) {
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const d = Math.hypot(dx, dy);
      const v = d <= 0 ? 1 : Math.exp(-(d * d) / (2 * reach * reach * 0.35));
      if (v > best) best = v;
      if (best >= 1) break;
    }
    return best < 0.02 ? 0 : best;
  };
}

/** Two-stage scenes: every light found belongs to the marker the user placed on it (or "other"). */
function groupByMarkers(lights: LightInfo[], markers: Marker[], w: number): GroupInfo[] {
  const pad = 0.04 * w;
  for (const L of lights) {
    let pick: Marker | null = null, best = Infinity;
    for (const m of markers) {
      if (!m.box) continue;
      const [x0, y0, x1, y1] = m.box;
      if (L.x >= x0 - pad && L.x <= x1 + pad && L.y >= y0 - pad && L.y <= y1 + pad) {
        const area = (x1 - x0) * (y1 - y0);
        if (area < best) { best = area; pick = m; }
      }
    }
    if (!pick) {
      best = Infinity;
      for (const m of markers) {
        const d = Math.hypot(L.x - m.x, L.y - m.y);
        if (d < best) { best = d; pick = m; }
      }
      if (best > 0.2 * w) pick = null;
    }
    L.marker = pick?.n ?? 0;
  }
  const groups: GroupInfo[] = [];
  for (const m of [...markers].sort((a, b) => a.n - b.n)) {
    const ls = lights.filter((L) => L.marker === m.n);
    if (!ls.length) continue;
    groups.push({ id: groups.length, name: markerName(m), lights: ls.map((L) => L.id), x: m.x, y: m.y });
  }
  const rest = lights.filter((L) => !L.marker);
  if (rest.length) {
    const x = rest.reduce((a, L) => a + L.x, 0) / rest.length, y = rest.reduce((a, L) => a + L.y, 0) / rest.length;
    groups.push({ id: groups.length, name: 'Other light', lights: rest.map((L) => L.id), x, y });
  }
  const byLight = new Map<number, number>();
  groups.forEach((g) => g.lights.forEach((id) => byLight.set(id, g.id)));
  for (const L of lights) L.group = byLight.get(L.id) ?? 0;
  return groups;
}

export function markerName(m: Marker) {
  // your own words first (short and yours); the planner's fuller description otherwise
  let t = (m.note || m.object || `Light ${m.n}`).trim().replace(/^(the|a|an) /i, '');
  if (t.length > 42) t = t.slice(0, 40).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export async function analyzeScene(doc: SceneDoc, get: ImageGetter): Promise<AnalysisResult> {
  const t0 = performance.now();
  const { width: w, height: h } = doc;
  const p = { ...DEFAULT_ANALYSIS, ...(doc.analysis ?? {}) };
  const { split, sprite } = await plate(doc, get);
  const stats = { ...split.stats, ms: 0 };

  let lights = split.lights, groups = split.groups;
  if (doc.markers?.length) {
    lights = split.lights.map((L) => ({ ...L }));
    groups = groupByMarkers(lights, doc.markers, w);
  }
  const ambient = doc.images.ambient ? (await get('ambient', [w, h])).data.slice() : undefined;
  const common = { width: w, height: h, waterline: split.waterline, stats, signed: split.signed, ambient };

  if (doc.method !== 'perLight') {
    stats.ms = performance.now() - t0;
    return { ...common, layers: [split.layer], lights, groups, sprite };
  }

  const crops: CropDelta[] = [];
  const replaced = new Set<number>();
  for (const r of doc.refinements ?? []) {
    // Find the light again by where it was; ids can change when lights are re-found.
    let id = r.lightId;
    if (r.at) {
      let best = Infinity;
      for (const L of split.lights) {
        const [x0, y0, x1, y1] = L.bbox;
        const dx = r.at[0] < x0 ? x0 - r.at[0] : r.at[0] > x1 ? r.at[0] - x1 : 0;
        const dy = r.at[1] < y0 ? y0 - r.at[1] : r.at[1] > y1 ? r.at[1] - y1 : 0;
        const d = Math.hypot(dx, dy) + 0.01 * Math.hypot(L.x - r.at[0], L.y - r.at[1]);
        if (d < best) { best = d; id = L.id; }
      }
      if (best > 40) continue; // that light no longer exists
    }
    if (replaced.has(id)) continue;
    const img = await get(r.image, [r.crop[2], r.crop[3]]);
    crops.push(cropDelta(split.offLin, w, h, r.crop, img.data, id, p.cleanup, splitOwnership(split.layer, w, h, id, r.crop)));
    replaced.add(id);
  }
  const edited = layerFromContributions(w, h, split.layer.base, crops, {
    D: split.D, ids: split.layer.ids, weights: split.layer.weights, replaced,
  });
  const refinedLights = lights.map((L) => ({ ...L, refined: replaced.has(L.id) }));
  stats.ms = performance.now() - t0;
  return { ...common, layers: [split.layer, edited], lights: refinedLights, groups, editedLayer: 1 };
}

/** sRGB RGBA bytes of a crop of a grid frame or of a stored image (for sending to the model). */
export async function cropSource(
  doc: SceneDoc, get: ImageGetter,
  src: { kind: 'image'; key: string },
  crop: Rect,
): Promise<Decoded> {
  const { width: w, height: h } = doc;
  const full = (await get(src.key, [w, h])).data;
  const [cx, cy, cw, ch] = crop;
  const out = new Uint8ClampedArray(cw * ch * 4);
  // Crops may reach past the picture (to keep a light centred): repeat the edge pixels there.
  for (let y = 0; y < ch; y++) {
    const Y = Math.min(h - 1, Math.max(0, cy + y));
    for (let x = 0; x < cw; x++) {
      const X = Math.min(w - 1, Math.max(0, cx + x));
      const s = (Y * w + X) * 4, o = (y * cw + x) * 4;
      out[o] = full[s]; out[o + 1] = full[s + 1]; out[o + 2] = full[s + 2]; out[o + 3] = 255;
    }
  }
  return { w: cw, h: ch, data: out };
}

export { rgbaToLinear };

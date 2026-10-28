// Turns a scene document plus its images into GPU-ready light layers.
// Runs inside the analysis worker; images arrive as decoded RGBA.

import {
  analyzeSplit, computeSprite, compositeSprite, cropDelta, layerFromContributions, lightScore,
  linearToRgba, rgbaToLinear, type CropDelta,
} from './analysis';
import type { AnalysisResult, GroupInfo, LayerData, LightInfo, Rect, SceneDoc, SpriteData } from './types';
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
  const layered = doc.method === 'layered' || doc.method === 'grid';
  const onKey = layered ? 'plateOn' : 'on';
  const offKey = layered ? 'plateOff' : 'off';
  const [on, off] = await Promise.all([get(onKey, [w, h]), get(offKey, [w, h])]);
  const split = analyzeSplit(on.data, off.data, w, h, {
    cleanup: p.cleanup, strictness: p.coreStrictness, maxLights: p.maxLights,
    waterline: doc.waterline === undefined ? undefined : doc.waterline,
  });
  let sprite: SpriteData | undefined;
  if (layered && doc.motion) {
    const [tOn, tOff] = await Promise.all([get('on', [w, h]), get('off', [w, h])]);
    sprite = computeSprite(tOn.data, tOff.data, on.data, off.data, w, h, doc.motion.rect);
  }
  return { split, sprite };
}

/** Linear lights-off frame for grid frame `f` (plate with the dark element at its offset). */
export function gridFrameLin(split: PlateInfo['split'], sprite: SpriteData, w: number, h: number, dx: number): Float32Array {
  return compositeSprite(split.offLin, w, h, sprite, dx, 0);
}

/** For a static grid group: how much of each pixel's light belongs to that group's lights. */
export function ownershipFn(lights: LightInfo[], members: Set<number>, waterline: number | null) {
  return (x: number, y: number) => {
    let mine = 0, all = 0;
    for (const L of lights) {
      const [s] = lightScore(L, x, y, waterline);
      all += s;
      if (members.has(L.id)) mine += s;
    }
    return all > 0 ? mine / all : 0;
  };
}

export async function analyzeScene(doc: SceneDoc, get: ImageGetter): Promise<AnalysisResult> {
  const t0 = performance.now();
  const { width: w, height: h } = doc;
  const n = w * h;
  const p = { ...DEFAULT_ANALYSIS, ...(doc.analysis ?? {}) };
  const { split, sprite } = await plate(doc, get);
  const stats = { ...split.stats, ms: 0 };

  if (doc.method === 'split' || doc.method === 'layered') {
    stats.ms = performance.now() - t0;
    return {
      width: w, height: h, layers: [split.layer], lights: split.lights, groups: split.groups,
      sprite, waterline: split.waterline, stats,
    };
  }

  if (doc.method === 'perLight') {
    const crops: CropDelta[] = [];
    const replaced = new Set<number>();
    for (const r of doc.refinements ?? []) {
      const img = await get(r.image, [r.crop[2], r.crop[3]]);
      crops.push(cropDelta(split.offLin, w, h, r.crop, img.data, r.lightId, p.cleanup));
      replaced.add(r.lightId);
    }
    const edited = layerFromContributions(w, h, split.layer.base, crops, {
      D: split.D, ids: split.layer.ids, weights: split.layer.weights, replaced,
    });
    const lights = split.lights.map((L) => ({ ...L, refined: replaced.has(L.id) }));
    stats.ms = performance.now() - t0;
    return {
      width: w, height: h, layers: [split.layer, edited], lights, groups: split.groups,
      waterline: split.waterline, stats, editedLayer: 1,
    };
  }

  // grid: every frame x every group was generated separately
  const grid = doc.grid!;
  if (!sprite) throw new Error('Grid scenes need a moving element.');
  const layers: LayerData[] = [];
  const perGroupPos: Record<number, [number, number][]> = {};
  const perGroupFlux: Record<number, number> = {};
  const perGroupRGB: Record<number, [number, number, number]> = {};
  const owners = new Map<number, (x: number, y: number) => number>();
  for (const g of grid.groups)
    if (g.kind === 'static' && g.lights?.length) owners.set(g.id, ownershipFn(split.lights, new Set(g.lights), split.waterline));
  for (let f = 0; f < grid.frames; f++) {
    const baseLin = gridFrameLin(split, sprite, w, h, grid.offsets[f]);
    const crops: CropDelta[] = [];
    for (const cell of grid.cells.filter((c) => c.f === f)) {
      const img = await get(cell.image, [cell.crop[2], cell.crop[3]]);
      const cd = cropDelta(baseLin, w, h, cell.crop, img.data, cell.g, p.cleanup, owners.get(cell.g));
      crops.push(cd);
      // light position for this frame = flux-weighted centroid of its contribution
      let sx = 0, sy = 0, sf = 0, r = 0, gg = 0, b = 0;
      const [cx, cy, cw] = cell.crop;
      for (let i = 0; i < cd.d.length / 3; i++) {
        const l = 0.2126 * cd.d[i * 3] + 0.7152 * cd.d[i * 3 + 1] + 0.0722 * cd.d[i * 3 + 2];
        if (l <= 0) continue;
        sx += (cx + (i % cw)) * l; sy += (cy + ((i / cw) | 0)) * l; sf += l;
        r += cd.d[i * 3]; gg += cd.d[i * 3 + 1]; b += cd.d[i * 3 + 2];
      }
      (perGroupPos[cell.g] ??= [])[f] = sf > 0 ? [sx / sf, sy / sf] : [cx + cell.crop[2] / 2, cy + cell.crop[3] / 2];
      perGroupFlux[cell.g] = (perGroupFlux[cell.g] ?? 0) + sf / grid.frames;
      const prev = perGroupRGB[cell.g] ?? [0, 0, 0];
      perGroupRGB[cell.g] = [prev[0] + r, prev[1] + gg, prev[2] + b];
    }
    layers.push(layerFromContributions(w, h, linearToRgba(baseLin, n), crops));
  }
  const lights: LightInfo[] = grid.groups.map((g, k) => {
    const pos = perGroupPos[g.id] ?? [];
    const avg = pos.reduce((a, q) => [a[0] + q[0] / pos.length, a[1] + q[1] / pos.length], [0, 0]);
    const rgb = perGroupRGB[g.id] ?? [1, 0.8, 0.5];
    const m = Math.max(...rgb, 1e-9);
    return {
      id: g.id, x: avg[0], y: avg[1], bbox: [avg[0] - 8, avg[1] - 8, avg[0] + 8, avg[1] + 8],
      area: 64, flux: perGroupFlux[g.id] ?? 1, color: [rgb[0] / m, rgb[1] / m, rgb[2] / m], group: k,
      framePos: pos,
    };
  });
  const groups: GroupInfo[] = grid.groups.map((g, k) => ({
    id: k, name: g.name, lights: [g.id], x: lights[k].x, y: lights[k].y, kind: g.kind,
  }));
  stats.ms = performance.now() - t0;
  return {
    width: w, height: h, layers, lights, groups, waterline: split.waterline, stats,
    frameOffsets: grid.offsets,
  };
}

/** sRGB RGBA bytes of a crop of a grid frame or of a stored image (for sending to the model). */
export async function cropSource(
  doc: SceneDoc, get: ImageGetter,
  src: { kind: 'image'; key: string } | { kind: 'gridFrame'; dx: number; litElement?: boolean },
  crop: Rect,
): Promise<Decoded> {
  const { width: w, height: h } = doc;
  let full: Uint8ClampedArray;
  if (src.kind === 'image') full = (await get(src.key, [w, h])).data;
  else {
    const { split, sprite } = await plate(doc, get);
    if (!sprite) throw new Error('No moving element in this scene.');
    full = linearToRgba(compositeSprite(split.offLin, w, h, sprite, src.dx, src.litElement ? 1 : 0), w * h);
  }
  const [cx, cy, cw, ch] = crop;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(full.subarray(((cy + y) * w + cx) * 4, ((cy + y) * w + cx + cw) * 4), y * cw * 4);
  return { w: cw, h: ch, data: out };
}

/** Exposed for the grid planner: the static analysis of a layered scene's plate. */
export async function plateSummary(doc: SceneDoc, get: ImageGetter) {
  const { split, sprite } = await plate(doc, get);
  return {
    lights: split.lights, groups: split.groups, waterline: split.waterline,
    sprite: sprite ? { rect: sprite.rect, spillRect: sprite.spillRect } : undefined,
  };
}

export { rgbaToLinear };

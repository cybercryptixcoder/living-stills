// Scene creation flows. Every step is a real call to the image model; the progress
// callback lets the UI show each image as it arrives.

import { analyzer } from './analyzer';
import { contextCrop } from './analysis';
import { generateImage, pool, priceOf } from './openrouter';
import {
  GROUP_LIGHTS_PROMPT, LIGHTS_OFF_PROMPT, SINGLE_LIGHT_PROMPT, elementLightsPrompt, removeElementPrompt, scenePrompt, styleById,
} from './prompts';
import type { GridGroupSpec, GridSpec, LightInfo, GroupInfo, Rect, Refinement, SceneDoc, StepLog } from './types';

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface JobStep {
  id: string;
  label: string;
  status: StepStatus;
  cost?: number;
  ms?: number;
  preview?: Blob;
  error?: string;
}

export type Report = (steps: JobStep[]) => void;

export interface Bundle {
  doc: SceneDoc;
  images: Record<string, Blob>;
}

export interface CreateParams {
  key: string;
  model: string;
  resolution: string;
  aspect: string;
  description: string;
  styleId: string;
  element?: string;
  title?: string;
  signal?: AbortSignal;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function titleFrom(description: string) {
  const words = description.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const skip = new Set(['a', 'an', 'the', 'small', 'little', 'of', 'with', 'and', 'at', 'in', 'on']);
  const keep = words.filter((w, i) => !(i === 0 && skip.has(w.toLowerCase()))).slice(0, 4);
  const t = keep.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

class Tracker {
  steps: JobStep[];
  log: StepLog[] = [];
  cost = 0;
  constructor(steps: { id: string; label: string }[], private report: Report) {
    this.steps = steps.map((s) => ({ ...s, status: 'waiting' }));
    this.emit();
  }
  emit() { this.report(this.steps.map((s) => ({ ...s }))); }
  set(id: string, patch: Partial<JobStep>) {
    const s = this.steps.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
    this.emit();
  }
  async run<T extends { blob: Blob; cost: number; ms: number }>(id: string, fn: () => Promise<T>, model: string, image?: string): Promise<T> {
    this.set(id, { status: 'running' });
    try {
      const r = await fn();
      this.cost += r.cost;
      const label = this.steps.find((s) => s.id === id)?.label ?? id;
      this.log.push({ label, model, cost: r.cost, ms: Math.round(r.ms), image });
      this.set(id, { status: 'done', cost: r.cost, ms: r.ms, preview: r.blob });
      return r;
    } catch (err) {
      this.set(id, { status: 'failed', error: (err as Error).message });
      throw err;
    }
  }
}

async function dims(b: Blob): Promise<[number, number]> {
  const bmp = await createImageBitmap(b);
  const d: [number, number] = [bmp.width, bmp.height];
  bmp.close();
  return d;
}

export function estimateCreate(model: string, resolution: string, withElement: boolean) {
  const n = withElement ? 4 : 2;
  return { images: n, cost: n * priceOf(model, resolution) };
}

export async function createScene(p: CreateParams, report: Report): Promise<Bundle> {
  const style = styleById(p.styleId);
  const element = p.element?.trim() || undefined;
  const steps = [
    { id: 'paint', label: 'Painting the scene' },
    { id: 'off', label: 'Switching every light off' },
  ];
  if (element) steps.push({ id: 'plate', label: `Taking ${element} out` }, { id: 'plateOff', label: 'Switching the lights off without it' });
  const t = new Tracker(steps, report);
  const opts = { key: p.key, model: p.model, resolution: p.resolution, aspectRatio: p.aspect, signal: p.signal };
  const prompt = scenePrompt(p.description, style, element);
  const images: Record<string, Blob> = {};

  images.on = (await t.run('paint', () => generateImage({ ...opts, prompt }), p.model, 'on')).blob;
  const jobs: Promise<void>[] = [
    t.run('off', () => generateImage({ ...opts, prompt: LIGHTS_OFF_PROMPT, refs: [images.on] }), p.model, 'off').then((r) => { images.off = r.blob; }),
  ];
  if (element) {
    jobs.push((async () => {
      images.plateOn = (await t.run('plate', () => generateImage({ ...opts, prompt: removeElementPrompt(element), refs: [images.on] }), p.model, 'plateOn')).blob;
      images.plateOff = (await t.run('plateOff', () => generateImage({ ...opts, prompt: LIGHTS_OFF_PROMPT, refs: [images.plateOn] }), p.model, 'plateOff')).blob;
    })());
  }
  await Promise.all(jobs);

  const [w, h] = await dims(images.on);
  const id = `${Date.now().toString(36)}-${uid()}`;
  const doc: SceneDoc = {
    version: 1, id, title: p.title?.trim() || titleFrom(p.description), prompt: p.description, style: style.id,
    createdAt: new Date().toISOString(), model: p.model, resolution: p.resolution, width: w, height: h,
    method: element ? 'layered' : 'split',
    images: Object.fromEntries(Object.keys(images).map((k) => [k, k])),
    steps: t.log, cost: t.cost,
  };
  if (element) {
    const rect = await analyzer().detectElement(doc, images, id);
    if (rect) doc.motion = { element, rect, dir: 1, speed: Math.round(w * 0.06) };
    else doc.method = 'split'; // keep the lights even if the element could not be cut out
  }
  return { doc, images };
}

// ---------------------------------------------------------------- per-light edits

export function refineCrop(L: LightInfo, w: number, h: number): Rect {
  const [x0, y0, x1, y1] = L.bbox;
  return contextCrop([x0, y0, x1 - x0 + 1, y1 - y0 + 1], w, h, w / h, 3, Math.max(160, Math.round(w * 0.2)));
}

export function aspectString(w: number, h: number, model: { aspects: string[] }) {
  const r = w / h;
  let best = model.aspects[0], bd = Infinity;
  for (const a of model.aspects) {
    const [x, y] = a.split(':').map(Number);
    const d = Math.abs(Math.log(x / y / r));
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

export interface RefineParams {
  key: string;
  model: string;
  aspect: string;
  lights: LightInfo[];
  signal?: AbortSignal;
}

export async function refineLights(b: Bundle, token: string, p: RefineParams, report: Report): Promise<Bundle> {
  const { width: w, height: h } = b.doc;
  const t = new Tracker(p.lights.map((L) => ({ id: `L${L.id}`, label: `Light ${L.id}` })), report);
  const images = { ...b.images };
  const refinements: Refinement[] = (b.doc.refinements ?? []).filter((r) => !p.lights.some((L) => L.id === r.lightId));
  await pool(p.lights, 3, async (L) => {
    const crop = refineCrop(L, w, h);
    const input = await analyzer().crop(b.doc, b.images, token, { kind: 'image', key: 'off' }, crop, 1024);
    const key = `refine_${L.id}`;
    const r = await t.run(`L${L.id}`, () => generateImage({ key: p.key, model: p.model, resolution: '768', aspectRatio: p.aspect, prompt: SINGLE_LIGHT_PROMPT, refs: [input], signal: p.signal }), p.model, key);
    images[key] = r.blob;
    refinements.push({ lightId: L.id, crop, image: key });
  });
  refinements.sort((a, c) => a.lightId - c.lightId);
  const doc: SceneDoc = {
    ...b.doc,
    method: 'perLight',
    refinements,
    images: { ...b.doc.images, ...Object.fromEntries(refinements.map((r) => [r.image, r.image])) },
    steps: [...b.doc.steps, ...t.log],
    cost: b.doc.cost + t.cost,
  };
  return { doc, images };
}

// ---------------------------------------------------------------- the full grid (frames x lights)

export interface GridPlan {
  frames: number;
  groups: GroupInfo[]; // static groups from the plate analysis to include
  includeElement: boolean;
}

export function gridOffsets(doc: SceneDoc, frames: number): number[] {
  const m = doc.motion!;
  const [rx, , rw] = m.rect;
  const margin = 0.03 * doc.width;
  let lo = -rx + margin, hi = doc.width - rx - rw - margin;
  if (hi < lo) { const c = (lo + hi) / 2; lo = c - doc.width * 0.25; hi = c + doc.width * 0.25; }
  const out: number[] = [];
  for (let f = 0; f < frames; f++) out.push(Math.round(frames === 1 ? 0 : lo + ((hi - lo) * f) / (frames - 1)));
  return m.dir === 1 ? out : out.reverse();
}

export function gridCellCount(plan: GridPlan) {
  return plan.frames * (plan.groups.length + (plan.includeElement ? 1 : 0));
}

export async function buildGrid(
  b: Bundle, token: string, plan: GridPlan, plateLights: LightInfo[],
  p: { key: string; model: string; aspect: string; signal?: AbortSignal }, report: Report,
): Promise<Bundle> {
  const doc0 = b.doc;
  const { width: w, height: h } = doc0;
  const motion = doc0.motion!;
  const offsets = gridOffsets(doc0, plan.frames);
  const groups: GridGroupSpec[] = [];
  let nextId = 1;
  if (plan.includeElement) groups.push({ id: nextId++, name: capital(motion.element.replace(/^the /, '')), kind: 'moving' });
  for (const g of plan.groups) {
    const ls = plateLights.filter((L) => g.lights.includes(L.id));
    const x0 = Math.min(...ls.map((L) => L.bbox[0])), y0 = Math.min(...ls.map((L) => L.bbox[1]));
    const x1 = Math.max(...ls.map((L) => L.bbox[2])), y1 = Math.max(...ls.map((L) => L.bbox[3]));
    groups.push({ id: nextId++, name: `Lights ${g.name}`, kind: 'static', region: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], lights: g.lights });
  }
  const cells: { f: number; g: GridGroupSpec; crop: Rect }[] = [];
  for (let f = 0; f < plan.frames; f++)
    for (const g of groups) {
      let crop: Rect;
      if (g.kind === 'moving') {
        const [rx, ry, rw, rh] = motion.rect;
        crop = contextCrop([rx + offsets[f], ry, rw, rh], w, h, w / h, 1.35, Math.round(w * 0.2));
      } else crop = contextCrop(g.region!, w, h, w / h, 1.3, Math.round(w * 0.2));
      cells.push({ f, g, crop });
    }
  const t = new Tracker(cells.map((c) => ({ id: `f${c.f}g${c.g.id}`, label: `Frame ${c.f + 1}, ${c.g.name}` })), report);
  const images = { ...b.images };
  const spec: GridSpec = { frames: plan.frames, offsets, groups, cells: [] };
  await pool(cells, 3, async (c) => {
    const input = await analyzer().crop(doc0, b.images, token, { kind: 'gridFrame', dx: offsets[c.f] }, c.crop, 1024);
    const key = `grid_f${c.f}_g${c.g.id}`;
    const prompt = c.g.kind === 'moving' ? elementLightsPrompt(motion.element) : GROUP_LIGHTS_PROMPT;
    const r = await t.run(`f${c.f}g${c.g.id}`, () => generateImage({ key: p.key, model: p.model, resolution: '768', aspectRatio: p.aspect, prompt, refs: [input], signal: p.signal }), p.model, key);
    images[key] = r.blob;
    spec.cells.push({ f: c.f, g: c.g.id, crop: c.crop, image: key });
  });
  spec.cells.sort((a, c) => a.f - c.f || a.g - c.g);
  const id = `${Date.now().toString(36)}-${uid()}`;
  const keep = ['on', 'off', 'plateOn', 'plateOff'];
  const doc: SceneDoc = {
    ...doc0,
    id,
    title: `${doc0.title}, every frame`,
    method: 'grid',
    createdAt: new Date().toISOString(),
    grid: spec,
    refinements: undefined,
    images: Object.fromEntries([...keep, ...spec.cells.map((c) => c.image)].map((k) => [k, k])),
    steps: [...doc0.steps.filter((s) => !s.image || keep.includes(s.image)), ...t.log],
    cost: doc0.steps.filter((s) => !s.image || keep.includes(s.image)).reduce((a, s) => a + s.cost, 0) + t.cost,
    demo: undefined,
  };
  return { doc, images };
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

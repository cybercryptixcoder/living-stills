// Scene creation flows. Every step is a real call to the image model; the progress
// callback lets the UI show each image as it arrives.

import { analyzer } from './analyzer';
import { contextCrop } from './analysis';
import { generateImage, pool, priceOf } from './openrouter';
import {
  DARK_VERSION_PROMPT, SINGLE_LIGHT_WITH_REFERENCE_PROMPT, basePrompt, lightFromTextPrompt, lightUpPrompt, lightsOffPrompt, recreatePrompt,
  removeElementPrompt, scenePrompt,
} from './prompts';
import type { LightInfo, Marker, Rect, Refinement, SceneDoc, StepLog } from './types';

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
  lighting?: string;
  element?: string;
  title?: string;
  signal?: AbortSignal;
}

const uid = () => Math.random().toString(36).slice(2, 10);

const MEDIA = /\b(photo|photograph|picture|image|sketch|drawing|painting|illustration|render|art|artwork|watercolou?r|gouache|etching|print|poster|scene|shot|view)\b/i;
const STOP = new Set(['on', 'in', 'at', 'with', 'by', 'under', 'over', 'near', 'during', 'from', 'seen', 'and', 'where', 'while', 'that', 'which']);

/** A short title from a description: drops the medium ("a pen sketch of…") and stops at the first preposition. */
export function titleFrom(description: string) {
  let t = description.trim().split(/[.,;:\n]/)[0];
  const of = t.toLowerCase().indexOf(' of ');
  if (of > 0 && MEDIA.test(t.slice(0, of))) t = t.slice(of + 4);
  const words = t.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const skip = new Set(['a', 'an', 'the', 'small', 'little', 'tiny']);
  const keep: string[] = [];
  for (const w of words) {
    if (!keep.length && skip.has(w.toLowerCase())) continue;
    if (keep.length >= 2 && STOP.has(w.toLowerCase())) break;
    keep.push(w);
    if (keep.length >= 4) break;
  }
  const out = keep.join(' ') || 'Untitled';
  return out.charAt(0).toUpperCase() + out.slice(1);
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
  const element = p.element?.trim() || undefined;
  const lighting = p.lighting?.trim() || undefined;
  const steps = [
    { id: 'paint', label: 'Making the picture, lights on' },
    { id: 'off', label: 'Switching the lights off' },
  ];
  if (element) steps.push({ id: 'plate', label: `Taking ${element} out` }, { id: 'plateOff', label: 'Switching the lights off without it' });
  const t = new Tracker(steps, report);
  const opts = { key: p.key, model: p.model, resolution: p.resolution, aspectRatio: p.aspect, signal: p.signal };
  const prompt = scenePrompt(p.description, lighting, element);
  const offPrompt = lightsOffPrompt(lighting);
  const images: Record<string, Blob> = {};

  images.on = (await t.run('paint', () => generateImage({ ...opts, prompt }), p.model, 'on')).blob;
  const jobs: Promise<void>[] = [
    t.run('off', () => generateImage({ ...opts, prompt: offPrompt, refs: [images.on] }), p.model, 'off').then((r) => { images.off = r.blob; }),
  ];
  if (element) {
    jobs.push((async () => {
      images.plateOn = (await t.run('plate', () => generateImage({ ...opts, prompt: removeElementPrompt(element), refs: [images.on] }), p.model, 'plateOn')).blob;
      images.plateOff = (await t.run('plateOff', () => generateImage({ ...opts, prompt: offPrompt, refs: [images.plateOn] }), p.model, 'plateOff')).blob;
    })());
  }
  await Promise.all(jobs);

  const [w, h] = await dims(images.on);
  const id = `${Date.now().toString(36)}-${uid()}`;
  const doc: SceneDoc = {
    version: 1, id, title: p.title?.trim() || titleFrom(p.description), prompt: p.description, lighting,
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

/** Crop for a per-light edit: centred on the light's brightness-weighted centre, so the light is
 *  exactly where the prompt says ("the exact centre"), with room for its glow, never more than half the picture. */
export function refineCrop(L: LightInfo, w: number, h: number): Rect {
  const [x0, y0, x1, y1] = L.bbox;
  const s = Math.min(Math.max(x1 - x0 + 1, y1 - y0 + 1, 24), Math.round(w * 0.16));
  const crop = contextCrop([L.x - s / 2, L.y - s / 2, s, s], w, h, w / h, 3.2, Math.round(w * 0.2), true);
  const maxW = Math.round(w * 0.5);
  if (crop[2] <= maxW) return crop;
  return contextCrop([L.x - s / 2, L.y - s / 2, s, s], w, h, w / h, 1, maxW, true);
}

/** Lights worth a real edit: bright, compact, and not a reflection on the ground. */
export function bestForEdits(lights: LightInfo[], w: number, h: number, waterline: number | null, n: number): number[] {
  return lights
    .filter((L) => {
      const bw = L.bbox[2] - L.bbox[0], bh = L.bbox[3] - L.bbox[1];
      return Math.hypot(bw, bh) < 0.16 * w && (waterline == null || L.y < waterline) && L.y < h * 0.97;
    })
    // lamps themselves peak brighter than the walls they light, so rank by peak, then size
    .sort((a, b) => (b.peak ?? 0) * Math.sqrt(b.flux) - (a.peak ?? 0) * Math.sqrt(a.flux))
    .reduce<LightInfo[]>((picked, L) => {
      // keep picks apart: two edits of the same lamp are wasted money
      if (picked.length < n && picked.every((P) => Math.hypot(P.x - L.x, P.y - L.y) > 0.08 * w)) picked.push(L);
      return picked;
    }, [])
    .map((L) => L.id);
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
    const [input, lit] = await Promise.all([
      analyzer().crop(b.doc, b.images, token, { kind: 'image', key: 'off' }, crop, 1024),
      analyzer().crop(b.doc, b.images, token, { kind: 'image', key: 'on' }, crop, 1024),
    ]);
    const key = `refine_${L.id}`;
    const r = await t.run(`L${L.id}`, () => generateImage({ key: p.key, model: p.model, resolution: '768', aspectRatio: p.aspect, prompt: SINGLE_LIGHT_WITH_REFERENCE_PROMPT, refs: [input, lit], signal: p.signal }), p.model, key);
    images[key] = r.blob;
    refinements.push({ lightId: L.id, at: [Math.round(L.x), Math.round(L.y)], crop, image: key });
  });
  refinements.sort((a, c) => a.lightId - c.lightId);
  const doc: SceneDoc = {
    ...b.doc,
    method: 'perLight',
    refinements,
    images: { ...b.doc.images, ...Object.fromEntries(refinements.map((r) => [r.image, r.image])) },
    // the log describes the images the scene is made of: a replaced edit drops out
    steps: [...b.doc.steps.filter((x) => !x.image || !t.log.some((n) => n.image === x.image)), ...t.log],
    cost: 0,
  };
  doc.cost = doc.steps.reduce((a, x) => a + x.cost, 0);
  return { doc, images };
}

// ---------------------------------------------------------------- repaint the dark version

/** Asks for a new lights-off image. Per-light edits were made against the old one, so they are dropped. */
export async function repaintOff(b: Bundle, p: { key: string; model: string; signal?: AbortSignal }, report: Report): Promise<Bundle> {
  const t = new Tracker([{ id: 'off', label: 'Switching every light off again' }], report);
  const aspect = aspectString(b.doc.width, b.doc.height, { aspects: ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16'] });
  const r = await t.run('off', () => generateImage({ key: p.key, model: p.model, resolution: b.doc.resolution, aspectRatio: aspect, prompt: lightsOffPrompt(b.doc.lighting), refs: [b.images.on], signal: p.signal }), p.model, 'off');
  const keep = (k: string) => k === 'on' || k === 'off' || k === 'ambient';
  const doc: SceneDoc = {
    ...b.doc,
    method: 'split',
    refinements: undefined,
    images: Object.fromEntries(Object.entries(b.doc.images).filter(([k]) => keep(k))),
    steps: [...b.doc.steps.filter((s) => !s.image || s.image === 'on'), ...t.log],
    cost: 0,
  };
  doc.cost = doc.steps.reduce((a, x) => a + x.cost, 0);
  return { doc, images: { ...(b.images.ambient ? { ambient: b.images.ambient } : {}), on: b.images.on, off: r.blob } };
}

// ---------------------------------------------------------------- two stages: picture first, lights placed by hand

export type BaseKind = 'dark' | 'ambient';

export interface BaseParams {
  key: string;
  model: string;
  resolution: string;
  aspect: string;
  description: string;
  lighting?: string;
  kind: BaseKind;
  title?: string;
  signal?: AbortSignal;
}

/** Stage one: just the picture. The result is a draft scene the user places lights on. */
export async function createBase(p: BaseParams, report: Report): Promise<Bundle> {
  const t = new Tracker([{ id: 'base', label: 'Making the picture' }], report);
  const r = await t.run('base', () => generateImage({ key: p.key, model: p.model, resolution: p.resolution, aspectRatio: p.aspect, prompt: basePrompt(p.description), signal: p.signal }), p.model, 'base');
  const [w, h] = await dims(r.blob);
  const doc: SceneDoc = {
    version: 1, id: `${Date.now().toString(36)}-${uid()}`, title: p.title?.trim() || titleFrom(p.description),
    prompt: p.description, lighting: p.lighting?.trim() || undefined, createdAt: new Date().toISOString(),
    model: p.model, resolution: p.resolution, width: w, height: h, method: 'split',
    images: { base: 'base' }, steps: t.log, cost: t.cost, draft: { kind: p.kind, aspect: p.aspect }, markers: [],
  };
  return { doc, images: { base: r.blob } };
}

export interface LightUpParams {
  key: string;
  model: string;
  markers: Marker[];
  lighting?: string;
  /** what each marker is and how it should glow (from the planner, or the user's own notes) */
  plan: { n: number; object: string; how: string }[];
  signal?: AbortSignal;
}

/** Stage two: the dark version (if the picture was ambient) and the version with the placed lights on. */
export async function lightUp(b: Bundle, p: LightUpParams, report: Report): Promise<Bundle> {
  const draft = b.doc.draft!;
  const ambient = draft.kind === 'ambient';
  const steps = ambient
    ? [{ id: 'off', label: 'Making the dark version' }, { id: 'on', label: 'Switching your lights on' }]
    : [{ id: 'on', label: 'Switching your lights on' }];
  const t = new Tracker(steps, report);
  const opts = { key: p.key, model: p.model, resolution: b.doc.resolution, aspectRatio: draft.aspect, signal: p.signal };
  const images: Record<string, Blob> = {};
  if (ambient) {
    images.ambient = b.images.base;
    images.off = (await t.run('off', () => generateImage({ ...opts, prompt: DARK_VERSION_PROMPT, refs: [b.images.base] }), p.model, 'off')).blob;
  } else images.off = b.images.base;
  const prompt = lightUpPrompt(p.plan, p.lighting);
  images.on = (await t.run('on', () => generateImage({ ...opts, prompt, refs: [images.off] }), p.model, 'on')).blob;
  const baseStep = b.doc.steps.map((s) => (s.image === 'base' ? { ...s, image: ambient ? 'ambient' : 'off' } : s));
  const doc: SceneDoc = {
    ...b.doc,
    draft: undefined,
    lighting: p.lighting?.trim() || b.doc.lighting,
    markers: p.markers,
    images: Object.fromEntries(Object.keys(images).map((k) => [k, k])),
    steps: [...baseStep, ...t.log],
    cost: 0,
  };
  doc.cost = doc.steps.reduce((a, x) => a + x.cost, 0);
  return { doc, images };
}


// ---------------------------------------------------------------- starting from a photo

export const ASPECTS = ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16'];

/** Shrinks a photo to at most `max` px on its long side, as JPEG (phones take 12-megapixel photos). */
export async function preparePhoto(file: Blob, max = 1536): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }), w, h };
}

export interface PhotoParams {
  key: string;
  model: string;
  resolution: string;
  photo: Blob;
  recreate: boolean;
  changes?: string;
  /** what to make: just the picture (a draft to light later), lights from a description, or lights placed by hand */
  then: 'picture' | 'describe' | 'place';
  /** dark: its lights are off; ambient: an everyday picture (a dark version is made); lit: its lights are already on */
  kind: BaseKind | 'lit';
  lighting?: string;
  title?: string;
  signal?: AbortSignal;
}

/** A photo (or a scan of artwork) as the start of a scene. Returns a draft, or a finished scene for 'describe'. */
export async function fromPhoto(p: PhotoParams, report: Report): Promise<Bundle> {
  const { blob: photo, w: pw, h: ph } = await preparePhoto(p.photo);
  const aspect = aspectString(pw, ph, { aspects: ASPECTS });
  const describe = p.then === 'describe';
  const steps: { id: string; label: string }[] = [];
  if (p.recreate) steps.push({ id: 'base', label: p.changes?.trim() ? 'Recreating your picture, with your changes' : 'Recreating your picture' });
  if (describe && p.kind === 'ambient') steps.push({ id: 'off', label: 'Making the dark version' });
  if (describe && p.kind === 'lit') steps.push({ id: 'off', label: 'Switching the lights off' });
  else if (describe) steps.push({ id: 'on', label: 'Switching the lights on' });
  const t = new Tracker(steps.length ? steps : [{ id: 'none', label: 'Reading your picture' }], report);
  const opts = { key: p.key, model: p.model, resolution: p.resolution, aspectRatio: aspect, signal: p.signal };
  let base = photo;
  if (p.recreate) base = (await t.run('base', () => generateImage({ ...opts, prompt: recreatePrompt(p.changes), refs: [photo] }), p.model, 'base')).blob;
  else if (!steps.length) t.set('none', { status: 'done', preview: photo });
  const [w, h] = await dims(base);
  const id = `${Date.now().toString(36)}-${uid()}`;
  const title = p.title?.trim() || (p.changes?.trim() ? titleFrom(p.changes) : 'From a photo');
  const common = {
    version: 1 as const, id, title, prompt: p.changes?.trim() ? `From a photo, with: ${p.changes.trim()}` : 'From a photo',
    createdAt: new Date().toISOString(), model: p.model, resolution: p.resolution, width: w, height: h, method: 'split' as const,
  };
  if (!describe) {
    const steps0 = p.recreate ? t.log : [{ label: 'Your photo', cost: 0, ms: 0, image: 'base' }];
    const doc: SceneDoc = { ...common, lighting: p.lighting?.trim() || undefined, images: { base: 'base' }, steps: steps0, cost: t.cost, draft: { kind: p.kind === 'lit' ? 'dark' : p.kind, aspect }, markers: [] };
    return { doc, images: { base } };
  }
  const images: Record<string, Blob> = {};
  if (p.kind === 'lit') {
    // the lights are already on in the picture: make the version with them off
    images.on = base;
    images.off = (await t.run('off', () => generateImage({ ...opts, prompt: lightsOffPrompt(p.lighting), refs: [base] }), p.model, 'off')).blob;
  } else {
    if (p.kind === 'ambient') {
      images.ambient = base;
      images.off = (await t.run('off', () => generateImage({ ...opts, prompt: DARK_VERSION_PROMPT, refs: [base] }), p.model, 'off')).blob;
    } else images.off = base;
    images.on = (await t.run('on', () => generateImage({ ...opts, prompt: lightFromTextPrompt(p.lighting || 'the lamps, windows and other light sources in the picture'), refs: [images.off] }), p.model, 'on')).blob;
  }
  const baseStep = p.recreate ? t.log.filter((x) => x.image === 'base').map((x) => ({ ...x, image: p.kind === 'ambient' ? 'ambient' : p.kind === 'lit' ? 'on' : 'off' })) : [];
  const log = [...baseStep, ...t.log.filter((x) => x.image !== 'base')];
  const doc: SceneDoc = {
    ...common, lighting: p.lighting?.trim() || undefined,
    images: Object.fromEntries(Object.keys(images).map((k) => [k, k])),
    steps: log, cost: log.reduce((a, x) => a + x.cost, 0),
  };
  return { doc, images };
}

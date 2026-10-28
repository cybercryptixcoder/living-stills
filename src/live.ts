// Glue between the library, the analysis worker, the renderer and the engine.

import { analyzer } from './core/analyzer';
import { deleteLocal, exportZip, importZip, listExamples, listLocal, loadBundle, saveLocal, type SceneEntry } from './core/library';
import { modelById } from './core/openrouter';
import {
  aspectString, buildGrid, createScene, refineLights, repaintOff, type Bundle, type CreateParams, type GridPlan, type JobStep,
} from './core/pipeline';
import type { AnalysisResult, GroupInfo, LightInfo } from './core/types';
import { Engine, makeRoute, type ModeId } from './play/engine';
import type { Renderer } from './render/Renderer';
import { DEFAULT_VIEW, useStore, type SceneState } from './state';

export const live = {
  engine: new Engine(),
  renderer: null as Renderer | null,
  bundle: null as (Bundle & { source: 'example' | 'local' }) | null,
  token: '',
  motionDx: 0,
  gridPhase: 0,
  plate: null as { lights: LightInfo[]; groups: GroupInfo[] } | null,
  abort: null as AbortController | null,
};

(window as unknown as { __living: typeof live & { store: typeof useStore } }).__living = Object.assign(live, { store: useStore });

const S = () => useStore.getState();

export async function refreshLibrary() {
  const [examples, locals] = await Promise.all([listExamples(), listLocal().catch(() => [])]);
  S().set({ examples, locals });
  return { examples, locals };
}

function sceneState(b: Bundle & { source: 'example' | 'local' }, a: AnalysisResult): SceneState {
  const doc = b.doc;
  return {
    doc,
    source: b.source,
    lights: a.lights.length,
    groups: a.groups.map((g) => ({ name: g.name, count: g.lights.length, kind: g.kind })),
    hasElement: !!a.sprite,
    elementName: doc.motion?.element,
    frames: a.layers.length,
    editedLayer: a.editedLayer,
    waterline: a.waterline,
  };
}

export async function openBundle(b: Bundle & { source: 'example' | 'local' }, keepUi = false) {
  const set = S().set;
  set({ status: 'loading', statusText: 'Finding the lights', selected: null, hovered: null, picking: false, picked: [] });
  const token = `${b.doc.id}@${b.doc.steps.length}@${Object.keys(b.doc.images).length}`;
  const a = await analyzer().analyze(b.doc, b.images, token);
  live.bundle = b;
  live.token = token;
  live.plate = null;
  const r = live.renderer;
  if (!r) throw new Error('The renderer is not ready.');
  r.load({ w: a.width, h: a.height, layers: a.layers, sprite: a.sprite });
  const sp = a.sprite;
  const element = sp
    ? { x: sp.rect[0] + sp.rect[2] / 2, y: sp.rect[1] + sp.rect[3] / 2, flux: Math.max(1, sp.flux), color: sp.color }
    : null;
  const e = live.engine;
  e.load(a.lights, a.groups.length, a.width, a.height, element);
  e.route = b.doc.demo?.route ? makeRoute(b.doc.demo.route) : null;
  e.wake();
  live.motionDx = 0;
  live.gridPhase = 0;
  const startMode = (b.doc.demo?.startMode as ModeId) || 'hand';
  const ui = keepUi
    ? {}
    : {
        view: { ...DEFAULT_VIEW, ...(b.doc.demo?.view ?? {}) },
        mode: startMode,
        variant: (a.editedLayer != null ? 'edits' : 'estimate') as 'edits' | 'estimate',
        motion: { ...S().motion, playing: true },
      };
  set({
    analysis: a,
    scene: sceneState(b, a),
    currentId: b.doc.id,
    status: 'ready',
    statusText: '',
    groups: a.groups.map(() => 1),
    master: 1,
    elementFader: 1,
    ...ui,
  });
  try { localStorage.setItem('living-stills:last', b.doc.id); } catch { /* ignore */ }
}

export async function openEntry(entry: SceneEntry): Promise<void> {
  try {
    S().set({ status: 'loading', statusText: 'Loading the scene', sheet: null });
    const b = await loadBundle(entry);
    await openBundle(b);
  } catch (err) {
    S().set({ status: 'error', statusText: (err as Error).message });
  }
}

// ---------------------------------------------------------------- jobs

function startJob(title: string) {
  live.abort?.abort();
  live.abort = new AbortController();
  const spend0 = S().spend;
  S().set({ job: { title, steps: [] }, sheet: null });
  const report = (steps: JobStep[]) => {
    const spent = steps.reduce((a, s) => a + (s.cost ?? 0), 0);
    const job = S().job;
    S().set({ job: job ? { ...job, steps } : { title, steps }, spend: spend0 + spent });
  };
  return { report, signal: live.abort.signal };
}

async function finishJob(b: Bundle) {
  const job = S().job;
  S().set({ job: job ? { ...job, finding: true } : null });
  await saveLocal(b);
  await refreshLibrary();
  try {
    await openBundle({ ...b, source: 'local' });
  } catch (err) {
    throw new Error(`The images are saved in Scenes, but opening the scene failed: ${(err as Error).message}`);
  }
  S().set({ job: null });
}

function failJob(err: unknown) {
  const msg = (err as Error).name === 'AbortError' ? 'Stopped.' : (err as Error).message;
  const job = S().job;
  S().set({ job: job ? { ...job, error: msg } : null });
}

export function cancelJob() {
  live.abort?.abort();
  S().set({ job: null });
}

export async function runCreate(p: Omit<CreateParams, 'key' | 'signal'>) {
  const { key } = S();
  const { report, signal } = startJob('Painting a new night');
  try {
    const b = await createScene({ ...p, key, signal }, report);
    await finishJob(b);
  } catch (err) {
    failJob(err);
  }
}

export async function runRefine(lightIds: number[]) {
  const b = live.bundle, a = S().analysis;
  if (!b || !a) return;
  const { key, model } = S();
  const lights = a.lights.filter((L) => lightIds.includes(L.id));
  const { report, signal } = startJob(`Real edits for ${lights.length} light${lights.length === 1 ? '' : 's'}`);
  try {
    const aspect = aspectString(b.doc.width, b.doc.height, modelById(model));
    const nb = await refineLights(b, live.token, { key, model, aspect, lights, signal }, report);
    if (b.source === 'example') {
      // a refined example becomes the user's own copy
      nb.doc = { ...nb.doc, id: `${b.doc.id}-mine-${Date.now().toString(36)}`, title: `${b.doc.title}, edited`, demo: undefined };
    }
    await finishJob(nb);
  } catch (err) {
    failJob(err);
  }
}

/** Repaints the lights-off image (when the model removed lamps instead of switching them off). */
export async function runRepaintOff() {
  const b = live.bundle;
  if (!b) return;
  const { key, model } = S();
  const { report, signal } = startJob('Repainting the dark version');
  try {
    const nb = await repaintOff(b, { key, model, signal }, report);
    if (b.source === 'example') nb.doc = { ...nb.doc, id: `${b.doc.id}-mine-${Date.now().toString(36)}`, title: `${b.doc.title}, repainted`, demo: undefined };
    await finishJob(nb);
  } catch (err) {
    failJob(err);
  }
}

export async function plateFor(): Promise<{ lights: LightInfo[]; groups: GroupInfo[] } | null> {
  const b = live.bundle;
  if (!b || !b.doc.motion) return null;
  if (live.plate) return live.plate;
  const doc = b.doc.method === 'grid' ? { ...b.doc, method: 'layered' as const } : b.doc;
  const r = await analyzer().plate(doc, b.images, live.token);
  live.plate = { lights: r.lights, groups: r.groups };
  return live.plate;
}

export async function runGrid(plan: GridPlan) {
  const b = live.bundle;
  if (!b?.doc.motion) return;
  const plate = await plateFor();
  if (!plate) return;
  const { key, model } = S();
  const { report, signal } = startJob('Painting every frame');
  try {
    const aspect = aspectString(b.doc.width, b.doc.height, modelById(model));
    const base = b.doc.method === 'grid' ? { ...b, doc: { ...b.doc, method: 'layered' as const } } : b;
    const nb = await buildGrid(base, live.token, plan, plate.lights, { key, model, aspect, signal }, report);
    await finishJob(nb);
  } catch (err) {
    failJob(err);
  }
}

/** Re-finds the lights with new settings (waterline, detail). Saved for your own scenes. */
export async function reanalyze(patch: Partial<Pick<Bundle['doc'], 'waterline' | 'analysis'>>) {
  const b = live.bundle;
  if (!b) return;
  const doc = { ...b.doc, ...patch };
  if ('waterline' in patch && patch.waterline === undefined) delete (doc as { waterline?: unknown }).waterline;
  const nb = { ...b, doc };
  if (b.source === 'local') await saveLocal(nb);
  await openBundle(nb, true);
  if (b.source === 'local') await refreshLibrary();
}

export async function removeLocal(id: string) {
  await deleteLocal(id);
  await refreshLibrary();
}

export async function downloadScene() {
  const b = live.bundle;
  if (!b) return;
  const zip = await exportZip(b);
  saveBlob(zip, `${slug(b.doc.title)}.living-stills.zip`);
}

export async function importScene(file: File) {
  const b = await importZip(file);
  b.doc = { ...b.doc, id: `${b.doc.id}-imported-${Date.now().toString(36)}`, demo: b.doc.demo };
  await saveLocal(b);
  await refreshLibrary();
  await openBundle({ ...b, source: 'local' });
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene';
}

/** Exports a scene as the files the app ships in /public/scenes (used to make the examples). */
export async function exportForExamples(): Promise<{ doc: unknown; files: Record<string, string> } | null> {
  const b = live.bundle;
  if (!b) return null;
  const files: Record<string, string> = {};
  const images: Record<string, string> = {};
  for (const k of Object.keys(b.doc.images)) {
    const blob = b.images[k];
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
    const name = `${k}.${ext}`;
    images[k] = name;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    files[name] = btoa(bin);
  }
  return { doc: { ...b.doc, images }, files };
}
(window as unknown as { __exportScene: typeof exportForExamples }).__exportScene = exportForExamples;

Object.assign(live, { openEntryForTests: openEntry });

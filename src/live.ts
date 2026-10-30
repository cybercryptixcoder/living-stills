// Glue between the library, the analysis worker, the renderer and the engine.

import { analyzer } from './core/analyzer';
import { deleteLocal, exportZip, importZip, listExamples, listLocal, loadBundle, saveLocal, type SceneEntry } from './core/library';
import { modelById } from './core/openrouter';
import {
  aspectString, createBase, createScene, fromPhoto, lightUp, makeOrbit, refineLights, repaintOff,
  type BaseParams, type Bundle, type CreateParams, type JobStep, type PhotoParams,
} from './core/pipeline';
import { direct, labelZones, planFromNotes, planMarkers, planOrbit, type DirectorScene, type MarkerPlan } from './core/agents';
import { relayUrl } from './core/luminal';
import type { AnalysisResult, Marker } from './core/types';
import { audio } from './play/audio';
import { Engine, makeRoute, type LightFx, type ModeId } from './play/engine';
import { BUILT_IN, type Preset } from './play/presets';
import { usesMusic, type Show } from './play/show';
import { computeZones, zonesFromGroups, zonesKey, type Zone } from './play/zones';
import type { Renderer } from './render/Renderer';
import { depthFromPng, depthToPng, estimateDepth, refineDepth, type DepthMap } from './splat/depth';
import { buildSplats, View3D } from './splat/view';
import { buildEnv, EnvCamera, type EnvGeometry } from './splat/env';
import { DEFAULT_VIEW, useStore, type SceneState } from './state';

export const live = {
  engine: new Engine(),
  renderer: null as Renderer | null,
  bundle: null as (Bundle & { source: 'example' | 'local' }) | null,
  token: '',
  motionDx: 0,
  abort: null as AbortController | null,
  /** the two-stage draft open in the studio */
  draft: null as (Bundle & { source: 'local' }) | null,
  /** the 3D view: camera and depth */
  view3d: new View3D(),
  /** the 3D space (views from around the scene) */
  env: null as EnvGeometry | null,
  envCam: new EnvCamera(),
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
    hasElement: !!a.sprite,
    elementName: doc.motion?.element,
    editedLayer: a.editedLayer,
    waterline: a.waterline,
    signed: !!a.signed,
    hasDaylight: !!a.ambient,
  };
}

export async function openBundle(b: Bundle & { source: 'example' | 'local' }, keepUi = false) {
  const set = S().set;
  if (b.doc.draft) { openStudio(b as Bundle & { source: 'local' }); return; }
  set({ status: 'loading', statusText: 'Finding the lights', selection: null, hovered: null, picking: false, picked: [] });
  const token = `${b.doc.id}@${b.doc.steps.length}@${Object.keys(b.doc.images).length}`;
  const a = await analyzer().analyze(b.doc, b.images, token);
  live.bundle = b;
  live.token = token;

  const r = live.renderer;
  if (!r) throw new Error('The renderer is not ready.');
  r.load({ w: a.width, h: a.height, layers: a.layers, sprite: a.sprite, ambient: a.ambient });
  const sp = a.sprite;
  const element = sp
    ? { x: sp.rect[0] + sp.rect[2] / 2, y: sp.rect[1] + sp.rect[3] / 2, flux: Math.max(1, sp.flux), color: sp.color }
    : null;
  const e = live.engine;
  // zones: the user's own groups in two-stage scenes, nearby clusters otherwise
  const zones = b.doc.markers?.length ? zonesFromGroups(a.groups, a.lights, a.width, a.height) : computeZones(a.lights, a.width, a.height);
  a.lights.forEach((L) => { L.group = 0; });
  zones.forEach((z, j) => z.lights.forEach((i) => { a.lights[i].group = j; }));
  e.load(a.lights, zones.length, a.width, a.height, element);
  zones.forEach((z, j) => z.lights.forEach((i) => { e.zoneOf[i] = j; }));
  e.zoneCount = zones.length;
  e.route = b.doc.demo?.route ? makeRoute(b.doc.demo.route) : null;
  e.wake();
  live.motionDx = 0;
  const startMode = b.doc.demo?.startMode || 'hand';
  const ui = keepUi
    ? {}
    : {
        view: { ...DEFAULT_VIEW, ...(b.doc.demo?.view ?? {}) },
        mode: (startMode === 'dusk' ? 'hand' : startMode) as ModeId,
        variant: (a.editedLayer != null ? 'edits' : 'estimate') as 'edits' | 'estimate',
        motion: { ...S().motion, playing: true },
        playing: null,
      };
  const key = zonesKey(zones, a.width);
  const labels = b.doc.labels?.key === key ? b.doc.labels : null;
  set({
    analysis: a,
    scene: sceneState(b, a),
    zones: applyLabels(zones, labels),
    labels,
    currentId: b.doc.id,
    status: 'ready',
    statusText: '',
    master: 1,
    routeReady: !!e.route,
    ...ui,
  });
  if (!keepUi && startMode === 'dusk') playPreset(BUILT_IN.find((p) => p.id === 'dusk')!);
  await setupDepth(b, !keepUi && !!b.doc.demo?.start3d);
  await setupSpace(b);
  try { localStorage.setItem('living-stills:last', b.doc.id); } catch { /* ignore */ }
  if (!labels) void ensureLabels();
}

function applyLabels(zones: Zone[], labels: { zones: Record<string, string> } | null): Zone[] {
  if (!labels) return zones;
  const named = zones.map((z) => ({ ...z, name: capital(labels.zones[String(z.n)] ?? z.name) }));
  // several zones with the same name ("string lights" ×6): tell them apart by where they are
  const groups = new Map<string, Zone[]>();
  named.forEach((z) => groups.set(z.name, [...(groups.get(z.name) ?? []), z]));
  for (const [, same] of groups) {
    if (same.length < 2) continue;
    const byX = [...same].sort((a, b) => a.x - b.x);
    const words = same.length === 2 ? ['left', 'right'] : same.length === 3 ? ['left', 'middle', 'right'] : null;
    byX.forEach((z, k) => { z.name = `${z.name}, ${words ? words[k] : `${k + 1} of ${same.length}`}`; });
  }
  return named;
}

/** Names the zones with the vision model, once per scene (kept with your own scenes). */
export async function ensureLabels(force = false) {
  const st = S(), b = live.bundle, a = st.analysis;
  if (!b || !a || !st.zones.length || b.doc.markers?.length) return;
  if (!st.luminalKey || !relayUrl(st.relay)) return;
  if (st.labels && !force) return;
  const key = zonesKey(st.zones, a.width);
  try {
    const labels = await labelZones(b.images.on, st.zones, a.width, key, { key: st.luminalKey, relay: st.relay });
    if (live.bundle !== b) return;
    b.doc = { ...b.doc, labels };
    if (b.source === 'local') await saveLocal(b);
    S().set({ labels, zones: applyLabels(S().zones, labels) });
  } catch (err) {
    console.warn('labels', (err as Error).message);
  }
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
  // "and make it 3D": measure depth right after, in the browser
  if (S().also3d && !b.doc.draft) void make3D();
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
  const { report, signal } = startJob('Making a new scene');
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

Object.assign(live, { openEntryForTests: openEntry, make3DForTests: () => make3D() });
// test hook: depth for the open scene's lit image
Object.assign(live, {
  depthTest: async () => {
    const { estimateDepth } = await import('./splat/depth');
    const t0 = performance.now();
    const d = await estimateDepth(live.bundle!.images.on, (p, t) => console.log('depth', t, Math.round(p * 100)));
    let s = 0; for (const v of d.data) s += v;
    return { w: d.w, h: d.h, mean: s / d.data.length, ms: performance.now() - t0 };
  },
});

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------- two stages

export async function runCreateBase(p: Omit<BaseParams, 'key' | 'signal'>) {
  const { key } = S();
  const { report, signal } = startJob('Making the picture');
  try {
    const b = await createBase({ ...p, key, signal }, report);
    await saveLocal(b);
    await refreshLibrary();
    S().set({ job: null });
    openStudio({ ...b, source: 'local' });
  } catch (err) {
    failJob(err);
  }
}

export async function runFromPhoto(p: Omit<PhotoParams, 'key' | 'signal' | 'model' | 'resolution'>) {
  const { key, model, resolution } = S();
  const { report, signal } = startJob(p.then === 'describe' ? 'Lighting your picture' : 'Bringing in your picture');
  try {
    const b = await fromPhoto({ ...p, key, model, resolution, signal }, report);
    if (b.doc.draft) {
      await saveLocal(b);
      await refreshLibrary();
      S().set({ job: null });
      if (p.then === 'place') openStudio({ ...b, source: 'local' });
      else S().toast('Saved in Scenes. Open it any time to place its lights.');
    } else await finishJob(b);
  } catch (err) {
    failJob(err);
  }
}

export function openStudio(b: Bundle & { source: 'local' }) {
  live.draft = b;
  S().set({ sheet: 'studio', status: S().scene ? 'ready' : 'idle' });
}

export async function saveDraftMarkers(markers: Marker[], lighting: string) {
  const d = live.draft;
  if (!d) return;
  d.doc = { ...d.doc, markers, lighting };
  await saveLocal(d);
}

/** Stage two: the planner reads the picture, then the image model switches the placed lights on. */
export async function runLightUp(markers: Marker[], lighting: string) {
  const d = live.draft;
  if (!d) return;
  const st = S();
  const { report, signal } = startJob('Lighting your picture');
  const w = d.doc.width, h = d.doc.height;
  let plan: MarkerPlan[];
  const planStep: JobStep = { id: 'plan', label: 'Reading the picture', status: 'running' };
  const canPlan = !!st.luminalKey && !!relayUrl(st.relay);
  try {
    if (canPlan) {
      report([planStep]);
      const t0 = performance.now();
      try {
        plan = await planMarkers(d.images.base, markers, w, h, d.doc.prompt, lighting, { key: st.luminalKey, relay: st.relay, signal });
        planStep.status = 'done';
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        plan = planFromNotes(markers, w, h);
        planStep.status = 'done';
        planStep.error = `Used your notes as written (${(err as Error).message})`;
      }
      planStep.ms = performance.now() - t0;
    } else plan = planFromNotes(markers, w, h);
    const planned = markers.map((m) => {
      const p = plan.find((x) => x.n === m.n);
      return { ...m, object: p?.object, box: p?.box };
    });
    const nb = await lightUp(d, { key: st.key, model: st.model, markers: planned, lighting, plan, signal }, (steps) => report(canPlan ? [planStep, ...steps] : steps));
    await deleteLocal(d.doc.id);
    live.draft = null;
    await finishJob(nb);
  } catch (err) {
    failJob(err);
  }
}

// ---------------------------------------------------------------- selection and the light panel

/** The engine indices the light panel controls right now. */
export function selectedIndices(): number[] {
  const sel = S().selection;
  if (!sel) return [];
  if (sel.scope === 'picked') return sel.picked;
  if (sel.scope === 'zone') {
    const z = live.engine.zoneOf[sel.anchor];
    const zone = S().zones[z];
    return zone ? zone.lights : [sel.anchor];
  }
  return [sel.anchor];
}

function leaveShow() {
  const e = live.engine;
  if (e.mode === 'show') {
    e.stopShow();
    S().set({ mode: 'hand', playing: null });
  }
}

export function setLevel(ix: number[], v: number) {
  leaveShow();
  for (const i of ix) live.engine.base[i] = v;
  S().set({ rev: S().rev + 1 });
}

export function setColor(ix: number[], c: [number, number, number] | null) {
  leaveShow();
  for (const i of ix) live.engine.colors[i] = c;
  S().set({ rev: S().rev + 1 });
}

export function setFx(ix: number[], fx: LightFx) {
  live.engine.setFx(ix, fx);
  if (fx === 'music' && !audio.active) S().toast('Turn on Listen in the Music effect (or the light panel) so the light can hear.');
  S().set({ rev: S().rev + 1 });
}

// ---------------------------------------------------------------- shows: presets and the director

export function playShow(show: Show, id?: string) {
  const e = live.engine;
  e.playShow(show);
  S().set({ mode: 'show', playing: { name: show.name, id, loop: !!show.loop }, menu: null });
  if (usesMusic(show) && !audio.active) S().toast('This show follows music. Turn on Listen to hear it.');
}

export function playPreset(p: Preset) {
  playShow(p.show, p.id);
}

export function stopShow() {
  live.engine.stopShow();
  S().set({ mode: 'hand', playing: null });
}

export function directorScene(): DirectorScene {
  const st = S(), a = st.analysis!, e = live.engine;
  return {
    summary: st.labels?.summary || st.scene?.doc.prompt || '',
    zones: st.zones.map((z) => ({
      n: z.n, name: z.name,
      x: z.bbox[0] / a.width, y: z.bbox[1] / a.height, w: (z.bbox[2] - z.bbox[0]) / a.width, h: (z.bbox[3] - z.bbox[1]) / a.height,
      count: z.lights.length,
      on: z.lights.reduce((s, i) => s + Math.min(1, e.level[i] ?? 0), 0) / Math.max(1, z.lights.length),
    })),
    hasMusic: audio.active,
  };
}

export async function runDirector(request: string) {
  const st = S();
  if (!st.analysis || !request.trim()) return;
  const d = st.director;
  const turns = [...d.turns, { role: 'you' as const, text: request.trim() }];
  S().set({ director: { ...d, busy: true, draft: '', thinking: '', turns, error: undefined } });
  const history = d.turns.flatMap((t, i) => (t.role === 'director' && t.show && d.turns[i - 1]?.role === 'you' ? [{ request: d.turns[i - 1].text, show: t.show }] : []));
  try {
    if (!st.labels) await ensureLabels();
    const show = await direct(directorScene(), request.trim(), history, {
      key: st.luminalKey, relay: st.relay,
      onThinking: (t) => { const cur = S().director; S().set({ director: { ...cur, thinking: t.slice(-280) } }); },
    });
    const cur = S().director;
    S().set({ director: { ...cur, busy: false, thinking: '', turns: [...cur.turns, { role: 'director', text: show.summary || show.name, show }] } });
    playShow(show);
  } catch (err) {
    const cur = S().director;
    S().set({ director: { ...cur, busy: false, thinking: '', error: (err as Error).message } });
  }
}

// ---------------------------------------------------------------- music

export async function listen(source: 'mic' | 'tab' | null) {
  const set = S().set;
  if (!source) {
    audio.stop();
    live.engine.audio = null;
    set({ music: { ...S().music, source: null, error: undefined } });
    return;
  }
  try {
    await audio.start(source);
    set({ music: { ...S().music, source, error: undefined } });
  } catch (err) {
    const msg = (err as Error).name === 'NotAllowedError' ? 'Permission to listen was not given.' : (err as Error).message;
    set({ music: { ...S().music, source: null, error: msg } });
  }
}

// ---------------------------------------------------------------- 3D (Gaussian splats from depth)

/** Splat spacing: fine on a real GPU, coarse on software rendering (tests) and phones. */
function finalStride(): number {
  const forced = Number(new URLSearchParams(location.search).get('splatStride')) || 0;
  if (forced) return forced;
  if (live.renderer?.software) return 5;
  if (S().three.detail === 'fast' || matchMedia('(pointer: coarse)').matches) return 2;
  return 1;
}

let buildSeq = 0;
/** Shows the splats coarse first, then at full detail a moment later (building a million points takes a second). */
function showSplats(b: Bundle, depth: DepthMap) {
  const r = live.renderer, v = live.view3d;
  if (!r) return;
  const seq = ++buildSeq;
  v.setScene(depth, b.doc.width, b.doc.height);
  const target = finalStride();
  const first = Math.max(target, r.software ? target : 3);
  r.setSplats(buildSplats(v, b.doc.width, b.doc.height, first));
  if (first !== target) {
    setTimeout(() => {
      if (seq !== buildSeq || live.bundle !== b) return;
      r.setSplats(buildSplats(v, b.doc.width, b.doc.height, target));
    }, 60);
  }
}

/** Loads the scene's depth map (if it has one) and builds its splats. */
async function setupDepth(b: Bundle, start3d: boolean) {
  const r = live.renderer, v = live.view3d;
  const three = S().three;
  if (!r) return;
  if (!b.images.depth) {
    r.setSplats(null);
    v.depth = null;
    S().set({ three: { ...three, available: false, on: false, busy: null } });
    return;
  }
  const depth = await depthFromPng(b.images.depth);
  if (live.bundle !== b) return;
  v.cam = { yaw: 0, pitch: 0, dolly: 0, strength: three.strength };
  v.goal = { ...v.cam };
  showSplats(b, depth);
  S().set({ three: { ...S().three, available: true, on: start3d || S().three.on, busy: null } });
}

/** Rebuilds the splats at a new level of detail (the 3D menu). */
export function rebuildSplats() {
  const b = live.bundle, d = live.view3d.depth;
  if (b && d) showSplats(b, d);
}

async function pictureRGBA(b: Bundle): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(b.images.on ?? b.images.off);
  const c = new OffscreenCanvas(b.doc.width, b.doc.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, b.doc.width, b.doc.height);
  bmp.close();
  return ctx.getImageData(0, 0, b.doc.width, b.doc.height).data;
}

/**
 * Measures depth for the open scene in the browser (free) and keeps it with the scene. Progressive:
 * a quick pass with the small model shows the 3D view within seconds; a detailed pass with the larger
 * model follows and replaces it. Both have their edges snapped to the picture's edges.
 */
export async function make3D() {
  const b = live.bundle;
  if (!b) return;
  const set = (patch: Partial<ReturnType<typeof S>['three']>) => S().set({ three: { ...S().three, ...patch } });
  const keep = async (d: DepthMap) => {
    const png = await depthToPng(d);
    b.images = { ...b.images, depth: png };
    b.doc = { ...b.doc, images: { ...b.doc.images, depth: 'depth' } };
    if (b.source === 'local') { await saveLocal(b); await refreshLibrary(); }
  };
  try {
    set({ busy: 'Loading the depth model' });
    const src = b.images.on ?? b.images.off;
    const rgba = await pictureRGBA(b);
    const progress = (p: number, text: string) => set({ busy: p < 1 ? `${text} · ${Math.round(p * 100)}%` : text });
    const quick = refineDepth(await estimateDepth(src, progress, 'small'), rgba, b.doc.width, b.doc.height);
    if (live.bundle !== b) return;
    await keep(quick);
    await setupDepth(b, true);
    set({ busy: 'Adding detail' });
    const fine = refineDepth(await estimateDepth(src, (p, t) => set({ busy: p < 1 ? `${t} · ${Math.round(p * 100)}%` : 'Adding detail' }), 'base'), rgba, b.doc.width, b.doc.height);
    if (live.bundle !== b) return;
    await keep(fine);
    showSplats(b, fine);
    set({ busy: null, available: true });
  } catch (err) {
    set({ busy: null });
    S().toast(`Could not measure depth: ${(err as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------- the 3D space (views from around the scene)

const ORBIT = [90, 180, 270];

async function decodeAt(blob: Blob, w: number, h: number): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h).data;
}

/** Builds the 3D space if the scene has its views and their depth. */
async function setupSpace(b: Bundle) {
  const r = live.renderer;
  const space = S().space;
  const angles = b.doc.orbit?.angles ?? [];
  const ok = !!r && !!b.images.depth && angles.length > 0 && angles.every((a) => b.images[`orbit${a}On`] && b.images[`orbit${a}Off`] && b.images[`orbit${a}Depth`]);
  if (!ok) {
    r?.setEnv(null);
    live.env = null;
    S().set({ space: { ...space, available: false, on: false } });
    return;
  }
  const { width: w, height: h } = b.doc;
  const depths = await Promise.all([b.images.depth, ...angles.map((a) => b.images[`orbit${a}Depth`])].map((x) => depthFromPng(x)));
  const on = await Promise.all(angles.map((a) => decodeAt(b.images[`orbit${a}On`], w, h)));
  const off = await Promise.all(angles.map((a) => decodeAt(b.images[`orbit${a}Off`], w, h)));
  if (live.bundle !== b) return;
  const stride = r!.software ? 6 : S().three.detail === 'fast' ? 3 : 2;
  const g = buildEnv([0, ...angles].map((angle, k) => ({ angle, depth: depths[k] })), w, h, S().three.strength, stride);
  live.env = g;
  r!.setEnv(g, { on, off });
  live.envCam.yaw = live.envCam.goal.yaw = 0;
  live.envCam.pitch = live.envCam.goal.pitch = 0;
  live.envCam.dist = live.envCam.goal.dist = 1;
  S().set({ space: { ...S().space, available: true, on: S().space.on || !!b.doc.demo?.startSpace, busy: null } });
  if (S().space.on) S().set({ three: { ...S().three, on: false } });
}

/**
 * Makes the 3D space: DeepSeek describes the place from three more sides, the image model draws them
 * (and each with its lights off), then their depth is measured in the browser and everything is placed
 * on one circle around the scene's centre.
 */
export async function makeSpace() {
  const b0 = live.bundle;
  if (!b0) return;
  const st = S();
  const set = (patch: Partial<ReturnType<typeof S>['space']>) => S().set({ space: { ...S().space, ...patch } });
  if (!st.key) { S().set({ sheet: 'settings' }); return; }
  try {
    if (!b0.images.depth) { set({ busy: 'Measuring depth first' }); await make3D(); }
    const b = live.bundle!;
    let plan = { layout: '', views: ORBIT.map((angle) => ({ angle, prompt: '' })) };
    if (st.luminalKey && relayUrl(st.relay)) {
      set({ busy: 'Imagining the other sides' });
      plan = await planOrbit(b.images.on, ORBIT, { key: st.luminalKey, relay: st.relay });
    }
    set({ busy: null });
    const { report, signal } = startJob('Drawing it from around');
    const nb = await makeOrbit(b, { key: st.key, model: st.model, angles: ORBIT, layout: plan.layout, plans: plan.views, signal }, report);
    if (b.source === 'example') nb.doc = { ...nb.doc, id: `${b.doc.id}-space-${Date.now().toString(36)}`, title: `${b.doc.title}, in 3D`, demo: { ...b.doc.demo, order: undefined } };
    S().set({ job: null });
    const rgbaFor = async (blob: Blob) => decodeAt(blob, nb.doc.width, nb.doc.height);
    for (const a of ORBIT) {
      set({ busy: `Measuring depth from ${a}°` });
      const src = nb.images[`orbit${a}On`];
      const d = refineDepth(await estimateDepth(src, (p, t) => set({ busy: p < 1 ? `${t} · ${Math.round(p * 100)}%` : `Measuring depth from ${a}°` }), 'base'), await rgbaFor(src), nb.doc.width, nb.doc.height);
      nb.images[`orbit${a}Depth`] = await depthToPng(d);
      nb.doc.images[`orbit${a}Depth`] = `orbit${a}Depth`;
    }
    await saveLocal(nb);
    await refreshLibrary();
    await openBundle({ ...nb, source: 'local' }, true);
    set({ busy: null, on: true });
  } catch (err) {
    set({ busy: null });
    failJob(err);
    S().toast(`The 3D space could not be made: ${(err as Error).message}`, 'error');
  }
}
Object.assign(live, { makeSpaceForTests: () => makeSpace() });

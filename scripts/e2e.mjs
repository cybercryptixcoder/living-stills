// End-to-end test of Living Stills through the real UI, with real OpenRouter calls.
//
//   OPENROUTER_KEY=sk-or-... node scripts/e2e.mjs --flow viaduct [--bake viaduct] [--url http://127.0.0.1:5173/]
//
// Flows:
//   viaduct  paint a scene with a moving train (4 images), check lights + motion
//   city     paint a split scene (2 images), check lights + torch mode
//   alley    paint a split scene, then real per-light edits for the brightest 5 (2 + 5 images)
//   grid     open the viaduct scene in this browser profile and paint every frame (frames x lights)
//   play     no generation: open each example and exercise every mode (free)
// --mock    answer image calls with local fixtures instead of OpenRouter (plumbing only, free)
// --bake    export the resulting scene into public/scenes/<name> as an example
// --profile keep browser storage between runs in this folder (needed for grid after viaduct)

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:5173/';
const FLOW = args.flow || 'play';
const KEY = process.env.OPENROUTER_KEY || '';
const MOCK = !!args.mock;
const OUT = 'test-results';
fs.mkdirSync(OUT, { recursive: true });

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
let failures = 0;
const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };

const launchArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
const context = args.profile
  ? await chromium.launchPersistentContext(path.resolve(args.profile), { args: launchArgs, proxy, viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  : await (await chromium.launch({ args: launchArgs, proxy })).newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(120000);
page.on('pageerror', (e) => { log('pageerror', e.message); failures++; });
page.on('console', (m) => { if (m.type() === 'error') log('console error:', m.text()); });
page.on('dialog', (d) => d.accept());

// ------------------------------------------------------------------ mock image API (free plumbing runs)
if (MOCK) {
  const sharp = (await import('sharp')).default;
  const fx = (n) => fs.readFileSync(path.join('scratch', n));
  await page.route('https://openrouter.ai/api/v1/key', (r) => r.fulfill({ json: { data: { limit_remaining: 5, usage: 0, limit: 5 } } }));
  await page.route('https://openrouter.ai/api/v1/images', async (route) => {
    const body = JSON.parse(route.request().postData());
    const p = body.prompt;
    let buf;
    if (/remove/.test(p)) buf = fx('klein3_plate.jpg');
    else if (/switch off every/.test(p)) buf = body.input_references[0].image_url.url.includes('image/png') ? fx('klein3_off.jpg') : fx('klein3_off.jpg');
    else if (/switch on/.test(p)) {
      const ref = Buffer.from(body.input_references[0].image_url.url.split(',')[1], 'base64');
      const meta = await sharp(ref).metadata();
      const glow = Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><defs><radialGradient id="g"><stop offset="0" stop-color="#ffcf80" stop-opacity=".9"/><stop offset="1" stop-color="#ffcf80" stop-opacity="0"/></radialGradient></defs><circle cx="${meta.width / 2}" cy="${meta.height / 2}" r="${meta.height / 4}" fill="url(#g)"/></svg>`);
      buf = await sharp(ref).composite([{ input: glow, blend: 'screen' }]).jpeg().toBuffer();
    } else buf = fx('klein3_gen.jpg');
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ json: { data: [{ b64_json: buf.toString('base64'), media_type: 'image/jpeg' }], usage: { cost: 0 } } });
  });
}

// ------------------------------------------------------------------ helpers
async function ready() {
  await page.goto(URL_);
  await page.waitForFunction(() => window.__living?.store, null, { timeout: 60000 });
  // the scene's lights and layers arrive with the asset analysis: wait for them so the reads
  // below never race the load (software GL takes a while to get there)
  await page.waitForFunction(() => {
    const s = window.__living.store.getState();
    return !!s.analysis && !!window.__living.renderer?.rect;
  }, null, { timeout: 180000 });
}
const state = (fn) => page.evaluate(fn);
async function waitEngine(seconds) {
  await page.evaluate(async (s) => {
    const e = window.__living.engine, t0 = e.time;
    while (e.time < t0 + s) await new Promise((r) => setTimeout(r, 100));
  }, seconds);
}
async function waitScene(timeout = 180000) {
  // Software rendering is slow (often under 1 frame per second): let engine time follow real
  // time and skip the wake-up reveal, then wait for a few rendered frames.
  await page.waitForFunction(() => {
    const L = window.__living, s = L?.store.getState();
    if (!s || s.status !== 'ready' || !L.renderer?.loaded) return false;
    L.engine.maxDt = 1;
    L.engine.finishWake();
    return true;
  }, null, { timeout, polling: 250 });
  await page.evaluate(async () => {
    const e = window.__living.engine, t0 = e.time;
    while (e.time < t0 + 0.5) await new Promise((r) => setTimeout(r, 100));
  });
}
async function setKey() {
  if (!KEY && !MOCK) throw new Error('Set OPENROUTER_KEY');
  await page.click('button[aria-label="Settings"]');
  await page.fill('#orkey', KEY || 'sk-or-v1-mock');
  await page.click('text=Save and check');
  await page.waitForSelector('.notice--ok, .notice--bad', { timeout: 30000 });
  const ok = await page.isVisible('.notice--ok');
  check(ok, `key accepted: ${await page.textContent('.notice')}`);
  await page.keyboard.press('Escape');
}
async function waitJob(timeout) {
  await page.waitForSelector('.job', { timeout: 15000 });
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    const j = await state(() => {
      const s = window.__living.store.getState();
      return s.job ? { error: s.job.error, steps: s.job.steps.map((x) => `${x.label}:${x.status}`).join(' | '), finding: s.job.finding } : null;
    });
    if (!j) return true;
    if (j.error) { check(false, `job failed: ${j.error}`); await page.screenshot({ path: `${OUT}/job-error.png` }); return false; }
    if (j.steps !== last) { log('  ', j.steps); last = j.steps; }
    await page.waitForTimeout(1500);
  }
  check(false, 'job timed out');
  return false;
}
async function composite() {
  return page.evaluate(() => {
    const c = window.__living.renderer.readComposite();
    let s = 0;
    for (let i = 0; i < c.length; i += 4) s += 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2];
    return s / (c.length / 4);
  });
}
async function regionLum(x0, y0, x1, y1) {
  return page.evaluate(([x0, y0, x1, y1]) => {
    const a = window.__living.store.getState().analysis, c = window.__living.renderer.readComposite();
    let s = 0, n = 0;
    for (let y = Math.round(y0 * a.height); y < y1 * a.height; y++)
      for (let x = Math.round(x0 * a.width); x < x1 * a.width; x++) {
        const i = (y * a.width + x) * 4;
        s += 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2]; n++;
      }
    return s / n;
  }, [x0, y0, x1, y1]);
}
async function spent() {
  return state(() => window.__living.store.getState().spend);
}
async function sceneSummary() {
  return state(() => {
    const s = window.__living.store.getState();
    return { title: s.scene.doc.title, method: s.scene.doc.method, lights: s.scene.lights, groups: s.scene.groups.length, element: s.scene.hasElement, frames: s.scene.frames, cost: s.scene.doc.cost, images: s.scene.doc.steps.filter((x) => x.image).length, waterline: s.scene.waterline, size: [s.scene.doc.width, s.scene.doc.height] };
  });
}

async function lightChecks(tag) {
  await page.evaluate(() => {
    const L = window.__living;
    L.store.getState().set({ view: { ambient: 1, exposure: 1, glow: 0.5, haze: 0.3, grain: 0.5, warmth: 0 }, mode: 'hand' });
    L.store.getState().setSettings({ feel: 'filament' });
    L.store.getState().set({ motion: { ...L.store.getState().motion, playing: false } });
  });
  await page.evaluate(() => window.__living.engine.setAll(1));
  await waitEngine(1.2);
  const on = await composite();
  await page.screenshot({ path: `${OUT}/${tag}-on.png` });
  await page.evaluate(() => window.__living.engine.setAll(0));
  await waitEngine(1.5);
  const off = await composite();
  await page.screenshot({ path: `${OUT}/${tag}-off.png` });
  const isGrid = await state(() => window.__living.store.getState().scene.doc.method === 'grid');
  check(on > off * (isGrid ? 1.02 : 1.08), `${tag}: switching all lights changes the picture (mean linear luminance ${off.toFixed(4)} -> ${on.toFixed(4)})`);
  if (isGrid) { await page.evaluate(() => window.__living.engine.setAll(1)); return; }
  // torch: only lights near the cursor
  await page.keyboard.press('2');
  const r = await state(() => window.__living.renderer.rect);
  const a = await state(() => { const s = window.__living.store.getState().analysis; return { w: s.width, h: s.height, lights: s.lights.map((L) => [L.x, L.y, L.flux]) }; });
  // The torch lights whatever is under the cursor. Pick the brightest light whose
  // neighbourhood is sparse: on software GL (about one frame per second) a dense cluster
  // of bulbs both cools down and heats up inside the two sample windows and averages out.
  const R_SAMPLE = 0.09; // the torch's pool of light is about this wide; sample it, not a dot
  const density = await page.evaluate((pts) => {
    const e = window.__living.engine, R = 0.14 * e.W;
    return pts.map(([x, y]) => {
      let n = 0;
      for (let i = 0; i < e.count; i++) if (Math.hypot(e.posX[i] - x, e.posY[i] - y) < R) n++;
      return n;
    });
  }, a.lights.map((l) => [l[0], l[1]]));
  const byFlux = a.lights.map((l, i) => ({ l, n: density[i] })).sort((p, q) => q.l[2] - p.l[2]);
  const pick = [...byFlux].sort((p, q) => Math.abs(p.n - 4) - Math.abs(q.n - 4))[0];
  const best = pick.l;
  const tx = best[0] / a.w, ty = best[1] / a.h;
  await page.mouse.move(r.x + tx * r.w, r.y + ty * r.h);
  await waitEngine(1.2);
  const near = await regionLum(Math.max(0, tx - R_SAMPLE), Math.max(0, ty - R_SAMPLE), Math.min(1, tx + R_SAMPLE), Math.min(1, ty + R_SAMPLE));
  const far = await regionLum(tx < 0.5 ? 0.7 : 0.05, 0.05, tx < 0.5 ? 0.95 : 0.3, 0.6);
  await page.screenshot({ path: `${OUT}/${tag}-torch.png` });
  const hovering = await state(() => window.__living.engine.pointer.inside);
  // aim at the point on the print farthest from the bulb, not at r.x/r.y: the print is centred,
  // so a bulb near one edge would otherwise be un-hovered to "around the centre" and stay lit
  await page.mouse.move(r.w - (r.x + tx * r.w), r.h - (r.y + ty * r.h));
  await waitEngine(1.2);
  const nearAfter = await regionLum(Math.max(0, tx - R_SAMPLE), Math.max(0, ty - R_SAMPLE), Math.min(1, tx + R_SAMPLE), Math.min(1, ty + R_SAMPLE));
  check(near > nearAfter * 1.05 && hovering, `${tag}: torch lights the area under the cursor (${near.toFixed(4)} vs ${nearAfter.toFixed(4)} after moving away; far region ${far.toFixed(4)}; ${pick.n} lights near the target; hover registered ${hovering})`);
  await page.keyboard.press('1');
  await page.evaluate(() => window.__living.engine.setAll(1));
}

async function motionCheck(tag) {
  const isGrid = await state(() => window.__living.store.getState().scene.doc.method === 'grid');
  if (isGrid) {
    await page.evaluate(() => { const s = window.__living.store.getState(); s.set({ motion: { ...s.motion, playing: true, speed: 2 } }); });
    const g0 = await state(() => window.__living.gridPhase);
    await waitEngine(1.5);
    const g1 = await state(() => window.__living.gridPhase);
    const frames = await state(() => window.__living.store.getState().scene.frames);
    const moved = (((g1 - g0) % frames) + frames) % frames;
    check(moved > 0.3, `${tag}: grid frames advance (${g0.toFixed(2)} -> ${g1.toFixed(2)} of ${frames})`);
    await page.screenshot({ path: `${OUT}/${tag}-motion.png` });
    return;
  }
  const p0 = await state(() => { const e = window.__living.engine; return e.hasElement ? e.posX[e.count - 1] : null; });
  await page.evaluate(() => { const s = window.__living.store.getState(); s.set({ motion: { ...s.motion, playing: true, speed: 2 } }); });
  await waitEngine(1.5);
  const p1 = await state(() => { const e = window.__living.engine; return e.hasElement ? e.posX[e.count - 1] : null; });
  check(p0 != null && p1 != null && Math.abs(p1 - p0) > 20, `${tag}: the moving element travels (${p0?.toFixed(0)} -> ${p1?.toFixed(0)} px)`);
  await page.screenshot({ path: `${OUT}/${tag}-motion.png` });
  await page.evaluate(() => { const s = window.__living.store.getState(); s.set({ motion: { ...s.motion, speed: 1 } }); });
}

async function bake(name, meta) {
  const res = await page.evaluate(() => window.__exportScene());
  const dir = path.join('public', 'scenes', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, b64] of Object.entries(res.files)) fs.writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'));
  const doc = { ...res.doc, id: name, ...meta.doc, demo: meta.demo };
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(doc, null, 2));
  const idxPath = path.join('public', 'scenes', 'index.json');
  const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')).filter((x) => !x.startsWith('dev-')) : [];
  if (!idx.includes(name)) idx.push(name);
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  log(`baked ${name}: ${Object.keys(res.files).length} images`);
}

async function create(idea, opts = {}) {
  await page.click('button[title^="Paint a new scene"]');
  await page.click(`.chip:has-text("${idea}")`);
  if (opts.detail) await page.click(`.segmented[aria-label="Detail"] button:has-text("${opts.detail}")`);
  const est = await page.textContent('.estimate p');
  log('estimate:', est);
  const before = await spent();
  await page.click('button:has-text("Paint it")');
  const ok = await waitJob(8 * 60000);
  if (!ok) return null;
  await waitScene();
  const s = await sceneSummary();
  log('scene:', JSON.stringify(s), 'spent this run', ((await spent()) - before).toFixed(4));
  return s;
}

// ------------------------------------------------------------------ flows
await ready();
const t0 = Date.now();

if (FLOW === 'play') {
  await waitScene();
  const examples = await state(() => window.__living.store.getState().examples.map((e) => e.id));
  for (const id of examples) {
    await page.evaluate(async (id) => {
      const s = window.__living.store.getState();
      await window.__living.openEntryForTests(s.examples.find((x) => x.id === id));
    }, id);
    await waitScene();
    const s = await sceneSummary();
    log('example', id, JSON.stringify(s));
    check(s.lights > 0, `${id}: has lights`);
    await lightChecks(id);
    if (s.element || s.method === 'grid') await motionCheck(id);
    // a grid scene has no light of its own: the modes that move a light around would only show
    // the previous frame, so walk the ones that do not need a pointer, and leave the pointer
    // modes to the layered and split scenes (software GL renders too slowly to drive them here)
    const modes = s.method === 'grid' ? ['7', '8', '9'] : ['3', '4', '5', '6', '7', '8', '9'];
    for (const k of modes) { await page.keyboard.press(k); await waitEngine(0.4); }
    await page.screenshot({ path: `${OUT}/${id}-dusk.png` });
    await page.keyboard.press('1');
  }
} else {
  await setKey();
  if (FLOW === 'viaduct') {
    const s = await create('Train over a viaduct');
    check(!!s && s.method === 'layered' && s.element, 'viaduct: scene has a moving layer');
    check(!!s && s.lights >= 10, `viaduct: found ${s?.lights} lights`);
    if (s) { await lightChecks('viaduct'); await motionCheck('viaduct'); }
    if (s && args.bake) await bake(args.bake, {
      doc: { title: 'Night Viaduct' },
      demo: { order: 1, startMode: 'hand', blurb: 'The train is cut out once and loops forever; the town is split into lights.' },
    });
  }
  if (FLOW === 'city') {
    const s = await create('City of windows');
    check(!!s && s.method === 'split', 'city: split scene');
    check(!!s && s.lights >= 30, `city: found ${s?.lights} lights`);
    if (s) await lightChecks('city');
    if (s && args.bake) await bake(args.bake, { doc: { title: 'Window City' }, demo: { order: 2, startMode: 'torch' } });
  }
  if (FLOW === 'alley') {
    const s = await create('Rainy alley');
    check(!!s && s.method === 'split', 'alley: split scene');
    if (s) {
      await page.click('text=Real edits for chosen lights');
      await page.click('.chip:has-text("Brightest 5")');
      const before = await spent();
      await page.click('.sheet__foot button.btn--primary');
      const ok = await waitJob(8 * 60000);
      await waitScene();
      const r = await sceneSummary();
      log('refined:', JSON.stringify(r), 'spent', ((await spent()) - before).toFixed(4));
      check(ok && r.method === 'perLight', 'alley: per-light edits applied');
      const diff = await page.evaluate(async () => {
        const L = window.__living, st = L.store;
        L.engine.setAll(1);
        const wait = async (s) => { const t0 = L.engine.time; while (L.engine.time < t0 + s) await new Promise((r) => setTimeout(r, 100)); };
        st.getState().set({ variant: 'estimate' }); await wait(0.6);
        const a = L.renderer.readComposite();
        st.getState().set({ variant: 'edits' }); await wait(0.6);
        const b = L.renderer.readComposite();
        let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        return d / (a.length / 4);
      });
      check(diff > 1e-4, `alley: edited lights differ from the estimate (mean abs diff ${diff.toFixed(5)})`);
      await page.screenshot({ path: `${OUT}/alley-edits.png` });
      await lightChecks('alley');
      if (args.bake) await bake(args.bake, { doc: { title: 'Rain Alley' }, demo: { order: 3, startMode: 'hand' } });
    }
  }
  if (FLOW === 'repaint') {
    // repaint the lights-off image of a split example, then give its best lights real edits
    await waitScene();
    const target = args.scene || 'Rain Alley';
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = s.examples.find((x) => x.title === t);
      await window.__living.openEntryForTests(e);
    }, target);
    await waitScene();
    const before = await spent();
    await page.click('text=Repaint the dark version');
    const ok = await waitJob(5 * 60000);
    await waitScene();
    const r = await sceneSummary();
    log('repainted:', JSON.stringify(r), 'spent', ((await spent()) - before).toFixed(4));
    check(ok && r.method === 'split' && r.title.endsWith('repainted'), 'repaint: new dark version made');
    await page.screenshot({ path: `${OUT}/repaint.png` });
    args.scene = r.title;
  }
  if (FLOW === 'refine' || FLOW === 'repaint') {
    // real per-light edits on an existing split scene (an example or one of yours)
    await waitScene();
    const target = args.scene || 'Rain Alley';
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = [...s.locals, ...s.examples].find((x) => x.title === t && (x.method === 'split' || x.method === 'perLight'));
      if (!e) throw new Error(`No split scene titled ${t}`);
      await window.__living.openEntryForTests(e);
    }, target);
    await waitScene();
    await page.click('text=Real edits for chosen lights');
    await page.click(`.chip:has-text("Brightest ${args.count || 5}")`);
    const before = await spent();
    await page.click('.sheet__foot button.btn--primary');
    const ok = await waitJob(8 * 60000);
    await waitScene();
    const r = await sceneSummary();
    log('refined:', JSON.stringify(r), 'spent', ((await spent()) - before).toFixed(4));
    check(ok && r.method === 'perLight', 'refine: per-light edits applied');
    await page.screenshot({ path: `${OUT}/refine-edits.png` });
    if (args.bake) await bake(args.bake, { doc: { title: target }, demo: { order: 3, startMode: 'hand', view: { ambient: 0.8 } } });
  }
  if (FLOW === 'grid') {
    await waitScene();
    const target = args.scene || 'Night Viaduct';
    const has = await page.evaluate((t) => {
      const s = window.__living.store.getState();
      return [...s.locals, ...s.examples].some((e) => e.title === t && e.method === 'layered');
    }, target);
    if (!has) throw new Error(`No layered scene titled ${target} in this browser profile or examples.`);
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = [...s.locals, ...s.examples].find((x) => x.title === t && x.method === 'layered');
      await window.__living.openEntryForTests(e);
    }, target);
    await waitScene();
    await page.click('text=Paint every frame');
    await page.waitForSelector('.groupcheck', { timeout: 60000 });
    if (args.frames) await page.click(`.segmented[aria-label="Positions"] button:has-text("${args.frames}")`);
    const est = await page.textContent('.estimate p');
    log('grid estimate:', est);
    const before = await spent();
    await page.click('.sheet__foot button.btn--primary');
    const ok = await waitJob(12 * 60000);
    await waitScene(240000);
    const s = await sceneSummary();
    log('grid scene:', JSON.stringify(s), 'spent', ((await spent()) - before).toFixed(4));
    check(ok && s.method === 'grid' && s.frames >= 2, 'grid: every-frame scene built');
    await lightChecks('grid');
    await motionCheck('grid');
    if (args.bake) await bake(args.bake, { doc: { title: 'Night Viaduct, every frame' }, demo: { order: 4, startMode: 'hand' } });
  }
}

log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s, spent in this browser session: ${(await spent()).toFixed(4)} USD, failures: ${failures}`);
await context.close();
process.exit(failures ? 1 : 0);

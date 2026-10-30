// End-to-end test of Living Stills through the real UI, with real OpenRouter and Luminal calls.
//
//   OPENROUTER_KEY=sk-or-... LUMINAL_KEY=lum_... node scripts/e2e.mjs --flow play [--url http://127.0.0.1:5173/]
//
// Flows:
//   play      free: every example, the light panel, every effect, presets, music (fake microphone)
//   director  Luminal only: names the zones, asks the director for a show, refines it, checks it plays
//   create    one go: --prompt "..." [--lighting "..."] [--element "the train"]  (2 or 4 images)
//   base      two stages, part 1: --prompt "..." [--kind dark|ambient]  makes the picture (1 image) and
//             saves a screenshot so markers can be chosen; needs --profile to keep the draft
//   lightup   two stages, part 2: --markers "x,y,note,#color;x,y,note" (fractions of the picture) on the
//             draft in this --profile; the planner reads the picture, then 1 (or 2) images
//   refine    repaint the brightest --count lights of --scene (default Rain Alley)
//   depth     (splat) measure depth for --scene (--remeasure to redo), check parallax and lights in 3D, --bake
//   space     (splat) make the 3D space for --scene (6 images), walk round it, --bake
// --mock    answer image calls with local fixtures instead of OpenRouter (plumbing only, free)
// --bake    export the resulting scene into public/scenes/<name> as an example
// --profile keep browser storage between runs in this folder

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
const LUM = process.env.LUMINAL_KEY || '';
const MOCK = !!args.mock;
const OUT = 'test-results';
fs.mkdirSync(OUT, { recursive: true });

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
let failures = 0;
const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };

const launchArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve('scripts/fixtures/beat.wav')}`, '--autoplay-policy=no-user-gesture-required'];
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
const context = args.profile
  ? await chromium.launchPersistentContext(path.resolve(args.profile), { args: launchArgs, proxy, viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ['microphone'] })
  : await (await chromium.launch({ args: launchArgs, proxy })).newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ['microphone'] });
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
    if (/remove .* completely/.test(p)) buf = fx('klein3_plate.jpg');
    else if (/switch off the light sources|in darkness/.test(p)) buf = fx('klein3_off.jpg');
    else if (/make these things glow|switch on only/.test(p)) {
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
  await page.click('[data-testid=open-settings]');
  await page.fill('[data-testid=or-key]', KEY || 'sk-or-v1-mock');
  await page.click('[data-testid=or-save]');
  await page.waitForSelector('.notice--ok, .notice--bad', { timeout: 30000 });
  check(await page.isVisible('.notice--ok'), `OpenRouter key accepted: ${await page.textContent('.notice')}`);
  if (LUM) {
    await page.fill('[data-testid=lum-key]', LUM);
    await page.click('[data-testid=lum-save]');
    await page.waitForFunction(() => document.querySelectorAll('.notice').length >= 2 && !document.querySelector('.notice--busy'), null, { timeout: 30000 });
    const notes = await page.$$eval('.notice', (n) => n.map((x) => x.textContent));
    check(notes.some((t) => t.startsWith('Luminal works')), `Luminal key accepted: ${notes[notes.length - 1]}`);
  }
  await page.keyboard.press('Escape');
}
async function setLuminal() {
  if (!LUM) throw new Error('Set LUMINAL_KEY');
  await page.click('[data-testid=open-settings]');
  await page.fill('[data-testid=lum-key]', LUM);
  await page.click('[data-testid=lum-save]');
  await page.waitForSelector('.notice--ok, .notice--bad', { timeout: 30000 });
  check(await page.isVisible('.notice--ok'), `Luminal key accepted: ${await page.textContent('.notice')}`);
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
    return { title: s.scene.doc.title, method: s.scene.doc.method, lights: s.scene.lights, groups: s.zones.length, element: s.scene.hasElement, signed: s.scene.signed, daylight: s.scene.hasDaylight, markers: s.scene.doc.markers?.length ?? 0, cost: s.scene.doc.cost, images: s.scene.doc.steps.filter((x) => x.image).length, waterline: s.scene.waterline, size: [s.scene.doc.width, s.scene.doc.height] };
  });
}

async function lightChecks(tag) {
  await page.evaluate(() => {
    const L = window.__living;
    if (L.engine.mode === 'show') L.engine.stopShow();
    L.store.getState().set({ view: { ambient: 1, exposure: 1, glow: 0.5, haze: 0.3, grain: 0.5, warmth: 0, daylight: 0 }, mode: 'hand', playing: null, selection: null });
    L.store.getState().setSettings({ feel: 'filament' });
    L.store.getState().set({ motion: { ...L.store.getState().motion, playing: false } });
  });
  await page.evaluate(() => window.__living.engine.setAll(1));
  await waitEngine(1.2);
  const on = await composite();
  const onBuf = await page.evaluate(() => { window.__onBuf = window.__living.renderer.readComposite(); return true; });
  await page.screenshot({ path: `${OUT}/${tag}-on.png` });
  await page.evaluate(() => window.__living.engine.setAll(0));
  await waitEngine(1.5);
  const off = await composite();
  await page.screenshot({ path: `${OUT}/${tag}-off.png` });
  const signed = await state(() => window.__living.store.getState().scene.signed);
  const change = await page.evaluate(() => { const a = window.__onBuf, b = window.__living.renderer.readComposite(); let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4); });
  void onBuf;
  log(`${tag}: mean change between all on and all off ${change.toFixed(4)}`);
  check(signed ? change > 0.004 : on > off * 1.08 || change > 0.006, `${tag}: switching all lights changes the picture (mean linear luminance ${off.toFixed(4)} -> ${on.toFixed(4)}${signed ? ', signed light' : ''})`);
  await page.evaluate(() => window.__living.engine.setAll(1));
  await waitEngine(1);
  // the light panel: click a light, switch its group off in the panel, the picture darkens there
  const panelPick = await state(() => {
    const L = window.__living, a = L.store.getState().analysis, e = L.engine;
    const best = [...a.lights].map((l, i) => ({ l, i })).sort((p, q) => q.l.flux - p.l.flux)[0];
    const g = document.querySelector('.stage__gl').getBoundingClientRect();
    const z = L.store.getState().zones[e.zoneOf[best.i]];
    return { x: g.left + (best.l.x / a.width) * g.width, y: g.top + (best.l.y / a.height) * g.height, bbox: z.bbox.map((v, k) => v / (k % 2 ? a.height : a.width)), n: z.lights.length };
  });
  await page.mouse.click(panelPick.x, panelPick.y);
  await page.waitForSelector('[data-testid=inspector]', { timeout: 20000 });
  const groupBtn = await page.$('[data-testid=inspector] .segmented button:has-text("Its group")');
  if (groupBtn) await groupBtn.click();
  const zb = panelPick.bbox;
  const zoneOn = await regionLum(zb[0], zb[1], Math.max(zb[2], zb[0] + 0.01), Math.max(zb[3], zb[1] + 0.01));
  await page.click('[data-testid=light-switch]');
  await waitEngine(1.5);
  const zoneOff = await regionLum(zb[0], zb[1], Math.max(zb[2], zb[0] + 0.01), Math.max(zb[3], zb[1] + 0.01));
  await page.screenshot({ path: `${OUT}/${tag}-panel.png` });
  check(signed ? Math.abs(zoneOn - zoneOff) > 1e-4 : zoneOff < zoneOn * 0.97, `${tag}: the light panel switches ${groupBtn ? `a group of ${panelPick.n} lights` : 'a light'} off (${zoneOn.toFixed(4)} -> ${zoneOff.toFixed(4)} in its area)`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__living.engine.setAll(1));
  if (signed) return;
  // torch: only lights near the cursor
  await page.keyboard.press('2');
  const r = await state(() => { const g = document.querySelector('.stage__gl').getBoundingClientRect(); return { x: g.left, y: g.top, w: g.width, h: g.height }; });
  // lights above any water line (a reflection's light belongs to the lamp above it)
  const a = await state(() => { const s = window.__living.store.getState().analysis; const yw = s.waterline ?? s.height; return { w: s.width, h: s.height, lights: s.lights.filter((L) => L.y < yw - 4).map((L) => [L.x, L.y, L.flux]) }; });
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
  await page.mouse.move(r.x + (1 - tx) * r.w, r.y + (1 - ty) * r.h);
  await waitEngine(1.2);
  const nearAfter = await regionLum(Math.max(0, tx - R_SAMPLE), Math.max(0, ty - R_SAMPLE), Math.min(1, tx + R_SAMPLE), Math.min(1, ty + R_SAMPLE));
  check(near - nearAfter > Math.max(0.0015, 0.02 * nearAfter) && hovering, `${tag}: torch lights the area under the cursor (${near.toFixed(4)} vs ${nearAfter.toFixed(4)} after moving away; far region ${far.toFixed(4)}; ${pick.n} lights near the target; hover registered ${hovering})`);
  await page.keyboard.press('1');
  await page.evaluate(() => window.__living.engine.setAll(1));
}

/** Presets and music: levels must move while a show plays, and the music effect must hear the fake microphone. */
async function showChecks(tag) {
  await page.click('[data-testid=menu-presets]');
  await page.click('[data-testid=preset-dusk]');
  const lv = () => state(() => { const e = window.__living.engine; let s = 0; for (let i = 0; i < e.count; i++) s += e.level[i]; return s / e.count; });
  await waitEngine(0.6);
  const a = await lv();
  await waitEngine(5);
  const b = await lv();
  check(Math.abs(b - a) > 0.05, `${tag}: the Dusk preset changes the lights over time (${a.toFixed(2)} -> ${b.toFixed(2)})`);
  await page.click('[data-testid=stop-show]');
  // music: Microphone in the Music effect (Chromium's fake device plays a tone)
  await page.keyboard.press('9');
  await page.click('.listen button:has-text("Microphone")');
  await page.waitForFunction(() => window.__living.store.getState().music.source === 'mic', null, { timeout: 20000 });
  await waitEngine(2);
  const heard = await state(() => { const e = window.__living.engine; let s = 0; for (let i = 0; i < e.count; i++) s += e.level[i]; return { audio: e.audio ? +e.audio.level.toFixed(3) : null, mean: s / e.count }; });
  check(heard.audio != null && heard.audio > 0.01 && heard.mean > 0.01, `${tag}: music mode hears the microphone and moves the lights (audio ${heard.audio}, mean level ${heard.mean.toFixed(3)})`);
  await page.screenshot({ path: `${OUT}/${tag}-music.png` });
  await page.click('.listen button:has-text("Listening")');
  await page.keyboard.press('1');
}

async function motionCheck(tag) {
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

async function makeScene({ prompt, lighting, element, two, kind }) {
  await page.click('[data-testid=open-create]');
  if (two) await page.click('.sheet .segmented button:has-text("Picture, then lights")');
  await page.fill('[data-testid=create-prompt]', prompt);
  if (lighting) await page.fill('[data-testid=create-lighting]', lighting);
  if (element) {
    await page.click('.sheet .linkbtn:has-text("More options")');
    await page.fill('#elem', element);
  }
  if (two && kind === 'ambient') await page.click('.choice:has-text("An everyday picture")');
  log('estimate:', await page.textContent('.estimate p'));
  const before = await spent();
  await page.click('[data-testid=create-go]');
  const ok = await waitJob(8 * 60000);
  log('spent this run', ((await spent()) - before).toFixed(4));
  return ok;
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
    if (s.element) await motionCheck(id);
    for (const k of ['3', '4', '5', '6', '7', '8']) { await page.keyboard.press(k); await waitEngine(0.4); }
    await page.keyboard.press('1');
    if (!args.quick) await showChecks(id);
    args.quick = true; // presets and music once is enough
  }
} else if (FLOW === 'director') {
  await waitScene();
  await setLuminal();
  const target = args.scene || 'city';
  await page.evaluate(async (id) => { const s = window.__living.store.getState(); await window.__living.openEntryForTests(s.examples.find((e) => e.id === id) ?? s.locals.find((e) => e.title === id)); }, target);
  await waitScene();
  await page.waitForFunction(() => !!window.__living.store.getState().labels || !!window.__living.store.getState().scene?.doc.markers?.length, null, { timeout: 120000 });
  const labels = await state(() => window.__living.store.getState().zones.map((z) => `${z.n}: ${z.name}`));
  log('zones:', labels.join(' | '));
  check(labels.length > 0, `${target}: zones are named`);
  await page.click('[data-testid=open-director]');
  const ask = args.ask || 'Everything goes dark. Then the lights at the top left flicker four times together, a wave of light runs from left to right across the whole picture, and finally everything breathes slowly in warm amber.';
  await page.fill('[data-testid=director-input]', ask);
  await page.click('[data-testid=director-send]');
  await page.waitForFunction(() => { const d = window.__living.store.getState().director; return !d.busy && (d.turns.length >= 2 || d.error); }, null, { timeout: 180000 });
  const d = await state(() => window.__living.store.getState().director);
  const show = d.turns[d.turns.length - 1]?.show;
  check(!d.error && !!show && show.steps.length >= 3, `director wrote a show: ${d.error || `${show.name} (${show.steps.length} steps)`}`);
  log('show:', JSON.stringify(show));
  const lv = () => state(() => { const e = window.__living.engine; let s = 0; for (let i = 0; i < e.count; i++) s += e.level[i]; return { mean: s / e.count, t: e.showTime }; });
  const samples = [];
  for (let i = 0; i < 5; i++) { await waitEngine(1.2); samples.push(await lv()); }
  log('levels:', samples.map((x) => `${x.mean.toFixed(2)}@${x.t.toFixed(1)}s`).join(' '));
  check(samples.some((x, i) => i && Math.abs(x.mean - samples[0].mean) > 0.03), 'the show moves the lights');
  await page.screenshot({ path: `${OUT}/director.png` });
  await page.fill('[data-testid=director-input]', 'Same, but twice as fast and in cyan');
  await page.click('[data-testid=director-send]');
  await page.waitForFunction(() => { const d = window.__living.store.getState().director; return !d.busy && (d.turns.length >= 4 || d.error); }, null, { timeout: 180000 });
  const d2 = await state(() => window.__living.store.getState().director);
  const show2 = d2.turns[d2.turns.length - 1]?.show;
  check(!d2.error && !!show2 && JSON.stringify(show2).includes('#'), `follow-up refines the show: ${d2.error || show2.name}`);
  await page.click('.turn:last-child .chip:has-text("Save as preset")');
  await page.click('[data-testid=menu-presets]');
  check(await page.isVisible(`.item:has-text("${show2.name}")`), 'the refined show is saved in Presets');
  await page.keyboard.press('Escape');
} else {
  await setKey();
  if (FLOW === 'create') {
    const ok = await makeScene({ prompt: args.prompt, lighting: args.lighting, element: args.element });
    if (ok) {
      await waitScene();
      const s = await sceneSummary();
      log('scene:', JSON.stringify(s));
      check(s.lights >= 3, `create: found ${s.lights} lights`);
      if (args.element) check(s.element, 'create: the moving element is its own layer');
      await lightChecks('create');
      if (s.element) await motionCheck('create');
      if (args.bake) await bake(args.bake, { doc: { title: args.title || s.title }, demo: { order: Number(args.order || 10), startMode: 'hand' } });
    }
  }
  if (FLOW === 'base') {
    const ok = await makeScene({ prompt: args.prompt, lighting: args.lighting, two: true, kind: args.kind || 'dark' });
    check(ok, 'base: picture made');
    await page.waitForSelector('[data-testid=studio-picture] img', { timeout: 60000 });
    await page.waitForTimeout(1500);
    const img = await page.$('[data-testid=studio-picture] img');
    await img.screenshot({ path: `${OUT}/base.png` });
    log('draft saved; picture at', `${OUT}/base.png`);
  }
  if (FLOW === 'lightup') {
    // open the newest draft
    await page.evaluate(async () => {
      const s = window.__living.store.getState();
      const d = s.locals.find((e) => e.doc.draft);
      if (!d) throw new Error('No draft in this profile');
      await window.__living.openEntryForTests(d);
    });
    await page.waitForSelector('[data-testid=studio-picture] img');
    await page.waitForTimeout(800);
    const box = await (await page.$('[data-testid=studio-picture] img')).boundingBox();
    const markers = String(args.markers).split(';').map((m) => { const [x, y, note, color] = m.split(','); return { x: +x, y: +y, note, color }; });
    for (const [i, m] of markers.entries()) {
      await page.mouse.click(box.x + m.x * box.width, box.y + m.y * box.height);
      await page.fill(`[data-testid=pin-note-${i + 1}]`, m.note || '');
      if (m.color) await page.click(`.pinlist li:nth-child(${i + 1}) .swatch[title="${m.color}"]`);
    }
    if (args.lighting) await page.fill('#st-light', args.lighting);
    await page.screenshot({ path: `${OUT}/studio.png` });
    const before = await spent();
    await page.click('[data-testid=studio-go]');
    const ok = await waitJob(8 * 60000);
    log('spent this run', ((await spent()) - before).toFixed(4));
    if (ok) {
      await waitScene();
      const s = await sceneSummary();
      log('scene:', JSON.stringify(s));
      const planned = await state(() => window.__living.store.getState().scene.doc.markers.map((m) => `${m.n}: ${m.object ?? m.note}${m.box ? ' [box]' : ''}`));
      log('planned:', planned.join(' | '));
      const zones = await state(() => window.__living.store.getState().zones.map((z) => `${z.name} (${z.lights.length})`));
      log('groups:', zones.join(' | '));
      check(s.markers === markers.length, `lightup: ${s.markers} placed lights kept`);
      check(s.lights >= 1, `lightup: found ${s.lights} lights in them`);
      await lightChecks('lightup');
      if (args.bake) await bake(args.bake, { doc: { title: args.title || s.title }, demo: { order: Number(args.order || 10), startMode: 'hand' } });
    }
  }
  if (FLOW === 'photo') {
    // start from a photo: --file path [--changes "..."] [--no-recreate] --then describe|place|picture [--kind lit|dark|ambient] [--lighting "..."]
    await page.click('[data-testid=open-create]');
    await page.click('.sheet .segmented button:has-text("From a photo")');
    await page.setInputFiles('[data-testid=photo-input]', path.resolve(args.file));
    if (args['no-recreate']) await page.click('.sheet .toggle:has-text("Recreate it")');
    else if (args.changes) await page.fill('[data-testid=photo-changes]', args.changes);
    const then = args.then || 'describe';
    await page.click(`.sheet .segmented[aria-label="What to make"] button:has-text("${then === 'describe' ? 'Describe' : then === 'place' ? 'Place' : 'Just the picture'}")`);
    if (then === 'describe' && args.lighting) await page.fill('[data-testid=create-lighting]', args.lighting);
    if (args.kind) await page.click(`.choice:has-text("${args.kind === 'lit' ? 'Its lights are on' : args.kind === 'ambient' ? 'An everyday picture' : 'Its lights are off'}")`);
    if (args.title) { await page.click('.sheet .linkbtn:has-text("More options")'); await page.fill('#title', args.title); }
    log('estimate:', await page.textContent('.estimate p'));
    const before = await spent();
    await page.click('[data-testid=create-go]');
    const ok = await waitJob(8 * 60000);
    log('spent this run', ((await spent()) - before).toFixed(4));
    check(ok, 'photo: job finished');
    if (ok && then === 'describe') {
      await waitScene();
      const s = await sceneSummary();
      log('scene:', JSON.stringify(s));
      check(s.lights >= 3, `photo: found ${s.lights} lights`);
      await lightChecks('photo');
      if (args.bake) await bake(args.bake, { doc: { title: args.title || s.title }, demo: { order: Number(args.order || 10), startMode: 'hand' } });
    } else if (ok && then === 'place') {
      await page.waitForSelector('[data-testid=studio-picture] img', { timeout: 60000 });
      await page.waitForTimeout(1500);
      await (await page.$('[data-testid=studio-picture] img')).screenshot({ path: `${OUT}/base.png` });
      log('draft ready for lights; picture at', `${OUT}/base.png`);
    }
  }
  if (FLOW === 'bakelocal') {
    // export one of your scenes in this --profile as an example
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = s.locals.find((x) => x.title === t && !x.doc.draft);
      if (!e) throw new Error(`No scene titled ${t}`);
      await window.__living.openEntryForTests(e);
    }, args.scene);
    await waitScene();
    if (args.labels && LUM) await page.waitForFunction(() => !!window.__living.store.getState().labels, null, { timeout: 120000 }).catch(() => log('no labels'));
    const s = await sceneSummary();
    log('scene:', JSON.stringify(s));
    await bake(args.bake, { doc: { title: args.title || s.title }, demo: { order: Number(args.order || 10), startMode: args.start || 'hand' } });
  }
  if (FLOW === 'depth') {
    // the 3D view: measure depth (in the browser), check parallax and that lights still switch in 3D
    await waitScene();
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = s.examples.find((x) => x.id === t) ?? s.locals.find((x) => x.title === t && !x.doc.draft);
      if (!e) throw new Error(`No scene ${t}`);
      await window.__living.openEntryForTests(e);
    }, args.scene);
    await waitScene();
    const t0 = Date.now();
    if (args.remeasure || !(await state(() => window.__living.store.getState().three.available))) {
      await page.evaluate(() => { window.__d3 = false; window.__living.make3DForTests().then(() => { window.__d3 = true; }); });
      let last = '';
      while (!(await state(() => window.__d3))) {
        const b = await state(() => window.__living.store.getState().three.busy);
        if (b !== last) { log('  ', b); last = b; }
        await page.waitForTimeout(3000);
      }
    }
    log(`depth ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await page.evaluate(() => { const s = window.__living.store.getState(); s.set({ three: { ...s.three, on: true, motion: 'drag' } }); window.__living.engine.setAll(1); });
    const viewLum = () => page.evaluate(() => { const c = window.__living.renderer.readComposite('view'); let s = 0; for (let i = 0; i < c.length; i += 4) s += 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2]; return s / (c.length / 4); });
    const viewBuf = () => page.evaluate(() => { window.__v = window.__living.renderer.readComposite('view'); return true; });
    const viewDiff = () => page.evaluate(() => { const a = window.__v, b = window.__living.renderer.readComposite('view'); let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4); });
    const pose = (yaw, pitch) => page.evaluate(([y, p]) => { const v = window.__living.view3d; v.goal = { ...v.goal, yaw: y, pitch: p, dolly: 0 }; v.cam = { ...v.goal }; v.update(); }, [yaw, pitch]);
    await pose(0, 0);
    await waitEngine(1.5);
    await viewBuf();
    await pose(0.12, 0.05);
    await waitEngine(1.5);
    const moved = await viewDiff();
    await page.screenshot({ path: `${OUT}/depth-moved.png`, timeout: 300000 });
    check(moved > 0.01, `3D: moving the camera changes the view (mean change ${moved.toFixed(4)})`);
    // parallax, not a flat shift: a near and a far point move by different amounts
    const par = await page.evaluate(() => {
      const v = window.__living.view3d, d = v.depth;
      let near = [0, 0, -1], far = [0, 0, 2];
      for (let y = 0.1; y < 0.9; y += 0.05) for (let x = 0.1; x < 0.9; x += 0.05) {
        const z = v.depthAt(x * v.w, y * v.h);
        if (z > near[2]) near = [x * v.w, y * v.h, z];
        if (z < far[2]) far = [x * v.w, y * v.h, z];
      }
      const pn = v.project(near[0], near[1]), pf = v.project(far[0], far[1]);
      void d;
      return { near: Math.hypot(pn[0] - near[0], pn[1] - near[1]), far: Math.hypot(pf[0] - far[0], pf[1] - far[1]) };
    });
    check(Math.abs(par.near - par.far) > 3, `3D: near and far things move by different amounts (${par.near.toFixed(1)} px vs ${par.far.toFixed(1)} px)`);
    const on = await viewLum();
    await page.evaluate(() => window.__living.engine.setAll(0));
    await waitEngine(1.5);
    const off = await viewLum();
    await page.screenshot({ path: `${OUT}/depth-off.png`, timeout: 300000 });
    check(on > off * 1.03 || Math.abs(on - off) > 0.004, `3D: switching the lights changes the 3D view (${off.toFixed(4)} -> ${on.toFixed(4)})`);
    await page.evaluate(() => window.__living.engine.setAll(1));
    await pose(0, 0);
    if (args.bake) {
      const meta = await state(() => window.__living.store.getState().scene.doc);
      await bake(args.bake, { doc: { title: args.title || meta.title }, demo: { ...(meta.demo ?? {}), order: Number(args.order || meta.demo?.order || 10), start3d: true } });
    }
  }
  if (FLOW === 'spaceview') {
    // look at an already-made 3D space (e.g. a baked example) from several angles; no spend
    await waitScene();
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = s.examples.find((x) => x.id === t) ?? s.locals.find((x) => x.title === t && !x.doc.draft);
      await window.__living.openEntryForTests(e);
    }, args.scene);
    await waitScene();
    for (let i = 0; i < 200 && !(await state(() => window.__living.store.getState().space.available)); i++) await page.waitForTimeout(3000);
    await page.evaluate(() => { const s = window.__living.store.getState(); s.set({ space: { ...s.space, on: true } }); window.__living.engine.setAll(1); });
    for (const y of String(args.yaws || '0,40,90,180').split(',').map(Number)) {
      await page.evaluate((v) => { const c = window.__living.envCam; c.goal.yaw = v; c.yaw = v; }, y);
      await waitEngine(1.5);
      await page.screenshot({ path: `${OUT}/view-${args.scene}-${y}.png`, timeout: 300000 });
      log(`shot ${args.scene} at ${y}°`);
    }
  }
  if (FLOW === 'space') {
    // the 3D space: views from around the scene (6 images), their depth, then walk round it
    await waitScene();
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = s.examples.find((x) => x.id === t) ?? s.locals.find((x) => x.title === t && !x.doc.draft);
      await window.__living.openEntryForTests(e);
    }, args.scene);
    await waitScene();
    const before = await spent();
    const t0 = Date.now();
    await page.evaluate((m) => { window.__sp = false; window.__living.makeSpaceForTests(m).then(() => { window.__sp = true; }); }, args.mode || 'around');
    let last = '';
    while (!(await state(() => window.__sp))) {
      const b = await state(() => { const s = window.__living.store.getState(); return s.job ? s.job.steps.map((x) => `${x.label}:${x.status}`).join(' | ') + (s.job.error ? ` ERROR ${s.job.error}` : '') : s.space.busy; });
      if (b !== last) { log('  ', b); last = b; }
      await page.waitForTimeout(3000);
    }
    log(`space made in ${((Date.now() - t0) / 1000).toFixed(0)} s, spent ${((await spent()) - before).toFixed(4)}`);
    const sp = await state(() => ({ ...window.__living.store.getState().space, n: window.__living.env?.count }));
    check(sp.available && sp.on, `space: built (${sp.n} splats)`);
    await page.evaluate(() => { const s = window.__living.store.getState(); s.set({ space: { ...s.space, on: true } }); window.__living.engine.setAll(1); });
    const shot = async (yaw, name) => {
      await page.evaluate((y) => { const c = window.__living.envCam; c.goal.yaw = y; c.yaw = y; }, yaw);
      await waitEngine(1.5);
      await page.screenshot({ path: `${OUT}/space-${args.mode === 'panorama' ? 'pano-' : ''}${name}.png`, timeout: 300000 });
      return page.evaluate(() => { const c = window.__living.renderer.readComposite('view'); let s = 0; for (let i = 0; i < c.length; i += 4) s += c[i] + c[i + 1] + c[i + 2]; return s / c.length; });
    };
    const a0 = await shot(0, 'front');
    await shot(40, 'right40');
    const a90 = await shot(90, 'right');
    await shot(180, 'back');
    await shot(270, 'left');
    check(Math.abs(a0 - a90) > 0.001, `space: walking round changes the view (${a0.toFixed(4)} vs ${a90.toFixed(4)})`);
    await shot(0, 'front-again');
    if (args.bake) {
      const meta = await state(() => window.__living.store.getState().scene.doc);
      await bake(args.bake, { doc: { title: args.title || meta.title.replace(/, in 3D$/, '') }, demo: { ...(meta.demo ?? {}), order: Number(args.order || 1), start3d: true } });
    }
  }
  if (FLOW === 'refine') {
    await waitScene();
    const target = args.scene || 'Rain Alley';
    await page.evaluate(async (t) => {
      const s = window.__living.store.getState();
      const e = [...s.locals, ...s.examples].find((x) => x.title === t && (x.method === 'split' || x.method === 'perLight'));
      if (!e) throw new Error(`No split scene titled ${t}`);
      await window.__living.openEntryForTests(e);
    }, target);
    await waitScene();
    await page.click('[data-testid=menu-scene]');
    await page.click('.item:has-text("Repaint chosen lights")');
    await page.click(`.chip:has-text("Brightest ${args.count || 3}")`);
    const before = await spent();
    await page.click('.sheet__foot button.btn--primary');
    const ok = await waitJob(8 * 60000);
    await waitScene();
    const r = await sceneSummary();
    log('refined:', JSON.stringify(r), 'spent', ((await spent()) - before).toFixed(4));
    check(ok && r.method === 'perLight', 'refine: repainted lights applied');
  }
}

log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s, spent in this browser session: ${(await spent()).toFixed(4)} USD, failures: ${failures}`);
await context.close();
process.exit(failures ? 1 : 0);

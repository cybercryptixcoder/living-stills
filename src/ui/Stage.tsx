import { useEffect, useRef, useState } from 'react';
import { live, selectedIndices } from '../live';
import { audio } from '../play/audio';
import { makeRoute } from '../play/engine';
import { Renderer, type View3DParams } from '../render/Renderer';
import { Engine } from '../play/engine';
import { worldOf } from '../splat/env';
import { useStore } from '../state';
import { switchSound, tickSound } from './sound';

const S = () => useStore.getState();

/** Screen position of the pointer over the print (0..1), for the 3D camera; and drag state. */
const raw = { x: 0.5, y: 0.5, inside: false, drag: null as null | { x: number; y: number; yaw: number; pitch: number; moved: boolean } };
const SPEC = { pos: new Float32Array(32), col: new Float32Array(24) };

/** Phones: tilt the phone to look around (follow mode). iOS asks for permission on a tap. */
let tilt: { base: [number, number] | null; on: boolean } = { base: null, on: false };
export async function enableTilt() {
  if (tilt.on || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
  const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  try { if (D.requestPermission && (await D.requestPermission()) !== 'granted') return; } catch { return; }
  tilt = { base: null, on: true };
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    if (!tilt.base) tilt.base = [e.beta, e.gamma];
    const dx = Math.max(-1, Math.min(1, (e.gamma - tilt.base[1]) / 25));
    const dy = Math.max(-1, Math.min(1, (e.beta - tilt.base[0]) / 25));
    raw.x = 0.5 + 0.5 * dx; raw.y = 0.5 + 0.5 * dy; raw.inside = true;
  });
}
const SPRITES = new Float32Array(64 * 7);
const isSpace = () => S().space.on && !!live.renderer?.hasEnv && !!live.env;
const is3d = () => isSpace() || (S().three.on && !!live.renderer?.hasSplats);
/** dragging the 3D space round */
const orbitDrag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, moved: false };
/** where each light lands on the picture in the 3D space this frame (image px), for picking */
let envLightPx: Float32Array = new Float32Array(0);

/** A picture pixel (of the original view) projected into the 3D space's camera, in image px. */
function envProject(x: number, y: number): [number, number] {
  const v = live.view3d, g = live.env!;
  const p = live.envCam.project(worldOf(v, x, y, g.radius), v.focal, v.w, v.h, 1);
  return [p[0], p[1]];
}

/** The 3D space: camera, how much each view counts from here, lights placed in the world. */
function envParams(dt: number): View3DParams {
  const st = S(), v = live.view3d, e = live.engine, g = live.env!, cam = live.envCam;
  if (st.space.turn && !orbitDrag.on) cam.goal.yaw += dt * 8;
  cam.step(dt);
  cam.update(g.radius, g.depthScale);
  const weights = new Float32Array(8);
  g.angles.forEach((a, k) => {
    let d = Math.abs(((cam.yaw - a) % 360 + 540) % 360 - 180);
    d = (d * Math.PI) / 180;
    weights[k] = Math.pow(Math.max(0, Math.cos(d)), 2) * (k === 0 ? 1.5 : 1);
  });
  const T = e.lightTable();
  const order = e.lights.map((L, i) => ({ L, i, s: L.flux * Math.max(0, e.level[i]) })).filter((o) => o.s > 0.001).sort((a, b) => b.s - a.s);
  const maxFlux = order[0]?.s || 1;
  const nSpec = Math.min(8, order.length);
  for (let k = 0; k < nSpec; k++) {
    const { L, s } = order[k];
    const p = worldOf(v, L.x, L.y, g.radius);
    SPEC.pos.set([p[0], p[1], p[2], 0.28 * g.depthScale], k * 4);
    const c = [T[L.id * 4], T[L.id * 4 + 1], T[L.id * 4 + 2]], m = Math.sqrt(s / maxFlux) * 1.6;
    SPEC.col.set([L.color[0] * c[0] * m, L.color[1] * c[1] * m, L.color[2] * c[2] * m], k * 3);
  }
  const nSprites = Math.min(64, order.length);
  for (let k = 0; k < nSprites; k++) {
    const { L, s } = order[k];
    const p = worldOf(v, L.x, L.y, g.radius);
    const px = Math.min(110, Math.max(12, Math.sqrt(L.area) * 2.6 + 16)) * (v.w / 1360);
    const size = (px * (p[2] + g.radius)) / v.focal; // world size from its size in the picture (view 0 depth)
    const c = [T[L.id * 4], T[L.id * 4 + 1], T[L.id * 4 + 2]], m = 0.35 + 0.65 * Math.sqrt(s / maxFlux);
    SPRITES.set([p[0], p[1], p[2], size, L.color[0] * c[0] * m, L.color[1] * c[1] * m, L.color[2] * c[2] * m], k * 7);
  }
  if (envLightPx.length !== e.lights.length * 2) envLightPx = new Float32Array(e.lights.length * 2);
  e.lights.forEach((L, i) => { const q = envProject(L.x, L.y); envLightPx[i * 2] = q[0]; envLightPx[i * 2 + 1] = q[1]; });
  return {
    view: cam.view, focal: v.focal, zoom: 1, zRange: v.zRange, eye: cam.eye, size: 1,
    spec: st.three.spec, glow3d: st.three.glow3d,
    lights: { pos: SPEC.pos, col: SPEC.col, count: nSpec },
    sprites: { data: SPRITES, count: nSprites },
    env: { weights, lit: e.litness },
  };
}

/** Camera goal for this frame, the brightest lights for highlights and glow sprites. */
function view3dParams(dt: number, t: number): View3DParams {
  const st = S(), three = st.three, v = live.view3d, e = live.engine;
  const A = 0.11 * three.amount;
  if (three.motion === 'follow') {
    const k = raw.inside ? 1 : 0;
    v.goal.yaw = -(raw.x - 0.5) * 2 * A * k;
    v.goal.pitch = (raw.y - 0.5) * 2 * A * 0.55 * k;
    v.goal.dolly = raw.inside ? 0.04 * three.amount : 0;
  } else if (three.motion === 'sway') {
    v.goal.yaw = Math.sin(t * 0.35) * A * 0.8;
    v.goal.pitch = Math.sin(t * 0.23 + 1.3) * A * 0.35;
    v.goal.dolly = (0.5 + 0.5 * Math.sin(t * 0.17)) * 0.06 * three.amount;
  }
  v.goal.strength = three.strength;
  v.step(dt);
  // lights: by how much light they are giving right now
  const T = e.lightTable();
  const order = e.lights.map((L, i) => ({ L, i, s: L.flux * Math.max(0, e.level[i]) })).filter((o) => o.s > 0.001).sort((a, b) => b.s - a.s);
  const nSpec = Math.min(8, order.length);
  const reach = 0.28 * v.pivot;
  const maxFlux = order[0]?.s || 1;
  for (let k = 0; k < nSpec; k++) {
    const { L, s } = order[k];
    const p = v.lift(L.x, L.y, v.depthAt(L.x, L.y));
    SPEC.pos.set([p[0], p[1], p[2] * 0.97, reach], k * 4);
    const g = [T[L.id * 4], T[L.id * 4 + 1], T[L.id * 4 + 2]];
    const m = Math.sqrt(s / maxFlux) * 1.6;
    SPEC.col.set([L.color[0] * g[0] * m, L.color[1] * g[1] * m, L.color[2] * g[2] * m], k * 3);
  }
  const nSprites = Math.min(64, order.length);
  const scale = v.w / 1360;
  for (let k = 0; k < nSprites; k++) {
    const { L, s } = order[k];
    const g = [T[L.id * 4], T[L.id * 4 + 1], T[L.id * 4 + 2]];
    const size = Math.min(110, Math.max(12, Math.sqrt(L.area) * 2.6 + 16)) * scale;
    const m = 0.35 + 0.65 * Math.sqrt(s / maxFlux);
    SPRITES.set([L.x, L.y, v.depthAt(L.x, L.y), size, L.color[0] * g[0] * m, L.color[1] * g[1] * m, L.color[2] * g[2] * m], k * 7);
  }
  return {
    view: v.view, focal: v.focal, zoom: v.zoom, zRange: v.zRange, eye: v.eye, size: 1,
    spec: three.spec, glow3d: three.glow3d,
    lights: { pos: SPEC.pos, col: SPEC.col, count: nSpec },
    sprites: { data: SPRITES, count: nSprites },
  };
}
void Engine;
export const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export interface ImageRect { x: number; y: number; w: number; h: number }
/** Where the print sits in VIEWPORT coordinates (the light card is anchored to it). */
export const stageRect: ImageRect = { x: 0, y: 0, w: 1, h: 1 };
/** The same rectangle in the stage element's own coordinates. */
const local: ImageRect & { left: number; top: number } = { x: 0, y: 0, w: 1, h: 1, left: 0, top: 0 };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** The heat field: one splat per lit light, normalised and tinted with the one accent. */
const HEAT_W = 180;

export function Stage() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const status = useStore((s) => s.status);
  const statusText = useStore((s) => s.statusText);
  const hasScene = useStore((s) => !!s.scene);
  const mode = useStore((s) => s.mode);
  const picking = useStore((s) => s.picking);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; sub: string } | null>(null);
  const drawing = useRef<[number, number][] | null>(null);
  const press = useRef<{ t: number; x: number; y: number; timer: number } | null>(null);
  const boxSel = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const ripplesUi = useRef<{ x: number; y: number; t0: number }[]>([]);
  const heatRef = useRef<{ c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; field: Float32Array; img: ImageData; w: number; h: number } | null>(null);

  // renderer + loop
  useEffect(() => {
    let r: Renderer;
    try {
      r = new Renderer(canvas.current!);
    } catch (err) {
      setGlError((err as Error).message);
      return;
    }
    live.renderer = r;
    let raf = 0;
    let last = performance.now();
    let frame = 0;
    const root = document.documentElement;
    const octx = overlay.current!.getContext('2d')!;

    let placed = '';
    const layout = () => {
      const el = wrap.current!;
      const cw = el.clientWidth, ch = el.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const ov = overlay.current!;
      if (ov.width !== Math.round(cw * dpr) || ov.height !== Math.round(ch * dpr)) {
        ov.width = Math.round(cw * dpr);
        ov.height = Math.round(ch * dpr);
      }
      const st = S();
      const a = st.analysis;
      const aspect = a ? a.width / a.height : 16 / 9;
      // the print is fitted into the card; the paper-coloured mat behind it is CSS
      let w = cw, h = cw / aspect;
      if (h > ch) { h = ch; w = ch * aspect; }
      const rect = { x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w: Math.round(w), h: Math.round(h) };
      // the GL canvas covers exactly the print, so the mat colour comes from CSS and follows the theme
      const gl = canvas.current!;
      const key = `${rect.x}|${rect.y}|${rect.w}|${rect.h}|${dpr}`;
      if (key !== placed) {
        placed = key;
        gl.style.left = `${rect.x}px`;
        gl.style.top = `${rect.y}px`;
        gl.style.width = `${rect.w}px`;
        gl.style.height = `${rect.h}px`;
        r.resize(rect.w, rect.h, dpr);
        r.rect = { x: 0, y: 0, w: rect.w, h: rect.h };
      }
      const box = el.getBoundingClientRect();
      Object.assign(local, rect, { left: box.left, top: box.top });
      Object.assign(stageRect, { x: box.left + rect.x, y: box.top + rect.y, w, h });
      return { dpr, rect };
    };

    const drawHeat = (a: NonNullable<ReturnType<typeof S>['analysis']>) => {
      const w = HEAT_W, h = Math.max(1, Math.round((HEAT_W * a.height) / a.width));
      let hs = heatRef.current;
      if (!hs || hs.w !== w || hs.h !== h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const hctx = c.getContext('2d')!;
        hs = { c, ctx: hctx, field: new Float32Array(w * h), img: hctx.createImageData(w, h), w, h };
        heatRef.current = hs;
      }
      const e = live.engine;
      const f = hs.field;
      f.fill(0);
      const px = a.width / w, py = a.height / h;
      let max = 0;
      const splat = (cx: number, cy: number, rCells: number, wgt: number) => {
        const x0 = Math.max(0, Math.floor(cx - rCells)), x1 = Math.min(w - 1, Math.ceil(cx + rCells));
        const y0 = Math.max(0, Math.floor(cy - rCells)), y1 = Math.min(h - 1, Math.ceil(cy + rCells));
        const inv = 1 / (rCells * rCells);
        for (let y = y0; y <= y1; y++) {
          const dy = y - cy;
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx;
            const d2 = (dx * dx + dy * dy) * inv;
            if (d2 >= 1) continue;
            const k = 1 - d2;
            f[y * w + x] += wgt * k * k;
          }
        }
      };
      const count = Math.min(e.lights.length, e.level.length);
      for (let i = 0; i < count; i++) {
        // every lamp keeps a faint ember so the survey always reads as a plan of the rig,
        // and brightens to full heat as it is switched up
        const lv = Math.max(e.level[i], 0.26);
        const L = e.lights[i];
        const cx = e.posX[i] / px, cy = e.posY[i] / py;
        const size = Math.sqrt(Math.max(1, L.area)) / px;
        const rCells = clamp(size * 1.25 + 1.6, 2, 26);
        splat(cx, cy, rCells, lv * (0.55 + 0.45 * Math.min(1, L.flux / 40 + size / 40)));
      }
      if (e.hasElement) {
        const i = e.count - 1;
        splat(e.posX[i] / px, e.posY[i] / py, 12, Math.max(e.level[i], 0.3) * 0.9);
      }
      for (let i = 0; i < f.length; i++) if (f[i] > max) max = f[i];
      const d = hs.img.data;
      // fixed reference, not per-frame max: an unlit scene must stay dim, not normalise to full heat
      const inv = 1 / Math.max(max, 0.85);
      // one accent: ember at the edge of the field, hot cream at the core
      const loCol = [240, 105, 42], hiCol = [255, 226, 176];
      for (let i = 0; i < f.length; i++) {
        const t = Math.pow(Math.min(1, f[i] * inv), 0.62);
        const j = i * 4;
        d[j] = loCol[0] + (hiCol[0] - loCol[0]) * t;
        d[j + 1] = loCol[1] + (hiCol[1] - loCol[1]) * t;
        d[j + 2] = loCol[2] + (hiCol[2] - loCol[2]) * t;
        d[j + 3] = t < 0.01 ? 0 : Math.round(255 * (0.1 + 0.72 * t));
      }
      hs.ctx.putImageData(hs.img, 0, 0);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(live.engine.maxDt, (now - last) / 1000);
      last = now;
      frame++;
      const st = S();
      const { dpr, rect } = layout();
      const a = st.analysis;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, overlay.current!.width, overlay.current!.height);
      if (!a || !r.loaded) return;
      const e = live.engine;
      if (e.mode !== 'show' || st.mode !== 'hand') e.mode = st.mode;
      e.params = st.params;
      e.master = st.master;
      e.warmth = st.view.warmth;
      e.feel = st.feel;
      audio.sensitivity = st.music.sensitivity;
      e.audio = audio.active ? audio.update(dt) : null;

      // motion
      let layerA = 0, layerB = 0, mix = 0, spriteDx = 0;
      const doc = st.scene?.doc;
      if (a.sprite && doc?.motion) {
        const m = doc.motion;
        const [rx, , rw] = a.sprite.rect;
        if (st.motion.playing) live.motionDx += m.dir * m.speed * st.motion.speed * dt;
        const lo = -(rx + rw) - 0.04 * a.width, hi = a.width - rx + 0.04 * a.width;
        if (live.motionDx > hi) live.motionDx = lo;
        if (live.motionDx < lo) live.motionDx = hi;
        spriteDx = live.motionDx;
        e.setElementPos(rx + rw / 2 + spriteDx, a.sprite.rect[1] + a.sprite.rect[3] / 2);
      }
      if (a.editedLayer != null) {
        layerA = st.variant === 'edits' ? a.editedLayer : 0;
      }
      e.step(dt);
      r.setTable(e.lightTable());
      const el = e.elementOutput();
      const v = st.view;
      const view3d = isSpace() ? envParams(dt) : is3d() ? view3dParams(dt, now / 1000) : undefined;
      r.draw({
        layerA, layerB, mix, ambient: v.ambient, daylight: v.daylight, exposure: v.exposure, glow: v.glow, haze: v.haze, grain: v.grain,
        spriteDx, spriteT: el.t, spriteGain: el.gain, radius: 0,
        backdrop: 0, view3d,
      }, now / 1000);

      // UI is lit by the scene
      if (frame % 3 === 0) {
        root.style.setProperty('--lit', e.litness.toFixed(3));
        const c = e.litColor;
        const m = Math.max(...c);
        const to = (x: number) => Math.round(255 * Math.pow(Math.max(0.25, x / m), 1 / 2.2));
        root.style.setProperty('--lit-rgb', `${to(c[0])} ${to(c[1])} ${to(c[2])}`);
        document.querySelectorAll<HTMLElement>('[data-lit-text]').forEach((n) => {
          n.textContent = `${Math.round(e.litness * 100)}%`;
        });
        const vu = document.querySelector<HTMLElement>('[data-vu]');
        if (vu) vu.style.width = `${Math.round((e.audio?.level ?? 0) * 100)}%`;
        const stt = document.querySelector<HTMLElement>('[data-show-time]');
        if (stt && e.show) stt.textContent = `${e.showTime.toFixed(0)} / ${e.show.compiled.length.toFixed(0)} s`;
      }

      // overlay
      const sx = rect.w / a.width;
      const flat = !view3d;
      const space = !!view3d?.env;
      const toScreen = (x: number, y: number): [number, number] => {
        if (flat) return [rect.x + x * sx, rect.y + y * sx];
        if (space) { const [px, py] = envProject(x, y); return [rect.x + px * sx, rect.y + py * sx]; }
        const [px, py] = live.view3d.project(x, y);
        return [rect.x + px * sx, rect.y + py * sx];
      };
      const ring = (x: number, y: number, rad: number, color: string, width = 1, dash?: number[]) => {
        const [X, Y] = toScreen(x, y);
        octx.beginPath();
        octx.setLineDash(dash ?? []);
        octx.strokeStyle = color;
        octx.lineWidth = width;
        octx.arc(X, Y, rad, 0, Math.PI * 2);
        octx.stroke();
      };
      const lightRadius = (i: number) => {
        const L = e.lights[i];
        return Math.max(5, Math.min(22, Math.sqrt(L.area) * sx * 0.9 + 4));
      };
      const dot = (x: number, y: number, rad: number, color: string) => {
        const [X, Y] = toScreen(x, y);
        octx.beginPath();
        octx.fillStyle = color;
        octx.arc(X, Y, rad, 0, Math.PI * 2);
        octx.fill();
      };

      // the heat map: where the light actually falls, not just where the bulbs are
      if (st.survey === 'heat') {
        if (frame % 4 === 0) drawHeat(a);
        const hs = heatRef.current;
        if (hs) {
          octx.save();
          octx.globalCompositeOperation = 'screen';
          octx.imageSmoothingEnabled = true;
          octx.imageSmoothingQuality = 'high';
          octx.globalAlpha = 0.85;
          octx.drawImage(hs.c, rect.x, rect.y, rect.w, rect.h);
          octx.restore();
        }
      }
      if (st.survey === 'dots' || st.picking) {
        for (let i = 0; i < e.lights.length; i++) {
          const lv = e.level[i];
          const picked = st.picked.includes(e.lights[i].id);
          if (picked) {
            ring(e.posX[i], e.posY[i], lightRadius(i) + 2, 'rgba(240,105,42,0.95)', 1.6);
            dot(e.posX[i], e.posY[i], 3, 'rgba(255,190,140,1)');
          } else dot(e.posX[i], e.posY[i], 2.2, `rgba(${lv > 0.5 ? '255,196,130' : '245,240,230'},${0.3 + 0.45 * lv})`);
        }
      }
      if (st.previewWaterline != null) {
        const [, Y] = toScreen(0, st.previewWaterline);
        octx.setLineDash([6, 6]);
        octx.strokeStyle = 'rgba(255,226,176,0.85)';
        octx.lineWidth = 1.2;
        octx.beginPath();
        octx.moveTo(rect.x, Y);
        octx.lineTo(rect.x + rect.w, Y);
        octx.stroke();
        octx.setLineDash([]);
        octx.fillStyle = 'rgba(255,236,206,0.9)';
        octx.font = '12px "Space Mono", monospace';
        octx.fillText('Reflections below this line', rect.x + 12, Y - 8);
      }
      // what the light panel controls: a marching outline round each light
      if (st.selection) {
        const ix = selectedIndices();
        const march = -(performance.now() / 60) % 8;
        octx.lineDashOffset = march;
        for (const i of ix) {
          if (i >= e.lights.length) { ring(e.posX[i], e.posY[i], 24, 'rgba(255,255,255,0.95)', 1.6, [4, 4]); continue; }
          ring(e.posX[i], e.posY[i], lightRadius(i) + 4, 'rgba(20,16,12,0.55)', 3.2);
          ring(e.posX[i], e.posY[i], lightRadius(i) + 4, 'rgba(255,248,236,0.98)', 1.5, [4, 4]);
        }
        octx.lineDashOffset = 0;
      }
      if (st.hovered != null && (st.mode === 'hand' || st.mode === 'show' || st.picking)) {
        const i = st.hovered;
        if (i < e.lights.length) {
          // the whole group it belongs to, faintly, so you can see what "its group" would be
          const z = st.zones[e.zoneOf[i]];
          if (z && z.lights.length > 1 && !st.picking) for (const j of z.lights) if (j !== i) dot(e.posX[j], e.posY[j], 2.4, 'rgba(255,240,220,0.75)');
          ring(e.posX[i], e.posY[i], lightRadius(i) + 3, 'rgba(255,214,140,0.95)', 1.6);
        } else if (e.hasElement) ring(e.posX[i], e.posY[i], 26, 'rgba(255,226,176,0.9)', 1.4);
      }
      const box = boxSel.current;
      if (box) {
        const [X0, Y0] = toScreen(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
        const [X1, Y1] = toScreen(Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
        octx.setLineDash([5, 4]);
        octx.strokeStyle = 'rgba(255,248,236,0.95)';
        octx.lineWidth = 1.4;
        octx.fillStyle = 'rgba(240,105,42,0.12)';
        octx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
        octx.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
        octx.setLineDash([]);
      }
      const p = e.pointer;
      if (p.inside && !st.picking && (st.mode === 'torch' || st.mode === 'paint' || st.mode === 'trail')) {
        const R = st.params.radius * a.width * sx;
        ring(p.x, p.y, R, 'rgba(255,236,206,0.45)', 1);
        ring(p.x, p.y, R * (1 - st.params.softness * 0.9), 'rgba(255,236,206,0.18)', 1, [2, 4]);
      }
      const routePts = drawing.current ?? e.route?.pts;
      if (st.mode === 'route' && routePts && routePts.length > 1) {
        octx.beginPath();
        octx.setLineDash([2, 7]);
        octx.lineCap = 'round';
        octx.strokeStyle = drawing.current ? 'rgba(255,214,140,0.95)' : 'rgba(255,236,206,0.55)';
        octx.lineWidth = 2;
        routePts.forEach(([x, y], k) => { const [X, Y] = toScreen(x, y); if (k) octx.lineTo(X, Y); else octx.moveTo(X, Y); });
        octx.stroke();
        octx.setLineDash([]);
        const rp = !drawing.current && e.routePoint();
        if (rp) {
          const [X, Y] = toScreen(rp[0], rp[1]);
          const g = octx.createRadialGradient(X, Y, 0, X, Y, 14);
          g.addColorStop(0, 'rgba(255,236,200,0.95)');
          g.addColorStop(0.35, 'rgba(240,140,70,0.55)');
          g.addColorStop(1, 'rgba(240,140,70,0)');
          octx.fillStyle = g;
          octx.beginPath();
          octx.arc(X, Y, 14, 0, Math.PI * 2);
          octx.fill();
        }
      }
      const tnow = performance.now() / 1000;
      ripplesUi.current = ripplesUi.current.filter((q) => tnow - q.t0 < 1.4);
      for (const q of ripplesUi.current) {
        const k = (tnow - q.t0) / 1.4;
        ring(q.x, q.y, 6 + k * 90, `rgba(255,214,140,${0.5 * (1 - k)})`, 1.2);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      live.renderer = null;
      r.dispose();
    };
  }, []);

  // pointer handling
  const toImage = (cx: number, cy: number) => {
    const a = S().analysis;
    const box = wrap.current!.getBoundingClientRect();
    if (!a) return null;
    let x = ((cx - box.left - local.x) / local.w) * a.width;
    let y = ((cy - box.top - local.y) / local.h) * a.height;
    const inside = x >= 0 && y >= 0 && x < a.width && y < a.height;
    raw.x = x / a.width; raw.y = y / a.height; raw.inside = inside;
    // in 3D, find the point of the picture that is under the cursor in the moved view
    if (isSpace()) { /* picking in the 3D space works on projected light positions (pickAt) */ }
    else if (is3d() && inside) [x, y] = live.view3d.unproject(x, y);
    return { x, y, inside, scale: local.w / a.width };
  };

  const pickAt = (x: number, y: number, scale: number) => {
    if (!isSpace()) return live.engine.pick(x, y, 14 / scale);
    // the 3D space: the light whose projected place is nearest the pointer
    let best = -1, bd = 16 / scale;
    for (let i = 0; i * 2 < envLightPx.length; i++) {
      const d = Math.hypot(envLightPx[i * 2] - x, envLightPx[i * 2 + 1] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  const onMove = (ev: React.PointerEvent) => {
    if (orbitDrag.on) {
      const dx = ev.clientX - orbitDrag.x, dy = ev.clientY - orbitDrag.y;
      if (Math.hypot(dx, dy) > 3) orbitDrag.moved = true;
      const cam = live.envCam;
      // walking round: drag the scene round; panorama: drag the view (turn the other way)
      cam.goal.yaw = orbitDrag.yaw + (live.env?.mode === 'panorama' ? 0.25 : -0.3) * dx;
      cam.goal.pitch = clamp(orbitDrag.pitch + dy * 0.15, -18, 28);
      return;
    }
    const q = toImage(ev.clientX, ev.clientY);
    if (!q) return;
    if (press.current && Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 10) { clearTimeout(press.current.timer); press.current = null; }
    const e = live.engine;
    e.pointer.x = q.x;
    e.pointer.y = q.y;
    e.pointer.inside = q.inside;
    const st = S();
    if (drawing.current && q.inside) {
      const lastPt = drawing.current[drawing.current.length - 1];
      if (Math.hypot(q.x - lastPt[0], q.y - lastPt[1]) > 6 / q.scale) drawing.current.push([q.x, q.y]);
    }
    if (st.mode === 'paint' && e.pointer.down && !st.picking) {
      const changed = e.paintAt(q.x, q.y, !(st.params.erase || ev.altKey));
      if (changed.length) switchSound(!(st.params.erase || ev.altKey));
    }
    if (boxSel.current) { boxSel.current.x1 = q.x; boxSel.current.y1 = q.y; if (tip) setTip(null); return; }
    if (st.mode === 'hand' || st.mode === 'show' || st.picking) {
      const i = q.inside ? pickAt(q.x, q.y, q.scale) : -1;
      const hovered = i >= 0 ? i : null;
      if (hovered !== st.hovered) st.set({ hovered });
      if (i >= 0) {
        const box = wrap.current!.getBoundingClientRect();
        const isEl = i >= e.lights.length;
        const z = isEl ? null : st.zones[e.zoneOf[i]];
        setTip({
          x: ev.clientX - box.left, y: ev.clientY - box.top,
          title: isEl ? capital(st.scene?.elementName ?? 'Moving light') : z?.name ?? 'Light',
          sub: st.picking
            ? (st.picked.includes(e.lights[i].id) ? 'Click to leave it out' : 'Click to choose it')
            : TOUCH ? 'Tap to adjust' : 'Click to adjust · Shift-click to add',
        });
      } else setTip(null);
    } else if (tip) setTip(null);
  };

  const onDown = (ev: React.PointerEvent) => {
    if (isSpace() && ev.button !== 2) {
      const q0 = toImage(ev.clientX, ev.clientY);
      const hit = q0 && q0.inside ? pickAt(q0.x, q0.y, q0.scale) : -1;
      if (hit < 0) {
        // empty space: drag to walk round
        Object.assign(orbitDrag, { on: true, x: ev.clientX, y: ev.clientY, yaw: live.envCam.goal.yaw, pitch: live.envCam.goal.pitch, moved: false });
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        return;
      }
    }
    if (ev.button === 2) return;
    const q = toImage(ev.clientX, ev.clientY);
    if (!q || !q.inside) return;
    const e = live.engine;
    const st = S();
    e.pointer.down = true;
    if (ev.pointerType === 'touch') {
      // long-press on a light opens its card (the touch version of right-click)
      e.pointer.inside = true;
      e.pointer.x = q.x;
      e.pointer.y = q.y;
      const i = pickAt(q.x, q.y, q.scale * 0.6);
      if (press.current) clearTimeout(press.current.timer);
      press.current = i >= 0 ? {
        t: performance.now(), x: ev.clientX, y: ev.clientY,
        timer: window.setTimeout(() => { S().set({ selection: { anchor: i, scope: 'light', picked: [i] } }); tickSound(); press.current = null; }, 520),
      } : null;
    }
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    if (st.picking) {
      const i = pickAt(q.x, q.y, q.scale);
      if (i >= 0 && i < e.lights.length) {
        const id = e.lights[i].id;
        const picked = st.picked.includes(id) ? st.picked.filter((x) => x !== id) : [...st.picked, id].slice(0, 12);
        st.set({ picked });
        tickSound();
      }
      return;
    }
    switch (st.mode) {
      case 'show':
      case 'hand': {
        const i = pickAt(q.x, q.y, q.scale);
        if (ev.altKey && i >= 0) {
          // quick switch without opening the panel
          const on = e.base[i] < 0.5;
          e.base[i] = on ? 1 : 0;
          switchSound(on);
          st.set({ rev: st.rev + 1 });
          break;
        }
        if (ev.shiftKey) {
          if (i >= 0) {
            const cur = st.selection ? selectedIndices() : [];
            const picked = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i];
            st.set({ selection: picked.length ? { anchor: picked[picked.length - 1], scope: picked.length > 1 ? 'picked' : 'light', picked } : null, menu: null });
            tickSound();
          } else boxSel.current = { x0: q.x, y0: q.y, x1: q.x, y1: q.y };
          break;
        }
        if (i >= 0) {
          const already = st.selection?.anchor === i && st.selection.scope !== 'picked';
          const scope = already ? st.selection!.scope : st.scene?.doc.markers?.length ? 'zone' : 'light';
          st.set({ selection: { anchor: i, scope, picked: [i] }, menu: null });
          tickSound();
        } else if (st.selection) st.set({ selection: null });
        else boxSel.current = { x0: q.x, y0: q.y, x1: q.x, y1: q.y };
        break;
      }
      case 'paint': {
        const on = !(st.params.erase || ev.altKey);
        if (e.paintAt(q.x, q.y, on).length) switchSound(on);
        break;
      }
      case 'route':
        drawing.current = [[q.x, q.y]];
        break;
      case 'sweep':
      case 'breathe':
      case 'flicker':
      case 'trail':
        e.addRipple(q.x, q.y);
        ripplesUi.current.push({ x: q.x, y: q.y, t0: performance.now() / 1000 });
        tickSound();
        break;
    }
  };

  const onUp = (ev?: React.PointerEvent) => {
    if (orbitDrag.on) {
      orbitDrag.on = false;
      if (!orbitDrag.moved && S().selection) S().set({ selection: null });
      return;
    }
    const e = live.engine;
    e.pointer.down = false;
    if (press.current) { clearTimeout(press.current.timer); press.current = null; }
    if (ev?.pointerType === 'touch' && S().mode !== 'trail') e.pointer.inside = false;
    const box = boxSel.current;
    if (box) {
      boxSel.current = null;
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        const picked: number[] = [];
        for (let i = 0; i < e.lights.length; i++) if (e.posX[i] >= x0 && e.posX[i] <= x1 && e.posY[i] >= y0 && e.posY[i] <= y1) picked.push(i);
        if (picked.length) { S().set({ selection: { anchor: picked[0], scope: picked.length > 1 ? 'picked' : 'light', picked }, menu: null }); tickSound(); }
      }
    }
    if (drawing.current) {
      const route = makeRoute(drawing.current);
      if (route) { e.route = route; e.routeS = 0; tickSound(); S().set({ routeReady: true }); }
      drawing.current = null;
    }
  };

  const onContext = (ev: React.MouseEvent) => {
    const q = toImage(ev.clientX, ev.clientY);
    if (!q || !q.inside) return;
    const i = pickAt(q.x, q.y, q.scale);
    if (i >= 0) {
      ev.preventDefault();
      S().set({ selection: { anchor: i, scope: 'light', picked: [i] }, menu: null });
      tickSound();
    }
  };

  const cursor = picking ? 'crosshair' : mode === 'hand' || mode === 'show' ? (tip ? 'pointer' : 'default') : mode === 'route' ? 'crosshair' : mode === 'torch' || mode === 'trail' || mode === 'paint' ? 'none' : 'default';

  return (
    <div className="stage" ref={wrap}>
      <canvas ref={canvas} className="stage__gl" />
      <canvas
        ref={overlay}
        className="stage__overlay"
        style={{ cursor }}
        onPointerMove={onMove}
        onPointerEnter={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={(ev) => {
          if (!isSpace()) return;
          const cam = live.envCam;
          cam.goal.dist = clamp(cam.goal.dist * (1 + ev.deltaY * 0.001), 0.35, 1.8);
        }}
        onPointerLeave={() => { live.engine.pointer.inside = false; setTip(null); if (S().hovered != null) S().set({ hovered: null }); }}
        onContextMenu={onContext}
        data-testid="stage"
      />
      {tip && (
        <div className="stage__tip" style={{ left: tip.x + 16, top: tip.y + 14 }}>
          <strong>{tip.title}</strong>
          <span>{tip.sub}</span>
        </div>
      )}
      {glError && <div className="stage__msg"><p>{glError}</p></div>}
      {status === 'loading' && (
        <div className="stage__msg" aria-live="polite">
          <span className="filament-loader" aria-hidden="true" />
          <p>{statusText || 'Loading'}</p>
        </div>
      )}
      {status === 'error' && (
        <div className="stage__msg stage__msg--error" role="alert"><p>{statusText}</p></div>
      )}
      {!hasScene && status === 'idle' && (
        <div className="stage__msg"><p>Choose a scene, or make a new one.</p></div>
      )}
    </div>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

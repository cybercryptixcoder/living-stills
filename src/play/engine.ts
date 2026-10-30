// The light engine: turns modes, faders and the pointer into a level per light every frame.
// It is plain mutable state (no React), stepped from the render loop.

import type { LightInfo, Vec3 } from '../core/types';
import type { AudioFrame } from './audio';
import { compile, evaluate, type Show, type ShowScene } from './show';

export type ModeId = 'hand' | 'torch' | 'paint' | 'trail' | 'route' | 'sweep' | 'breathe' | 'flicker' | 'music' | 'show';
export type MusicMap = 'together' | 'height' | 'across' | 'beat';
/** A behaviour given to individual lights from the light panel; it runs on top of any effect. */
export type LightFx = 'steady' | 'breathe' | 'flicker' | 'music';
const FX: LightFx[] = ['steady', 'breathe', 'flicker', 'music'];
export type SwitchFeel = 'filament' | 'instant' | 'neon';

export interface ModeParams {
  radius: number; // fraction of image width
  softness: number; // 0..1
  afterglow: number; // seconds
  speed: number; // tempo multiplier
  angle: number; // degrees, sweep direction
  depth: number; // breathe depth
  unrest: number; // share of lights that flicker
  keep: boolean; // spatial modes keep your switched-on lights lit
  erase: boolean; // paint switches lights off instead of on
  music: MusicMap; // how music maps onto the lights
}

export const DEFAULT_PARAMS: ModeParams = {
  radius: 0.14, softness: 0.55, afterglow: 2.2, speed: 1, angle: 0, depth: 0.7, unrest: 0.35, keep: false, erase: false, music: 'together',
};

/** Sweep cycle: switch on across the picture, then off, repeating. */
const SWEEP_PERIOD = 9;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash1(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x: number) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Ripple { x: number; y: number; t0: number }

export interface Route {
  pts: [number, number][];
  cum: number[];
  total: number;
}

export function makeRoute(pts: [number, number][]): Route | null {
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  return total > 4 ? { pts, cum, total } : null;
}

function routeAt(r: Route, s: number): [number, number] {
  s = ((s % r.total) + r.total) % r.total;
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < s) i++;
  const a = r.pts[i - 1], b = r.pts[i];
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const t = (s - r.cum[i - 1]) / seg;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

interface Seed { phase: number; period: number; onset: number; offset: number; unrest: number; rate: number; neon: number }

export interface ElementLight {
  x: number;
  y: number;
  flux: number;
  color: Vec3;
}

export class Engine {
  lights: LightInfo[] = [];
  W = 1;
  H = 1;
  base = new Float32Array(0);
  target = new Float32Array(0);
  level = new Float32Array(0);
  trail = new Float32Array(0);
  onAt = new Float64Array(0);
  wasOn = new Uint8Array(0);
  colors: (Vec3 | null)[] = [];
  seeds: Seed[] = [];
  posX = new Float32Array(0);
  posY = new Float32Array(0);
  groups: number[] = [];
  master = 1;
  warmth = 0;
  feel: SwitchFeel = 'filament';
  mode: ModeId = 'hand';
  params: ModeParams = { ...DEFAULT_PARAMS };
  pointer = { x: 0, y: 0, inside: false, down: false };
  route: Route | null = null;
  routeS = 0;
  ripples: Ripple[] = [];
  time = 0;
  // the moving element counts as one more light (index = lights.length)
  element: ElementLight | null = null;
  elementFader = 1;
  elementColor: Vec3 | null = null;
  private table = new Float32Array(256 * 4);
  private c0: Vec3[] = [];
  litness = 0;
  litColor: Vec3 = [1, 0.75, 0.45];
  private wakeAt = -100;
  /** zone (0-based) of each light, set by the app after zoning */
  zoneOf = new Int16Array(0);
  zoneCount = 0;
  /** per-light behaviour from the light panel */
  fx = new Uint8Array(0);
  /** latest audio analysis (music mode, music fx, music steps in shows) */
  audio: AudioFrame | null = null;
  /** the running show (presets and the director) */
  show: { compiled: ReturnType<typeof compile>; t0: number; start: Float32Array } | null = null;
  showTime = 0;
  private showOut = new Float32Array(0);
  private showColors: (Vec3 | null | undefined)[] = [];

  /** Longest time step per frame; tests on software rendering raise it so engine time keeps up. */
  maxDt = 0.1;

  /** Skips the wake-up reveal (tests). */
  finishWake() {
    this.wakeAt = -100;
  }

  /** The scene "wakes": lights come on one by one over about two seconds. */
  wake() {
    this.wakeAt = this.time;
    this.level.fill(0);
  }

  load(lights: LightInfo[], groupCount: number, W: number, H: number, element: ElementLight | null) {
    this.lights = lights;
    this.W = W;
    this.H = H;
    this.element = element;
    const n = lights.length + (element ? 1 : 0);
    this.base = new Float32Array(n).fill(1);
    this.target = new Float32Array(n);
    this.level = new Float32Array(n);
    this.trail = new Float32Array(n);
    this.onAt = new Float64Array(n).fill(-10);
    this.wasOn = new Uint8Array(n);
    this.colors = new Array(n).fill(null);
    this.fx = new Uint8Array(n);
    this.zoneOf = new Int16Array(n).fill(-1);
    this.showOut = new Float32Array(n);
    this.showColors = new Array(n).fill(undefined);
    this.show = null;
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    lights.forEach((L, i) => { this.posX[i] = L.x; this.posY[i] = L.y; });
    if (element) { this.posX[n - 1] = element.x; this.posY[n - 1] = element.y; }
    this.c0 = lights.map((L) => L.color);
    if (element) this.c0.push(element.color);
    this.groups = new Array(groupCount).fill(1);
    this.seeds = Array.from({ length: n }, (_, i) => {
      const r = mulberry(1013 + i * 7919);
      return {
        phase: r() * Math.PI * 2, period: 3.5 + r() * 4.5, onset: r(), offset: r(),
        unrest: r(), rate: 0.6 + r() * 1.8, neon: r(),
      };
    });
    this.ripples = [];
    this.routeS = 0;
    this.time = 0;
  }

  get count() {
    return this.base.length;
  }

  get hasElement() {
    return !!this.element;
  }

  setElementPos(x: number, y: number) {
    if (!this.element) return;
    const i = this.count - 1;
    this.posX[i] = x;
    this.posY[i] = y;
  }

  /** Scene facts a show needs (positions 0..1, ids, zones). */
  showScene(): ShowScene {
    const n = this.count;
    const x = new Float32Array(n), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { x[i] = this.posX[i] / this.W; y[i] = this.posY[i] / this.H; }
    return { x, y, ids: [...this.lights.map((L) => L.id), ...(this.element ? [-1] : [])], zoneOf: this.zoneOf, count: n };
  }

  /** Starts a show from the lights' current state. */
  playShow(show: Show) {
    const start = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) start[i] = this.mode === 'show' && this.show ? this.showOut[i] : this.base[i];
    this.show = { compiled: compile(show, this.showScene()), t0: this.time, start };
    this.showTime = 0;
    this.mode = 'show';
  }

  /** Stops a show; the lights keep the state the show left them in. */
  stopShow() {
    if (this.show) for (let i = 0; i < this.count; i++) this.base[i] = Math.min(1, this.showOut[i]);
    if (this.show) this.showColors.forEach((c, i) => { if (c !== undefined) this.colors[i] = c; });
    this.show = null;
  }

  setFx(indices: number[], fx: LightFx) {
    const v = FX.indexOf(fx);
    for (const i of indices) this.fx[i] = v;
  }

  fxOf(i: number): LightFx {
    return FX[this.fx[i]] ?? 'steady';
  }

  groupOf(i: number) {
    return i < this.lights.length ? this.lights[i].group : -1;
  }

  setAll(v: number) {
    this.base.fill(v);
  }

  setGroup(g: number, v: number) {
    this.lights.forEach((L, i) => { if (L.group === g) this.base[i] = v; });
  }

  private falloff(i: number, x: number, y: number) {
    const R = this.params.radius * this.W;
    const d = Math.hypot(this.posX[i] - x, this.posY[i] - y);
    return 1 - smooth(R * (1 - this.params.softness * 0.9), R, d);
  }

  /** Paint mode: switch lights under the brush. Returns ids that changed. */
  paintAt(x: number, y: number, on: boolean): number[] {
    const changed: number[] = [];
    for (let i = 0; i < this.count; i++) {
      if (this.falloff(i, x, y) > 0.5) {
        const v = on ? 1 : 0;
        if (this.base[i] !== v) { this.base[i] = v; changed.push(i); }
      }
    }
    return changed;
  }

  addRipple(x: number, y: number) {
    this.ripples.push({ x, y, t0: this.time });
    if (this.ripples.length > 8) this.ripples.shift();
  }

  /** Index of the light at image point (x, y) within `r` image px, or -1. */
  pick(x: number, y: number, r: number): number {
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const [x0, y0, x1, y1] = L.bbox;
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const score = d + 0.02 * Math.sqrt(L.area) + 0.001 * Math.hypot(this.posX[i] - x, this.posY[i] - y);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0 && this.element) {
      const i = this.count - 1;
      if (Math.hypot(this.posX[i] - x, this.posY[i] - y) < r * 4) return i;
    }
    return best;
  }

  private lastMode: ModeId | null = null;
  private modeT0 = 0;

  /** Where the travelling light of Route mode is now (for drawing it). */
  routePoint(): [number, number] | null {
    return this.route ? routeAt(this.route, this.routeS) : null;
  }

  step(dt: number) {
    this.time += dt;
    const t = this.time;
    if (this.mode !== this.lastMode) {
      // cycles (sweep, dusk) start from their beginning when you switch to them
      this.lastMode = this.mode;
      this.modeT0 = t;
      if (this.mode === 'route') this.routeS = 0;
    }
    const p = this.params;
    const n = this.count;
    const sp = p.speed;
    const R = p.radius * this.W;
    const transient = this.mode === 'torch' || this.mode === 'trail' || this.mode === 'route' || this.mode === 'sweep';

    // driver position for trail-like modes
    let drvX = 0, drvY = 0, drv = false;
    if (this.mode === 'trail' || this.mode === 'torch') {
      drv = this.pointer.inside; drvX = this.pointer.x; drvY = this.pointer.y;
    } else if (this.mode === 'route' && this.route) {
      this.routeS += dt * sp * this.W * 0.12;
      [drvX, drvY] = routeAt(this.route, this.routeS);
      drv = true;
    }
    const decay = Math.exp(-dt / Math.max(0.05, p.afterglow));

    // sweep geometry
    let ux = 1, uy = 0, pmin = 0, pspan = 1;
    if (this.mode === 'sweep') {
      const a = (p.angle * Math.PI) / 180;
      ux = Math.cos(a); uy = Math.sin(a);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const q = this.posX[i] * ux + this.posY[i] * uy; lo = Math.min(lo, q); hi = Math.max(hi, q); }
      pmin = lo; pspan = Math.max(1, hi - lo);
    }
    const sweepPh = (((t - this.modeT0) * sp) / SWEEP_PERIOD) % 1;
    if (this.mode === 'show' && this.show) {
      this.showTime = evaluate(this.show.compiled, (t - this.show.t0) * sp, this.show.start, this.showOut, this.showColors, this.audio);
    }
    const au = this.audio;
    // music: where each light sits decides which part of the sound drives it
    let ylo = Infinity, yhi = -Infinity, xlo = Infinity, xhi = -Infinity;
    if (this.mode === 'music' && au) {
      for (let i = 0; i < n; i++) { ylo = Math.min(ylo, this.posY[i]); yhi = Math.max(yhi, this.posY[i]); xlo = Math.min(xlo, this.posX[i]); xhi = Math.max(xhi, this.posX[i]); }
    }
    this.ripples = this.ripples.filter((r) => (t - r.t0) * sp * this.W * 0.35 < Math.hypot(this.W, this.H) + R);

    let litNum = 0, litDen = 0, cr = 0, cg = 0, cb = 0;
    for (let i = 0; i < n; i++) {
      const base = this.base[i];
      const s = this.seeds[i];
      let v = base;
      switch (this.mode) {
        case 'torch':
          v = drv ? this.falloff(i, drvX, drvY) : 0;
          break;
        case 'trail':
        case 'route': {
          const f = drv ? this.falloff(i, drvX, drvY) : 0;
          this.trail[i] = Math.max(this.trail[i] * decay, f);
          v = this.trail[i];
          break;
        }
        case 'sweep': {
          const q = (this.posX[i] * ux + this.posY[i] * uy - pmin) / pspan;
          const e = 0.08;
          if (sweepPh < 0.5) {
            const front = (sweepPh / 0.42) * (1 + e);
            v = smooth(q - e, q, front);
          } else {
            const front = ((sweepPh - 0.5) / 0.42) * (1 + e);
            v = 1 - smooth(q - e, q, front);
          }
          break;
        }
        case 'breathe':
          v = base * (1 - p.depth * 0.5 * (1 + Math.sin((2 * Math.PI * t * sp) / s.period + s.phase)));
          break;
        case 'flicker': {
          if (s.unrest < p.unrest) {
            const x = t * sp * s.rate * 3 + s.offset * 100;
            const dip = smooth(0.62, 0.8, noise1(x)) * (0.55 + 0.45 * s.neon);
            const buzz = 0.06 * noise1(t * 37 + s.phase * 10);
            v = base * Math.max(0, 1 - dip - buzz);
          }
          break;
        }
        case 'show':
          v = this.show ? this.showOut[i] : base;
          break;
        case 'music': {
          if (!au) { v = base * 0.15; break; }
          const bands = au.bands, B = bands.length;
          let m: number;
          if (p.music === 'height') {
            // low lights take the bass, high lights the treble
            const q = yhi > ylo ? (yhi - this.posY[i]) / (yhi - ylo) : 0.5;
            m = bands[Math.min(B - 1, Math.floor(q * B))];
          } else if (p.music === 'across') {
            const q = xhi > xlo ? (this.posX[i] - xlo) / (xhi - xlo) : 0.5;
            m = bands[Math.min(B - 1, Math.floor(q * B))];
          } else if (p.music === 'beat') {
            // each beat lights the next zone
            const zc = Math.max(1, this.zoneCount);
            const z = this.zoneOf[i] < 0 ? 0 : this.zoneOf[i];
            m = (au.beats % zc === z ? 1 : 0.08) * (0.55 + 0.45 * au.beat) + 0.1 * au.level;
          } else m = 0.25 * au.level + 0.75 * Math.max(au.bass * 0.8, au.beat);
          v = base * Math.min(1.4, m * 1.25);
          break;
        }
        default:
          v = base;
      }
      // ripples work on top of any mode
      for (const r of this.ripples) {
        const rad = (t - r.t0) * sp * this.W * 0.35;
        const d = Math.hypot(this.posX[i] - r.x, this.posY[i] - r.y);
        const width = 0.05 * this.W;
        v = Math.max(v, Math.exp(-((d - rad) * (d - rad)) / (2 * width * width)));
      }
      if (transient && p.keep) v = Math.max(v, base);
      // the light's own behaviour (from the light panel)
      const fx = this.fx[i];
      if (fx === 1) v *= 1 - 0.75 * 0.5 * (1 + Math.sin((2 * Math.PI * t) / (s.period * 0.7) + s.phase));
      else if (fx === 2) {
        const x = t * s.rate * 3.2 + s.offset * 100;
        v *= Math.max(0, 1 - smooth(0.55, 0.75, noise1(x)) * 0.9 - 0.06 * noise1(t * 37 + s.phase * 10));
      } else if (fx === 3) v *= au ? Math.min(1.4, 0.15 + 1.2 * Math.max(au.bass, au.beat)) : 0.3;
      const wt = (t - this.wakeAt) / 2.4;
      if (wt < 1.2) v *= smooth(s.onset * 0.8, s.onset * 0.8 + 0.2, wt);
      const g = this.groupOf(i);
      const fader = g >= 0 ? this.groups[g] ?? 1 : this.elementFader;
      let tgt = Math.min(1.5, v * fader * this.master);
      // neon: stutter when switching on
      if (tgt > 0.6 && !this.wasOn[i]) { this.wasOn[i] = 1; this.onAt[i] = t; }
      else if (tgt < 0.25) this.wasOn[i] = 0;
      if (this.feel === 'neon') {
        const a = t - this.onAt[i] - s.neon * 0.06;
        if (a >= 0 && a < 0.42) {
          const pat = a < 0.05 ? 1 : a < 0.12 ? 0.08 : a < 0.17 ? 0.85 : a < 0.31 ? 0.12 : a < 0.35 ? 0.7 : 1;
          tgt *= pat;
        }
      }
      this.target[i] = tgt;
      const cur = this.level[i];
      if (this.feel === 'filament') {
        const tau = tgt > cur ? 0.07 : 0.2;
        this.level[i] = cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
      } else this.level[i] = tgt;
      const flux = i < this.lights.length ? this.lights[i].flux : this.element!.flux;
      const c = this.colorOf(i) ?? this.c0[i];
      litNum += flux * this.level[i]; litDen += flux;
      cr += flux * this.level[i] * c[0]; cg += flux * this.level[i] * c[1]; cb += flux * this.level[i] * c[2];
    }
    this.litness = litDen > 0 ? Math.min(1, litNum / litDen) : 0;
    const m = Math.max(cr, cg, cb, 1e-9);
    if (litNum > 1e-6) this.litColor = [cr / m, cg / m, cb / m];
  }

  /** The colour a light shows now: a running show's colour, else the one you gave it (null = its own). */
  colorOf(i: number): Vec3 | null {
    if (this.mode === 'show' && this.show) {
      const c = this.showColors[i];
      if (c !== undefined) return c;
    }
    return this.colors[i];
  }

  /** Per-channel multiplier that recolours a light from its own colour c0 to `target`, keeping brightness. */
  static colourGain(c0: Vec3, target: Vec3 | null): Vec3 {
    if (!target) return [1, 1, 1];
    const lum = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const g: Vec3 = [target[0] / Math.max(0.05, c0[0]), target[1] / Math.max(0.05, c0[1]), target[2] / Math.max(0.05, c0[2])];
    const k = lum(c0) / Math.max(1e-4, lum([c0[0] * g[0], c0[1] * g[1], c0[2] * g[2]]));
    return [Math.min(6, g[0] * k), Math.min(6, g[1] * k), Math.min(6, g[2] * k)];
  }

  private warmthGain(): Vec3 {
    const w = this.warmth;
    return w >= 0 ? [1 + 0.12 * w, 1, 1 - 0.45 * w] : [1 + 0.25 * w, 1 + 0.02 * w, 1 - 0.6 * w];
  }

  lightTable(): Float32Array {
    const T = this.table;
    T.fill(0);
    const wg = this.warmthGain();
    let num = 0, den = 0;
    this.lights.forEach((L, i) => {
      if (L.id > 255) return;
      const g = Engine.colourGain(L.color, this.colorOf(i));
      const v = this.level[i];
      T[L.id * 4] = v * g[0] * wg[0];
      T[L.id * 4 + 1] = v * g[1] * wg[1];
      T[L.id * 4 + 2] = v * g[2] * wg[2];
      T[L.id * 4 + 3] = 1;
      num += L.flux * v; den += L.flux;
    });
    const rem = den > 0 ? num / den : this.master;
    T[0] = rem * wg[0]; T[1] = rem * wg[1]; T[2] = rem * wg[2]; T[3] = 1;
    return T;
  }

  elementOutput(): { t: number; gain: Vec3 } {
    if (!this.element) return { t: 0, gain: [1, 1, 1] };
    const i = this.count - 1;
    const wg = this.warmthGain();
    const g = Engine.colourGain(this.element.color, this.colorOf(i));
    return { t: this.level[i], gain: [g[0] * wg[0], g[1] * wg[1], g[2] * wg[2]] };
  }
}

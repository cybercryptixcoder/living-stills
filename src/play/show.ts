// Light shows: timed steps that drive the lights. Presets are shows, and the director agent writes
// shows from plain language. A show is plain JSON, so it can be saved, shared and edited.

import type { Vec3 } from '../core/types';
import type { AudioFrame } from './audio';

export interface Target {
  all?: boolean;
  zones?: number[]; // groups of lights as numbered for the director (1-based)
  lights?: number[]; // light ids
  region?: { x: number; y: number; w: number; h: number }; // 0..1 of the picture
  near?: { x: number; y: number; r: number }; // 0..1
  except?: Target;
}

export type Action = 'set' | 'fade' | 'flicker' | 'pulse' | 'chase' | 'scatter' | 'sparkle' | 'strobe' | 'spark' | 'color' | 'music';
export type Direction = 'left' | 'right' | 'up' | 'down' | 'out' | 'in';
export type Band = 'bass' | 'mid' | 'treble' | 'all';

export interface Step {
  at: number; // seconds from the start
  dur?: number; // seconds
  target: Target;
  do: Action;
  to?: number; // level to end at (0..1.5)
  times?: number; // flicker count
  period?: number; // pulse period (s)
  depth?: number; // pulse depth 0..1
  dir?: Direction; // chase direction
  color?: string; // #rrggbb, or "original"
  band?: Band; // music band
  rate?: number; // strobe flashes per second
  density?: number; // sparkle share 0..1
}

export interface Show {
  name: string;
  summary?: string;
  loop?: boolean;
  length?: number; // seconds; defaults to the end of the last step
  steps: Step[];
}

export const ACTIONS: Action[] = ['set', 'fade', 'flicker', 'pulse', 'chase', 'scatter', 'sparkle', 'strobe', 'spark', 'color', 'music'];

const DEFAULT_DUR: Record<Action, number> = {
  set: 0, fade: 1.2, flicker: 1.6, pulse: 8, chase: 2.5, scatter: 6, sparkle: 6, strobe: 2, spark: 0.7, color: 0.8, music: 30,
};

/** What a show needs to know about the scene. Positions are 0..1. */
export interface ShowScene {
  x: Float32Array;
  y: Float32Array;
  ids: number[]; // light id per engine index
  zoneOf: Int16Array; // 0-based zone per engine index (-1 for none)
  count: number;
}

interface Compiled {
  show: Show;
  length: number;
  steps: { s: Step; dur: number; idx: number[]; order?: Float32Array; color: Vec3 | null | undefined }[];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function hexToRgb(hex: string): Vec3 | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  const lin = (c: number) => Math.pow(c / 255, 2.2);
  const rgb: Vec3 = [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)];
  const mx = Math.max(...rgb, 1e-6);
  return [rgb[0] / mx, rgb[1] / mx, rgb[2] / mx];
}

export function resolve(t: Target | undefined, sc: ShowScene): number[] {
  if (!t) return [];
  const pick = new Uint8Array(sc.count);
  const zoneSet = t.zones?.length ? new Set(t.zones.map((z) => z - 1)) : null;
  const idSet = t.lights?.length ? new Set(t.lights) : null;
  const any = !!(t.all || zoneSet || idSet || t.region || t.near);
  for (let i = 0; i < sc.count; i++) {
    if (!any) continue;
    let on = !!t.all;
    if (zoneSet && zoneSet.has(sc.zoneOf[i])) on = true;
    if (idSet && idSet.has(sc.ids[i])) on = true;
    if (t.region) {
      const r = t.region;
      if (sc.x[i] >= r.x && sc.x[i] <= r.x + r.w && sc.y[i] >= r.y && sc.y[i] <= r.y + r.h) on = true;
    }
    if (t.near && Math.hypot(sc.x[i] - t.near.x, sc.y[i] - t.near.y) <= t.near.r) on = true;
    if (on) pick[i] = 1;
  }
  if (t.except) for (const i of resolve(t.except, sc)) pick[i] = 0;
  const out: number[] = [];
  for (let i = 0; i < sc.count; i++) if (pick[i]) out.push(i);
  return out;
}

export function showLength(show: Show): number {
  if (show.length && show.length > 0) return show.length;
  let end = 0;
  for (const s of show.steps) end = Math.max(end, s.at + (s.dur ?? DEFAULT_DUR[s.do] ?? 1));
  return Math.max(0.5, end + (show.loop ? 0.6 : 0));
}

export function compile(show: Show, sc: ShowScene): Compiled {
  const steps = [...show.steps].sort((a, b) => a.at - b.at).map((s) => {
    const idx = resolve(s.target, sc);
    const dur = Math.max(0, s.dur ?? DEFAULT_DUR[s.do] ?? 1);
    let order: Float32Array | undefined;
    if (s.do === 'chase' || s.do === 'scatter') {
      order = new Float32Array(idx.length);
      if (s.do === 'scatter') idx.forEach((i, k) => { order![k] = hash(i * 7.13 + s.at * 3.1); });
      else {
        const cx = idx.reduce((a, i) => a + sc.x[i], 0) / Math.max(1, idx.length);
        const cy = idx.reduce((a, i) => a + sc.y[i], 0) / Math.max(1, idx.length);
        const key = (i: number) => {
          switch (s.dir) {
            case 'left': return -sc.x[i];
            case 'up': return -sc.y[i];
            case 'down': return sc.y[i];
            case 'out': return Math.hypot(sc.x[i] - cx, sc.y[i] - cy);
            case 'in': return -Math.hypot(sc.x[i] - cx, sc.y[i] - cy);
            default: return sc.x[i];
          }
        };
        const keys = idx.map(key);
        const lo = Math.min(...keys), hi = Math.max(...keys);
        idx.forEach((_, k) => { order![k] = hi > lo ? (keys[k] - lo) / (hi - lo) : 0; });
      }
    }
    const color = s.do === 'color' ? (s.color === 'original' ? null : hexToRgb(s.color ?? '') ?? undefined) : undefined;
    return { s, dur, idx, order, color };
  });
  return { show, length: showLength(show), steps };
}

/**
 * Levels (and colours) at show time t. `start` holds the levels the lights had when the show began.
 * Steps apply in order; a finished step leaves its end state (set, fade, chase...), a passing effect
 * (pulse, sparkle, strobe, music) only acts while it runs.
 */
export function evaluate(c: Compiled, tRaw: number, start: Float32Array, out: Float32Array, colors: (Vec3 | null | undefined)[], audio: AudioFrame | null) {
  const t = c.show.loop ? tRaw % c.length : Math.min(tRaw, c.length);
  out.set(start);
  colors.fill(undefined);
  for (const { s, dur, idx, order, color } of c.steps) {
    if (t < s.at) break;
    const local = t - s.at;
    const k = dur > 0 ? clamp(local / dur, 0, 1) : 1;
    const running = local < dur;
    const to = clamp(s.to ?? (s.do === 'fade' || s.do === 'set' ? 1 : NaN), 0, 1.5);
    switch (s.do) {
      case 'set':
        for (const i of idx) out[i] = to;
        break;
      case 'fade': {
        const e = k * k * (3 - 2 * k);
        for (const i of idx) out[i] = out[i] + (to - out[i]) * e;
        break;
      }
      case 'flicker': {
        const times = Math.max(1, Math.round(s.times ?? 4));
        if (running) {
          // one shared pattern, so lights flickering together stay in sync
          const ph = (local / dur) * times;
          const f = ph - Math.floor(ph);
          const dip = f > 0.18 && f < 0.62 ? 0.04 : 1;
          for (const i of idx) out[i] = Math.max(out[i], 0.85) * dip;
        } else if (!Number.isNaN(to)) for (const i of idx) out[i] = to;
        break;
      }
      case 'pulse': {
        if (!running) break;
        const period = Math.max(0.15, s.period ?? 1.6);
        const depth = clamp(s.depth ?? 0.75, 0, 1);
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * local) / period));
        for (const i of idx) out[i] = Math.max(out[i], 0.9) * (1 - depth * (1 - w));
        break;
      }
      case 'chase':
      case 'scatter': {
        const target = Number.isNaN(to) ? 1 : to;
        const edge = s.do === 'chase' ? 0.12 : 0.04;
        idx.forEach((i, q) => {
          const o = order![q];
          const m = smooth(o * (1 - edge), o * (1 - edge) + edge, k);
          out[i] = out[i] + (target - out[i]) * m;
        });
        break;
      }
      case 'sparkle': {
        if (!running) break;
        const density = clamp(s.density ?? 0.35, 0.02, 1);
        for (const i of idx) {
          const rate = 1.4 + 2.6 * hash(i * 3.7);
          const p = (local * rate + hash(i * 9.1) * 10) % 1;
          const lit = hash(i * 1.3 + Math.floor(local * rate + hash(i * 9.1) * 10)) < density;
          const flash = lit ? Math.exp(-p * 5) : 0;
          out[i] = Math.max(out[i] * 0.35, 1.25 * flash);
        }
        break;
      }
      case 'strobe': {
        if (!running) break;
        const rate = clamp(s.rate ?? 6, 0.5, 20);
        const on = Math.floor(local * rate * 2) % 2 === 0;
        const hi = Number.isNaN(to) ? 1 : to;
        for (const i of idx) out[i] = on ? hi : 0;
        break;
      }
      case 'spark': {
        const target = Number.isNaN(to) ? 1 : to;
        const stut = local < 0.16 ? (Math.floor(local * 40) % 2 ? 0.2 : 1.45) : 1.45;
        for (const i of idx) out[i] = target + (stut - target) * Math.exp(-Math.max(0, local - 0.16) / Math.max(0.05, dur * 0.35));
        break;
      }
      case 'color':
        for (const i of idx) colors[i] = color;
        break;
      case 'music': {
        if (!running || !audio) break;
        const band = s.band ?? 'all';
        const v = band === 'bass' ? audio.bass : band === 'mid' ? audio.mid : band === 'treble' ? audio.treble : audio.level;
        const gain = Number.isNaN(to) ? 1.2 : to + 0.2;
        for (const i of idx) out[i] = clamp(v * gain, 0, 1.5);
        break;
      }
    }
  }
  return t;
}

/** Cleans up a show from an untrusted source (the agent, a pasted file): drops what can't run, clamps numbers. */
export function sanitize(raw: unknown): Show {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d?: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isFinite(x)).slice(0, 300) : undefined);
  const box = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== 'object') return undefined;
    const r = v as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const k of keys) { const x = num(r[k], 0, 1); if (x == null) return undefined; out[k] = x; }
    return out;
  };
  const target = (v: unknown, depth = 0): Target => {
    const t = (v ?? {}) as Record<string, unknown>;
    const out: Target = {};
    if (t.all === true) out.all = true;
    const z = list(t.zones); if (z?.length) out.zones = z;
    const l = list(t.lights); if (l?.length) out.lights = l;
    const r = box(t.region, ['x', 'y', 'w', 'h']); if (r) out.region = r as Target['region'];
    const n = box(t.near, ['x', 'y', 'r']); if (n) out.near = n as Target['near'];
    if (t.except && depth < 1) out.except = target(t.except, depth + 1);
    if (!out.all && !out.zones && !out.lights && !out.region && !out.near) out.all = true;
    return out;
  };
  const steps: Step[] = (Array.isArray(o.steps) ? o.steps : []).slice(0, 200).flatMap((sv) => {
    const s = (sv ?? {}) as Record<string, unknown>;
    const act = String(s.do ?? s.action ?? '') as Action;
    if (!ACTIONS.includes(act)) return [];
    const step: Step = { at: num(s.at, 0, 3600, 0)!, do: act, target: target(s.target) };
    const dur = num(s.dur ?? s.duration, 0, 3600); if (dur != null) step.dur = dur;
    const to = num(s.to ?? s.level, 0, 1.5); if (to != null) step.to = to;
    const times = num(s.times, 1, 60); if (times != null) step.times = Math.round(times);
    const period = num(s.period, 0.15, 60); if (period != null) step.period = period;
    const depthv = num(s.depth, 0, 1); if (depthv != null) step.depth = depthv;
    const rate = num(s.rate, 0.5, 20); if (rate != null) step.rate = rate;
    const density = num(s.density, 0.02, 1); if (density != null) step.density = density;
    if (typeof s.dir === 'string' && ['left', 'right', 'up', 'down', 'out', 'in'].includes(s.dir)) step.dir = s.dir as Direction;
    if (typeof s.color === 'string' && (s.color === 'original' || hexToRgb(s.color))) step.color = s.color;
    if (typeof s.band === 'string' && ['bass', 'mid', 'treble', 'all'].includes(s.band)) step.band = s.band as Band;
    if (act === 'color' && !step.color) return [];
    return [step];
  });
  return {
    name: String(o.name ?? 'Untitled show').slice(0, 60),
    summary: typeof o.summary === 'string' ? o.summary.slice(0, 240) : undefined,
    loop: o.loop === true,
    length: num(o.length, 0.5, 3600),
    steps,
  };
}

export function usesMusic(show: Show) {
  return show.steps.some((s) => s.do === 'music');
}

/** A one-line, human description of a step (shown under a running show). */
export function describeStep(s: Step, zoneName: (n: number) => string): string {
  const t = s.target;
  const who = t.all ? 'all lights' : t.zones?.length ? t.zones.map(zoneName).join(', ') : t.lights?.length ? `${t.lights.length} light${t.lights.length > 1 ? 's' : ''}` : t.region ? 'an area' : t.near ? 'lights near a point' : 'lights';
  const dur = s.dur != null ? ` over ${s.dur}s` : '';
  switch (s.do) {
    case 'set': return `${who} ${s.to ? `to ${Math.round((s.to ?? 1) * 100)}%` : 'off'}`;
    case 'fade': return `${who} fade to ${Math.round((s.to ?? 1) * 100)}%${dur}`;
    case 'flicker': return `${who} flicker ${s.times ?? 4}×${dur}`;
    case 'pulse': return `${who} pulse${dur}`;
    case 'chase': return `${who} chase ${s.dir ?? 'right'} ${(s.to ?? 1) > 0 ? 'on' : 'off'}${dur}`;
    case 'scatter': return `${who} switch ${(s.to ?? 1) > 0 ? 'on' : 'off'} one by one${dur}`;
    case 'sparkle': return `${who} sparkle${dur}`;
    case 'strobe': return `${who} strobe${dur}`;
    case 'spark': return `${who} spark on`;
    case 'color': return `${who} turn ${s.color === 'original' ? 'back to their own colour' : s.color}`;
    case 'music': return `${who} follow the ${s.band === 'all' || !s.band ? 'music' : s.band}${dur}`;
  }
}

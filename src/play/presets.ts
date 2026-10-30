// Ready-made shows. Each is the same JSON the director writes, so presets and the agent's
// shows behave the same way and can be saved side by side.

import type { Show } from './show';

export interface Preset {
  id: string;
  show: Show;
  blurb: string;
  builtIn?: boolean;
}

const all = { all: true };

export const BUILT_IN: Preset[] = [
  {
    id: 'dusk', builtIn: true, blurb: 'Lights come on one by one, stay a while, then go out one by one.',
    show: { name: 'Dusk', loop: true, steps: [
      { at: 0, do: 'set', target: all, to: 0 },
      { at: 0.5, dur: 10, do: 'scatter', target: all, to: 1 },
      { at: 15, dur: 8, do: 'scatter', target: all, to: 0 },
    ], length: 25 },
  },
  {
    id: 'dawn', builtIn: true, blurb: 'Everything starts lit, then the lights go out one by one.',
    show: { name: 'Dawn', steps: [
      { at: 0, do: 'set', target: all, to: 1 },
      { at: 1, dur: 10, do: 'scatter', target: all, to: 0 },
    ] },
  },
  {
    id: 'wave', builtIn: true, blurb: 'A wave of light runs left to right, then switches off the same way.',
    show: { name: 'Wave', loop: true, steps: [
      { at: 0, do: 'set', target: all, to: 0 },
      { at: 0.2, dur: 3, do: 'chase', dir: 'right', target: all, to: 1 },
      { at: 4.2, dur: 3, do: 'chase', dir: 'right', target: all, to: 0 },
    ], length: 8 },
  },
  {
    id: 'heartbeat', builtIn: true, blurb: 'Every light pulses together, slow and steady.',
    show: { name: 'Heartbeat', loop: true, steps: [{ at: 0, dur: 30, do: 'pulse', period: 1.4, depth: 0.85, target: all }], length: 30 },
  },
  {
    id: 'outage', builtIn: true, blurb: 'The power stutters, everything goes dark, then sparks back on.',
    show: { name: 'Power cut', loop: true, steps: [
      { at: 0, do: 'set', target: all, to: 1 },
      { at: 1, dur: 2.2, do: 'flicker', times: 6, target: all, to: 0 },
      { at: 5.5, dur: 0.8, do: 'spark', target: all, to: 1 },
    ], length: 9 },
  },
  {
    id: 'sparkle', builtIn: true, blurb: 'Random lights twinkle like fairy lights.',
    show: { name: 'Twinkle', loop: true, steps: [{ at: 0, dur: 30, do: 'sparkle', density: 0.4, target: all }], length: 30 },
  },
  {
    id: 'party', builtIn: true, blurb: 'Colours roll through the lights. Best with music on.',
    show: { name: 'Party', loop: true, steps: [
      { at: 0, do: 'set', target: all, to: 1 },
      { at: 0, do: 'color', color: '#ff3d7f', target: { region: { x: 0, y: 0, w: 0.5, h: 1 } } },
      { at: 0, do: 'color', color: '#33d1ff', target: { region: { x: 0.5, y: 0, w: 0.5, h: 1 } } },
      { at: 2, do: 'color', color: '#ffd23d', target: { region: { x: 0, y: 0, w: 0.5, h: 1 } } },
      { at: 2, do: 'color', color: '#8a5cff', target: { region: { x: 0.5, y: 0, w: 0.5, h: 1 } } },
      { at: 4, do: 'color', color: '#3dff9e', target: all },
      { at: 0, dur: 6, do: 'pulse', period: 0.5, depth: 0.5, target: all },
    ], length: 6 },
  },
  {
    id: 'reset', builtIn: true, blurb: 'Every light on, in its own colour.',
    show: { name: 'All on', steps: [{ at: 0, do: 'set', target: all, to: 1 }, { at: 0, do: 'color', color: 'original', target: all }] },
  },
];

const KEY = 'living-stills:presets';

export function loadSaved(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

export function savePreset(show: Show, blurb: string): Preset {
  const p: Preset = { id: `mine-${Date.now().toString(36)}`, show, blurb };
  try { localStorage.setItem(KEY, JSON.stringify([p, ...loadSaved()].slice(0, 40))); } catch { /* storage unavailable */ }
  return p;
}

export function deletePreset(id: string) {
  try { localStorage.setItem(KEY, JSON.stringify(loadSaved().filter((p) => p.id !== id))); } catch { /* storage unavailable */ }
}

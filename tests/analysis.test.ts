import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { analyzeSplit, assignLights, computeSprite, contextCrop, detectElementRect, labelComponents, layerFromContributions, cropDelta, rgbaToLinear } from '../src/core/analysis';

// Synthetic scene: dark background, three "windows" that light up with a soft glow.
function scene(w: number, h: number, lights: [number, number][], on: boolean) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 20 + ((x * 7 + y * 13) % 5), g = 26, b = 48;
      if (on) for (const [cx, cy] of lights) {
        const dd = Math.hypot(x - cx, y - cy);
        const core = Math.abs(x - cx) < 3 && Math.abs(y - cy) < 4 ? 1 : 0;
        const glow = Math.exp(-(dd * dd) / 300);
        r += 230 * core + 90 * glow; g += 170 * core + 60 * glow; b += 80 * core + 20 * glow;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return d;
}

describe('split analysis', () => {
  const w = 240, h = 120, L: [number, number][] = [[40, 40], [120, 50], [200, 40]];
  const res = analyzeSplit(scene(w, h, L, true), scene(w, h, L, false), w, h, { waterline: null });
  it('finds one light per window', () => {
    expect(res.lights.length).toBe(3);
    for (const [x, y] of L) expect(res.lights.some((l) => Math.hypot(l.x - x, l.y - y) < 3)).toBe(true);
  });
  it('gives every lit pixel weights that sum to one', () => {
    const { ids, weights } = res.layer;
    let bad = 0;
    for (let i = 0; i < w * h; i++) {
      const s = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
      if (res.lumD[i] > 0 && s !== 255) bad++;
      void ids;
    }
    expect(bad).toBe(0);
  });
  it('reproduces the lit image when every light is on', () => {
    const on = rgbaToLinear(scene(w, h, L, true), w * h);
    const off = rgbaToLinear(res.layer.base, w * h);
    let err = 0;
    for (let i = 0; i < w * h * 3; i++) err += Math.abs(off[i] + res.layer.delta[Math.floor(i / 3) * 4 + (i % 3)] - on[i]);
    expect(err / (w * h * 3)).toBeLessThan(0.004);
  });
  it('lets a light own the glow nearest to it', () => {
    const i = 50 * w + 120; // centre light
    const o = i * 4;
    const best = [0, 1, 2, 3].reduce((a, q) => (res.layer.weights[o + q] > res.layer.weights[o + a] ? q : a), 0);
    const id = res.layer.ids[o + best];
    const light = res.lights.find((l) => l.id === id)!;
    expect(Math.hypot(light.x - 120, light.y - 50)).toBeLessThan(4);
  });
});

describe('helpers', () => {
  it('labels 8-connected components', () => {
    const m = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1]);
    const { count } = labelComponents(m, 4, 3);
    expect(count).toBe(2);
  });
  it('fits a context crop inside the image with the requested aspect', () => {
    const c = contextCrop([990, 10, 20, 20], 1024, 576, 16 / 9);
    expect(c[0] + c[2]).toBeLessThanOrEqual(1024);
    expect(c[1]).toBeGreaterThanOrEqual(0);
    expect(Math.abs(c[2] / c[3] - 16 / 9)).toBeLessThan(0.02);
  });
  it('assigns everything to the remainder when there are no lights', () => {
    const lum = new Float32Array([0, 0.5, 0.2, 0]);
    const r = assignLights(lum, { lights: [], coreLight: new Uint8Array(4) }, { lights: [], w: 2, h: 2, waterline: null });
    expect(Array.from(r.weights.filter((_, i) => i % 4 === 0))).toEqual([0, 255, 255, 0]);
  });
  it('builds a layer from crop edits', () => {
    const w = 64, h = 32;
    const base = new Uint8ClampedArray(w * h * 4).fill(40);
    const baseLin = rgbaToLinear(base, w * h);
    const crop: [number, number, number, number] = [16, 0, 32, 32];
    const res = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4, g = Math.exp(-((x - 16) ** 2 + (y - 16) ** 2) / 40);
      res[i] = 40 + 200 * g; res[i + 1] = 40 + 150 * g; res[i + 2] = 40 + 60 * g; res[i + 3] = 255;
    }
    const cd = cropDelta(baseLin, w, h, crop, res, 7);
    const layer = layerFromContributions(w, h, base, [cd]);
    const centre = (16 * w + 32) * 4;
    expect(layer.ids[centre]).toBe(7);
    expect(layer.delta[centre]).toBeGreaterThan(0.3);
    expect(layer.delta[(16 * w + 2) * 4]).toBe(0); // outside the crop
  });
});

describe('moving element', () => {
  it('cuts out the element and its spill without NaNs', () => {
    const w = 200, h = 100;
    const plate = scene(w, h, [], false);
    const withTrain = (lit: boolean) => {
      const d = plate.slice();
      for (let y = 40; y < 52; y++) for (let x = 60; x < 120; x++) {
        const i = (y * w + x) * 4;
        const win = lit && y > 43 && y < 48 && x % 8 < 5;
        d[i] = win ? 250 : 70; d[i + 1] = win ? 190 : 72; d[i + 2] = win ? 110 : 90;
      }
      if (lit) for (let y = 52; y < 70; y++) for (let x = 60; x < 120; x++) { const i = (y * w + x) * 4; d[i] += 25; d[i + 1] += 15; }
      return d;
    };
    const rect = detectElementRect(withTrain(true), plate, w, h)!;
    expect(rect).not.toBeNull();
    expect(rect[0]).toBeLessThanOrEqual(62);
    const sp = computeSprite(withTrain(true), withTrain(false), plate, plate, w, h, rect);
    const bad = [sp.lit, sp.dark, sp.spill].reduce((a, arr) => a + arr.filter((v) => !Number.isFinite(v)).length, 0);
    expect(bad).toBe(0);
    expect(sp.flux).toBeGreaterThan(0);
    let spill = 0;
    for (let i = 0; i < sp.spill.length; i += 4) spill += sp.spill[i];
    expect(spill).toBeGreaterThan(0);
  });
});

describe('real image pair', () => {
  const on = 'scratch/klein3_gen.jpg', off = 'scratch/klein3_off.jpg';
  it.skipIf(!fs.existsSync(on))('finds the river and many lights in the model-test viaduct', () => {
    const dec = (p: string) => { const r = jpeg.decode(fs.readFileSync(p), { useTArray: true }); return { w: r.width, h: r.height, d: new Uint8ClampedArray(r.data.buffer) }; };
    const a = dec(on), b = dec(off);
    const res = analyzeSplit(a.d, b.d, a.w, a.h, {});
    expect(res.lights.length).toBeGreaterThan(80);
    expect(res.waterline).toBeGreaterThan(260);
    expect(res.waterline).toBeLessThan(310);
  });
});

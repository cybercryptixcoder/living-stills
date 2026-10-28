/// <reference lib="webworker" />
// Analysis worker: decodes images and runs the light analysis off the main thread.

import { analyzeScene, cropSource, plateSummary, type Decoded } from './sceneAnalysis';
import { detectElementRect } from './analysis';
import type { AnalysisResult, Rect, SceneDoc } from './types';

declare const self: DedicatedWorkerGlobalScope;

const decodeCache = new Map<string, Decoded>();
let currentImages: Record<string, Blob> = {};
let currentToken = '';

async function decode(blob: Blob, size?: [number, number]): Promise<Decoded> {
  const bmp = await createImageBitmap(blob);
  const w = size?.[0] ?? bmp.width, h = size?.[1] ?? bmp.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

function getter(token: string) {
  return async (key: string, size?: [number, number]) => {
    const blob = currentImages[`${token}/${key}`];
    if (!blob) throw new Error(`Missing image "${key}"`);
    const ck = `${token}|${key}|${size?.join('x') ?? ''}`;
    let hit = decodeCache.get(ck);
    if (!hit) {
      hit = await decode(blob, size);
      decodeCache.set(ck, hit);
      if (decodeCache.size > 64) decodeCache.delete(decodeCache.keys().next().value!);
    }
    return hit;
  };
}

function transferables(r: AnalysisResult): Transferable[] {
  // Layers can share buffers (an edited layer reuses the estimate's base), so de-duplicate.
  const t = new Set<ArrayBufferLike>();
  for (const L of r.layers) [L.base, L.delta, L.ids, L.weights].forEach((a) => t.add(a.buffer));
  if (r.sprite) [r.sprite.lit, r.sprite.dark, r.sprite.spill].forEach((a) => t.add(a.buffer));
  return [...t] as Transferable[];
}

async function encodePng(d: Decoded, outW?: number): Promise<Blob> {
  const c = new OffscreenCanvas(d.w, d.h);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.data), d.w, d.h), 0, 0);
  if (!outW || outW === d.w) return c.convertToBlob({ type: 'image/png' });
  const outH = Math.round((outW / d.w) * d.h);
  const big = new OffscreenCanvas(outW, outH);
  const ctx = big.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, outW, outH);
  return big.convertToBlob({ type: 'image/png' });
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, doc, images, token } = e.data as { id: number; type: string; doc: SceneDoc; images: Record<string, Blob>; token: string; [k: string]: unknown };
  try {
    if (images) { currentImages = { ...currentImages, ...images }; }
    if (token && token !== currentToken) currentToken = token;
    const get = getter(token ?? currentToken);
    if (type === 'analyze') {
      const r0 = await analyzeScene(doc, get);
      // The plate analysis is cached here for later crops, so hand over copies, never the cached buffers.
      const r = {
        ...r0,
        layers: r0.layers.map((L) => ({ base: L.base.slice(), delta: L.delta.slice(), ids: L.ids.slice(), weights: L.weights.slice() })),
        sprite: r0.sprite && { ...r0.sprite, lit: r0.sprite.lit.slice(), dark: r0.sprite.dark.slice(), spill: r0.sprite.spill.slice() },
      };
      self.postMessage({ id, ok: true, result: r }, transferables(r));
    } else if (type === 'crop') {
      const { src, crop, outW } = e.data as { src: Parameters<typeof cropSource>[2]; crop: Rect; outW?: number };
      const d = await cropSource(doc, get, src, crop);
      self.postMessage({ id, ok: true, result: await encodePng(d, outW) });
    } else if (type === 'detectElement') {
      const [on, plate] = await Promise.all([get('on', [doc.width, doc.height]), get('plateOn', [doc.width, doc.height])]);
      self.postMessage({ id, ok: true, result: detectElementRect(on.data, plate.data, doc.width, doc.height) });
    } else if (type === 'plate') {
      self.postMessage({ id, ok: true, result: await plateSummary(doc, get) });
    } else if (type === 'reset') {
      currentImages = {};
      decodeCache.clear();
      self.postMessage({ id, ok: true, result: null });
    } else throw new Error(`Unknown request ${type}`);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

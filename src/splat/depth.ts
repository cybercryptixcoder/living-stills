// Monocular depth in the browser: Depth Anything V2 (small) through transformers.js, on WebGPU
// when the browser has it, otherwise WebAssembly. The model (~25 MB) is downloaded once from the
// Hugging Face hub and cached by the browser.

export interface DepthMap {
  w: number;
  h: number;
  /** relative inverse depth, 0 (far) .. 1 (near) */
  data: Float32Array;
}

export type DepthModel = 'small' | 'base';
const MODELS: Record<DepthModel, string> = {
  small: 'onnx-community/depth-anything-v2-small', // ~27 MB: quick first look
  base: 'onnx-community/depth-anything-v2-base', // ~100 MB: the detailed pass
};
type DepthPipe = (input: unknown) => Promise<{ predicted_depth: { data: Float32Array; dims: number[] } }>;
const pipes: Partial<Record<DepthModel, Promise<DepthPipe>>> = {};

async function load(model: DepthModel, onProgress?: (p: number, text: string) => void): Promise<DepthPipe> {
  const t = await import('@huggingface/transformers');
  t.env.allowLocalModels = false;
  const gpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const files = new Map<string, number>();
  const progress = (e: { status: string; file?: string; progress?: number }) => {
    if (e.status === 'progress' && e.file) {
      files.set(e.file, e.progress ?? 0);
      const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size;
      onProgress?.(avg / 100, model === 'small' ? 'Downloading the depth model (once)' : 'Downloading the detailed depth model (once)');
    }
  };
  const p = await t.pipeline('depth-estimation', MODELS[model], { device: gpu ? 'webgpu' : 'wasm', dtype: gpu ? 'fp16' : 'q8', progress_callback: progress } as never);
  return p as unknown as DepthPipe;
}

/** Depth for a picture (relative inverse depth, 0 far .. 1 near). */
export async function estimateDepth(img: Blob, onProgress?: (p: number, text: string) => void, model: DepthModel = 'small'): Promise<DepthMap> {
  const pipe = (pipes[model] ??= load(model, onProgress).catch((err) => { delete pipes[model]; throw err; }));
  const p = await pipe;
  onProgress?.(1, model === 'small' ? 'Measuring depth' : 'Measuring depth in detail');
  const t = await import('@huggingface/transformers');
  const image = await t.RawImage.fromBlob(img);
  const out = await p(image);
  const d = out.predicted_depth;
  const [h, w] = d.dims.slice(-2);
  const src = d.data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < src.length; i++) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const data = new Float32Array(w * h);
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < data.length; i++) data[i] = (src[i] - lo) * k;
  return { w, h, data };
}

/** Depth map <-> 16-bit-in-two-channels PNG (kept with the scene, so it is measured only once). */
export async function depthToPng(d: DepthMap): Promise<Blob> {
  const c = new OffscreenCanvas(d.w, d.h);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(d.w, d.h);
  for (let i = 0; i < d.data.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, d.data[i])) * 65535);
    img.data[i * 4] = v >> 8; img.data[i * 4 + 1] = v & 255; img.data[i * 4 + 2] = v >> 8; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

export async function depthFromPng(b: Blob): Promise<DepthMap> {
  const bmp = await createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { colorSpace: 'srgb' })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Float32Array(bmp.width * bmp.height);
  for (let i = 0; i < data.length; i++) data[i] = ((px[i * 4] << 8) | px[i * 4 + 1]) / 65535;
  const out = { w: bmp.width, h: bmp.height, data };
  bmp.close();
  return out;
}

/**
 * Snaps depth edges to the picture's edges: a guided filter (He, Sun and Tang 2010) with the picture's
 * luminance as the guide, at the picture's full resolution. The depth model sees the picture at about
 * 518 px, so its edges are soft and slightly off; after this, a lamp post's outline in depth is the
 * lamp post's outline in the picture, which keeps foreground and background splats apart.
 */
export function refineDepth(d: DepthMap, rgba: Uint8ClampedArray, w: number, h: number, r = 6, eps = 2e-4): DepthMap {
  const n = w * h;
  const I = new Float32Array(n), P = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  // bilinear upsample of the depth to the picture
  for (let y = 0; y < h; y++) {
    const fy = Math.min(d.h - 1.001, Math.max(0, ((y + 0.5) / h) * d.h - 0.5)), y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(d.w - 1.001, Math.max(0, ((x + 0.5) / w) * d.w - 0.5)), x0 = Math.floor(fx), tx = fx - x0;
      const i = y0 * d.w + x0;
      P[y * w + x] = (d.data[i] * (1 - tx) + d.data[i + 1] * tx) * (1 - ty) + (d.data[i + d.w] * (1 - tx) + d.data[i + d.w + 1] * tx) * ty;
    }
  }
  const box = (src: Float32Array) => {
    const tmp = new Float32Array(n), out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    const k = 1 / ((2 * r + 1) * (2 * r + 1));
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc * k;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  };
  const mul = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };
  const mI = box(I), mP = box(P), mIP = box(mul(I, P)), mII = box(mul(I, I));
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIP[i] - mI[i] * mP[i], vr = mII[i] - mI[i] * mI[i];
    A[i] = cov / (vr + eps);
    B[i] = mP[i] - A[i] * mI[i];
  }
  const mA = box(A), mB = box(B);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, mA[i] * I[i] + mB[i]));
  return { w, h, data: out };
}

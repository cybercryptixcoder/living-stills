// Minimal OpenRouter image client. Calls go straight from the browser (OpenRouter allows CORS),
// so the key never touches any server of ours.

export const API = 'https://openrouter.ai/api/v1';

export interface ModelOption {
  id: string;
  name: string;
  /** USD per image by resolution tier. */
  price: Record<string, number>;
  resolutions: string[];
  aspects: string[];
  note: string;
  tested: boolean;
}

export const MODELS: ModelOption[] = [
  {
    id: 'black-forest-labs/flux-3-image-klein',
    name: 'FLUX 3 Image Klein',
    price: { '768': 0.008, '1K': 0.009, '1.5K': 0.011, '2K': 0.014 },
    resolutions: ['768', '1K', '1.5K', '2K'],
    aspects: ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16'],
    note: 'Cheapest model whose edits stay aligned to the pixel. Default.',
    tested: true,
  },
  {
    id: 'bytedance-seed/seedream-5-0-flash',
    name: 'Seedream 5.0 Flash',
    price: { '1K': 0.018, '2K': 0.018 },
    resolutions: ['1K', '2K'],
    aspects: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'],
    note: 'About twice the price. Not tested with this app.',
    tested: false,
  },
  {
    id: 'qwen/qwen-image-2.1-turbo',
    name: 'Qwen Image 2.1 Turbo',
    price: { '1K': 0.0184, '2K': 0.0184 },
    resolutions: ['1K', '2K'],
    aspects: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'],
    note: 'About twice the price. Not tested with this app.',
    tested: false,
  },
];

export const DEFAULT_MODEL = MODELS[0].id;
export const modelById = (id: string) => MODELS.find((m) => m.id === id) ?? MODELS[0];
export const priceOf = (model: string, res: string) => {
  const m = modelById(model);
  return m.price[res] ?? m.price[m.resolutions[0]];
};

export class ApiError extends Error {
  constructor(message: string, public status = 0, public retryable = false) {
    super(message);
  }
}

export interface GenResult {
  blob: Blob;
  cost: number;
  ms: number;
}

async function blobToDataUrl(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${b.type || 'image/png'};base64,${btoa(bin)}`;
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type });
}

function friendly(status: number, body: string): ApiError {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.message || '';
  } catch { /* not json */ }
  if (status === 401) return new ApiError('OpenRouter did not accept this key. Check it in Settings.', status);
  if (status === 402) return new ApiError('Your OpenRouter balance is too low for this image. Add credit, then try again.', status);
  if (status === 403) return new ApiError(msg ? `The model refused this request: ${msg}` : 'The model refused this request. Try rewording the description.', status);
  if (status === 408 || status === 429) return new ApiError('OpenRouter is busy right now. Trying again shortly.', status, true);
  if (status >= 500) return new ApiError(`The image service had a problem (${status}). Trying again shortly.`, status, true);
  return new ApiError(msg ? `OpenRouter: ${msg}` : `OpenRouter returned ${status}.`, status);
}

export interface GenOptions {
  key: string;
  model: string;
  prompt: string;
  refs?: Blob[];
  resolution?: string;
  aspectRatio?: string;
  signal?: AbortSignal;
}

export async function generateImage(o: GenOptions): Promise<GenResult> {
  const body: Record<string, unknown> = { model: o.model, prompt: o.prompt };
  if (o.resolution) body.resolution = o.resolution;
  if (o.aspectRatio) body.aspect_ratio = o.aspectRatio;
  if (o.refs?.length) {
    body.input_references = await Promise.all(o.refs.map(async (b) => ({ type: 'image_url', image_url: { url: await blobToDataUrl(b) } })));
  }
  let lastErr: ApiError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 2500 : 6000));
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${API}/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${o.key}`,
          'Content-Type': 'application/json',
          'X-Title': 'Living Stills',
        },
        body: JSON.stringify(body),
        signal: o.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      lastErr = new ApiError('Could not reach OpenRouter. Check your connection.', 0, true);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      lastErr = friendly(res.status, text);
      if (lastErr.retryable) continue;
      throw lastErr;
    }
    let j: { data?: { b64_json: string; media_type?: string }[]; usage?: { cost?: number } };
    try {
      j = JSON.parse(text);
    } catch {
      lastErr = new ApiError('OpenRouter sent a reply that was not an image.', res.status, true);
      continue;
    }
    const item = j.data?.[0];
    if (!item?.b64_json) {
      lastErr = new ApiError('The model returned no image. This sometimes happens with content filters; try rewording.', res.status, true);
      continue;
    }
    return {
      blob: base64ToBlob(item.b64_json, item.media_type || 'image/jpeg'),
      cost: j.usage?.cost ?? priceOf(o.model, o.resolution ?? '1K'),
      ms: performance.now() - t0,
    };
  }
  throw lastErr ?? new ApiError('Image generation failed.');
}

export interface KeyInfo {
  remaining: number | null;
  usage: number;
  limit: number | null;
}

export async function checkKey(key: string): Promise<KeyInfo> {
  let res: Response;
  try {
    res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new ApiError('Could not reach OpenRouter. Check your connection.');
  }
  if (!res.ok) throw friendly(res.status, await res.text());
  const j = (await res.json()).data;
  return { remaining: j.limit_remaining ?? null, usage: j.usage ?? 0, limit: j.limit ?? null };
}

/** Runs async jobs with bounded concurrency, preserving order of results. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Luminal text client (DeepSeek V4.1 Flash, OpenAI-compatible). Used for the director and for
// reading pictures (vision); images themselves come from OpenRouter.
//
// Luminal does not allow calls straight from a web page (no CORS), so requests go through a relay:
// the dev server has one built in at /luminal, and relay/worker.js is a one-file Cloudflare Worker
// for the published site. The key travels with each request and is never stored by the relay.
//
// Rules from the Luminal guide: always send reasoning_effort and max_tokens, stream everything,
// retry 429/503/drops with backoff, stay under ~12 concurrent requests.

export const LUMINAL_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';
export const DEV_RELAY = '/luminal';

export type Effort = 'none' | 'low' | 'medium' | 'high' | 'max';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
}

export interface ChatOptions {
  key: string;
  relay: string;
  messages: ChatMessage[];
  effort?: Effort;
  maxTokens?: number;
  json?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string, reasoning: string) => void;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  ms: number;
}

export class LuminalError extends Error {
  constructor(message: string, public status = 0, public retryable = false) { super(message); }
}

let sameOrigin = import.meta.env.DEV ? DEV_RELAY : '';

/**
 * Looks for a relay next to the page (`npm run dev` and `npm run serve` have one at /luminal; GitHub
 * Pages does not). A relay answers its routes (401 without a key); a static host answers 404.
 */
export async function detectRelay(): Promise<string> {
  if (import.meta.env.DEV) return sameOrigin;
  if (location.hostname.endsWith('github.io')) return ''; // static hosting: no relay can live next to the page
  try {
    const url = `${import.meta.env.BASE_URL}luminal`;
    const r = await fetch(`${url}/models`, { method: 'OPTIONS' });
    if (r.status === 204 || r.headers.get('access-control-allow-methods')) sameOrigin = url;
  } catch { /* no relay */ }
  return sameOrigin;
}

/** The relay to use: the setting if given, otherwise one served next to the page. */
export function relayUrl(setting: string): string {
  const s = setting.trim().replace(/\/+$/, '');
  return s || sameOrigin;
}

let inFlight = 0;
const waiters: (() => void)[] = [];
async function slot() {
  if (inFlight < 8) { inFlight++; return; }
  await new Promise<void>((r) => waiters.push(r));
  inFlight++;
}
function release() {
  inFlight--;
  waiters.shift()?.();
}

function friendly(status: number, body: string): LuminalError {
  let msg = '';
  try { msg = JSON.parse(body)?.error?.message ?? ''; } catch { /* not json */ }
  if (status === 401 || status === 403) return new LuminalError('Luminal did not accept this key. Check it in Settings.', status);
  if (status === 402) return new LuminalError('The Luminal wallet is empty.', status);
  if (status === 404) return new LuminalError('The relay did not answer at that address. Check the relay URL in Settings.', status);
  if (status === 429 || status === 503 || status >= 500) return new LuminalError(`Luminal is busy (${status}).`, status, true);
  return new LuminalError(msg ? `Luminal: ${msg}` : `Luminal returned ${status}.`, status);
}

export async function chat(o: ChatOptions): Promise<ChatResult> {
  if (!o.key) throw new LuminalError('Add a Luminal key in Settings to use the director.');
  const relay = relayUrl(o.relay);
  if (!relay) throw new LuminalError('The director needs a relay on the published site. Add the relay URL in Settings (see the note there).');
  const effort = o.effort ?? 'none';
  let max = o.maxTokens ?? 4000;
  if (effort !== 'none') max += 16000; // room for the hidden thinking
  const body: Record<string, unknown> = {
    model: LUMINAL_MODEL,
    messages: o.messages,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: effort,
    max_tokens: Math.min(393216, max),
    temperature: o.temperature ?? 0.7,
  };
  if (o.json) body.response_format = { type: 'json_object' };
  let last: LuminalError | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(16000, 2000 * 2 ** (attempt - 1)) + Math.random() * 600));
    const t0 = performance.now();
    await slot();
    try {
      let res: Response;
      try {
        res = await fetch(`${relay}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: o.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        last = new LuminalError('Could not reach the Luminal relay.', 0, true);
        continue;
      }
      if (!res.ok || !res.body) {
        last = friendly(res.status, await res.text().catch(() => ''));
        if (last.retryable) continue;
        throw last;
      }
      const out = await readStream(res.body, o.onDelta);
      if (!out.seen) { last = new LuminalError('Luminal sent an empty answer.', 0, true); continue; }
      return { content: out.content, reasoning: out.reasoning, usage: out.usage, ms: performance.now() - t0 };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      if (err instanceof LuminalError && !err.retryable) throw err;
      last = err instanceof LuminalError ? err : new LuminalError(`The answer was cut off: ${(err as Error).message}`, 0, true);
    } finally {
      release();
    }
  }
  throw last ?? new LuminalError('Luminal did not answer.');
}

async function readStream(stream: ReadableStream<Uint8Array>, onDelta?: ChatOptions['onDelta']) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', seen = false;
  let usage: ChatResult['usage'] = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // blank lines and ": ping"
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { content, reasoning, usage, seen };
      let chunk: { error?: unknown; usage?: ChatResult['usage']; choices?: { delta?: { content?: string; reasoning_content?: string } }[] };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new LuminalError(`Luminal stopped mid-answer: ${JSON.stringify(chunk.error).slice(0, 160)}`, 0, true);
      seen = true;
      if (chunk.usage) usage = chunk.usage;
      for (const ch of chunk.choices ?? []) {
        const d = ch.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
      }
      onDelta?.(content, reasoning);
    }
  }
  return { content, reasoning, usage, seen };
}

/** Pulls the first JSON object out of a reply (the model sometimes wraps it in a code fence). */
export function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1)) as T;
  throw new Error('The reply was not JSON.');
}

/** Checks a key through the relay (cheap: the balance route). */
export async function checkLuminal(key: string, relaySetting: string): Promise<number> {
  const relay = relayUrl(relaySetting);
  if (!relay) throw new LuminalError('No relay set.');
  const res = await fetch(`${relay}/balance`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw friendly(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  return (j.available_units ?? 0) / (j.units_per_usd ?? 1e10);
}

// Main-thread handle on the analysis worker.

import type { AnalysisResult, Rect, SceneDoc } from './types';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class Analyzer {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private sent = new WeakMap<Blob, Set<string>>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
  }

  private call<T>(msg: Record<string, unknown>, images: Record<string, Blob>, token: string): Promise<T> {
    const id = ++this.seq;
    // Each image is only cloned into the worker once; keys are namespaced by token.
    const fresh: Record<string, Blob> = {};
    for (const [k, b] of Object.entries(images)) {
      let tokens = this.sent.get(b);
      if (!tokens) this.sent.set(b, (tokens = new Set()));
      const name = `${token}/${k}`;
      if (!tokens.has(name)) { fresh[name] = b; tokens.add(name); }
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id, images: fresh, token });
    });
  }

  /** The worker sees keys as "<token>/<key>"; wrap the doc so lookups resolve. */
  private scoped(doc: SceneDoc, token: string): SceneDoc {
    const images: Record<string, string> = {};
    for (const k of Object.keys(doc.images)) images[k] = k;
    return { ...doc, images, id: `${token}:${doc.id}` };
  }

  analyze(doc: SceneDoc, images: Record<string, Blob>, token: string) {
    return this.call<AnalysisResult>({ type: 'analyze', doc: this.scoped(doc, token) }, images, token);
  }
  crop(doc: SceneDoc, images: Record<string, Blob>, token: string, src: { kind: 'image'; key: string }, crop: Rect, outW?: number) {
    return this.call<Blob>({ type: 'crop', doc: this.scoped(doc, token), src, crop, outW }, images, token);
  }
  detectElement(doc: SceneDoc, images: Record<string, Blob>, token: string) {
    return this.call<Rect | null>({ type: 'detectElement', doc: this.scoped(doc, token) }, images, token);
  }
}

let instance: Analyzer | null = null;
export const analyzer = () => (instance ??= new Analyzer());

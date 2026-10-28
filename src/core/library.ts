// Where scenes live: the bundled examples (fetched from /scenes) and the user's own
// scenes (IndexedDB in this browser). Bundles can be exported and imported as .zip files.

import { createStore, del, get, keys, set } from 'idb-keyval';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { SceneDoc } from './types';

export interface SceneBundle {
  doc: SceneDoc;
  images: Record<string, Blob>;
  source: 'example' | 'local';
}

export interface SceneEntry {
  id: string;
  title: string;
  method: SceneDoc['method'];
  cost: number;
  imageCount: number;
  source: 'example' | 'local';
  createdAt: string;
  order: number;
  /** URLs (examples) or blobs (local) for the two thumbnails. */
  thumbOff?: string | Blob;
  thumbOn?: string | Blob;
  doc: SceneDoc;
}

const store = createStore('living-stills', 'scenes');
const base = import.meta.env.BASE_URL;

const ext = (b: Blob) => (b.type.includes('png') ? 'png' : b.type.includes('webp') ? 'webp' : 'jpg');

export function entryFromDoc(doc: SceneDoc, source: SceneEntry['source'], images?: Record<string, Blob>): SceneEntry {
  const offKey = doc.method === 'layered' || doc.method === 'grid' ? 'off' : 'off';
  const url = (k: string) => (source === 'example' ? `${base}scenes/${doc.id}/${doc.images[k]}` : images?.[k]);
  return {
    id: doc.id, title: doc.title, method: doc.method, cost: doc.cost,
    imageCount: doc.steps.filter((s) => s.image).length,
    source, createdAt: doc.createdAt, order: doc.demo?.order ?? 100,
    thumbOff: doc.images[offKey] ? url(offKey) : undefined,
    thumbOn: doc.images.on ? url('on') : undefined,
    doc,
  };
}

export async function listExamples(): Promise<SceneEntry[]> {
  try {
    const res = await fetch(`${base}scenes/index.json`, { cache: 'no-cache' });
    if (!res.ok) return [];
    const ids: string[] = await res.json();
    const docs = await Promise.all(ids.map(async (id) => {
      const r = await fetch(`${base}scenes/${id}/scene.json`, { cache: 'no-cache' });
      return r.ok ? ((await r.json()) as SceneDoc) : null;
    }));
    return docs.filter((d): d is SceneDoc => !!d).map((d) => entryFromDoc(d, 'example')).sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

export async function listLocal(): Promise<SceneEntry[]> {
  const ks = (await keys(store)).filter((k) => String(k).startsWith('scene:'));
  const out: SceneEntry[] = [];
  for (const k of ks) {
    const v = await get<{ doc: SceneDoc; images: Record<string, Blob> }>(k, store);
    if (v) out.push(entryFromDoc(v.doc, 'local', v.images));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadBundle(entry: SceneEntry): Promise<SceneBundle> {
  if (entry.source === 'local') {
    const v = await get<{ doc: SceneDoc; images: Record<string, Blob> }>(`scene:${entry.id}`, store);
    if (!v) throw new Error('This scene is no longer stored in this browser.');
    return { ...v, source: 'local' };
  }
  const doc = entry.doc;
  const images: Record<string, Blob> = {};
  await Promise.all(Object.entries(doc.images).map(async ([k, file]) => {
    const r = await fetch(`${base}scenes/${doc.id}/${file}`);
    if (!r.ok) throw new Error(`Could not load ${file}`);
    images[k] = await r.blob();
  }));
  return { doc, images, source: 'example' };
}

export async function saveLocal(b: { doc: SceneDoc; images: Record<string, Blob> }) {
  // keep only images the doc refers to
  const images: Record<string, Blob> = {};
  for (const k of Object.keys(b.doc.images)) if (b.images[k]) images[k] = b.images[k];
  await set(`scene:${b.doc.id}`, { doc: b.doc, images }, store);
}

export async function deleteLocal(id: string) {
  await del(`scene:${id}`, store);
}

/** Bundle -> .zip (scene.json + image files named as in doc.images). */
export async function exportZip(b: { doc: SceneDoc; images: Record<string, Blob> }): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const doc: SceneDoc = { ...b.doc, images: {} };
  for (const [k, blob] of Object.entries(b.images)) {
    if (!(k in b.doc.images)) continue;
    const name = `${k}.${ext(blob)}`;
    doc.images[k] = name;
    files[name] = new Uint8Array(await blob.arrayBuffer());
  }
  files['scene.json'] = strToU8(JSON.stringify(doc, null, 2));
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
}

export async function importZip(file: Blob): Promise<{ doc: SceneDoc; images: Record<string, Blob> }> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = files['scene.json'];
  if (!raw) throw new Error('This file is not a Living Stills scene (scene.json is missing).');
  const doc = JSON.parse(strFromU8(raw)) as SceneDoc;
  const images: Record<string, Blob> = {};
  for (const [k, name] of Object.entries(doc.images)) {
    const data = files[name];
    if (!data) throw new Error(`The scene file is missing ${name}.`);
    const type = name.endsWith('png') ? 'image/png' : name.endsWith('webp') ? 'image/webp' : 'image/jpeg';
    images[k] = new Blob([data.buffer as ArrayBuffer], { type });
  }
  return { doc, images };
}

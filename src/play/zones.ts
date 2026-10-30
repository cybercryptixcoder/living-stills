// Zones: lights gathered into a handful of nearby groups (k-means on position). A zone is what
// "its group" means when you click a light, and what the director and the vision labels refer to.

import type { GroupInfo, LightInfo } from '../core/types';

export interface Zone {
  n: number; // 1-based, as shown to the director
  lights: number[]; // engine indices
  x: number; // centre, image px
  y: number;
  bbox: [number, number, number, number];
  name: string;
}

export function computeZones(lights: LightInfo[], w: number, h: number): Zone[] {
  const n = lights.length;
  if (!n) return [];
  const k = Math.max(1, Math.min(12, n < 4 ? n : Math.round(Math.sqrt(n / 2)) + 1));
  // deterministic start: farthest-point seeding from the top-left light, weighted by flux
  const pts = lights.map((L) => [L.x / w, (L.y / h) * (h / w)]);
  const cent: number[][] = [];
  let first = 0;
  for (let i = 1; i < n; i++) if (pts[i][0] + pts[i][1] < pts[first][0] + pts[first][1]) first = i;
  cent.push([...pts[first]]);
  const dmin = new Float64Array(n).fill(Infinity);
  while (cent.length < k) {
    let best = -1, bd = -1;
    for (let i = 0; i < n; i++) {
      const c = cent[cent.length - 1];
      dmin[i] = Math.min(dmin[i], (pts[i][0] - c[0]) ** 2 + (pts[i][1] - c[1]) ** 2);
      const score = dmin[i] * Math.sqrt(1 + lights[i].flux);
      if (score > bd) { bd = score; best = i; }
    }
    if (best < 0 || bd <= 0) break;
    cent.push([...pts[best]]);
  }
  const of = new Int32Array(n);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < n; i++) {
      let b = 0, bd = Infinity;
      cent.forEach((c, j) => { const d = (pts[i][0] - c[0]) ** 2 + (pts[i][1] - c[1]) ** 2; if (d < bd) { bd = d; b = j; } });
      of[i] = b;
    }
    cent.forEach((c, j) => {
      let sx = 0, sy = 0, m = 0;
      for (let i = 0; i < n; i++) if (of[i] === j) { sx += pts[i][0]; sy += pts[i][1]; m++; }
      if (m) { c[0] = sx / m; c[1] = sy / m; }
    });
  }
  const zones = cent.map((_, j) => lights.map((_, i) => i).filter((i) => of[i] === j)).filter((ix) => ix.length);
  // reading order: top to bottom, left to right
  zones.sort((a, b) => {
    const ay = a.reduce((s, i) => s + lights[i].y, 0) / a.length, by = b.reduce((s, i) => s + lights[i].y, 0) / b.length;
    const ax = a.reduce((s, i) => s + lights[i].x, 0) / a.length, bx = b.reduce((s, i) => s + lights[i].x, 0) / b.length;
    return Math.round((ay - by) / (h * 0.18)) || ax - bx;
  });
  return zones.map((ix, j) => fromIndices(j + 1, ix, lights, w, h));
}

function fromIndices(n: number, ix: number[], lights: LightInfo[], w: number, h: number, name?: string): Zone {
  const xs = ix.map((i) => lights[i]);
  const x = xs.reduce((s, L) => s + L.x, 0) / xs.length, y = xs.reduce((s, L) => s + L.y, 0) / xs.length;
  const bbox: [number, number, number, number] = [
    Math.min(...xs.map((L) => L.bbox[0])), Math.min(...xs.map((L) => L.bbox[1])),
    Math.max(...xs.map((L) => L.bbox[2])), Math.max(...xs.map((L) => L.bbox[3])),
  ];
  return { n, lights: ix, x, y, bbox, name: name ?? describeArea(x, y, w, h) };
}

/** Two-stage scenes keep the user's own groups (one per placed light). */
export function zonesFromGroups(groups: GroupInfo[], lights: LightInfo[], w: number, h: number): Zone[] {
  const index = new Map(lights.map((L, i) => [L.id, i]));
  return groups.map((g, j) => fromIndices(j + 1, g.lights.map((id) => index.get(id)!).filter((i) => i != null), lights, w, h, g.name)).filter((z) => z.lights.length);
}

export function describeArea(x: number, y: number, w: number, h: number) {
  const v = y < h / 3 ? 'top' : y > (2 * h) / 3 ? 'bottom' : 'middle';
  const s = x < w / 3 ? 'left' : x > (2 * w) / 3 ? 'right' : 'centre';
  if (v === 'middle' && s === 'centre') return 'Lights in the centre';
  if (v === 'middle') return `Lights on the ${s}`;
  return `Lights ${v} ${s === 'centre' ? 'centre' : s}`;
}

/** Fingerprint of a zone layout, so saved labels are only reused for the same zones. */
export function zonesKey(zones: Zone[], w: number): string {
  return zones.map((z) => `${Math.round((z.x / w) * 50)}.${Math.round((z.y / w) * 50)}.${z.lights.length}`).join('|');
}

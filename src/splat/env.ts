// The 3D space: views of the same place from around it, each lifted with its own depth and turned
// into place on a circle around the scene's centre, merged into one set of splats.

import type { DepthMap } from './depth';
import { View3D } from './view';

export const ENV_FLOATS = 10; // wx, wy, wz, view, nx, ny, nz, u, v, layer

export interface EnvView { angle: number; depth: DepthMap }

export interface EnvGeometry {
  data: Float32Array;
  count: number;
  stride: number;
  radius: number;
  /** each view's camera-to-world rotation angle (degrees, after alignment) */
  angles: number[];
}

/** camera-to-world rotation for a camera that has circled the centre by `deg` (clockwise from above) */
export function orbitRotation(deg: number): number[] {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  // columns: camera right, camera down, camera forward
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

const mul3 = (M: number[], v: number[]) => [
  M[0] * v[0] + M[3] * v[1] + M[6] * v[2],
  M[1] * v[0] + M[4] * v[1] + M[7] * v[2],
  M[2] * v[0] + M[5] * v[1] + M[8] * v[2],
];

/**
 * Lifts every view and turns it into place. Each view's depth is relative, so its scale is set so that
 * the centre of its picture (the point the camera circles) is at the same distance in every view.
 */
export function buildEnv(views: EnvView[], w: number, h: number, strength: number, stride: number): EnvGeometry {
  const pts: number[] = [];
  const v0 = new View3D();
  v0.cam.strength = strength;
  v0.setScene(views[0].depth, w, h);
  const centre = (v: View3D) => {
    // median depth in a small window at the centre: robust to a thin pole right in the middle
    const ds: number[] = [];
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) ds.push(v.lift(w / 2 + x * w * 0.02, h / 2 + y * h * 0.02, v.depthAt(w / 2 + x * w * 0.02, h / 2 + y * h * 0.02))[2]);
    ds.sort((a, b) => a - b);
    return ds[ds.length >> 1];
  };
  const R = centre(v0);
  views.forEach((view, k) => {
    const v = k === 0 ? v0 : new View3D();
    if (k) { v.cam.strength = strength; v.setScene(view.depth, w, h); }
    const scale = R / centre(v);
    const M = orbitRotation(view.angle);
    const span = Math.max(6, stride * 3);
    const toWorld = (p: number[]) => { const q = mul3(M, [p[0] * scale, p[1] * scale, p[2] * scale - R]); return q; };
    for (let y = stride / 2; y < h; y += stride)
      for (let x = stride / 2; x < w; x += stride) {
        let d = v.depthAt(x, y);
        // flying pixels on outlines snap to the nearer side
        let lo = d, hi = d;
        for (let dy = -stride; dy <= stride; dy += stride)
          for (let dx = -stride; dx <= stride; dx += stride) { const e = v.depthAt(x + dx, y + dy); if (e < lo) lo = e; if (e > hi) hi = e; }
        if (hi - lo > 0.04) d = hi - d < d - lo ? hi : lo;
        const pc = v.lift(x, y, d);
        const p = toWorld(pc);
        const foot = (stride * pc[2] * scale) / v.focal;
        const a = v.lift(x - span, y, v.depthAt(x - span, y)), b = v.lift(x + span, y, v.depthAt(x + span, y));
        const c = v.lift(x, y - span, v.depthAt(x, y - span)), e = v.lift(x, y + span, v.depthAt(x, y + span));
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = e[0] - c[0], vy = e[1] - c[1], vz = e[2] - c[2];
        let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map((q) => q / len);
        if (n[2] > 0) n = n.map((q) => -q);
        n = mul3(M, n);
        pts.push(p[0], p[1], p[2], k, n[0], n[1], n[2], x, y, foot);
      }
  });
  const data = new Float32Array(pts);
  return { data, count: data.length / ENV_FLOATS, stride, radius: R, angles: views.map((v) => v.angle) };
}

/** The camera moving around the space: yaw any way round, pitch a little, distance in and out. */
export class EnvCamera {
  yaw = 0; // degrees, clockwise from above, 0 = the original picture's camera
  pitch = 0; // degrees, up is positive
  dist = 1; // multiple of the orbit radius
  goal = { yaw: 0, pitch: 0, dist: 1 };
  view = new Float32Array(16);
  eye: [number, number, number] = [0, 0, 0];

  step(dt: number) {
    const k = 1 - Math.exp(-dt * 5);
    this.yaw += (this.goal.yaw - this.yaw) * k;
    this.pitch += (this.goal.pitch - this.pitch) * k;
    this.dist += (this.goal.dist - this.dist) * k;
  }

  /** world -> camera matrix (column-major) for a radius R */
  update(R: number) {
    const M = orbitRotation(this.yaw);
    const p = (this.pitch * Math.PI) / 180, cp = Math.cos(p), sp = Math.sin(p);
    // pitch: rotate about the camera's right axis; up (negative y) looks down at the centre
    const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp]; // columns
    const C = [0, 1, 2].flatMap((col) => mul3(M, [Rx[col * 3], Rx[col * 3 + 1], Rx[col * 3 + 2]]));
    const D = R * this.dist;
    const pos = mul3(C, [0, 0, -D]);
    this.eye = [pos[0], pos[1], pos[2]];
    // world -> camera = C^T (x - pos)
    const t = [-(C[0] * pos[0] + C[1] * pos[1] + C[2] * pos[2]), -(C[3] * pos[0] + C[4] * pos[1] + C[5] * pos[2]), -(C[6] * pos[0] + C[7] * pos[1] + C[8] * pos[2])];
    this.view.set([C[0], C[3], C[6], 0, C[1], C[4], C[7], 0, C[2], C[5], C[8], 0, t[0], t[1], t[2], 1]);
  }

  project(p: number[], focal: number, w: number, h: number, zoom = 1): [number, number, number] {
    const m = this.view;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    return [(x / Math.max(z, 0.05)) * focal * zoom + w / 2, (y / Math.max(z, 0.05)) * focal * zoom + h / 2, z];
  }
}

/** Where a picture pixel of view 0 sits in the space (for lights and the overlay). */
export function worldOf(v0: View3D, x: number, y: number, R: number): number[] {
  const p = v0.lift(x, y, v0.depthAt(x, y));
  return [p[0], p[1], p[2] - R];
}

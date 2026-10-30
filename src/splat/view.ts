// The 3D view: splat geometry from a depth map, the camera, and the same projection the shaders
// use (so clicks and the overlay line up with what is drawn).

import type { DepthMap } from './depth';

export interface SplatGeometry {
  data: Float32Array; // per point: x, y, d, layer, nx, ny, nz, srcX, srcY
  count: number;
  stride: number;
}

export const FLOATS_PER_POINT = 9;

export interface Camera3D {
  yaw: number; // radians, camera turned around the pivot
  pitch: number;
  dolly: number; // forward move, fraction of the pivot distance
  strength: number; // depth strength (how far the far plane is)
}

export class View3D {
  depth: DepthMap | null = null;
  w = 1;
  h = 1;
  focal = 1;
  cam: Camera3D = { yaw: 0, pitch: 0, dolly: 0, strength: 1 };
  /** the camera being eased towards */
  goal: Camera3D = { yaw: 0, pitch: 0, dolly: 0, strength: 1 };
  view = new Float32Array(16);
  /** a slight zoom while the camera is moved, so the picture's edges stay covered */
  zoom = 1;
  eye: [number, number, number] = [0, 0, 0];
  pivot = 2;

  setScene(depth: DepthMap, w: number, h: number) {
    this.depth = depth;
    this.w = w;
    this.h = h;
    this.focal = (0.5 * w) / Math.tan((52 * Math.PI) / 360);
    this.update();
  }

  get zRange(): [number, number] {
    const zNear = 1, zFar = 1 + 4 * this.cam.strength;
    return [1 / zFar, 1 / zNear];
  }

  /** depth (0 far .. 1 near) at an image pixel, bilinear */
  depthAt(x: number, y: number): number {
    const d = this.depth;
    if (!d) return 0.5;
    const fx = Math.min(d.w - 1.001, Math.max(0, (x / this.w) * d.w - 0.5));
    const fy = Math.min(d.h - 1.001, Math.max(0, (y / this.h) * d.h - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const i = y0 * d.w + x0;
    const a = d.data[i], b = d.data[i + 1], c = d.data[i + d.w], e = d.data[i + d.w + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }

  lift(x: number, y: number, d: number): [number, number, number] {
    const [s0, s1] = this.zRange;
    const z = 1 / (s0 + (s1 - s0) * d);
    return [((x - 0.5 * this.w) / this.focal) * z, ((y - 0.5 * this.h) / this.focal) * z, z];
  }

  /** Recomputes the view matrix: the camera turns around a pivot at the scene's middle depth. */
  update() {
    const c = this.cam;
    const [s0, s1] = this.zRange;
    this.pivot = 1 / (s0 + (s1 - s0) * 0.45);
    const P = [0, 0, this.pivot];
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    // camera rotation R = Ry(yaw) * Rx(pitch); points move by R^T around the pivot
    const R = [
      cy, sy * sp, sy * cp,
      0, cp, -sp,
      -sy, cy * sp, cy * cp,
    ];
    const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const t = [0, 0, this.pivot * c.dolly]; // moving forward
    // q = Rt (p - P) + P - t
    const off = [
      P[0] - (Rt[0] * P[0] + Rt[1] * P[1] + Rt[2] * P[2]) - t[0],
      P[1] - (Rt[3] * P[0] + Rt[4] * P[1] + Rt[5] * P[2]) - t[1],
      P[2] - (Rt[6] * P[0] + Rt[7] * P[1] + Rt[8] * P[2]) - t[2],
    ];
    const m = this.view;
    // column-major mat4
    m.set([Rt[0], Rt[3], Rt[6], 0, Rt[1], Rt[4], Rt[7], 0, Rt[2], Rt[5], Rt[8], 0, off[0], off[1], off[2], 1]);
    // eye in original space: solve q = 0 -> p = R (t - off') ... p = P + R (t - P) + ... use inverse
    const u = [t[0] - P[0] + P[0] * 0, t[1] - P[1], t[2] - P[2]];
    this.zoom = 1 + 0.9 * Math.abs(c.yaw) + 1.1 * Math.abs(c.pitch) + Math.max(0, c.dolly) * 0.5;
    this.eye = [
      P[0] + R[0] * u[0] + R[1] * u[1] + R[2] * u[2],
      P[1] + R[3] * u[0] + R[4] * u[1] + R[5] * u[2],
      P[2] + R[6] * u[0] + R[7] * u[1] + R[8] * u[2],
    ];
  }

  /** Eases the camera towards its goal; returns true while still moving. */
  step(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 6);
    const c = this.cam, g = this.goal;
    let moving = false;
    for (const key of ['yaw', 'pitch', 'dolly', 'strength'] as const) {
      const d = g[key] - c[key];
      if (Math.abs(d) > 1e-5) { c[key] += d * k; moving = true; }
    }
    this.update();
    return moving;
  }

  /** Image pixel (with its depth) -> where it lands in the moved view, in image pixels. */
  project(x: number, y: number, d = this.depthAt(x, y)): [number, number] {
    const p = this.lift(x, y, d);
    const m = this.view;
    const qx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const qy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const qz = Math.max(0.05, m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
    return [(qx / qz) * this.focal * this.zoom + 0.5 * this.w, (qy / qz) * this.focal * this.zoom + 0.5 * this.h];
  }

  /** Where in the picture a point of the moved view comes from (a few fixed-point steps). */
  unproject(sx: number, sy: number): [number, number] {
    let x = sx, y = sy;
    for (let i = 0; i < 4; i++) {
      const [px, py] = this.project(x, y);
      x += sx - px;
      y += sy - py;
    }
    return [x, y];
  }

  get moved() {
    const c = this.cam;
    return Math.abs(c.yaw) + Math.abs(c.pitch) + Math.abs(c.dolly) > 1e-4;
  }
}

/** Points for the splats: a surface layer every `stride` px and a layer behind depth edges. */
/** Box blur (separable, repeated) of a depth map: normals for highlights come from broad surfaces. */
function smoothDepth(d: DepthMap, r: number, passes = 2): DepthMap {
  let src = d.data;
  for (let k = 0; k < passes; k++) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < d.h; y++) {
      let acc = 0;
      const row = y * d.w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(d.w - 1, Math.max(0, x))];
      for (let x = 0; x < d.w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(d.w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < d.w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(d.h - 1, Math.max(0, y)) * d.w + x];
      for (let y = 0; y < d.h; y++) {
        out[y * d.w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(d.h - 1, y + r + 1) * d.w + x] - tmp[Math.max(0, y - r) * d.w + x];
      }
    }
    src = out;
  }
  return { w: d.w, h: d.h, data: src };
}

export function buildSplats(view: View3D, w: number, h: number, stride = 2): SplatGeometry {
  const pts: number[] = [];
  const at = (x: number, y: number) => view.depthAt(x, y);
  // normals from a smoothed copy of the depth: broad surfaces (walls, floor, a table) catch the
  // highlights; the fine texture of the depth map would otherwise throw random glints
  const smooth = new View3D();
  smooth.setScene(smoothDepth(view.depth!, Math.max(3, Math.round(view.depth!.w / 160))), w, h);
  smooth.cam = { ...view.cam };
  smooth.update();
  const lifted = (x: number, y: number) => smooth.lift(x, y, smooth.depthAt(x, y));
  const span = Math.max(6, stride * 4);
  const push = (x: number, y: number, d: number, layer: number, sx: number, sy: number) => {
    const a = lifted(x - span, y), b = lifted(x + span, y), c = lifted(x, y - span), e = lifted(x, y + span);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = e[0] - c[0], vy = e[1] - c[1], vz = e[2] - c[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; } // face the camera
    pts.push(x, y, d, layer, nx, ny, nz, sx, sy);
  };
  // "flying pixels": at an object's outline the depth is a blend of the object and what is behind
  // it, which would leave splats floating in between. Snap those to the nearer side.
  const e = Math.max(1, stride);
  for (let y = stride / 2; y < h; y += stride)
    for (let x = stride / 2; x < w; x += stride) {
      let d = at(x, y);
      let lo = d, hi = d;
      for (let dy = -e; dy <= e; dy += e)
        for (let dx = -e; dx <= e; dx += e) {
          const v = at(x + dx, y + dy);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo > 0.04) d = hi - d < d - lo ? hi : lo;
      push(x, y, d, 0, x, y);
    }
  // behind depth edges: what a moving camera uncovers is guessed as the far side continuing
  const s2 = stride * 2, R = stride * 4;
  for (let y = s2 / 2; y < h; y += s2)
    for (let x = s2 / 2; x < w; x += s2) {
      let lo = Infinity, hi = -Infinity, fx = x, fy = y;
      for (let dy = -R; dy <= R; dy += stride)
        for (let dx = -R; dx <= R; dx += stride) {
          const d = at(x + dx, y + dy);
          if (d < lo) { lo = d; fx = x + dx; fy = y + dy; }
          if (d > hi) hi = d;
        }
      if (hi - lo > 0.06) push(x, y, lo, 1, Math.min(w - 1, Math.max(0, fx)), Math.min(h - 1, Math.max(0, fy)));
    }
  const data = new Float32Array(pts);
  return { data, count: data.length / FLOATS_PER_POINT, stride };
}

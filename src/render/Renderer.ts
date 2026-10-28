// WebGL2 compositor. One draw of the composite shader per frame at image resolution, then a
// blur pyramid for glow and the backdrop, then a final pass to the screen.

import type { LayerData, SpriteData } from '../core/types';
import { COMPOSITE, DOWN, FINAL, UP, VERT } from './shaders';

export interface RenderInput {
  w: number;
  h: number;
  layers: LayerData[];
  sprite?: SpriteData;
}

export interface RenderParams {
  layerA: number;
  layerB: number;
  mix: number;
  ambient: number;
  exposure: number;
  glow: number;
  haze: number;
  grain: number;
  spriteDx: number;
  spriteT: number;
  spriteGain: [number, number, number];
  radius: number; // css px
  backdrop: number;
}

export interface Rect { x: number; y: number; w: number; h: number }

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { fb: WebGLFramebuffer; tex: WebGLTexture[]; w: number; h: number };

const LEVELS = 6;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private progs: Record<'comp' | 'down' | 'up' | 'final', Prog>;
  private vao: WebGLVertexArrayObject;
  private tex: Record<string, WebGLTexture | null> = {};
  private scene: Target | null = null;
  private glowDown: Target[] = [];
  private glowUp: Target[] = [];
  private backDown: Target[] = [];
  private input: RenderInput | null = null;
  private floatFb: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  lost = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser cannot run WebGL2, which Living Stills needs to draw the lights.');
    this.gl = gl;
    this.floatFb = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.progs = {
      comp: this.program(COMPOSITE),
      down: this.program(DOWN),
      up: this.program(UP),
      final: this.program(FINAL),
    };
    this.vao = gl.createVertexArray()!;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  private program(frag: string): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link error: ${gl.getProgramInfoLog(p)}`);
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  private texParams(target: number, filter: number) {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private array(name: string, internal: number, type: number, filter: number, w: number, h: number, data: ArrayBufferView[]) {
    const gl = this.gl;
    if (this.tex[name]) gl.deleteTexture(this.tex[name]);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    this.texParams(gl.TEXTURE_2D_ARRAY, filter);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internal, w, h, data.length);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    data.forEach((d, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, h, 1, gl.RGBA, type, d));
    this.tex[name] = t;
  }

  private tex2d(name: string, internal: number, type: number, filter: number, w: number, h: number, data: ArrayBufferView | null) {
    const gl = this.gl;
    if (this.tex[name]) gl.deleteTexture(this.tex[name]);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    this.texParams(gl.TEXTURE_2D, filter);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, type, data);
    this.tex[name] = t;
  }

  private target(w: number, h: number, count = 1): Target {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const tex: WebGLTexture[] = [];
    const internal = this.floatFb ? gl.RGBA16F : gl.RGBA8;
    for (let i = 0; i < count; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      this.texParams(gl.TEXTURE_2D, gl.LINEAR);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      tex.push(t);
    }
    gl.drawBuffers(tex.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  private freeTarget(t: Target | null) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    t.tex.forEach((x) => this.gl.deleteTexture(x));
  }

  load(input: RenderInput) {
    const gl = this.gl;
    const { w, h, layers, sprite } = input;
    this.input = input;
    this.array('base', gl.SRGB8_ALPHA8, gl.UNSIGNED_BYTE, gl.LINEAR, w, h, layers.map((l) => new Uint8Array(l.base.buffer, l.base.byteOffset, l.base.byteLength)));
    this.array('delta', gl.RGBA16F, gl.FLOAT, gl.LINEAR, w, h, layers.map((l) => l.delta));
    this.array('ids', gl.RGBA8, gl.UNSIGNED_BYTE, gl.NEAREST, w, h, layers.map((l) => l.ids));
    this.array('w', gl.RGBA8, gl.UNSIGNED_BYTE, gl.NEAREST, w, h, layers.map((l) => l.weights));
    this.tex2d('table', gl.RGBA32F, gl.FLOAT, gl.NEAREST, 256, 1, new Float32Array(256 * 4));
    if (sprite) {
      this.tex2d('spLit', gl.RGBA16F, gl.FLOAT, gl.LINEAR, sprite.rect[2], sprite.rect[3], sprite.lit);
      this.tex2d('spDark', gl.RGBA16F, gl.FLOAT, gl.LINEAR, sprite.rect[2], sprite.rect[3], sprite.dark);
      this.tex2d('spill', gl.RGBA16F, gl.FLOAT, gl.LINEAR, sprite.spillRect[2], sprite.spillRect[3], sprite.spill);
    }
    this.freeTarget(this.scene);
    [...this.glowDown, ...this.glowUp, ...this.backDown].forEach((t) => this.freeTarget(t));
    this.scene = this.target(w, h, 2);
    this.glowDown = [];
    this.glowUp = [];
    this.backDown = [];
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(2, Math.ceil(lw / 2));
      lh = Math.max(2, Math.ceil(lh / 2));
      this.glowDown.push(this.target(lw, lh));
      this.glowUp.push(this.target(lw, lh));
      if (i < 5) this.backDown.push(this.target(lw, lh));
    }
  }

  get loaded() {
    return !!this.input;
  }

  setTable(table: Float32Array) {
    const gl = this.gl;
    if (!this.tex.table) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.table);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.FLOAT, table);
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const W = Math.max(1, Math.round(cssW * dpr)), H = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  private bindTex(prog: Prog, name: string, unit: number, tex: WebGLTexture | null, target: number = this.gl.TEXTURE_2D) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
    gl.uniform1i(prog.u[name], unit);
  }

  private pass(t: Target | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  draw(p: RenderParams, time: number) {
    const gl = this.gl;
    if (!this.input || !this.scene || this.lost) return;
    const { w, h, sprite } = this.input;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 1. composite
    const c = this.progs.comp;
    gl.useProgram(c.p);
    this.bindTex(c, 'uBase', 0, this.tex.base, gl.TEXTURE_2D_ARRAY);
    this.bindTex(c, 'uDelta', 1, this.tex.delta, gl.TEXTURE_2D_ARRAY);
    this.bindTex(c, 'uIds', 2, this.tex.ids, gl.TEXTURE_2D_ARRAY);
    this.bindTex(c, 'uW', 3, this.tex.w, gl.TEXTURE_2D_ARRAY);
    this.bindTex(c, 'uTable', 4, this.tex.table);
    gl.uniform2f(c.u.uSize, w, h);
    gl.uniform1i(c.u.uLayerA, p.layerA);
    gl.uniform1i(c.u.uLayerB, p.layerB);
    gl.uniform1f(c.u.uMix, p.mix);
    gl.uniform1f(c.u.uAmbient, p.ambient);
    gl.uniform1i(c.u.uHasSprite, sprite ? 1 : 0);
    if (sprite) {
      this.bindTex(c, 'uSpLit', 5, this.tex.spLit);
      this.bindTex(c, 'uSpDark', 6, this.tex.spDark);
      this.bindTex(c, 'uSpill', 7, this.tex.spill);
      gl.uniform4f(c.u.uSpRect, ...sprite.rect);
      gl.uniform4f(c.u.uSpillRect, ...sprite.spillRect);
      gl.uniform1f(c.u.uSpDx, p.spriteDx);
      gl.uniform1f(c.u.uSpT, p.spriteT);
      gl.uniform3f(c.u.uSpGain, ...p.spriteGain);
    } else {
      // keep samplers valid
      this.bindTex(c, 'uSpLit', 5, this.tex.table);
      this.bindTex(c, 'uSpDark', 6, this.tex.table);
      this.bindTex(c, 'uSpill', 7, this.tex.table);
    }
    this.pass(this.scene);

    // 2. pyramids: glow from the light-only target, backdrop from the colour target
    const d = this.progs.down;
    gl.useProgram(d.p);
    const down = (src: WebGLTexture, sw: number, sh: number, chain: Target[]) => {
      let s = src, w0 = sw, h0 = sh;
      for (const t of chain) {
        this.bindTex(d, 'uSrc', 0, s);
        gl.uniform2f(d.u.uTexel, 1 / w0, 1 / h0);
        this.pass(t);
        s = t.tex[0]; w0 = t.w; h0 = t.h;
      }
    };
    down(this.scene.tex[1], w, h, this.glowDown);
    down(this.scene.tex[0], w, h, this.backDown);
    const u = this.progs.up;
    gl.useProgram(u.p);
    const weights = [0.5 * p.glow, 0.42 * p.glow, 0.28 * p.glow + 0.22 * p.haze, 0.45 * p.haze, 0.6 * p.haze, 0.75 * p.haze];
    for (let i = LEVELS - 1; i >= 0; i--) {
      const low = i === LEVELS - 1 ? this.glowDown[i] : this.glowUp[i + 1];
      this.bindTex(u, 'uLow', 0, low.tex[0]);
      this.bindTex(u, 'uHigh', 1, this.glowDown[i].tex[0]);
      gl.uniform2f(u.u.uLowTexel, 1 / low.w, 1 / low.h);
      gl.uniform1f(u.u.uHighWeight, weights[i]);
      gl.uniform1f(u.u.uLowWeight, i === LEVELS - 1 ? 0 : 1);
      this.pass(this.glowUp[i]);
    }

    // 3. to screen
    const f = this.progs.final;
    gl.useProgram(f.p);
    this.bindTex(f, 'uScene', 0, this.scene.tex[0]);
    this.bindTex(f, 'uGlow', 1, this.glowUp[0].tex[0]);
    const back = this.backDown[4];
    this.bindTex(f, 'uBack', 2, back.tex[0]);
    gl.uniform2f(f.u.uBackTexel, 1 / back.w, 1 / back.h);
    const k = this.dpr;
    gl.uniform4f(f.u.uRect, this.rect.x * k, this.rect.y * k, this.rect.w * k, this.rect.h * k);
    gl.uniform2f(f.u.uCanvas, this.canvas.width, this.canvas.height);
    gl.uniform1f(f.u.uExposure, p.exposure);
    gl.uniform1f(f.u.uGlowAmt, 1);
    gl.uniform1f(f.u.uGrain, p.grain);
    gl.uniform1f(f.u.uTime, time);
    gl.uniform1f(f.u.uRadius, p.radius * k);
    gl.uniform1f(f.u.uBackdrop, p.backdrop);
    // cover fit for the backdrop
    const ca = this.cssW / this.cssH, ia = w / h;
    gl.uniform2f(f.u.uCover, ca > ia ? 1 : ia / ca, ca > ia ? ca / ia : 1);
    this.pass(null);
  }

  /** Linear composite at image resolution (before glow and tone mapping), for tests. */
  readComposite(): Float32Array | null {
    const gl = this.gl;
    if (!this.scene) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Float32Array(this.scene.w * this.scene.h * 4);
    gl.readPixels(0, 0, this.scene.w, this.scene.h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Reads back the average colour of a region of the canvas (for tests and the UI glow). */
  sample(x: number, y: number, wpx: number, hpx: number): [number, number, number] {
    const gl = this.gl;
    const k = this.dpr;
    const X = Math.round(x * k), Y = Math.round(this.canvas.height - (y + hpx) * k), W = Math.max(1, Math.round(wpx * k)), H = Math.max(1, Math.round(hpx * k));
    const buf = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(X, Y, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
    const n = W * H;
    return [r / n, g / n, b / n];
  }

  dispose() {
    const gl = this.gl;
    Object.values(this.tex).forEach((t) => t && gl.deleteTexture(t));
    this.freeTarget(this.scene);
    [...this.glowDown, ...this.glowUp, ...this.backDown].forEach((t) => this.freeTarget(t));
    Object.values(this.progs).forEach((p) => gl.deleteProgram(p.p));
  }
}

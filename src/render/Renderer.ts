// WebGL2 compositor. One draw of the composite shader per frame at image resolution, then a
// blur pyramid for glow and the backdrop, then a final pass to the screen.

import type { LayerData, SpriteData } from '../core/types';
import { ENV_SPRITE_VERT, ENV_VERT, NORMALIZE, SPLAT_FRAG, SPLAT_VERT, SPRITE_FRAG, SPRITE_VERT } from '../splat/shaders';
import { ENV_FLOATS, type EnvGeometry } from '../splat/env';
import { FLOATS_PER_POINT, type SplatGeometry } from '../splat/view';
import { COMPOSITE, DOWN, FINAL, UP, VERT } from './shaders';

export interface RenderInput {
  w: number;
  h: number;
  layers: LayerData[];
  sprite?: SpriteData;
  /** daylight version of the picture (sRGB RGBA), mixed in by `daylight` */
  ambient?: Uint8ClampedArray;
}

export interface RenderParams {
  layerA: number;
  layerB: number;
  mix: number;
  ambient: number;
  daylight?: number;
  exposure: number;
  glow: number;
  haze: number;
  grain: number;
  spriteDx: number;
  spriteT: number;
  spriteGain: [number, number, number];
  radius: number; // css px
  backdrop: number;
  /** colour behind the picture (a paper mat); when set, the letterbox is flat instead of the blurred backdrop */
  mat?: [number, number, number];
  /** the 3D view (splats); off draws the flat picture */
  view3d?: View3DParams;
}

export interface View3DParams {
  view: Float32Array; // mat4, original camera -> moved camera
  focal: number;
  zoom: number;
  zRange: [number, number];
  eye: [number, number, number];
  size: number; // splat size multiplier
  spec: number; // highlight strength
  glow3d: number; // glow sprite strength
  lights: { pos: Float32Array; col: Float32Array; count: number }; // up to 8: xyz reach, rgb
  sprites: { data: Float32Array; count: number }; // per sprite: x, y, d, size, r, g, b
  /** the 3D space instead of the parallax view: world -> camera, per-view weights, how lit */
  env?: { weights: Float32Array; lit: number };
}

export interface Rect { x: number; y: number; w: number; h: number }

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { fb: WebGLFramebuffer; tex: WebGLTexture[]; w: number; h: number };

const LEVELS = 6;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private progs: Record<'comp' | 'down' | 'up' | 'final' | 'norm', Prog>;
  private splatProg: Prog;
  private spriteProg: Prog;
  private splatVao: WebGLVertexArrayObject;
  private splatBuf: WebGLBuffer;
  private splatCount = 0;
  private splatStride = 2;
  private spriteVao: WebGLVertexArrayObject;
  private spriteBuf: WebGLBuffer;
  private envProg: Prog;
  private envSpriteProg: Prog;
  private envVao: WebGLVertexArrayObject;
  private envBuf: WebGLBuffer;
  private envCount = 0;
  private acc: Target | null = null;
  private view: Target | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
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
  /** software rendering (no GPU): the 3D view uses fewer splats */
  software = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser cannot run WebGL2, which Living Stills needs to draw the lights.');
    this.gl = gl;
    this.floatFb = !!gl.getExtension('EXT_color_buffer_float');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.software = /swiftshader|llvmpipe|software/i.test(name);
    gl.getExtension('OES_texture_float_linear');
    this.progs = {
      comp: this.program(COMPOSITE),
      down: this.program(DOWN),
      up: this.program(UP),
      final: this.program(FINAL),
      norm: this.program(NORMALIZE),
    };
    this.vao = gl.createVertexArray()!;
    this.splatProg = this.program(SPLAT_FRAG, SPLAT_VERT);
    this.spriteProg = this.program(SPRITE_FRAG, SPRITE_VERT);
    this.splatBuf = gl.createBuffer()!;
    this.splatVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.splatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    const S = FLOATS_PER_POINT * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 16);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 28);
    this.envProg = this.program(SPLAT_FRAG, ENV_VERT);
    this.envSpriteProg = this.program(SPRITE_FRAG, ENV_SPRITE_VERT);
    this.envBuf = gl.createBuffer()!;
    this.envVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.envVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.envBuf);
    const E = ENV_FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, E, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, E, 16);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, E, 28);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, E, 36);
    this.spriteBuf = gl.createBuffer()!;
    this.spriteVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
    gl.bindVertexArray(null);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  private program(frag: string, vert: string = VERT): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vert));
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

  private target(w: number, h: number, count = 1, levels = 1): Target {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const tex: WebGLTexture[] = [];
    const internal = this.floatFb ? gl.RGBA16F : gl.RGBA8;
    for (let i = 0; i < count; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      this.texParams(gl.TEXTURE_2D, gl.LINEAR);
      if (levels > 1) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      tex.push(t);
    }
    gl.drawBuffers(tex.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  /** The splats for the 3D view (null removes them). */
  setSplats(g: SplatGeometry | null) {
    const gl = this.gl;
    this.splatCount = g?.count ?? 0;
    this.splatStride = g?.stride ?? 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, g?.data ?? new Float32Array(0), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  get hasSplats() {
    return this.splatCount > 0;
  }

  /** The 3D space: placed splats and the other views' lit and unlit pictures (RGBA, picture size). */
  setEnv(g: EnvGeometry | null, views?: { on: Uint8ClampedArray[]; off: Uint8ClampedArray[] }) {
    const gl = this.gl;
    this.envCount = g?.count ?? 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.envBuf);
    gl.bufferData(gl.ARRAY_BUFFER, g?.data ?? new Float32Array(0), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (g && views && this.input) {
      const { w, h } = this.input;
      const u8 = (a: Uint8ClampedArray) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const list = (xs: Uint8ClampedArray[]) => (xs.length ? xs.map(u8) : [new Uint8Array(w * h * 4)]);
      this.array('envOn', gl.SRGB8_ALPHA8, gl.UNSIGNED_BYTE, gl.LINEAR, w, h, list(views.on));
      this.array('envOff', gl.SRGB8_ALPHA8, gl.UNSIGNED_BYTE, gl.LINEAR, w, h, list(views.off));
    }
  }

  get hasEnv() {
    return this.envCount > 0;
  }

  private makeView(w: number, h: number) {
    const gl = this.gl;
    [this.acc, this.view].forEach((t) => this.freeTarget(t));
    if (this.depthRb) gl.deleteRenderbuffer(this.depthRb);
    this.depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    this.acc = this.target(w, h, 2, 7); // mip levels: holes are filled from coarser levels (pull-push)
    this.view = this.target(w, h, 2);
    for (const t of [this.acc, this.view]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Lifts the composite into 3D: visibility, accumulation, normalisation, then glow sprites. */
  private drawSplats(v: View3DParams) {
    const gl = this.gl;
    const { w, h } = this.input!;
    if (!this.acc || this.acc.w !== w || this.acc.h !== h) this.makeView(w, h);
    const acc = this.acc!, view = this.view!;
    const env = !!v.env && this.envCount > 0;
    const sp = env ? this.envProg : this.splatProg;
    const camera = (prog: Prog) => {
      gl.uniform2f(prog.u.uImg, w, h);
      gl.uniform1f(prog.u.uFocal, v.focal);
      if (prog.u.uZ) gl.uniform2f(prog.u.uZ, v.zRange[0], v.zRange[1]);
      gl.uniformMatrix4fv(prog.u.uView, false, v.view);
      if (prog.u.uStride) gl.uniform1f(prog.u.uStride, this.splatStride);
      gl.uniform1f(prog.u.uZoom, v.zoom);
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(sp.p);
    camera(sp);
    this.bindTex(sp, 'uColor', 0, this.scene!.tex[0]);
    this.bindTex(sp, 'uLight', 1, this.scene!.tex[1]);
    gl.uniform1f(sp.u.uSize, v.size);
    gl.uniform3f(sp.u.uEye, ...v.eye);
    gl.uniform1i(sp.u.uLights, v.lights.count);
    if (v.lights.count) {
      gl.uniform4fv(sp.u['uLPos[0]'], v.lights.pos);
      gl.uniform3fv(sp.u['uLCol[0]'], v.lights.col);
    }
    gl.uniform1f(sp.u.uSpec, v.spec);
    if (env) {
      this.bindTex(sp, 'uOn', 2, this.tex.envOn, gl.TEXTURE_2D_ARRAY);
      this.bindTex(sp, 'uOff', 3, this.tex.envOff, gl.TEXTURE_2D_ARRAY);
      gl.uniform1f(sp.u.uLit, v.env!.lit);
      gl.uniform1fv(sp.u['uVW[0]'], v.env!.weights);
    }
    const count = env ? this.envCount : this.splatCount;
    gl.bindVertexArray(env ? this.envVao : this.splatVao);
    // 1. visibility
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(false, false, false, false);
    gl.uniform1i(sp.u.uPass, 0);
    gl.drawArrays(gl.POINTS, 0, count);
    // 2. accumulation within the depth tolerance
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1i(sp.u.uPass, 1);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    for (const t of acc.tex) { gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D); }
    // 3. normalise into the view target; sparse spots take colour from coarser levels
    gl.bindVertexArray(this.vao);
    const n = this.progs.norm;
    gl.useProgram(n.p);
    this.bindTex(n, 'uAccC', 0, acc.tex[0]);
    this.bindTex(n, 'uAccL', 1, acc.tex[1]);
    this.bindTex(n, 'uBack', 2, this.backDown[1]?.tex[0] ?? acc.tex[0]);
    this.pass(view);
    // 4. glow sprites, hidden behind nearer surfaces
    if (v.sprites.count && v.glow3d > 0) {
      const s = env ? this.envSpriteProg : this.spriteProg;
      gl.useProgram(s.p);
      camera(s);
      gl.uniform1f(s.u.uGlow3d, v.glow3d);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      gl.bufferData(gl.ARRAY_BUFFER, v.sprites.data.subarray(0, v.sprites.count * 7), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(this.spriteVao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, view.fb);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, v.sprites.count);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }
    gl.bindVertexArray(this.vao);
    return view;
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
    if (input.ambient) this.tex2d('ambient', gl.SRGB8_ALPHA8, gl.UNSIGNED_BYTE, gl.LINEAR, w, h, new Uint8Array(input.ambient.buffer, input.ambient.byteOffset, input.ambient.byteLength));
    else if (this.tex.ambient) { gl.deleteTexture(this.tex.ambient); this.tex.ambient = null; }
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
    gl.uniform1f(c.u.uDay, this.tex.ambient ? p.daylight ?? 0 : 0);
    this.bindTex(c, 'uDayTex', 8, this.tex.ambient ?? this.tex.table);
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
    let src: Target = this.scene;
    if (p.view3d && (p.view3d.env ? this.envCount : this.splatCount)) {
      // the backdrop pyramid of the flat picture fills holes in the 3D view
      down(this.scene.tex[0], w, h, this.backDown);
      src = this.drawSplats(p.view3d);
      gl.useProgram(d.p);
    }
    down(src.tex[1], w, h, this.glowDown);
    if (src === this.scene) down(this.scene.tex[0], w, h, this.backDown);
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
    this.bindTex(f, 'uScene', 0, src.tex[0]);
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
    const mat = p.mat ?? [0, 0, 0];
    gl.uniform3f(f.u.uMat, mat[0], mat[1], mat[2]);
    // cover fit for the backdrop
    const ca = this.cssW / this.cssH, ia = w / h;
    gl.uniform2f(f.u.uCover, ca > ia ? 1 : ia / ca, ca > ia ? ca / ia : 1);
    this.pass(null);
  }

  /** Linear composite at image resolution (before glow and tone mapping), for tests. */
  readComposite(which: 'flat' | 'view' = 'flat'): Float32Array | null {
    const gl = this.gl;
    if (!this.scene) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, which === 'view' && this.view ? this.view.fb : this.scene.fb);
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
    [this.acc, this.view].forEach((t) => this.freeTarget(t));
    gl.deleteProgram(this.splatProg.p);
    gl.deleteProgram(this.spriteProg.p);
    gl.deleteProgram(this.envProg.p);
    gl.deleteProgram(this.envSpriteProg.p);
  }
}

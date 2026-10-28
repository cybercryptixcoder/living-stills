import { useEffect, useRef, useState } from 'react';
import { live } from '../live';
import { makeRoute } from '../play/engine';
import { Renderer } from '../render/Renderer';
import { useStore } from '../state';
import { switchSound, tickSound } from './sound';

const S = () => useStore.getState();
const GRID_FRAME_SECONDS = 1.7;
export const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export interface ImageRect { x: number; y: number; w: number; h: number }
export const stageRect: ImageRect = { x: 0, y: 0, w: 1, h: 1 };

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function Stage() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const status = useStore((s) => s.status);
  const statusText = useStore((s) => s.statusText);
  const hasScene = useStore((s) => !!s.scene);
  const mode = useStore((s) => s.mode);
  const picking = useStore((s) => s.picking);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; sub: string } | null>(null);
  const drawing = useRef<[number, number][] | null>(null);
  const press = useRef<{ t: number; x: number; y: number; timer: number } | null>(null);
  const ripplesUi = useRef<{ x: number; y: number; t0: number }[]>([]);

  // renderer + loop
  useEffect(() => {
    let r: Renderer;
    try {
      r = new Renderer(canvas.current!);
    } catch (err) {
      setGlError((err as Error).message);
      return;
    }
    live.renderer = r;
    let raf = 0;
    let last = performance.now();
    let frame = 0;
    const root = document.documentElement;
    const octx = overlay.current!.getContext('2d')!;

    const layout = () => {
      const el = wrap.current!;
      const cw = el.clientWidth, ch = el.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      r.resize(cw, ch, dpr);
      const ov = overlay.current!;
      if (ov.width !== Math.round(cw * dpr) || ov.height !== Math.round(ch * dpr)) {
        ov.width = Math.round(cw * dpr);
        ov.height = Math.round(ch * dpr);
      }
      const st = S();
      const a = st.analysis;
      const aspect = a ? a.width / a.height : 16 / 9;
      const cinema = st.cinema;
      const consoleEl = document.querySelector('.console') as HTMLElement | null;
      const topEl = document.querySelector('.titlecard') as HTMLElement | null;
      const top = cinema ? 0 : Math.max(72, (topEl ? topEl.offsetTop + topEl.offsetHeight : 60) + 14);
      const bottom = cinema ? 0 : (consoleEl?.offsetHeight ?? 120) + 32;
      const side = cinema ? 0 : Math.max(16, Math.min(56, cw * 0.035));
      const aw = cw - side * 2, ah = Math.max(80, ch - top - bottom);
      let w = aw, h = aw / aspect;
      if (h > ah) { h = ah; w = ah * aspect; }
      const rect = { x: (cw - w) / 2, y: top + (ah - h) / 2, w, h };
      r.rect = rect;
      Object.assign(stageRect, rect);
      return { dpr, rect };
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(live.engine.maxDt, (now - last) / 1000);
      last = now;
      frame++;
      const st = S();
      const { dpr, rect } = layout();
      const a = st.analysis;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, overlay.current!.width, overlay.current!.height);
      if (!a || !r.loaded) return;
      const e = live.engine;
      e.mode = st.mode;
      e.params = st.params;
      e.groups = st.groups;
      e.master = st.master;
      e.elementFader = st.elementFader;
      e.warmth = st.view.warmth;
      e.feel = st.feel;

      // motion
      let layerA = 0, layerB = 0, mix = 0, spriteDx = 0;
      const doc = st.scene?.doc;
      if (a.sprite && doc?.motion) {
        const m = doc.motion;
        const [rx, , rw] = a.sprite.rect;
        if (st.motion.playing) live.motionDx += m.dir * m.speed * st.motion.speed * dt;
        const lo = -(rx + rw) - 0.04 * a.width, hi = a.width - rx + 0.04 * a.width;
        if (live.motionDx > hi) live.motionDx = lo;
        if (live.motionDx < lo) live.motionDx = hi;
        spriteDx = live.motionDx;
        e.setElementPos(rx + rw / 2 + spriteDx, a.sprite.rect[1] + a.sprite.rect[3] / 2);
      }
      if (a.layers.length > 1 && doc?.method === 'grid') {
        const F = a.layers.length;
        if (st.motion.playing) live.gridPhase = (live.gridPhase + (dt * st.motion.speed) / GRID_FRAME_SECONDS) % F;
        const f = Math.floor(live.gridPhase);
        const local = live.gridPhase - f;
        layerA = f % F;
        layerB = (f + 1) % F;
        const b = st.motion.blend;
        mix = b <= 0.01 ? 0 : smooth(1 - b, 1, local);
        e.setFramePos(layerA, layerB, mix);
      } else if (a.editedLayer != null) {
        layerA = st.variant === 'edits' ? a.editedLayer : 0;
      }
      e.step(dt);
      r.setTable(e.lightTable());
      const el = e.elementOutput();
      const v = st.view;
      r.draw({
        layerA, layerB, mix, ambient: v.ambient, exposure: v.exposure, glow: v.glow, haze: v.haze, grain: v.grain,
        spriteDx, spriteT: el.t, spriteGain: el.gain, radius: st.cinema ? 0 : 10, backdrop: st.cinema ? 0.2 : 0.32,
      }, now / 1000);

      // UI is lit by the scene
      if (frame % 3 === 0) {
        root.style.setProperty('--lit', e.litness.toFixed(3));
        const c = e.litColor;
        const m = Math.max(...c);
        const to = (x: number) => Math.round(255 * Math.pow(Math.max(0.25, x / m), 1 / 2.2));
        root.style.setProperty('--lit-rgb', `${to(c[0])} ${to(c[1])} ${to(c[2])}`);
        // fader lamps
        const lamps = document.querySelectorAll<HTMLElement>('[data-lamp]');
        if (lamps.length) {
          const sums = new Float32Array(st.groups.length), counts = new Float32Array(st.groups.length);
          e.lights.forEach((L, i) => { if (L.group < sums.length) { sums[L.group] += e.level[i]; counts[L.group]++; } });
          lamps.forEach((lamp) => {
            const id = lamp.dataset.lamp!;
            let val = 0;
            if (id === 'all') val = e.litness;
            else if (id === 'el') val = e.hasElement ? e.level[e.count - 1] : 0;
            else { const g = +id; val = counts[g] ? sums[g] / counts[g] : 0; }
            lamp.style.setProperty('--g', Math.min(1, val).toFixed(3));
          });
        }
      }

      // overlay
      const sx = rect.w / a.width;
      const toScreen = (x: number, y: number): [number, number] => [rect.x + x * sx, rect.y + y * sx];
      const ring = (x: number, y: number, rad: number, color: string, width = 1, dash?: number[]) => {
        const [X, Y] = toScreen(x, y);
        octx.beginPath();
        octx.setLineDash(dash ?? []);
        octx.strokeStyle = color;
        octx.lineWidth = width;
        octx.arc(X, Y, rad, 0, Math.PI * 2);
        octx.stroke();
      };
      const lightRadius = (i: number) => {
        const L = e.lights[i];
        return Math.max(5, Math.min(22, Math.sqrt(L.area) * sx * 0.9 + 4));
      };
      const dot = (x: number, y: number, rad: number, color: string) => {
        const [X, Y] = toScreen(x, y);
        octx.beginPath();
        octx.fillStyle = color;
        octx.arc(X, Y, rad, 0, Math.PI * 2);
        octx.fill();
      };
      if (st.showLights || st.picking) {
        for (let i = 0; i < e.lights.length; i++) {
          const lv = e.level[i];
          const picked = st.picked.includes(e.lights[i].id);
          const inGroup = st.hoverGroup != null && e.lights[i].group === st.hoverGroup;
          if (picked) {
            ring(e.posX[i], e.posY[i], lightRadius(i) + 2, 'rgba(255,214,140,0.95)', 1.6);
            dot(e.posX[i], e.posY[i], 3, 'rgba(255,214,140,1)');
          } else {
            dot(e.posX[i], e.posY[i], inGroup ? 3.2 : 2.2, `rgba(${lv > 0.5 ? '255,226,180' : '214,220,236'},${inGroup ? 0.95 : 0.35 + 0.45 * lv})`);
          }
        }
      }
      if (st.previewWaterline != null) {
        const [, Y] = toScreen(0, st.previewWaterline);
        octx.setLineDash([6, 6]);
        octx.strokeStyle = 'rgba(160,200,255,0.8)';
        octx.lineWidth = 1.2;
        octx.beginPath();
        octx.moveTo(rect.x, Y);
        octx.lineTo(rect.x + rect.w, Y);
        octx.stroke();
        octx.setLineDash([]);
        octx.fillStyle = 'rgba(200,220,255,0.85)';
        octx.font = '12px "IBM Plex Sans", sans-serif';
        octx.fillText('Reflections below this line', rect.x + 12, Y - 8);
      }
      if (!(st.showLights || st.picking) && st.hoverGroup != null) {
        for (let i = 0; i < e.lights.length; i++)
          if (e.lights[i].group === st.hoverGroup) ring(e.posX[i], e.posY[i], lightRadius(i), 'rgba(214,220,236,0.75)');
        if (st.hoverGroup === -2 && e.hasElement) {
          const i = e.count - 1;
          ring(e.posX[i], e.posY[i], 26, 'rgba(214,220,236,0.75)');
        }
      }
      if (st.hovered != null && st.hovered < e.lights.length && (st.mode === 'hand' || st.picking)) {
        ring(e.posX[st.hovered], e.posY[st.hovered], lightRadius(st.hovered) + 3, 'rgba(255,226,170,0.95)', 1.5);
      }
      if (st.selected != null && st.selected < e.count) {
        ring(e.posX[st.selected], e.posY[st.selected], (st.selected < e.lights.length ? lightRadius(st.selected) : 24) + 5, 'rgba(255,214,140,0.9)', 1.2, [3, 3]);
      }
      const p = e.pointer;
      if (p.inside && !st.picking && (st.mode === 'torch' || st.mode === 'paint' || st.mode === 'trail')) {
        const R = st.params.radius * a.width * sx;
        ring(p.x, p.y, R, 'rgba(214,220,236,0.32)', 1);
        ring(p.x, p.y, R * (1 - st.params.softness * 0.9), 'rgba(214,220,236,0.12)', 1, [2, 4]);
      }
      const routePts = drawing.current ?? e.route?.pts;
      if (st.mode === 'route' && routePts && routePts.length > 1) {
        octx.beginPath();
        octx.setLineDash([2, 7]);
        octx.lineCap = 'round';
        octx.strokeStyle = drawing.current ? 'rgba(255,214,140,0.85)' : 'rgba(214,220,236,0.42)';
        octx.lineWidth = 2;
        routePts.forEach(([x, y], k) => { const [X, Y] = toScreen(x, y); if (k) octx.lineTo(X, Y); else octx.moveTo(X, Y); });
        octx.stroke();
        octx.setLineDash([]);
        const rp = !drawing.current && e.routePoint();
        if (rp) {
          const [X, Y] = toScreen(rp[0], rp[1]);
          const g = octx.createRadialGradient(X, Y, 0, X, Y, 14);
          g.addColorStop(0, 'rgba(255,236,200,0.95)');
          g.addColorStop(0.35, 'rgba(255,200,120,0.5)');
          g.addColorStop(1, 'rgba(255,200,120,0)');
          octx.fillStyle = g;
          octx.beginPath();
          octx.arc(X, Y, 14, 0, Math.PI * 2);
          octx.fill();
        }
      }
      const tnow = performance.now() / 1000;
      ripplesUi.current = ripplesUi.current.filter((q) => tnow - q.t0 < 1.4);
      for (const q of ripplesUi.current) {
        const k = (tnow - q.t0) / 1.4;
        ring(q.x, q.y, 6 + k * 90, `rgba(255,214,140,${0.5 * (1 - k)})`, 1.2);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      live.renderer = null;
      r.dispose();
    };
  }, []);

  // pointer handling
  const toImage = (cx: number, cy: number) => {
    const a = S().analysis;
    const box = wrap.current!.getBoundingClientRect();
    if (!a) return null;
    const x = ((cx - box.left - stageRect.x) / stageRect.w) * a.width;
    const y = ((cy - box.top - stageRect.y) / stageRect.h) * a.height;
    const inside = x >= 0 && y >= 0 && x < a.width && y < a.height;
    return { x, y, inside, scale: stageRect.w / a.width };
  };

  const pickAt = (x: number, y: number, scale: number) => live.engine.pick(x, y, 14 / scale);

  const onMove = (ev: React.PointerEvent) => {
    const q = toImage(ev.clientX, ev.clientY);
    if (!q) return;
    if (press.current && Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 10) { clearTimeout(press.current.timer); press.current = null; }
    const e = live.engine;
    e.pointer.x = q.x;
    e.pointer.y = q.y;
    e.pointer.inside = q.inside;
    const st = S();
    if (drawing.current && q.inside) {
      const lastPt = drawing.current[drawing.current.length - 1];
      if (Math.hypot(q.x - lastPt[0], q.y - lastPt[1]) > 6 / q.scale) drawing.current.push([q.x, q.y]);
    }
    if (st.mode === 'paint' && e.pointer.down && !st.picking) {
      const changed = e.paintAt(q.x, q.y, !(st.params.erase || ev.altKey));
      if (changed.length) switchSound(!(st.params.erase || ev.altKey));
    }
    if (st.mode === 'hand' || st.picking) {
      const i = q.inside ? pickAt(q.x, q.y, q.scale) : -1;
      const hovered = i >= 0 ? i : null;
      if (hovered !== st.hovered) st.set({ hovered });
      if (i >= 0 && i < e.lights.length) {
        const L = e.lights[i];
        const box = wrap.current!.getBoundingClientRect();
        const g = st.scene?.groups[L.group]?.name;
        setTip({
          x: ev.clientX - box.left, y: ev.clientY - box.top,
          title: st.scene?.doc.method === 'grid' ? (g ?? `Light ${L.id}`) : `Light ${L.id}${g ? `, group ${g}` : ''}`,
          sub: st.picking ? (st.picked.includes(L.id) ? 'Click to leave it out' : 'Click to choose it') : TOUCH ? 'Tap to switch. Hold for colour.' : 'Click to switch. Right-click for colour.',
        });
      } else if (i >= 0 && e.hasElement && i === e.count - 1) {
        const box = wrap.current!.getBoundingClientRect();
        setTip({ x: ev.clientX - box.left, y: ev.clientY - box.top, title: st.scene?.elementName ? capital(st.scene.elementName) : 'Moving light', sub: 'Click to switch. Right-click for colour.' });
      } else setTip(null);
    } else if (tip) setTip(null);
  };

  const onDown = (ev: React.PointerEvent) => {
    if (ev.button === 2) return;
    const q = toImage(ev.clientX, ev.clientY);
    if (!q || !q.inside) return;
    const e = live.engine;
    const st = S();
    e.pointer.down = true;
    if (ev.pointerType === 'touch') {
      // long-press on a light opens its card (the touch version of right-click)
      e.pointer.inside = true;
      e.pointer.x = q.x;
      e.pointer.y = q.y;
      const i = pickAt(q.x, q.y, q.scale * 0.6);
      if (press.current) clearTimeout(press.current.timer);
      press.current = i >= 0 ? {
        t: performance.now(), x: ev.clientX, y: ev.clientY,
        timer: window.setTimeout(() => { S().set({ selected: i }); tickSound(); press.current = null; }, 520),
      } : null;
    }
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    if (st.picking) {
      const i = pickAt(q.x, q.y, q.scale);
      if (i >= 0 && i < e.lights.length) {
        const id = e.lights[i].id;
        const picked = st.picked.includes(id) ? st.picked.filter((x) => x !== id) : [...st.picked, id].slice(0, 12);
        st.set({ picked });
        tickSound();
      }
      return;
    }
    switch (st.mode) {
      case 'hand': {
        const i = pickAt(q.x, q.y, q.scale);
        if (i >= 0) {
          const on = e.base[i] < 0.5;
          e.base[i] = on ? 1 : 0;
          switchSound(on);
          if (st.selected != null) st.set({ selected: i });
        } else if (st.selected != null) st.set({ selected: null });
        break;
      }
      case 'paint': {
        const on = !(st.params.erase || ev.altKey);
        if (e.paintAt(q.x, q.y, on).length) switchSound(on);
        break;
      }
      case 'route':
        drawing.current = [[q.x, q.y]];
        break;
      case 'sweep':
      case 'breathe':
      case 'flicker':
      case 'dusk':
      case 'trail':
        e.addRipple(q.x, q.y);
        ripplesUi.current.push({ x: q.x, y: q.y, t0: performance.now() / 1000 });
        tickSound();
        break;
    }
  };

  const onUp = (ev?: React.PointerEvent) => {
    const e = live.engine;
    e.pointer.down = false;
    if (press.current) { clearTimeout(press.current.timer); press.current = null; }
    if (ev?.pointerType === 'touch' && S().mode !== 'trail') e.pointer.inside = false;
    if (drawing.current) {
      const route = makeRoute(drawing.current);
      if (route) { e.route = route; e.routeS = 0; tickSound(); S().set({ routeReady: true }); }
      drawing.current = null;
    }
  };

  const onContext = (ev: React.MouseEvent) => {
    const q = toImage(ev.clientX, ev.clientY);
    if (!q || !q.inside) return;
    const i = pickAt(q.x, q.y, q.scale);
    if (i >= 0) {
      ev.preventDefault();
      S().set({ selected: i });
      tickSound();
    }
  };

  const cursor = picking ? 'crosshair' : mode === 'hand' ? (tip ? 'pointer' : 'default') : mode === 'route' ? 'crosshair' : mode === 'torch' || mode === 'trail' || mode === 'paint' ? 'none' : 'default';

  return (
    <div className="stage" ref={wrap}>
      <canvas ref={canvas} className="stage__gl" />
      <canvas
        ref={overlay}
        className="stage__overlay"
        style={{ cursor }}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => { live.engine.pointer.inside = false; setTip(null); if (S().hovered != null) S().set({ hovered: null }); }}
        onContextMenu={onContext}
        data-testid="stage"
      />
      {tip && (
        <div className="stage__tip" style={{ left: tip.x + 16, top: tip.y + 14 }}>
          <strong>{tip.title}</strong>
          <span>{tip.sub}</span>
        </div>
      )}
      {glError && <div className="stage__msg"><p>{glError}</p></div>}
      {status === 'loading' && (
        <div className="stage__msg" aria-live="polite">
          <span className="filament-loader" aria-hidden="true" />
          <p>{statusText || 'Loading'}</p>
        </div>
      )}
      {status === 'error' && (
        <div className="stage__msg stage__msg--error" role="alert"><p>{statusText}</p></div>
      )}
      {!hasScene && status === 'idle' && (
        <div className="stage__msg"><p>Choose a scene, or paint a new one.</p></div>
      )}
    </div>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

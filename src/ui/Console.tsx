import { useEffect, useRef, useState } from 'react';
import { live, saveBlob, slug } from '../live';
import type { ModeId } from '../play/engine';
import { DEFAULT_VIEW, useStore } from '../state';
import { Fader, Segmented, Slider, Toggle } from './controls';
import { Icon, type IconName } from './icons';
import { stageRect } from './Stage';
import { switchSound, tickSound } from './sound';

export const MODES: { id: ModeId; icon: IconName; name: string; help: string; key: string }[] = [
  { id: 'hand', icon: 'switch', name: 'Switch', help: 'Click a light to switch it. Right-click it for colour and brightness.', key: '1' },
  { id: 'torch', icon: 'torch', name: 'Torch', help: 'Lights near the cursor come on. Everything else rests in the dark.', key: '2' },
  { id: 'paint', icon: 'paint', name: 'Paint', help: 'Drag to switch lights on. Hold Alt, or turn on Erase, to switch them off.', key: '3' },
  { id: 'trail', icon: 'trail', name: 'Trail', help: 'Lights wake where the cursor passes and fade slowly behind it.', key: '4' },
  { id: 'route', icon: 'route', name: 'Route', help: 'Drag a path across the picture. A light travels along it, like a car down a street.', key: '5' },
  { id: 'sweep', icon: 'sweep', name: 'Sweep', help: 'A wave switches the scene on, then off. Click anywhere to send a ripple.', key: '6' },
  { id: 'breathe', icon: 'breathe', name: 'Breathe', help: 'Every light swells and fades on its own slow rhythm.', key: '7' },
  { id: 'flicker', icon: 'flicker', name: 'Flicker', help: 'Some lights stutter like tired bulbs. Unrest sets how many.', key: '8' },
  { id: 'dusk', icon: 'dusk', name: 'Dusk', help: 'Lights come on one by one as night falls, then go out before dawn.', key: '9' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(1)} s`;
const times = (v: number) => `${v.toFixed(v < 1 ? 2 : 1)}×`;

function ModeParams() {
  const mode = useStore((s) => s.mode);
  const p = useStore((s) => s.params);
  const feel = useStore((s) => s.feel);
  const set = useStore((s) => s.set);
  const setSettings = useStore((s) => s.setSettings);
  const up = (patch: Partial<typeof p>) => set({ params: { ...p, ...patch } });
  const radius = <Slider label="Radius" value={p.radius} min={0.03} max={0.45} def={0.14} format={pct} onChange={(radius) => up({ radius })} title="Share of the picture's width" />;
  const speed = (label = 'Speed') => <Slider label={label} value={p.speed} min={0.2} max={3} def={1} format={times} onChange={(speed) => up({ speed })} />;
  const keep = <Toggle on={p.keep} onChange={(keep) => up({ keep })} label="Keep my lights" title="Lights you switched on in Switch mode stay on" />;
  const routeSet = !!live.engine.route;
  switch (mode) {
    case 'hand':
      return (
        <>
          <span className="param-label">Switching</span>
          <Segmented
            label="How lights switch"
            value={feel}
            onChange={(v) => { setSettings({ feel: v }); tickSound(); }}
            options={[
              { value: 'filament', label: 'Filament', hint: 'Warm up and cool down like a bulb' },
              { value: 'instant', label: 'Instant', hint: 'No easing' },
              { value: 'neon', label: 'Neon', hint: 'Stutter on like a tube' },
            ]}
          />
        </>
      );
    case 'torch':
      return <>{radius}<Slider label="Softness" value={p.softness} min={0} max={1} def={0.55} format={pct} onChange={(softness) => up({ softness })} />{keep}</>;
    case 'paint':
      return <>{radius}<Toggle on={p.erase} onChange={(erase) => up({ erase })} label="Erase" /></>;
    case 'trail':
      return <>{radius}<Slider label="Afterglow" value={p.afterglow} min={0.2} max={8} def={2.2} format={secs} onChange={(afterglow) => up({ afterglow })} />{keep}</>;
    case 'route':
      return (
        <>
          {radius}{speed()}<Slider label="Afterglow" value={p.afterglow} min={0.2} max={8} def={2.2} format={secs} onChange={(afterglow) => up({ afterglow })} />
          {!routeSet && <span className="param-hint">Drag across the picture to draw a route.</span>}
        </>
      );
    case 'sweep':
      return <><Slider label="Direction" value={p.angle} min={-180} max={180} step={5} def={0} format={(v) => `${Math.round(v)}°`} onChange={(angle) => up({ angle })} />{speed()}{keep}</>;
    case 'breathe':
      return <><Slider label="Depth" value={p.depth} min={0.1} max={1} def={0.7} format={pct} onChange={(depth) => up({ depth })} />{speed('Tempo')}</>;
    case 'flicker':
      return <><Slider label="Unrest" value={p.unrest} min={0} max={1} def={0.35} format={pct} onChange={(unrest) => up({ unrest })} title="Share of lights that flicker" />{speed('Rate')}</>;
    case 'dusk':
      return <>{speed()}<span className="param-hint">One night lasts {Math.round(26 / p.speed)} s.</span></>;
  }
}

function Channels() {
  const scene = useStore((s) => s.scene);
  const groups = useStore((s) => s.groups);
  const master = useStore((s) => s.master);
  const elementFader = useStore((s) => s.elementFader);
  const set = useStore((s) => s.set);
  if (!scene) return null;
  const grid = scene.doc.method === 'grid';
  const toggleGroup = (g: number) => {
    const e = live.engine;
    const anyOn = e.lights.some((L, i) => L.group === g && e.base[i] > 0.5);
    e.setGroup(g, anyOn ? 0 : 1);
    switchSound(!anyOn);
  };
  return (
    <div className="channels" role="group" aria-label="Light channels">
      <div className="channels__scroll">
        {scene.groups.map((g, k) => (
          <Fader
            key={k}
            label={grid ? g.name.replace(/^Lights /, '') : g.name}
            sub={grid ? (g.kind === 'moving' ? 'moves' : '') : String(g.count)}
            title={grid ? g.name : `Group ${g.name}, ${g.count} light${g.count === 1 ? '' : 's'}`}
            lampId={String(k)}
            value={groups[k] ?? 1}
            onChange={(v) => { const next = [...groups]; next[k] = v; set({ groups: next }); }}
            onHover={(on) => set({ hoverGroup: on ? k : null })}
            onLabel={() => toggleGroup(k)}
          />
        ))}
        {scene.hasElement && (
          <Fader
            label={capital(scene.elementName?.replace(/^the /, '') ?? 'Moving')}
            sub="moves"
            title="The moving element's own light"
            lampId="el"
            value={elementFader}
            onChange={(v) => set({ elementFader: v })}
            onHover={(on) => set({ hoverGroup: on ? -2 : null })}
            onLabel={() => {
              const e = live.engine, i = e.count - 1;
              const on = e.base[i] < 0.5;
              e.base[i] = on ? 1 : 0;
              switchSound(on);
            }}
          />
        )}
      </div>
      <span className="channels__rule" aria-hidden="true" />
      <Fader label="All" wide title="Every light" lampId="all" value={master} onChange={(v) => set({ master: v })}
        onLabel={() => { const on = live.engine.base.some((b) => b < 0.5); live.engine.setAll(on ? 1 : 0); switchSound(on); }} />
    </div>
  );
}

function Picture() {
  const v = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const up = (patch: Partial<typeof v>) => set({ view: { ...v, ...patch } });
  return (
    <div className="picture" role="group" aria-label="Picture">
      <Slider label="Moon" value={v.ambient} min={0} max={1.6} def={1} format={pct} onChange={(ambient) => up({ ambient })} title="Light that is not from the lamps: moonlight, sky" />
      <Slider label="Exposure" value={v.exposure} min={0.4} max={2.4} def={1} format={times} onChange={(exposure) => up({ exposure })} />
      <Slider label="Glow" value={v.glow} min={0} max={1.6} def={DEFAULT_VIEW.glow} format={pct} onChange={(glow) => up({ glow })} />
      <Slider label="Haze" value={v.haze} min={0} max={1.6} def={DEFAULT_VIEW.haze} format={pct} onChange={(haze) => up({ haze })} />
      <Slider label="Warmth" value={v.warmth} min={-1} max={1} def={0} format={(x) => (Math.abs(x) < 0.05 ? '0' : x > 0 ? `+${Math.round(x * 100)}` : `−${Math.round(-x * 100)}`)} onChange={(warmth) => up({ warmth })} />
      <Slider label="Grain" value={v.grain} min={0} max={1.5} def={DEFAULT_VIEW.grain} format={pct} onChange={(grain) => up({ grain })} />
    </div>
  );
}

function captureCanvas(): HTMLCanvasElement | null {
  const gl = document.querySelector<HTMLCanvasElement>('.stage__gl');
  const a = useStore.getState().analysis;
  if (!gl || !a) return null;
  const dpr = gl.width / gl.clientWidth;
  const out = document.createElement('canvas');
  const scale = Math.min(1, 1920 / (stageRect.w * dpr));
  out.width = Math.round(stageRect.w * dpr * scale) & ~1;
  out.height = Math.round(stageRect.h * dpr * scale) & ~1;
  return out;
}

function drawCapture(out: HTMLCanvasElement) {
  const gl = document.querySelector<HTMLCanvasElement>('.stage__gl')!;
  const dpr = gl.width / gl.clientWidth;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(gl, stageRect.x * dpr, stageRect.y * dpr, stageRect.w * dpr, stageRect.h * dpr, 0, 0, out.width, out.height);
}

function Transport() {
  const scene = useStore((s) => s.scene);
  const motion = useStore((s) => s.motion);
  const variant = useStore((s) => s.variant);
  const set = useStore((s) => s.set);
  if (!scene) return null;
  const moving = scene.hasElement || scene.doc.method === 'grid';
  return (
    <div className="transport">
      {moving && (
        <>
          <button className="key key--round" onClick={() => { set({ motion: { ...motion, playing: !motion.playing } }); tickSound(); }} aria-label={motion.playing ? 'Pause the motion' : 'Play the motion'} title={motion.playing ? 'Pause (Space)' : 'Play (Space)'}>
            <Icon name={motion.playing ? 'pause' : 'play'} />
          </button>
          <Slider label="Motion" value={motion.speed} min={0.1} max={3} def={1} format={times} onChange={(speed) => set({ motion: { ...motion, speed } })} />
          {scene.doc.method === 'grid' && (
            <Slider label="Blend" value={motion.blend} min={0} max={1} def={0.6} format={(x) => (x < 0.02 ? 'Cut' : pct(x))} onChange={(blend) => set({ motion: { ...motion, blend } })} title="How much of each frame crossfades into the next" />
          )}
        </>
      )}
      {scene.editedLayer != null && (
        <div className="compare">
          <span className="param-label">Lights from</span>
          <Segmented
            label="Which light layers to show"
            value={variant}
            onChange={(v) => { set({ variant: v }); tickSound(); }}
            options={[
              { value: 'estimate', label: 'Split', hint: 'Every light estimated from one on and one off image' },
              { value: 'edits', label: 'Edits', hint: 'Chosen lights replaced by their own generated edit' },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function Actions() {
  const showLights = useStore((s) => s.showLights);
  const recording = useStore((s) => s.recording);
  const cinema = useStore((s) => s.cinema);
  const scene = useStore((s) => s.scene);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const rec = useRef<{ r: MediaRecorder; raf: number; t0: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const all = (v: number) => { live.engine.setAll(v); switchSound(v > 0); };

  const snapshot = () => {
    const out = captureCanvas();
    if (!out || !scene) return;
    drawCapture(out);
    out.toBlob((b) => b && saveBlob(b, `${slug(scene.doc.title)}.png`), 'image/png');
    tickSound();
  };

  const stopRec = () => {
    const cur = rec.current;
    if (!cur) return;
    cancelAnimationFrame(cur.raf);
    if (cur.r.state !== 'inactive') cur.r.stop();
    rec.current = null;
    set({ recording: false });
  };

  const startRec = () => {
    const out = captureCanvas();
    if (!out || !scene) return;
    const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'];
    const type = types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    if (!type) { toast('This browser cannot record video.', 'error'); return; }
    drawCapture(out);
    const stream = out.captureStream(60);
    const r = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      saveBlob(blob, `${slug(scene.doc.title)}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
      toast('Clip saved to your downloads.');
    };
    const t0 = performance.now();
    const tick = () => {
      drawCapture(out);
      const s = (performance.now() - t0) / 1000;
      setElapsed(s);
      if (s > 30) { stopRec(); return; }
      if (rec.current) rec.current.raf = requestAnimationFrame(tick);
    };
    rec.current = { r, raf: requestAnimationFrame(tick), t0 };
    r.start(250);
    set({ recording: true });
    tickSound();
  };

  useEffect(() => () => stopRec(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="actions">
      <button className="key" onClick={() => all(1)} title="Switch every light on (A)" aria-label="All lights on"><Icon name="sunUp" /></button>
      <button className="key" onClick={() => all(0)} title="Switch every light off (O)" aria-label="All lights off"><Icon name="moonDown" /></button>
      <button className={`key${showLights ? ' is-on' : ''}`} onClick={() => { set({ showLights: !showLights }); tickSound(); }} title="Show where the lights are (L)" aria-pressed={showLights} aria-label="Show lights"><Icon name="eye" /></button>
      <span className="actions__rule" aria-hidden="true" />
      <button className="key" onClick={snapshot} title="Save a still (PNG)" aria-label="Save a still"><Icon name="camera" /></button>
      <button className={`key${recording ? ' is-recording' : ''}`} onClick={() => (recording ? stopRec() : startRec())} title={recording ? 'Stop and save the clip' : 'Record a clip of the picture (up to 30 s)'} aria-label={recording ? 'Stop recording' : 'Record a clip'}>
        <Icon name={recording ? 'stop' : 'record'} />
        {recording && <span className="rec-time">{Math.floor(elapsed)} s</span>}
      </button>
      <button className={`key${cinema ? ' is-on' : ''}`} onClick={() => set({ cinema: !cinema })} title="Hide everything but the picture (H)" aria-label="Cinema view"><Icon name="expand" /></button>
    </div>
  );
}

export function Console() {
  const mode = useStore((s) => s.mode);
  const set = useStore((s) => s.set);
  const scene = useStore((s) => s.scene);
  const cinema = useStore((s) => s.cinema);
  const [tab, setTab] = useState<'modes' | 'lights' | 'picture'>('modes');
  const current = MODES.find((m) => m.id === mode)!;
  return (
    <section className={`console${cinema ? ' is-hidden' : ''}`} aria-label="Lighting console" data-tab={tab}>
      <div className="console__tabs" role="tablist">
        {(['modes', 'lights', 'picture'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>
            {t === 'modes' ? 'Modes' : t === 'lights' ? 'Channels' : 'Picture'}
          </button>
        ))}
      </div>
      <div className="console__modes">
        <div className="modekeys" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={mode === m.id}
              className={`modekey${mode === m.id ? ' is-on' : ''}`}
              onClick={() => { set({ mode: m.id, selected: null }); tickSound(); }}
              title={`${m.name} (${m.key})`}
            >
              <Icon name={m.icon} />
              <span>{m.name}</span>
            </button>
          ))}
        </div>
        <div className="modeparams">
          <p className="modehelp">{current.help}</p>
          <div className="modeparams__row"><ModeParams /></div>
        </div>
      </div>
      <div className="console__lights">{scene ? <Channels /> : null}</div>
      <div className="console__picture">
        <Picture />
        <div className="console__side">
          <Transport />
          <Actions />
        </div>
      </div>
    </section>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

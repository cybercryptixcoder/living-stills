import { useEffect, useRef, useState } from 'react';
import { saveBlob, slug } from '../live';
import type { ModeId } from '../play/engine';
import { useStore } from '../state';
import { Segmented, Slider, Toggle } from './controls';
import { Icon, type IconName } from './icons';
import { stageRect, TOUCH } from './Stage';
import { tickSound } from './sound';

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

/** The five that earn their place; the rest live behind "More". */
const PRIMARY: ModeId[] = ['hand', 'torch', 'trail', 'sweep', 'dusk'];

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
  const routeSet = useStore((s) => s.routeReady);
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
  const box = gl.getBoundingClientRect();
  const ctx = out.getContext('2d')!;
  ctx.drawImage(
    gl,
    (stageRect.x - box.left) * dpr, (stageRect.y - box.top) * dpr, stageRect.w * dpr, stageRect.h * dpr,
    0, 0, out.width, out.height,
  );
}

function Make() {
  const scene = useStore((s) => s.scene);
  const recording = useStore((s) => s.recording);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const rec = useRef<{ r: MediaRecorder; raf: number; t0: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);

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
    <div className="make">
      <button className="btn btn--quiet" onClick={snapshot} disabled={!scene} title="Save a still (PNG)">
        <Icon name="camera" /><span>Save still</span>
      </button>
      <button
        className={`btn btn--quiet${recording ? ' is-recording' : ''}`}
        onClick={() => (recording ? stopRec() : startRec())}
        disabled={!scene}
        title={recording ? 'Stop and save the clip' : 'Record a clip of the picture (up to 30 s)'}
      >
        <Icon name={recording ? 'stop' : 'record'} />
        <span>{recording ? `Stop · ${Math.floor(elapsed)} s` : 'Record'}</span>
      </button>
    </div>
  );
}

export function Console() {
  const mode = useStore((s) => s.mode);
  const set = useStore((s) => s.set);
  const cinema = useStore((s) => s.cinema);
  const [more, setMore] = useState(false);
  const current = MODES.find((m) => m.id === mode)!;
  const extra = MODES.filter((m) => !PRIMARY.includes(m.id));
  const pick = (id: ModeId) => { set({ mode: id, selected: null }); tickSound(); };
  const help = TOUCH
    ? current.help.replace('Click a light to switch it. Right-click it', 'Tap a light to switch it. Hold it').replace('the cursor', 'your finger').replace('Drag', 'Drag a finger').replace('Click anywhere', 'Tap anywhere')
    : current.help;
  return (
    <section className={`console${cinema ? ' is-hidden' : ''}`} aria-label="Lighting tools">
      <div className="console__body">
        <div className="modes" role="radiogroup" aria-label="Mode">
          {PRIMARY.map((id) => {
            const m = MODES.find((x) => x.id === id)!;
            return (
              <button key={id} role="radio" aria-checked={mode === id} className={`chip${mode === id ? ' is-on' : ''}`} onClick={() => pick(id)} title={`${m.name} (${m.key})`}>
                <Icon name={m.icon} />
                <span className="chip__name">{m.name}</span>
              </button>
            );
          })}
          {more && extra.map((m) => (
            <button key={m.id} role="radio" aria-checked={mode === m.id} className={`chip chip--small${mode === m.id ? ' is-on' : ''}`} onClick={() => pick(m.id)} title={`${m.name} (${m.key})`}>
              <Icon name={m.icon} />
              <span className="chip__name">{m.name}</span>
            </button>
          ))}
          <button className={`chip chip--more${extra.some((m) => m.id === mode) ? ' is-on' : ''}${more ? ' is-open' : ''}`} onClick={() => { setMore(!more); tickSound(); }} aria-expanded={more} aria-label="More tools" title="More tools">
            <Icon name="more" />
            <span className="chip__name">{extra.some((m) => m.id === mode) ? MODES.find((m) => m.id === mode)!.name : 'More'}</span>
          </button>
        </div>
        <div className="console__params">
          <p className="modehelp">{help}</p>
          <div className="params">
            <ModeParams />
          </div>
        </div>
        <Make />
      </div>
    </section>
  );
}

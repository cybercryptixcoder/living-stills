// The dock under the picture: one row, a few menus. Each menu opens a small card where every
// item says what it is for. Only the controls of what is active show on the row itself.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listen, live, make3D, makeSpace, rebuildSplats, playPreset, removeLocal, runRepaintOff, saveBlob, slug, stopShow, downloadScene } from '../live';
import type { ModeId, MusicMap } from '../play/engine';
import { BUILT_IN, deletePreset, loadSaved, type Preset } from '../play/presets';
import { DEFAULT_VIEW, useStore, type Menu } from '../state';
import { Segmented, Slider, Toggle } from './controls';
import { Icon, type IconName } from './icons';
import { enableTilt, stageRect, TOUCH } from './Stage';
import { tickSound } from './sound';

export const EFFECTS: { id: ModeId; icon: IconName; name: string; help: string; key: string }[] = [
  { id: 'hand', icon: 'switch', name: 'Select', help: 'Click a light to open its panel: switch, dim, recolour, animate it. Shift-drag to pick several.', key: '1' },
  { id: 'torch', icon: 'torch', name: 'Torch', help: 'Lights near your cursor come on, the rest rest in the dark.', key: '2' },
  { id: 'paint', icon: 'paint', name: 'Brush', help: 'Drag to paint lights on. Turn on Erase (or hold Alt) to paint them off.', key: '3' },
  { id: 'trail', icon: 'trail', name: 'Trail', help: 'Lights wake where the cursor passes and fade slowly behind it.', key: '4' },
  { id: 'route', icon: 'route', name: 'Path', help: 'Draw a path across the picture; a light travels along it, like a car down a street.', key: '5' },
  { id: 'sweep', icon: 'sweep', name: 'Wave', help: 'A wave of light crosses the picture again and again. Click to send ripples.', key: '6' },
  { id: 'breathe', icon: 'breathe', name: 'Breathe', help: 'Every light swells and fades on its own slow rhythm.', key: '7' },
  { id: 'flicker', icon: 'flicker', name: 'Flicker', help: 'Some bulbs stutter like tired filaments.', key: '8' },
  { id: 'music', icon: 'music', name: 'Music', help: 'Lights move to sound from your microphone or a browser tab.', key: '9' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(1)} s`;
const times = (v: number) => `${v.toFixed(v < 1 ? 2 : 1)}×`;

/** A menu button with its card. Clicking outside, or Escape, closes it. */
function MenuButton({ id, label, icon, children, wide, current, testid }: { id: Exclude<Menu, null>; label: ReactNode; icon: IconName; children: ReactNode; wide?: boolean; current?: boolean; testid?: string }) {
  const open = useStore((s) => s.menu === id);
  const set = useStore((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) set({ menu: null }); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') set({ menu: null }); };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, [open, set]);
  return (
    <div className={`menu${open ? ' is-open' : ''}`} ref={ref}>
      <button className={`pill${current ? ' is-current' : ''}`} aria-expanded={open} aria-haspopup="menu" data-testid={testid} onClick={() => { set({ menu: open ? null : id }); tickSound(); }}>
        <Icon name={icon} />
        <span className="pill__label">{label}</span>
        <span className="pill__chev"><Icon name="chevron" /></span>
      </button>
      {open && <div className={`menu__card${wide ? ' menu__card--wide' : ''}`} role="menu">{children}</div>}
    </div>
  );
}

function Item({ icon, name, help, on, onClick, kbd, right, testid }: { icon: IconName; name: string; help: string; on?: boolean; onClick: () => void; kbd?: string; right?: ReactNode; testid?: string }) {
  return (
    <button className={`item${on ? ' is-on' : ''}`} role="menuitemradio" aria-checked={!!on} onClick={onClick} data-testid={testid}>
      <span className="item__icon"><Icon name={icon} /></span>
      <span className="item__text">
        <span className="item__name">{name}</span>
        <span className="item__help">{help}</span>
      </span>
      {right}
      {kbd && !TOUCH && <kbd>{kbd}</kbd>}
    </button>
  );
}

// ---------------------------------------------------------------- effects

function EffectsMenu() {
  const mode = useStore((s) => s.mode);
  const set = useStore((s) => s.set);
  const cur = EFFECTS.find((e) => e.id === mode);
  const pick = (id: ModeId) => {
    if (live.engine.mode === 'show') live.engine.stopShow();
    set({ mode: id, menu: null, playing: null, selection: id === 'hand' ? useStore.getState().selection : null });
    tickSound();
  };
  return (
    <MenuButton id="effects" icon={cur?.icon ?? 'presets'} label={<><small>Effect</small>{cur?.name ?? 'Show'}</>} wide testid="menu-effects">
      <p className="menu__title">Effects <span>how the lights respond to you</span></p>
      <div className="menu__grid">
        {EFFECTS.map((e) => <Item key={e.id} icon={e.icon} name={e.name} help={e.help} on={mode === e.id} kbd={e.key} onClick={() => pick(e.id)} testid={`effect-${e.id}`} />)}
      </div>
    </MenuButton>
  );
}

function MusicControls() {
  const music = useStore((s) => s.music);
  const p = useStore((s) => s.params);
  const set = useStore((s) => s.set);
  return (
    <>
      <div className="listen">
        <button className={`chip${music.source === 'mic' ? ' is-on' : ''}`} onClick={() => void listen(music.source === 'mic' ? null : 'mic')} title="Listen through your microphone">
          <Icon name="mic" /><span>{music.source === 'mic' ? 'Listening' : 'Microphone'}</span>
        </button>
        <button className={`chip${music.source === 'tab' ? ' is-on' : ''}`} onClick={() => void listen(music.source === 'tab' ? null : 'tab')} title="Pick a tab (or screen) and tick Share audio">
          <Icon name="screen" /><span>{music.source === 'tab' ? 'Listening' : 'Tab sound'}</span>
        </button>
        <span className="vu" aria-hidden="true"><span data-vu /></span>
      </div>
      <Segmented<MusicMap>
        label="How music maps onto the lights"
        value={p.music}
        onChange={(music) => { set({ params: { ...p, music } }); tickSound(); }}
        options={[
          { value: 'together', label: 'Together', hint: 'All lights pulse with the beat' },
          { value: 'height', label: 'Bass low', hint: 'Low lights take the bass, high lights the treble' },
          { value: 'across', label: 'Spectrum', hint: 'Left to right, low notes to high notes' },
          { value: 'beat', label: 'Hop', hint: 'Each beat lights the next group' },
        ]}
      />
      <Slider label="Sensitivity" value={music.sensitivity} min={0.4} max={2.5} def={1} format={times} onChange={(sensitivity) => set({ music: { ...music, sensitivity } })} />
      {music.error && <span className="param-hint is-error">{music.error}</span>}
    </>
  );
}

/** The controls of the active effect, on the dock row itself. */
function EffectParams() {
  const mode = useStore((s) => s.mode);
  const p = useStore((s) => s.params);
  const set = useStore((s) => s.set);
  const routeSet = useStore((s) => s.routeReady);
  const selection = useStore((s) => s.selection);
  const up = (patch: Partial<typeof p>) => set({ params: { ...p, ...patch } });
  const radius = <Slider label="Size" value={p.radius} min={0.03} max={0.45} def={0.14} format={pct} onChange={(radius) => up({ radius })} title="Share of the picture's width" />;
  const speed = (label = 'Speed') => <Slider label={label} value={p.speed} min={0.2} max={3} def={1} format={times} onChange={(speed) => up({ speed })} />;
  const keep = <Toggle on={p.keep} onChange={(keep) => up({ keep })} label="Keep my lights" title="Lights you switched on stay on" />;
  switch (mode) {
    case 'hand':
      return <span className="param-hint">{selection ? 'Adjust the light in its panel. Esc to let go.' : TOUCH ? 'Tap a light to adjust it.' : 'Click a light to adjust it · Shift-drag to pick several · Alt-click to switch'}</span>;
    case 'torch':
      return <>{radius}<Slider label="Softness" value={p.softness} min={0} max={1} def={0.55} format={pct} onChange={(softness) => up({ softness })} />{keep}</>;
    case 'paint':
      return <>{radius}<Toggle on={p.erase} onChange={(erase) => up({ erase })} label="Erase" /></>;
    case 'trail':
      return <>{radius}<Slider label="Fade" value={p.afterglow} min={0.2} max={8} def={2.2} format={secs} onChange={(afterglow) => up({ afterglow })} />{keep}</>;
    case 'route':
      return <>{radius}{speed()}{!routeSet && <span className="param-hint">Drag across the picture to draw a path.</span>}</>;
    case 'sweep':
      return <><Slider label="Direction" value={p.angle} min={-180} max={180} step={5} def={0} format={(v) => `${Math.round(v)}°`} onChange={(angle) => up({ angle })} />{speed()}{keep}</>;
    case 'breathe':
      return <><Slider label="Depth" value={p.depth} min={0.1} max={1} def={0.7} format={pct} onChange={(depth) => up({ depth })} />{speed('Tempo')}</>;
    case 'flicker':
      return <><Slider label="How many" value={p.unrest} min={0} max={1} def={0.35} format={pct} onChange={(unrest) => up({ unrest })} title="Share of lights that flicker" />{speed('Rate')}</>;
    case 'music':
      return <MusicControls />;
    case 'show':
      return <ShowStatus />;
  }
}

function ShowStatus() {
  const playing = useStore((s) => s.playing);
  const p = useStore((s) => s.params);
  const set = useStore((s) => s.set);
  const music = useStore((s) => s.music);
  if (!playing) return null;
  return (
    <>
      <span className="nowplaying"><span className="nowplaying__dot" /> Playing <em>{playing.name}</em> <span data-show-time /></span>
      <Slider label="Tempo" value={p.speed} min={0.25} max={3} def={1} format={times} onChange={(speed) => set({ params: { ...p, speed } })} />
      {live.engine.show?.compiled.steps.some((s) => s.s.do === 'music') && !music.source && (
        <button className="chip" onClick={() => void listen('mic')}><Icon name="mic" /><span>Listen</span></button>
      )}
      <button className="chip" onClick={() => { stopShow(); tickSound(); }} data-testid="stop-show"><Icon name="stop" /><span>Stop</span></button>
    </>
  );
}

// ---------------------------------------------------------------- presets

function PresetsMenu() {
  const playing = useStore((s) => s.playing);
  const open = useStore((s) => s.menu === 'presets');
  const [saved, setSaved] = useState<Preset[]>([]);
  useEffect(() => { if (open) setSaved(loadSaved()); }, [open]);
  const icon = (p: Preset): IconName => (p.id === 'dusk' ? 'dusk' : p.id === 'dawn' ? 'sunUp' : p.id === 'wave' ? 'sweep' : p.id === 'heartbeat' ? 'breathe' : p.id === 'outage' ? 'flicker' : p.id === 'party' ? 'music' : p.id === 'reset' ? 'bulb' : 'spark');
  return (
    <MenuButton id="presets" icon="presets" label={<><small>Preset</small>{playing?.name ?? 'None'}</>} current={!!playing} testid="menu-presets">
      <p className="menu__title">Presets <span>light shows you can start with one click</span></p>
      {BUILT_IN.map((p) => <Item key={p.id} icon={icon(p)} name={p.show.name} help={p.blurb} on={playing?.id === p.id} onClick={() => { playPreset(p); tickSound(); }} testid={`preset-${p.id}`} />)}
      {saved.length > 0 && <p className="menu__title menu__title--sub">Yours <span>made with the director</span></p>}
      {saved.map((p) => (
        <Item
          key={p.id} icon="wand" name={p.show.name} help={p.blurb} on={playing?.id === p.id} onClick={() => { playPreset(p); tickSound(); }}
          right={<span className="item__del" role="button" tabIndex={0} aria-label={`Delete ${p.show.name}`} onClick={(e) => { e.stopPropagation(); deletePreset(p.id); setSaved(loadSaved()); }}><Icon name="trash" /></span>}
        />
      ))}
    </MenuButton>
  );
}

// ---------------------------------------------------------------- look

function LookMenu() {
  const view = useStore((s) => s.view);
  const master = useStore((s) => s.master);
  const feel = useStore((s) => s.feel);
  const survey = useStore((s) => s.survey);
  const scene = useStore((s) => s.scene);
  const motion = useStore((s) => s.motion);
  const set = useStore((s) => s.set);
  const setSettings = useStore((s) => s.setSettings);
  const up = (patch: Partial<typeof view>) => set({ view: { ...view, ...patch } });
  return (
    <MenuButton id="look" icon="sliders" label="Look" wide testid="menu-look">
      <p className="menu__title">Look <span>the picture itself, not single lights</span></p>
      <div className="look">
        <Slider label="All lights" value={master} min={0} max={1.5} def={1} format={pct} onChange={(m) => set({ master: m })} title="Brightness of every light at once" />
        <p className="look__help">Brightness of every light at once.</p>
        <Slider label="Unlit areas" value={view.ambient} min={0} max={1.6} def={1} format={pct} onChange={(ambient) => up({ ambient })} />
        <p className="look__help">How bright the parts no lamp reaches are.</p>
        {scene?.hasDaylight && (
          <>
            <Slider label="Daylight" value={view.daylight} min={0} max={1} def={0} format={pct} onChange={(daylight) => up({ daylight })} />
            <p className="look__help">Blend towards the picture as it was first made, before it went dark.</p>
          </>
        )}
        <Slider label="Glow" value={view.glow} min={0} max={1.5} def={DEFAULT_VIEW.glow} format={pct} onChange={(glow) => up({ glow })} />
        <p className="look__help">Soft bloom around bright lights.</p>
        <Slider label="Haze" value={view.haze} min={0} max={1.5} def={DEFAULT_VIEW.haze} format={pct} onChange={(haze) => up({ haze })} />
        <p className="look__help">Light scattering in the air, wide and faint.</p>
        <Slider label="Warmth" value={view.warmth} min={-1} max={1} def={0} format={(v) => (v === 0 ? 'neutral' : v > 0 ? `+${Math.round(v * 100)}` : `${Math.round(v * 100)}`)} onChange={(warmth) => up({ warmth })} />
        <p className="look__help">Shifts every light towards amber or towards blue.</p>
        <Slider label="Exposure" value={view.exposure} min={0.4} max={2.2} def={1} format={times} onChange={(exposure) => up({ exposure })} />
        <Slider label="Grain" value={view.grain} min={0} max={1.5} def={DEFAULT_VIEW.grain} format={pct} onChange={(grain) => up({ grain })} />
        {scene?.hasElement && (
          <>
            <div className="look__row">
              <span className="slider__label">{capital(scene.elementName ?? 'Motion')}</span>
              <button className="chip" onClick={() => set({ motion: { ...motion, playing: !motion.playing } })}><Icon name={motion.playing ? 'pause' : 'play'} /><span>{motion.playing ? 'Pause' : 'Play'}</span></button>
            </div>
            <Slider label="Its speed" value={motion.speed} min={0.1} max={3} def={1} format={times} onChange={(speed) => set({ motion: { ...motion, speed } })} />
          </>
        )}
        <div className="look__row">
          <span className="slider__label">Switching</span>
          <Segmented label="How lights switch" value={feel} onChange={(v) => { setSettings({ feel: v }); tickSound(); }} options={[
            { value: 'filament', label: 'Bulb', hint: 'Warm up and cool down like a filament' },
            { value: 'instant', label: 'Instant', hint: 'No easing' },
            { value: 'neon', label: 'Neon', hint: 'Stutter on like a tube' },
          ]} />
        </div>
        <div className="look__row">
          <span className="slider__label">Show lights</span>
          <Segmented label="Mark the lights" value={survey} onChange={(v) => setSettings({ survey: v })} options={[
            { value: 'off', label: 'Off' },
            { value: 'dots', label: 'Dots', hint: 'A dot on every light' },
            { value: 'heat', label: 'Heat', hint: 'Where the light falls' },
          ]} />
        </div>
        <button className="linkbtn" onClick={() => { set({ view: { ...DEFAULT_VIEW, ...(scene?.doc.demo?.view ?? {}) }, master: 1 }); tickSound(); }}>Reset the look</button>
      </div>
    </MenuButton>
  );
}

// ---------------------------------------------------------------- capture

function captureCanvas(): HTMLCanvasElement | null {
  const gl = document.querySelector<HTMLCanvasElement>('.stage__gl');
  if (!gl || !useStore.getState().analysis) return null;
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
  out.getContext('2d')!.drawImage(gl, (stageRect.x - box.left) * dpr, (stageRect.y - box.top) * dpr, stageRect.w * dpr, stageRect.h * dpr, 0, 0, out.width, out.height);
}

function CaptureMenu() {
  const scene = useStore((s) => s.scene);
  const recording = useStore((s) => s.recording);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const rec = useRef<{ r: MediaRecorder; raf: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const snapshot = () => {
    const out = captureCanvas();
    if (!out || !scene) return;
    drawCapture(out);
    out.toBlob((b) => b && saveBlob(b, `${slug(scene.doc.title)}.png`), 'image/png');
    set({ menu: null });
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
    const r = new MediaRecorder(out.captureStream(60), { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      saveBlob(new Blob(chunks, { type: type.split(';')[0] }), `${slug(scene.doc.title)}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
      toast('Clip saved to your downloads.');
    };
    const t0 = performance.now();
    const tick = () => {
      drawCapture(out);
      const s = (performance.now() - t0) / 1000;
      setElapsed(s);
      if (s > 60) { stopRec(); return; }
      if (rec.current) rec.current.raf = requestAnimationFrame(tick);
    };
    rec.current = { r, raf: requestAnimationFrame(tick) };
    r.start(250);
    set({ recording: true, menu: null });
    tickSound();
  };
  useEffect(() => () => stopRec(), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (recording) {
    return <button className="pill is-recording" onClick={stopRec} data-testid="stop-recording"><Icon name="stop" /><span className="pill__label">Stop · {Math.floor(elapsed)} s</span></button>;
  }
  return (
    <MenuButton id="capture" icon="camera" label="Capture" testid="menu-capture">
      <p className="menu__title">Capture <span>just the picture, no interface</span></p>
      <Item icon="camera" name="Save a still" help="A PNG of the picture as it looks right now." onClick={snapshot} />
      <Item icon="record" name="Record a clip" help="Up to a minute of video. Press Stop to save it." onClick={startRec} />
    </MenuButton>
  );
}

// ---------------------------------------------------------------- scene menu

function SceneMenu() {
  const scene = useStore((s) => s.scene);
  const key = useStore((s) => s.key);
  const variant = useStore((s) => s.variant);
  const set = useStore((s) => s.set);
  if (!scene) return null;
  const split = scene.doc.method === 'split' || scene.doc.method === 'perLight';
  const n = scene.doc.refinements?.length ?? 0;
  return (
    <MenuButton id="scene" icon="more" label="Scene" testid="menu-scene">
      <p className="menu__title">This scene <span>fixes and extras</span></p>
      {scene.editedLayer != null && (
        <Item icon="eye" name={variant === 'edits' ? 'Show the estimate' : 'Show the real edits'} help="Compare the lights the model repainted one by one with the ones split from the pair." onClick={() => set({ variant: variant === 'edits' ? 'estimate' : 'edits', menu: null })} />
      )}
      {split && (
        <Item icon="wand" name="Repaint chosen lights" help="Pick up to 12 lights and have the model repaint each one exactly (about 0.8¢ each). Best where lights overlap." onClick={() => set({ sheet: key ? 'refine' : 'settings', menu: null })} />
      )}
      {split && (
        <Item icon="moon" name="Redo the dark version" help={`One new image (about 1¢). Use it if lamps vanished instead of going dark.${n ? ` Drops the ${n} repainted lights.` : ''}`} onClick={() => {
          set({ menu: null });
          if (!key) { set({ sheet: 'settings' }); return; }
          if (confirm('Ask the model for a new lights-off version? (one image, about 1¢)')) void runRepaintOff();
        }} />
      )}
      <Item icon="heat" name="Lights and reflections" help="Tell it where water or wet ground starts, so lamps and their reflections switch together." onClick={() => set({ sheet: 'reflections', menu: null })} />
      <Item icon="download" name="Download the scene" help="A .zip with the images and settings. Open it again from Scenes." onClick={() => { void downloadScene(); set({ menu: null }); }} />
      {scene.source === 'local' && (
        <Item icon="trash" name="Delete this scene" help="Removes it from this browser." onClick={() => {
          if (confirm(`Delete “${scene.doc.title}” from this browser?`)) { void removeLocal(scene.doc.id); set({ menu: null, sheet: 'scenes' }); }
        }} />
      )}
    </MenuButton>
  );
}

// ---------------------------------------------------------------- 3D

function ThreeMenu() {
  const three = useStore((s) => s.three);
  const scene = useStore((s) => s.scene);
  const set = useStore((s) => s.set);
  const up = (patch: Partial<typeof three>) => set({ three: { ...useStore.getState().three, ...patch } });
  if (!scene) return null;
  if (!three.available) {
    return (
      <button className={`pill pill--three${three.busy ? ' is-busy' : ''}`} onClick={() => { if (!three.busy) void make3D(); }} disabled={!!three.busy} data-testid="make-3d" title="Measure depth in your browser (free) and turn the picture into 3D splats">
        <Icon name="cube" /><span className="pill__label">{three.busy ?? 'Parallax'}</span>
      </button>
    );
  }
  return (
    <MenuButton id="three" icon="cube" label={<><small>Parallax</small>{three.busy ? 'Adding detail' : three.on ? 'On' : 'Off'}</>} current={three.on} testid="menu-three">
      <p className="menu__title">Parallax <span>the picture as Gaussian splats: look around it a little</span></p>
      <div className="look">
        <div className="look__row">
          <span className="slider__label">Parallax</span>
          <Toggle on={three.on} onChange={(on) => { up({ on }); if (on) set({ space: { ...useStore.getState().space, on: false } }); if (on && TOUCH) void enableTilt(); live.view3d.goal = { ...live.view3d.goal, yaw: 0, pitch: 0, dolly: 0 }; tickSound(); }} label={three.on ? 'On' : 'Off'} />
        </div>
        <div className="look__row">
          <span className="slider__label">Camera</span>
          <Segmented label="How the camera moves" value={three.motion} onChange={(motion) => { up({ motion }); if (motion === 'follow' && TOUCH) void enableTilt(); live.view3d.goal = { ...live.view3d.goal, yaw: 0, pitch: 0, dolly: 0 }; tickSound(); }} options={[
            { value: 'follow', label: TOUCH ? 'Tilt' : 'Follow cursor', hint: TOUCH ? 'Tilt your phone to look around' : 'Look around as you move the pointer over the picture' },
            { value: 'drag', label: 'Drag', hint: 'Drag the empty parts of the picture to turn' },
            { value: 'sway', label: 'Sway', hint: 'Drifts slowly on its own' },
          ]} />
        </div>
        <div className="look__row">
          <span className="slider__label">Detail</span>
          <Segmented label="Detail" value={three.detail} onChange={(detail) => { up({ detail }); setTimeout(rebuildSplats, 0); tickSound(); }} options={[
            { value: 'fine', label: 'Every pixel', hint: 'One splat per pixel: full texture detail' },
            { value: 'fast', label: 'Lighter', hint: 'One splat per 2×2 pixels: for slower devices' },
          ]} />
        </div>
        {three.busy ? <p className="look__help">{three.busy}…</p> : (
          <button className="linkbtn" onClick={() => void make3D()} title="Runs both depth models again (free, a minute or two)">Measure depth again</button>
        )}
        <Slider label="Movement" value={three.amount} min={0.2} max={2.5} def={1} format={(v) => `${v.toFixed(1)}×`} onChange={(amount) => up({ amount })} />
        <p className="look__help">How far the camera may move.</p>
        <Slider label="Depth" value={three.strength} min={0.2} max={3} def={1} format={(v) => `${v.toFixed(1)}×`} onChange={(strength) => up({ strength })} />
        <p className="look__help">How deep the scene is: more makes near things pop out further.</p>
        <Slider label="Highlights" value={three.spec} min={0} max={2} def={0.6} format={(v) => `${Math.round(v * 100)}%`} onChange={(spec) => up({ spec })} />
        <p className="look__help">Glints from the brightest lights that slide over surfaces as you move.</p>
        <Slider label="Glow in space" value={three.glow3d} min={0} max={2} def={0.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(glow3d) => up({ glow3d })} />
        <p className="look__help">A glow at each light's place in space; nearer things hide it.</p>
      </div>
    </MenuButton>
  );
}

// ---------------------------------------------------------------- the 3D space

function SpaceMenu() {
  const space = useStore((s) => s.space);
  const scene = useStore((s) => s.scene);
  const set = useStore((s) => s.set);
  const up = (patch: Partial<typeof space>) => set({ space: { ...useStore.getState().space, ...patch } });
  if (!scene) return null;
  if (!space.available) {
    if (space.busy) return <button className="pill pill--space is-busy" disabled><Icon name="orbit" /><span className="pill__label">{space.busy}</span></button>;
    const make = (mode: 'around' | 'panorama') => { set({ menu: null }); void makeSpace(mode); };
    return (
      <MenuButton id="space" icon="orbit" label="3D space" testid="menu-space">
        <p className="menu__title">3D space <span>draw the place from more sides, then put it together (6 images, about 5.4¢)</span></p>
        <Item icon="orbit" name="Walk round it" help="The camera circles the middle of the picture, facing in, and sees it from the right, the back and the left. Best for a building, an object, a shop front." onClick={() => make('around')} testid="space-around" />
        <Item icon="sunUp" name="Look around from here" help="The camera stays where it is and turns, facing out: a panorama of everything around. Best for a room, a street, a landscape." onClick={() => make('panorama')} testid="space-panorama" />
        <p className="look__help">The other sides are imagined by the image model from your picture; Parallax stays the faithful view.</p>
      </MenuButton>
    );
  }
  const go = (yaw: number) => { live.envCam.goal = { ...live.envCam.goal, yaw }; tickSound(); };
  return (
    <MenuButton id="space" icon="orbit" label={<><small>3D space</small>{space.on ? 'On' : 'Off'}</>} current={space.on} testid="menu-space">
      <p className="menu__title">3D space <span>{live.env?.mode === 'panorama' ? 'everything around the camera, put together: look around' : 'the place drawn from around it, put together: walk round it'}</span></p>
      <div className="look">
        <div className="look__row">
          <span className="slider__label">3D space</span>
          <Toggle on={space.on} onChange={(on) => { up({ on }); if (on) set({ three: { ...useStore.getState().three, on: false } }); tickSound(); }} label={space.on ? 'On' : 'Off'} />
        </div>
        <p className="look__help">{live.env?.mode === 'panorama' ? 'Drag the empty parts of the picture to look around; scroll to step forward.' : 'Drag the empty parts of the picture to walk round; scroll to move in and out.'} Click a light to adjust it, as usual.</p>
        <div className="look__row">
          <span className="slider__label">Look from</span>
          <div className="segmented">
            {[['Front', 0], ['Right', 90], ['Back', 180], ['Left', 270]].map(([n, a]) => <button key={n} onClick={() => go(a as number)}>{n}</button>)}
          </div>
        </div>
        <div className="look__row">
          <span className="slider__label">Turn slowly</span>
          <Toggle on={space.turn} onChange={(turn) => up({ turn })} label={space.turn ? 'On' : 'Off'} />
        </div>
        <p className="look__help">The other sides are drawn by the image model from the first picture, so they are imagined: closest to true near the front.</p>
      </div>
    </MenuButton>
  );
}

// ---------------------------------------------------------------- the dock

export function Dock() {
  const cinema = useStore((s) => s.cinema);
  const scene = useStore((s) => s.scene);
  const directorOpen = useStore((s) => s.director.open);
  const director = useStore((s) => s.director);
  const set = useStore((s) => s.set);
  return (
    <section className={`dock${cinema ? ' is-hidden' : ''}`} aria-label="Lighting">
      <div className="dock__left">
        <EffectsMenu />
        <PresetsMenu />
        <button
          className={`pill pill--director${directorOpen ? ' is-current' : ''}`}
          onClick={() => { set({ director: { ...director, open: !directorOpen }, menu: null }); tickSound(); }}
          disabled={!scene}
          data-testid="open-director"
          title="Describe a light sequence in words"
        >
          <Icon name="wand" /><span className="pill__label">Director</span>
        </button>
        <ThreeMenu />
        <SpaceMenu />
      </div>
      <div className="dock__params"><EffectParams /></div>
      <div className="dock__right">
        <LookMenu />
        <CaptureMenu />
        <SceneMenu />
      </div>
    </section>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

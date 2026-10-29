import { useEffect, useRef, useState } from 'react';
import { live } from '../live';
import { useStore } from '../state';
import { Level, Slider } from './controls';
import { Icon } from './icons';
import { tickSound } from './sound';

export function CardHead({ title, right, note }: { title: string; right?: React.ReactNode; note?: string }) {
  return (
    <div className="cardhead">
      <h3 className="title">{title}</h3>
      {note && <span className="cardhead__note">{note}</span>}
      <span className="cardhead__rule" aria-hidden="true" />
      {right}
    </div>
  );
}

/** A miniature of the scene with the lights plotted on it — the survey plan. */
export function SurveyMap() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const analysis = useStore((s) => s.analysis);
  const survey = useStore((s) => s.survey);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !analysis) return;
    const ctx = cv.getContext('2d')!;
    let bitmap: ImageBitmap | null = null;
    let dead = false;
    let raf = 0;
    let frame = 0;
    let imgReady = false;
    const W = Math.min(640, analysis.width);
    const H = Math.round((W * analysis.height) / analysis.width);
    cv.width = W * 2;
    cv.height = H * 2;

    const b = live.bundle;
    const keys = b ? Object.keys(b.images) : [];
    const key = b ? (b.images.off ? 'off' : b.images.on ? 'on' : keys[0]) : undefined;
    const blob = key ? b!.images[key] : null;
    if (blob) {
      createImageBitmap(blob).then((bm) => { if (dead) { bm.close(); return; } bitmap = bm; imgReady = true; }).catch(() => { imgReady = true; });
    } else imgReady = true;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      frame++;
      const e = live.engine;
      const s = W / analysis.width;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (bitmap) {
        // the plate is data first, a picture second
        ctx.filter = 'grayscale(0.8) brightness(0.55) contrast(1.08)';
        ctx.globalAlpha = 0.9;
        ctx.drawImage(bitmap, 0, 0, W, H);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
      } else if (!imgReady) {
        // still decoding — an ink wash stands in
        ctx.fillStyle = '#221c17';
        ctx.fillRect(0, 0, W, H);
      }
      if (!bitmap && imgReady) {
        ctx.fillStyle = '#221c17';
        ctx.fillRect(0, 0, W, H);
      }
      if (survey === 'heat') {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.95;
        for (let i = 0; i < e.lights.length; i++) {
          const lv = Math.max(e.level[i], 0.22);
          const L = e.lights[i];
          const x = e.posX[i] * s, y = e.posY[i] * s;
          const r = Math.max(3, Math.sqrt(L.area) * s * 1.35);
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(255,238,206,${0.92 * lv})`);
          g.addColorStop(0.42, `rgba(240,120,52,${0.6 * lv})`);
          g.addColorStop(1, 'rgba(240,80,30,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // every light, always, as a hairline tick — the plan of the rig
      for (let i = 0; i < e.lights.length; i++) {
        const lv = e.level[i];
        const x = e.posX[i] * s, y = e.posY[i] * s;
        ctx.beginPath();
        ctx.fillStyle = lv > 0.5 ? 'rgba(255,236,206,0.95)' : 'rgba(244,236,224,0.5)';
        ctx.arc(x, y, lv > 0.5 ? 1.6 : 1.1, 0, Math.PI * 2);
        ctx.fill();
        if (lv > 0.06) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255,214,150,${0.12 + 0.3 * lv})`;
          ctx.lineWidth = 0.7;
          ctx.arc(x, y, 1.1 + 3.4 * lv, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const hover = useStore.getState().hoverGroup;
      if (hover != null) {
        for (let i = 0; i < e.lights.length; i++) {
          if (e.lights[i].group !== hover) continue;
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255,196,120,0.95)';
          ctx.lineWidth = 1.1;
          ctx.arc(e.posX[i] * s, e.posY[i] * s, 5.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const sel = useStore.getState().selected;
      if (sel != null && sel < e.count) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(240,105,42,1)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([2, 2]);
        ctx.arc(e.posX[sel] * s, e.posY[sel] * s, 6.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // the frame edge, so it reads as a plate rather than a picture
      ctx.strokeStyle = 'rgba(244,236,224,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    };
    raf = requestAnimationFrame(draw);
    return () => { dead = true; cancelAnimationFrame(raf); bitmap?.close(); };
  }, [analysis, survey]);

  const onClick = (ev: React.MouseEvent) => {
    const a = useStore.getState().analysis;
    if (!a) return;
    const box = (ev.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * a.width;
    const y = ((ev.clientY - box.top) / box.height) * a.height;
    const i = live.engine.pick(x, y, 22 / (box.width / a.width));
    if (i >= 0) { useStore.getState().set({ selected: i }); tickSound(); }
  };

  return (
    <div className="survey">
      <div className="survey__plate">
        <canvas ref={canvas} className="survey__canvas" onClick={onClick} role="img" aria-label="Light survey of the scene" />
        {!analysis && <div className="survey__empty">No scene open</div>}
      </div>
      <div className="minimap__scale" aria-hidden="true">
        <span>dark</span>
        <i />
        <span>lit</span>
      </div>
    </div>
  );
}

/** The survey plate that floats over the painting: where every lamp sits, and where its light falls. */
export function StageSurvey() {
  const survey = useStore((s) => s.survey);
  const setSettings = useStore((s) => s.setSettings);
  const scene = useStore((s) => s.scene);
  const [open, setOpen] = useState(true);
  if (!scene) return null;
  return (
    <div className={`minimap${open ? '' : ' is-closed'}`}>
      <div className="minimap__head">
        <button className="minimap__title" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the survey' : 'Show the survey'}>
          <Icon name="heat" />
          <span>Survey</span>
          <span className="minimap__count">{scene.lights}</span>
        </button>
        {open && (
          <div className="minimap__modes" role="radiogroup" aria-label="Survey overlay">
            {([['heat', 'heat'], ['dots', 'dots'], ['off', 'eyeOff']] as const).map(([v, icon]) => (
              <button
                key={v}
                role="radio"
                aria-checked={survey === v}
                className={survey === v ? 'is-on' : ''}
                onClick={() => { setSettings({ survey: v }); tickSound(); }}
                title={v === 'heat' ? 'Heat map (L)' : v === 'dots' ? 'Light positions (L)' : 'Hide the overlay (L)'}
                aria-label={v}
              >
                <Icon name={icon} />
              </button>
            ))}
          </div>
        )}
      </div>
      {open && <SurveyMap />}
    </div>
  );
}

export function ChannelsCard() {
  const scene = useStore((s) => s.scene);
  const groups = useStore((s) => s.groups);
  const master = useStore((s) => s.master);
  const elementFader = useStore((s) => s.elementFader);
  const set = useStore((s) => s.set);
  if (!scene) return null;
  const toggle = (i: number) => {
    const g = [...groups];
    const up = (g[i] ?? 0) < 0.02;
    g[i] = up ? 1 : 0;
    set({ groups: g });
    tickSound();
  };
  return (
    <section className="card card--channels" aria-label="Channels">
      <CardHead title="Channels" note="drag a bar to dim" />
      <div className="chans">
        {scene.groups.map((g, i) => (
          <div
            key={i}
            className={`chan${(groups[i] ?? 0) < 0.02 ? ' is-down' : ''}`}
            onPointerEnter={() => set({ hoverGroup: i })}
            onPointerLeave={() => set({ hoverGroup: null })}
          >
            <button
              className="chan__name"
              onClick={() => toggle(i)}
              title={`${(groups[i] ?? 0) < 0.02 ? 'Bring up' : 'Take down'} ${g.name} — ${g.count} light${g.count === 1 ? '' : 's'}`}
              aria-pressed={(groups[i] ?? 0) >= 0.02}
            >
              {g.name}
            </button>
            <Level
              label={g.name}
              lampId={String(i)}
              value={groups[i] ?? 1}
              onChange={(v) => { const n = [...groups]; n[i] = v; set({ groups: n }); }}
            />
          </div>
        ))}
        {scene.hasElement && (
          <div
            className={`chan chan--el${elementFader < 0.02 ? ' is-down' : ''}`}
            onPointerEnter={() => set({ hoverGroup: -2 })}
            onPointerLeave={() => set({ hoverGroup: null })}
          >
            <button className="chan__name" onClick={() => set({ elementFader: elementFader < 0.02 ? 1 : 0 })} title="The moving element">
              {scene.elementName ? scene.elementName.replace(/^the /, '') : 'moving light'}
            </button>
            <Level label="Moving light" lampId="el" value={elementFader} onChange={(v) => set({ elementFader: v })} />
          </div>
        )}
        <div className="chan chan--master">
          <button className="chan__name" onClick={() => set({ master: master < 0.02 ? 1 : 0 })} title="Every light at once" aria-pressed={master >= 0.02}>
            All lights
          </button>
          <Level label="All lights" lampId="all" value={master} onChange={(v) => set({ master: v })} title="Master level — drag to fade every light" />
          <span className="chan__val">{master.toFixed(2).replace(/^0/, '')}</span>
        </div>
      </div>
    </section>
  );
}

export function LookCard() {
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const up = (p: Partial<typeof view>) => set({ view: { ...view, ...p } });
  return (
    <section className="card card--look" aria-label="Look">
      <CardHead title="Look" note="the print itself" />
      <div className="sliders">
        <Slider label="Moonlight" value={view.ambient} min={0} max={1.6} step={0.01} def={1} onChange={(v) => up({ ambient: v })} title="How much of the unlit painting shows" format={(v) => `${Math.round(v * 100)}`} />
        <Slider label="Glow" value={view.glow} min={0} max={1.5} step={0.01} def={0.5} onChange={(v) => up({ glow: v })} title="Bloom around each lit surface" format={(v) => `${Math.round((v / 1.5) * 100)}`} />
        <Slider label="Warmth" value={view.warmth} min={-1} max={1} step={0.01} def={0} onChange={(v) => up({ warmth: v })} title="Push the light warm or cool" format={(v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`)} />
      </div>
      <details className="finer">
        <summary>Finer controls</summary>
        <div className="sliders">
          <Slider label="Exposure" value={view.exposure} min={0.5} max={1.6} step={0.01} def={1} onChange={(v) => up({ exposure: v })} format={(v) => `${v.toFixed(2)}×`} />
          <Slider label="Haze" value={view.haze} min={0} max={1} step={0.01} def={0.3} onChange={(v) => up({ haze: v })} format={(v) => `${Math.round(v * 100)}`} />
          <Slider label="Grain" value={view.grain} min={0} max={1} step={0.01} def={0.5} onChange={(v) => up({ grain: v })} format={(v) => `${Math.round(v * 100)}`} />
        </div>
      </details>
    </section>
  );
}

export function MotionCard() {
  const motion = useStore((s) => s.motion);
  const set = useStore((s) => s.set);
  const doc = useStore((s) => s.scene?.doc);
  if (!doc?.motion) return null;
  return (
    <section className="card card--motion" aria-label="Motion">
      <CardHead
        title="Motion"
        note={doc.method === 'grid' ? `${doc.grid?.frames ?? 0} painted frames` : 'one cut-out layer'}
        right={
          <button className={`playbtn${motion.playing ? ' is-on' : ''}`} onClick={() => set({ motion: { ...motion, playing: !motion.playing } })} title={motion.playing ? 'Pause (space)' : 'Play (space)'} aria-label={motion.playing ? 'Pause motion' : 'Play motion'}>
            <Icon name={motion.playing ? 'pause' : 'play'} />
          </button>
        }
      />
      <div className="sliders">
        <Slider label="Speed" value={motion.speed} min={0.1} max={3} step={0.05} def={1} onChange={(v) => set({ motion: { ...motion, speed: v } })} format={(v) => `${v.toFixed(2)}×`} />
        <Slider label="Blend" value={motion.blend} min={0} max={1} step={0.01} def={0.6} onChange={(v) => set({ motion: { ...motion, blend: v } })} format={(v) => (v < 0.02 ? 'hard cut' : `${Math.round(v * 100)}`)} />
      </div>
    </section>
  );
}

export function StageBar() {
  const motion = useStore((s) => s.motion);
  const set = useStore((s) => s.set);
  const doc = useStore((s) => s.scene?.doc);
  const cinema = useStore((s) => s.cinema);
  return (
    <div className="stagebar">
      <div className="livelamp" title="How much of the painting is lit right now">
        <span className="livelamp__dot" aria-hidden="true" />
        <span className="livelamp__num" data-lit-text>0%</span>
        <span className="livelamp__cap">lit</span>
      </div>
      <span className="stagebar__rule" />
      <div className="stagebar__hint">
        {useStore((s) => (s.picking ? 'Choosing lights for real edits' : s.scene ? `${s.scene.lights} lights · ${s.scene.groups.length} groups` : ''))}
      </div>
      <span className="spacer" />
      {doc?.motion && (
        <button className="iconbtn" onClick={() => set({ motion: { ...motion, playing: !motion.playing } })} title={motion.playing ? 'Pause (space)' : 'Play (space)'} aria-label={motion.playing ? 'Pause motion' : 'Play motion'}>
          <Icon name={motion.playing ? 'pause' : 'play'} />
        </button>
      )}
      <button className="iconbtn" onClick={() => set({ cinema: !cinema })} title={cinema ? 'Leave cinema (Esc)' : 'Cinema — the painting alone (F)'} aria-label="Cinema mode">
        <Icon name={cinema ? 'shrink' : 'expand'} />
      </button>
    </div>
  );
}


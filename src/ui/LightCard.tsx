import { useEffect, useRef, useState } from 'react';
import { live, runRefine } from '../live';
import { priceOf } from '../core/openrouter';
import type { Vec3 } from '../core/types';
import { useStore } from '../state';
import { Slider } from './controls';
import { Icon } from './icons';
import { stageRect } from './Stage';
import { switchSound, tickSound } from './sound';
import { money } from './TopBar';

const hexToLin = (hex: string): Vec3 => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const m = Math.max(...c, 1e-6);
  return [c[0] / m, c[1] / m, c[2] / m];
};

export const SWATCHES: { name: string; hex: string | null }[] = [
  { name: 'As painted', hex: null },
  { name: 'Candle', hex: '#ff8e3a' },
  { name: 'Tungsten', hex: '#ffb46b' },
  { name: 'Halogen', hex: '#ffdcae' },
  { name: 'Moonlight', hex: '#dbe5ff' },
  { name: 'Sodium', hex: '#ff7417' },
  { name: 'Rose', hex: '#ff86ad' },
  { name: 'Jade', hex: '#62f0b8' },
  { name: 'Iris', hex: '#a08fff' },
  { name: 'Ice', hex: '#86dcff' },
];

export function LightCard() {
  const selected = useStore((s) => s.selected);
  const scene = useStore((s) => s.scene);
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const set = useStore((s) => s.set);
  const [, force] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // follow the light (it can move: the train, grid frames)
  useEffect(() => {
    if (selected == null) return;
    let raf = 0;
    const tick = () => {
      const a = useStore.getState().analysis;
      const e = live.engine;
      if (a && selected < e.count) {
        const sx = stageRect.w / a.width;
        setPos((p) => {
          const x = stageRect.x + e.posX[selected] * sx, y = stageRect.y + e.posY[selected] * sx;
          return Math.abs(p.x - x) > 0.5 || Math.abs(p.y - y) > 0.5 ? { x, y } : p;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const close = (ev: KeyboardEvent) => { if (ev.key === 'Escape') set({ selected: null }); };
    window.addEventListener('keydown', close);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', close); };
  }, [selected, set]);

  if (selected == null || !scene) return null;
  const e = live.engine;
  if (selected >= e.count) return null;
  const isElement = e.hasElement && selected === e.count - 1;
  const L = isElement ? null : e.lights[selected];
  const on = e.base[selected] > 0.5;
  const colour = e.colors[selected];
  const name = isElement ? capital(scene.elementName ?? 'Moving light') : scene.doc.method === 'grid' ? scene.groups[L!.group]?.name ?? `Light ${L!.id}` : `Light ${L!.id}`;
  const groupName = L && scene.doc.method !== 'grid' ? scene.groups[L.group]?.name : null;
  const canRefine = !!L && scene.doc.method !== 'grid' && !!scene.doc.images.off && !(scene.doc.method === 'layered');

  const w = 272;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = pos.x + 24, top = pos.y - 40;
  if (left + w > vw - 12) left = pos.x - w - 24;
  if (top + 330 > vh - 12) top = vh - 342;
  if (top < 12) top = 12;

  return (
    <div className="lightcard" ref={ref} style={{ left, top, width: w }} role="dialog" aria-label={name}>
      <header className="lightcard__head">
        <div>
          <h2>{name}</h2>
          <p>{L?.refined ? 'Has its own generated edit.' : groupName ? `In group ${groupName}.` : isElement ? 'Travels with the moving layer.' : ''}</p>
        </div>
        <button className="iconbtn" onClick={() => set({ selected: null })} aria-label="Close"><Icon name="close" /></button>
      </header>
      <div className="lightcard__row">
        <button className={`bigswitch${on ? ' is-on' : ''}`} role="switch" aria-checked={on} onClick={() => { e.base[selected] = on ? 0 : 1; switchSound(!on); force((x) => x + 1); }}>
          <span className="bigswitch__plate"><span className="bigswitch__rocker" /></span>
          <span>{on ? 'On' : 'Off'}</span>
        </button>
        <button className="textbtn" onClick={() => { e.base.fill(0); e.base[selected] = 1; switchSound(true); force((x) => x + 1); }}>Only this one</button>
      </div>
      <Slider label="Brightness" value={e.base[selected]} min={0} max={1.5} def={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => { e.base[selected] = v; force((x) => x + 1); }} />
      <div className="swatches" role="radiogroup" aria-label="Colour">
        {SWATCHES.map((s) => {
          const active = s.hex === null ? !colour : !!colour && colour.join() === hexToLin(s.hex).join();
          return (
            <button
              key={s.name}
              role="radio"
              aria-checked={active}
              title={s.name}
              className={`swatch${active ? ' is-on' : ''}${s.hex ? '' : ' swatch--orig'}`}
              style={s.hex ? { ['--sw' as string]: s.hex } : undefined}
              onClick={() => { e.colors[selected] = s.hex ? hexToLin(s.hex) : null; tickSound(); force((x) => x + 1); }}
            />
          );
        })}
      </div>
      {groupName != null && (
        <button className="textbtn" onClick={() => {
          const c = e.colors[selected];
          e.lights.forEach((M, i) => { if (M.group === L!.group) e.colors[i] = c; });
          tickSound();
        }}>Use this colour for all of group {groupName}</button>
      )}
      {canRefine && (
        <div className="lightcard__refine">
          <p>Split lights are estimated. A real edit asks the model to light this one alone.</p>
          <button className="btn btn--small" disabled={!key} onClick={() => { set({ selected: null }); void runRefine([L!.id]); }} title={key ? undefined : 'Add your OpenRouter key in Settings first'}>
            <Icon name="spark" /><span>Generate its own edit, {money(priceOf(model, '768'))}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

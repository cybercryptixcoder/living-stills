// The light panel: appears when you click a light. Everything here acts on what is selected —
// one light, its whole group, or the lights you picked — and nothing needs a name or a letter.

import { useEffect, useState } from 'react';
import { live, runRefine, selectedIndices, setColor, setFx, setLevel, listen } from '../live';
import type { LightFx } from '../play/engine';
import { hexToRgb } from '../play/show';
import { useStore } from '../state';
import { Segmented, Slider } from './controls';
import { Icon } from './icons';
import { switchSound, tickSound } from './sound';

const SWATCHES: { name: string; hex: string | null }[] = [
  { name: 'Its own colour', hex: null },
  { name: 'Candle', hex: '#ffb46b' },
  { name: 'Warm white', hex: '#ffe2bd' },
  { name: 'Cool white', hex: '#e8f1ff' },
  { name: 'Amber', hex: '#ff9d2e' },
  { name: 'Red', hex: '#ff3b30' },
  { name: 'Pink', hex: '#ff4fa3' },
  { name: 'Violet', hex: '#9b6bff' },
  { name: 'Blue', hex: '#3d7dff' },
  { name: 'Cyan', hex: '#2fe0ff' },
  { name: 'Green', hex: '#3dff8a' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const zones = useStore((s) => s.zones);
  const scene = useStore((s) => s.scene);
  const music = useStore((s) => s.music);
  const key = useStore((s) => s.key);
  useStore((s) => s.rev);
  const set = useStore((s) => s.set);
  const [, force] = useState(0);
  const [more, setMore] = useState(false);
  // keep the switch in step with the engine (shows and effects change levels too)
  useEffect(() => {
    if (!selection) return;
    const t = setInterval(() => force((n) => n + 1), 400);
    return () => clearInterval(t);
  }, [selection]);
  if (!selection || !scene) return null;
  const e = live.engine;
  const ix = selectedIndices().filter((i) => i < e.count);
  if (!ix.length) return null;
  const anchor = selection.anchor;
  const isElement = anchor >= e.lights.length;
  const zone = isElement ? null : zones[e.zoneOf[anchor]];
  const avg = ix.reduce((s, i) => s + e.base[i], 0) / ix.length;
  const on = avg > 0.02;
  const fxs = new Set(ix.map((i) => e.fxOf(i)));
  const fx: LightFx | 'mixed' = fxs.size === 1 ? [...fxs][0] : 'mixed';
  const colours = ix.map((i) => e.colors[i]);
  const sameColour = colours.every((c) => JSON.stringify(c) === JSON.stringify(colours[0]));
  const title = selection.scope === 'picked'
    ? `${ix.length} lights`
    : isElement ? capital(scene.elementName ?? 'Moving light') : selection.scope === 'zone' ? zone?.name ?? 'Group' : zone?.name ?? 'Light';
  const sub = selection.scope === 'picked' ? 'that you picked' : selection.scope === 'zone' ? `the whole group · ${ix.length} light${ix.length === 1 ? '' : 's'}` : isElement ? 'the moving element' : zone && zone.lights.length > 1 ? `one light of this group of ${zone.lights.length}` : 'one light';
  const side = e.posX[anchor] / e.W > 0.58 ? 'left' : 'right';
  const canRefine = (scene.doc.method === 'split' || scene.doc.method === 'perLight') && !isElement;

  const scopeOptions = [
    { value: 'light' as const, label: 'This light' },
    ...(zone && zone.lights.length > 1 ? [{ value: 'zone' as const, label: `Its group · ${zone.lights.length}` }] : []),
    ...(selection.picked.length > 1 ? [{ value: 'picked' as const, label: `Picked · ${selection.picked.length}` }] : []),
  ];

  return (
    <aside className={`inspector inspector--${side}`} aria-label="Light" data-testid="inspector">
      <header className="inspector__head">
        <span className="inspector__bulb" style={{ ['--on' as string]: Math.min(1, avg) }} aria-hidden="true"><Icon name="bulb" /></span>
        <div className="inspector__titles">
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
        <button className="iconbtn" onClick={() => set({ selection: null })} aria-label="Close the light panel"><Icon name="close" /></button>
      </header>

      {scopeOptions.length > 1 && (
        <Segmented label="What to control" value={selection.scope} onChange={(scope) => { set({ selection: { ...selection, scope } }); tickSound(); }} options={scopeOptions} />
      )}

      <div className="inspector__power">
        <button
          className={`bigswitch${on ? ' is-on' : ''}`}
          role="switch"
          aria-checked={on}
          aria-label={on ? 'Switch off' : 'Switch on'}
          data-testid="light-switch"
          onClick={() => { setLevel(ix, on ? 0 : 1); switchSound(!on); }}
        >
          <span className="bigswitch__knob" />
          <span className="bigswitch__label">{on ? 'On' : 'Off'}</span>
        </button>
        <Slider label="Brightness" value={avg} min={0} max={1.5} def={1} format={pct} onChange={(v) => setLevel(ix, v)} />
      </div>

      <div className="inspector__block">
        <span className="inspector__label">Colour</span>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {SWATCHES.map((s) => {
            const rgb = s.hex ? hexToRgb(s.hex) : null;
            const active = sameColour && JSON.stringify(colours[0]) === JSON.stringify(rgb);
            return (
              <button
                key={s.name}
                role="radio"
                aria-checked={active}
                title={s.name}
                aria-label={s.name}
                className={`swatch${active ? ' is-on' : ''}${s.hex ? '' : ' swatch--own'}`}
                style={s.hex ? { background: s.hex } : undefined}
                onClick={() => { setColor(ix, rgb); tickSound(); }}
              />
            );
          })}
          <label className="swatch swatch--pick" title="Any colour">
            <input type="color" aria-label="Any colour" onChange={(ev) => setColor(ix, hexToRgb(ev.target.value))} />
          </label>
        </div>
      </div>

      <div className="inspector__block">
        <span className="inspector__label">Behaviour <em>runs on top of any effect</em></span>
        <Segmented<LightFx | 'mixed'>
          label="Behaviour"
          value={fx}
          onChange={(v) => {
            if (v === 'mixed') return;
            setFx(ix, v);
            if (v === 'music' && !music.source) void listen('mic');
            tickSound();
          }}
          options={[
            { value: 'steady', label: 'Steady' },
            { value: 'breathe', label: 'Breathe', hint: 'Slowly brightens and dims' },
            { value: 'flicker', label: 'Flicker', hint: 'Stutters like a tired bulb' },
            { value: 'music', label: 'Music', hint: 'Pulses with sound from your microphone' },
          ]}
        />
      </div>

      {canRefine && (
        <div className="inspector__more">
          <button className="linkbtn" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Less' : 'More'}</button>
          {more && (
            <div className="inspector__adv">
              <p>Doesn't look right? The model can repaint {ix.length === 1 ? 'this light' : 'these lights'} one by one, so each one's own glow is painted rather than estimated. About {(Math.min(12, ix.length) * 0.8).toFixed(1)}¢.</p>
              <button className="btn btn--small" onClick={() => {
                if (!key) { set({ sheet: 'settings' }); return; }
                void runRefine(ix.slice(0, 12).map((i) => e.lights[i].id));
              }}>
                <Icon name="wand" /> Repaint {ix.length === 1 ? 'it' : `${Math.min(12, ix.length)} lights`}
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

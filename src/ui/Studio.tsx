// Stage two of a two-stage scene: the picture is made; click where the lights go, say what each
// one is ("only the rubber of the front tyre"), pick a colour, then light it up.

import { useEffect, useMemo, useRef, useState } from 'react';
import { relayUrl } from '../core/luminal';
import { priceOf } from '../core/openrouter';
import type { Marker } from '../core/types';
import { cancelJob, live, removeLocal, runLightUp, saveDraftMarkers } from '../live';
import { useStore } from '../state';
import { Icon } from './icons';
import { tickSound } from './sound';
import { money } from './TopBar';

const COLOURS = ['', '#ffb46b', '#ffe2bd', '#ff3b30', '#ff4fa3', '#9b6bff', '#3d7dff', '#2fe0ff', '#3dff8a'];

export function Studio({ onClose }: { onClose: () => void }) {
  const draft = live.draft;
  const key = useStore((s) => s.key);
  const luminalKey = useStore((s) => s.luminalKey);
  const relay = useStore((s) => s.relay);
  const job = useStore((s) => s.job);
  const set = useStore((s) => s.set);
  const [markers, setMarkers] = useState<Marker[]>(() => draft?.doc.markers ?? []);
  const [lighting, setLighting] = useState(draft?.doc.lighting ?? '');
  const [active, setActive] = useState<number | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ n: number; moved: boolean } | null>(null);
  const url = useMemo(() => (draft ? URL.createObjectURL(draft.images.base) : ''), [draft]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // keep the draft saved as you go, so closing the tab loses nothing
  useEffect(() => {
    const t = setTimeout(() => void saveDraftMarkers(markers, lighting), 400);
    return () => clearTimeout(t);
  }, [markers, lighting]);
  if (!draft) return null;
  const { width: W, height: H } = draft.doc;
  const ambient = draft.doc.draft?.kind === 'ambient';
  const n = ambient ? 2 : 1;
  const cost = n * priceOf(draft.doc.model, draft.doc.resolution);
  const reads = !!luminalKey && !!relayUrl(relay);

  const toImage = (cx: number, cy: number) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round(((cx - r.left) / r.width) * W), y: Math.round(((cy - r.top) / r.height) * H) };
  };
  const add = (ev: React.PointerEvent) => {
    if (drag.current || job) return;
    const p = toImage(ev.clientX, ev.clientY);
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    const nn = (markers.reduce((m, x) => Math.max(m, x.n), 0) || 0) + 1;
    if (markers.length >= 12) return;
    setMarkers([...markers, { n: nn, x: p.x, y: p.y, note: '' }]);
    setActive(nn);
    tickSound();
  };
  const update = (nn: number, patch: Partial<Marker>) => setMarkers(markers.map((m) => (m.n === nn ? { ...m, ...patch } : m)));
  const remove = (nn: number) => {
    // renumber so the labels stay 1, 2, 3…
    const rest = markers.filter((m) => m.n !== nn).sort((a, b) => a.n - b.n).map((m, i) => ({ ...m, n: i + 1 }));
    setMarkers(rest);
    setActive(null);
  };

  return (
    <div className="studio-layer" role="dialog" aria-label="Place the lights">
      <div className="studio">
        <header className="studio__head">
          <div>
            <p className="studio__kicker">Step 2 of 2</p>
            <h2>Place the lights</h2>
            <p className="studio__lede">Click the picture wherever something should glow. Say what it is, especially if it’s a part of something (“only the rubber of the front tyre”).</p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close (the draft is kept in Scenes)"><Icon name="close" /></button>
        </header>
        <div className="studio__body">
          <div className="studio__picture">
            <div className="studio__frame" onPointerDown={add} style={{ aspectRatio: `${W} / ${H}` }} data-testid="studio-picture">
              <img ref={img} src={url} alt="Your picture" draggable={false} />
              {markers.map((m) => (
                <button
                  key={m.n}
                  className={`pinmark${active === m.n ? ' is-active' : ''}`}
                  style={{ left: `${(m.x / W) * 100}%`, top: `${(m.y / H) * 100}%`, ['--c' as string]: m.color || '#F0692A' }}
                  onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { n: m.n, moved: false }; setActive(m.n); }}
                  onPointerMove={(e) => {
                    if (!drag.current || drag.current.n !== m.n) return;
                    drag.current.moved = true;
                    const p = toImage(e.clientX, e.clientY);
                    update(m.n, { x: Math.min(W - 1, Math.max(0, p.x)), y: Math.min(H - 1, Math.max(0, p.y)) });
                  }}
                  onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); }}
                  aria-label={`Light ${m.n}`}
                >{m.n}</button>
              ))}
              {!markers.length && <p className="studio__hint">Click to place light 1</p>}
            </div>
          </div>
          <aside className="studio__side">
            <ol className="pinlist">
              {markers.map((m) => (
                <li key={m.n} className={active === m.n ? 'is-active' : ''} onFocus={() => setActive(m.n)}>
                  <span className="pinlist__n" style={{ ['--c' as string]: m.color || '#F0692A' }}>{m.n}</span>
                  <div className="pinlist__body">
                    <input className="input" value={m.note} placeholder="What glows here, e.g. “the lantern”" onChange={(e) => update(m.n, { note: e.target.value })} data-testid={`pin-note-${m.n}`} />
                    <div className="pinlist__colours" role="radiogroup" aria-label={`Colour of light ${m.n}`}>
                      {COLOURS.map((c) => (
                        <button key={c || 'own'} role="radio" aria-checked={(m.color ?? '') === c} className={`swatch swatch--small${(m.color ?? '') === c ? ' is-on' : ''}${c ? '' : ' swatch--own'}`} style={c ? { background: c } : undefined} title={c || 'Whatever suits it'} onClick={() => update(m.n, { color: c || undefined })} />
                      ))}
                    </div>
                  </div>
                  <button className="iconbtn" onClick={() => remove(m.n)} aria-label={`Remove light ${m.n}`}><Icon name="trash" /></button>
                </li>
              ))}
            </ol>
            {!markers.length && <p className="muted">No lights yet. Up to 12.</p>}
            <div className="field">
              <label className="field__label" htmlFor="st-light">Overall feel of the light <em>optional</em></label>
              <textarea id="st-light" className="input" rows={2} value={lighting} onChange={(e) => setLighting(e.target.value)} placeholder="e.g. warm and soft, like candlelight" />
            </div>
            <p className="field__hint">{reads ? 'First the picture is read, to find exactly what each number points at and where it ends. Then the image model switches those things on.' : 'Your notes go to the image model with each light’s position. Add a Luminal key in Settings and the picture is read first, which is more precise.'}</p>
          </aside>
        </div>
        <footer className="studio__foot">
          <button className="textbtn" onClick={() => { if (confirm('Throw this picture away?')) { void removeLocal(draft.doc.id); live.draft = null; set({ sheet: null }); } }}>Discard</button>
          <span className="spacer" />
          <p><strong>{n} image{n === 1 ? '' : 's'}</strong>, about {money(cost)}{ambient ? ' (the dark version, then your lights)' : ''}</p>
          {job ? (
            <button className="btn btn--quiet" onClick={cancelJob}>Stop</button>
          ) : (
            <button className="btn btn--primary btn--big" disabled={!markers.length || !key} onClick={() => { void runLightUp(markers, lighting); tickSound(); }} data-testid="studio-go">
              <Icon name="bulb" /><span>{key ? 'Light it up' : 'Add your OpenRouter key'}</span>
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

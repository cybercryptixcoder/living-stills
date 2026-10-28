import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { exportZip, loadBundle, type SceneEntry } from '../core/library';
import { checkKey, MODELS, modelById, priceOf } from '../core/openrouter';
import { bestForEdits, estimateCreate, gridCellCount } from '../core/pipeline';
import { IDEAS, STYLES } from '../core/prompts';
import type { GroupInfo, LightInfo } from '../core/types';
import { importScene, openEntry, plateFor, reanalyze, removeLocal, runCreate, runGrid, runRefine, saveBlob, slug } from '../live';
import { useStore } from '../state';
import { Segmented, Slider, Toggle } from './controls';
import { Icon } from './icons';
import { MODES } from './Console';
import { tickSound } from './sound';
import { methodLine, money } from './TopBar';

function Sheet({ side = 'right', title, children, footer, onClose, wide }: { side?: 'left' | 'right'; title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('input, textarea, button:not(.sheet__close)')?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-layer" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`sheet sheet--${side}${wide ? ' sheet--wide' : ''}`} ref={ref} role="dialog" aria-label={title}>
        <header className="sheet__head">
          <h2>{title}</h2>
          <button className="iconbtn sheet__close" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <footer className="sheet__foot">{footer}</footer>}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- scenes

function Thumb({ entry }: { entry: SceneEntry }) {
  const [urls, setUrls] = useState<{ off?: string; on?: string }>({});
  useEffect(() => {
    const made: string[] = [];
    const u = (v?: string | Blob) => {
      if (!v) return undefined;
      if (typeof v === 'string') return v;
      const x = URL.createObjectURL(v);
      made.push(x);
      return x;
    };
    setUrls({ off: u(entry.thumbOff), on: u(entry.thumbOn) });
    return () => made.forEach((x) => URL.revokeObjectURL(x));
  }, [entry]);
  return (
    <span className="thumb" style={{ aspectRatio: `${entry.doc.width} / ${entry.doc.height}` }}>
      {urls.off && <img src={urls.off} alt="" loading="lazy" className="thumb__off" />}
      {urls.on && <img src={urls.on} alt="" loading="lazy" className="thumb__on" />}
    </span>
  );
}

function SceneCard({ entry, current }: { entry: SceneEntry; current: boolean }) {
  const toast = useStore((s) => s.toast);
  const kind = { split: 'Split', perLight: 'Per-light edits', layered: 'Moving layer', grid: 'Every frame' }[entry.method];
  return (
    <li className={`scenecard${current ? ' is-current' : ''}`}>
      <button className="scenecard__open" onClick={() => { tickSound(); void openEntry(entry); }} aria-current={current}>
        <Thumb entry={entry} />
        <span className="scenecard__text">
          <span className="scenecard__kind">{kind}</span>
          <span className="scenecard__title">{entry.title}</span>
          <span className="scenecard__line">{methodLine(entry.doc)}</span>
        </span>
      </button>
      {entry.source === 'local' && (
        <span className="scenecard__tools">
          <button className="iconbtn" title="Download this scene" aria-label={`Download ${entry.title}`} onClick={async () => {
            const b = await loadBundle(entry);
            saveBlob(await exportZip(b), `${slug(entry.title)}.living-stills.zip`);
          }}><Icon name="download" /></button>
          <button className="iconbtn" title="Delete from this browser" aria-label={`Delete ${entry.title}`} onClick={async () => {
            if (!confirm(`Delete "${entry.title}" from this browser? This cannot be undone.`)) return;
            await removeLocal(entry.id);
            toast(`Deleted ${entry.title}.`);
          }}><Icon name="trash" /></button>
        </span>
      )}
    </li>
  );
}

export function ScenesSheet({ onClose }: { onClose: () => void }) {
  const examples = useStore((s) => s.examples);
  const locals = useStore((s) => s.locals);
  const currentId = useStore((s) => s.currentId);
  const toast = useStore((s) => s.toast);
  const file = useRef<HTMLInputElement>(null);
  return (
    <Sheet side="left" title="Scenes" onClose={onClose}
      footer={
        <>
          <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { await importScene(f); onClose(); } catch (err) { toast((err as Error).message, 'error'); }
            e.target.value = '';
          }} />
          <button className="btn btn--quiet" onClick={() => file.current?.click()}><Icon name="upload" /><span>Open a scene file</span></button>
        </>
      }>
      {locals.length > 0 && (
        <section className="scenegroup">
          <h3>Yours</h3>
          <ul>{locals.map((e) => <SceneCard key={e.id} entry={e} current={e.id === currentId} />)}</ul>
        </section>
      )}
      <section className="scenegroup">
        <h3>Examples</h3>
        {examples.length ? <ul>{examples.map((e) => <SceneCard key={e.id} entry={e} current={e.id === currentId} />)}</ul> : <p className="muted">No examples were found next to this page.</p>}
      </section>
    </Sheet>
  );
}

// ---------------------------------------------------------------- create

export function CreateSheet({ onClose }: { onClose: () => void }) {
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const resolution = useStore((s) => s.resolution);
  const aspect = useStore((s) => s.aspect);
  const setSettings = useStore((s) => s.setSettings);
  const set = useStore((s) => s.set);
  const [desc, setDesc] = useState('');
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState(STYLES[0].id);
  const [element, setElement] = useState('');
  const m = modelById(model);
  const res = m.resolutions.includes(resolution) ? resolution : m.resolutions[0];
  const est = estimateCreate(model, res, !!element.trim());
  const ok = desc.trim().length >= 8;
  const go = () => {
    if (!ok || !key) return;
    void runCreate({ model, resolution: res, aspect, description: desc, styleId: style, element: element.trim() || undefined, title: title.trim() || undefined });
  };
  return (
    <Sheet title="Paint a new night" onClose={onClose}
      footer={
        <div className="estimate">
          <p><strong>{est.images} images</strong>, about {money(est.cost)} and {est.images > 2 ? '40' : '25'} seconds.</p>
          {key ? (
            <button className="btn btn--primary btn--big" disabled={!ok} onClick={go}><Icon name="spark" /><span>Paint it</span></button>
          ) : (
            <button className="btn btn--primary btn--big" onClick={() => set({ sheet: 'settings' })}><Icon name="key" /><span>Add your key</span></button>
          )}
        </div>
      }>
      <label className="field">
        <span className="field__label">Describe the place</span>
        <textarea rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="A quiet canal street in the rain, old houses with small windows, a lantern over a bridge…" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); }} />
        <span className="field__hint">Name the lights you want to play with. The scene is painted at night with them switched on.</span>
      </label>
      <div className="ideas" aria-label="Ideas">
        {IDEAS.map((i) => (
          <button key={i.title} className="chip" onClick={() => { setDesc(i.prompt); setElement(i.element ?? ''); setTitle(i.name); tickSound(); }}>{i.title}</button>
        ))}
      </div>
      <div className="field">
        <span className="field__label">Style</span>
        <Segmented label="Style" value={style} onChange={setStyle} options={STYLES.map((s) => ({ value: s.id, label: s.name }))} />
      </div>
      <label className="field">
        <span className="field__label">Something that moves <em>optional</em></span>
        <input value={element} onChange={(e) => setElement(e.target.value)} placeholder="the train" />
        <span className="field__hint">One thing that should travel across the picture, seen from the side. It is cut out as its own layer, which takes 2 more images.</span>
      </label>
      <div className="field-row">
        <div className="field">
          <span className="field__label">Shape</span>
          <Segmented label="Shape" value={aspect} onChange={(v) => setSettings({ aspect: v })} options={[
            { value: '16:9', label: 'Wide' }, { value: '3:2', label: 'Photo' }, { value: '1:1', label: 'Square' }, { value: '9:16', label: 'Phone' },
          ]} />
        </div>
        <div className="field">
          <span className="field__label">Detail</span>
          <Segmented label="Detail" value={res} onChange={(v) => setSettings({ resolution: v })} options={m.resolutions.slice(0, 3).map((r) => ({ value: r, label: r, hint: `${money(priceOf(model, r))} per image` }))} />
        </div>
      </div>
      <label className="field">
        <span className="field__label">Title <em>optional</em></span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Made from the description if left empty" />
      </label>
    </Sheet>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const sound = useStore((s) => s.sound);
  const spend = useStore((s) => s.spend);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState(key);
  const [show, setShow] = useState(false);
  const [check, setCheck] = useState<{ state: 'idle' | 'busy' | 'ok' | 'bad'; text?: string }>({ state: 'idle' });
  const verify = async () => {
    const k = draft.trim();
    if (!k) return;
    setCheck({ state: 'busy' });
    try {
      const info = await checkKey(k);
      setSettings({ key: k });
      setCheck({ state: 'ok', text: info.remaining != null ? `Key works. ${money(info.remaining)} left on it.` : `Key works. ${money(info.usage)} used so far.` });
    } catch (err) {
      setCheck({ state: 'bad', text: (err as Error).message });
    }
  };
  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="field">
        <label className="field__label" htmlFor="orkey">OpenRouter key</label>
        <div className="keyfield">
          <input id="orkey" type={show ? 'text' : 'password'} value={draft} autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" onChange={(e) => { setDraft(e.target.value); setCheck({ state: 'idle' }); }} onKeyDown={(e) => e.key === 'Enter' && verify()} />
          <button className="textbtn" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
        </div>
        <div className="keyrow">
          <button className="btn btn--small" onClick={verify} disabled={!draft.trim() || check.state === 'busy'}>{check.state === 'busy' ? 'Checking…' : 'Save and check'}</button>
          {key && <button className="textbtn" onClick={() => { setSettings({ key: '' }); setDraft(''); setCheck({ state: 'idle' }); }}>Forget key</button>}
        </div>
        {check.text && <p className={`notice notice--${check.state}`} role="status">{check.text}</p>}
        <span className="field__hint">Stored only in this browser. Images are requested straight from OpenRouter.</span>
      </div>
      <div className="field">
        <span className="field__label">Image model</span>
        <div className="models" role="radiogroup" aria-label="Image model">
          {MODELS.map((m) => (
            <button key={m.id} role="radio" aria-checked={model === m.id} className={`model${model === m.id ? ' is-on' : ''}`} onClick={() => setSettings({ model: m.id })}>
              <span className="model__name">{m.name}</span>
              <span className="model__price">{money(m.price[m.resolutions.includes('1K') ? '1K' : m.resolutions[0]])} per image</span>
              <span className="model__note">{m.note}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <Toggle on={sound} onChange={(v) => setSettings({ sound: v })} label="Switch sounds" />
      </div>
      <p className="muted">Spent in this session: {money(spend)}.</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------- refine (per-light edits)

export function RefineSheet({ onClose }: { onClose: () => void }) {
  const picked = useStore((s) => s.picked);
  const analysis = useStore((s) => s.analysis);
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const set = useStore((s) => s.set);
  useEffect(() => {
    const before = useStore.getState().showLights;
    set({ picking: true, showLights: true });
    return () => set({ picking: false, showLights: before });
  }, [set]);
  if (!analysis) return null;
  const brightest = (n: number) => bestForEdits(analysis.lights, analysis.width, analysis.height, analysis.waterline, n);
  const cost = picked.length * priceOf(model, '768');
  return (
    <Sheet title="Real edits for chosen lights" onClose={() => { set({ picked: [] }); onClose(); }}
      footer={
        <div className="estimate">
          <p><strong>{picked.length} edit{picked.length === 1 ? '' : 's'}</strong>, about {money(cost)}.</p>
          <button className="btn btn--primary btn--big" disabled={!picked.length || !key} onClick={() => { const ids = picked; set({ picked: [] }); void runRefine(ids); }}>
            <Icon name="spark" /><span>{key ? `Generate ${picked.length || ''} edit${picked.length === 1 ? '' : 's'}` : 'Add your key in Settings'}</span>
          </button>
        </div>
      }>
      <p className="lede">The split method estimates where each light falls. A real edit crops the picture around one light, asks the model to switch on just that light, and pastes the result back with soft edges. Precise, and one image per light.</p>
      <p className="muted">Click lights in the picture to choose them. Up to 12.</p>
      <div className="ideas">
        <button className="chip" onClick={() => set({ picked: brightest(3) })}>Brightest 3</button>
        <button className="chip" onClick={() => set({ picked: brightest(5) })}>Brightest 5</button>
        {picked.length > 0 && <button className="chip" onClick={() => set({ picked: [] })}>Clear</button>}
      </div>
      {picked.length > 0 && (
        <ul className="picklist">
          {picked.map((id) => (
            <li key={id}><span>Light {id}</span><button className="iconbtn" aria-label={`Leave out light ${id}`} onClick={() => set({ picked: picked.filter((x) => x !== id) })}><Icon name="close" /></button></li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- grid (every frame x every light)

export function GridSheet({ onClose }: { onClose: () => void }) {
  const scene = useStore((s) => s.scene);
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const [plate, setPlate] = useState<{ lights: LightInfo[]; groups: GroupInfo[] } | null>(null);
  const [frames, setFrames] = useState(4);
  const [chosen, setChosen] = useState<number[]>([]);
  const [withElement, setWithElement] = useState(true);
  useEffect(() => {
    void plateFor().then((p) => {
      setPlate(p);
      if (p) setChosen([...p.groups].sort((a, b) => b.lights.length - a.lights.length).slice(0, 2).map((g) => g.id));
    });
  }, []);
  const plan = useMemo(() => ({ frames, groups: plate?.groups.filter((g) => chosen.includes(g.id)) ?? [], includeElement: withElement }), [frames, plate, chosen, withElement]);
  const cells = gridCellCount(plan);
  const cost = cells * priceOf(model, '768');
  const rows = [...(withElement ? [capital(scene?.doc.motion?.element.replace(/^the /, '') ?? 'Moving')] : []), ...plan.groups.map((g) => `Lights ${g.name}`)];
  return (
    <Sheet title="Paint every frame" onClose={onClose} wide
      footer={
        <div className="estimate">
          <p><strong>{cells} images</strong>, about {money(cost)}.</p>
          <button className="btn btn--primary btn--big" disabled={!cells || !key || !plate} onClick={() => void runGrid(plan)}>
            <Icon name="grid" /><span>{key ? `Generate ${cells} images` : 'Add your key in Settings'}</span>
          </button>
        </div>
      }>
      <p className="lede">The moving layer cuts {scene?.doc.motion?.element ?? 'the element'} out once and slides it. This is the brute-force way: put it at several positions and have the model paint every light again at every position. Light falls on it correctly at each stop, at the cost of frames × lights images.</p>
      <div className="field">
        <span className="field__label">Positions</span>
        <Segmented label="Positions" value={String(frames)} onChange={(v) => setFrames(+v)} options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }))} />
      </div>
      <div className="field">
        <span className="field__label">Lights to paint at each position</span>
        <Toggle on={withElement} onChange={setWithElement} label={`${capital(scene?.doc.motion?.element ?? 'The element')}'s own lights`} />
        {!plate && <p className="muted">Reading the lights…</p>}
        <div className="groupchecks">
          {plate?.groups.map((g) => (
            <label key={g.id} className={`groupcheck${chosen.includes(g.id) ? ' is-on' : ''}`} onPointerEnter={() => useStore.getState().set({ hoverGroup: g.id })} onPointerLeave={() => useStore.getState().set({ hoverGroup: null })}>
              <input type="checkbox" checked={chosen.includes(g.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, g.id] : chosen.filter((x) => x !== g.id))} />
              <span>Group {g.name}</span><em>{g.lights.length} lights</em>
            </label>
          ))}
        </div>
      </div>
      <div className="matrix" style={{ ['--cols' as string]: frames }} aria-label="Images that will be generated">
        <span />
        {Array.from({ length: frames }, (_, f) => <span key={f} className="matrix__col">{f + 1}</span>)}
        {rows.map((r) => (
          <MatrixRow key={r} label={r} frames={frames} />
        ))}
      </div>
    </Sheet>
  );
}

function MatrixRow({ label, frames }: { label: string; frames: number }) {
  return (
    <>
      <span className="matrix__row">{label}</span>
      {Array.from({ length: frames }, (_, f) => <span key={f} className="matrix__cell" />)}
    </>
  );
}

// ---------------------------------------------------------------- reflections and light detail

export function ReflectionsSheet({ onClose }: { onClose: () => void }) {
  const scene = useStore((s) => s.scene);
  const analysis = useStore((s) => s.analysis);
  const set = useStore((s) => s.set);
  const doc = scene?.doc;
  const H = analysis?.height ?? 1;
  const initial: 'auto' | 'set' | 'none' = doc?.waterline === undefined ? 'auto' : doc.waterline === null ? 'none' : 'set';
  const [how, setHow] = useState(initial);
  const [y, setY] = useState((doc?.waterline ?? analysis?.waterline ?? H * 0.7) / H);
  const [detail, setDetail] = useState(doc?.analysis?.coreStrictness ?? 1);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    set({ previewWaterline: how === 'set' ? y * H : how === 'auto' ? analysis?.waterline ?? null : null });
  }, [how, y, H, analysis, set]);
  useEffect(() => () => set({ previewWaterline: null }), [set]);
  if (!doc || !analysis) return null;
  const apply = async () => {
    setBusy(true);
    await reanalyze({
      waterline: how === 'auto' ? undefined : how === 'none' ? null : Math.round(y * H),
      analysis: { ...(doc.analysis ?? {}), coreStrictness: detail },
    });
    setBusy(false);
    onClose();
  };
  const now = analysis.waterline == null ? 'There is no reflection line now.' : `The line is now ${Math.round((analysis.waterline / H) * 100)}% of the way down.`;
  return (
    <Sheet title="Lights and reflections" onClose={onClose}
      footer={<div className="estimate"><p>{analysis.lights.length} lights now. Free, runs in your browser.</p><button className="btn btn--primary btn--big" disabled={busy} onClick={apply}>{busy ? 'Finding lights…' : 'Find the lights again'}</button></div>}>
      <p className="lede">Below the reflection line, light is treated as a reflection of the lights above it, so a lamp and its reflection switch together. Put it where the water or the wet ground begins.</p>
      <div className="field">
        <span className="field__label">Reflection line</span>
        <Segmented label="Reflection line" value={how} onChange={setHow} options={[
          { value: 'auto', label: 'Find it', hint: 'Look for water automatically' },
          { value: 'set', label: 'Set it', hint: 'Choose where reflections begin' },
          { value: 'none', label: 'None', hint: 'No reflections in this scene' },
        ]} />
        {how === 'set' && <Slider label="Height" value={y} min={0.2} max={0.98} def={0.7} format={(v) => `${Math.round(v * 100)}%`} onChange={setY} title="How far down the picture reflections begin" />}
        <span className="field__hint">{now} The dashed line on the picture shows where it will be.</span>
      </div>
      <div className="field">
        <span className="field__label">Light detail</span>
        <Slider label="Detail" value={2 - detail} min={0.4} max={1.4} def={1} format={(v) => (v > 1.05 ? 'Finer' : v < 0.95 ? 'Coarser' : 'Normal')} onChange={(v) => setDetail(2 - v)} title="Finer finds more, smaller lights" />
        <span className="field__hint">Finer finds dimmer and smaller lights; coarser keeps only the brightest.</span>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- help

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="How it works" onClose={onClose}>
      <p className="lede">Light adds up. If you have the same picture with every light on and with every light off, the difference is the light itself, and any mix of lights is the dark picture plus some share of that difference.</p>
      <dl className="methods">
        <dt>Split</dt>
        <dd>Two images. The lit areas are found in the difference and every lamp and window becomes its own light. Glow between lights is shared by distance, and reflections follow the lights above them.</dd>
        <dt>Per-light edits</dt>
        <dd>One extra image per light. The model sees a crop centred on that light and switches on only it, so the way its light falls is painted, not estimated.</dd>
        <dt>Moving layer</dt>
        <dd>Two more images: the scene without the moving thing, lit and unlit. The difference cuts it out with its own glow, so it can loop forever.</dd>
        <dt>Every frame</dt>
        <dd>Frames × lights images. Every light painted again at every position. Expensive, kept to compare.</dd>
      </dl>
      <h3 className="subhead">Keys</h3>
      <ul className="keys">
        {MODES.map((m) => <li key={m.id}><kbd>{m.key}</kbd><span>{m.name}</span></li>)}
        <li><kbd>A</kbd><span>All lights on</span></li>
        <li><kbd>O</kbd><span>All lights off</span></li>
        <li><kbd>L</kbd><span>Show lights</span></li>
        <li><kbd>Space</kbd><span>Play or pause motion</span></li>
        <li><kbd>[</kbd><kbd>]</kbd><span>Smaller or larger radius</span></li>
        <li><kbd>H</kbd><span>Hide everything but the picture</span></li>
        <li><kbd>N</kbd><span>New scene</span></li>
        <li><kbd>S</kbd><span>Scenes</span></li>
      </ul>
    </Sheet>
  );
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}


import { useEffect, useRef, useState, type ReactNode } from 'react';
import { exportZip, loadBundle, type SceneEntry } from '../core/library';
import { checkLuminal, relayUrl } from '../core/luminal';
import { checkKey, MODELS, modelById, priceOf } from '../core/openrouter';
import { bestForEdits } from '../core/pipeline';
import { IDEAS } from '../core/prompts';
import { importScene, openEntry, reanalyze, removeLocal, runCreate, runCreateBase, runFromPhoto, runRefine, saveBlob, slug } from '../live';
import { useStore } from '../state';
import { Segmented, Slider, Toggle } from './controls';
import { EFFECTS } from './Dock';
import { Icon } from './icons';
import { tickSound } from './sound';
import { methodLine, money } from './TopBar';

export function Sheet({ side = 'right', title, children, footer, onClose, wide }: { side?: 'left' | 'right'; title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
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
  const kind = entry.doc.draft ? 'Draft · place the lights' : entry.doc.markers?.length ? 'Lights placed by hand' : { split: 'Split', perLight: 'Repainted lights', layered: 'Moving layer' }[entry.method];
  return (
    <li className={`scenecard${current ? ' is-current' : ''}`}>
      <button className="scenecard__open" onClick={() => { tickSound(); void openEntry(entry); }} aria-current={current}>
        <Thumb entry={entry} />
        <span className="scenecard__text">
          <span className="scenecard__kind">{kind}</span>
          <span className="scenecard__title">{entry.title}</span>
          <span className="scenecard__line">{entry.doc.draft ? 'Only the picture so far. Open it to place the lights.' : methodLine(entry.doc, 0)}</span>
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

const ASPECTS = [
  { value: '16:9', label: 'Wide' },
  { value: '3:2', label: 'Photo' },
  { value: '1:1', label: 'Square' },
  { value: '9:16', label: 'Phone' },
];

export function CreateSheet({ onClose }: { onClose: () => void }) {
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const resolution = useStore((s) => s.resolution);
  const aspect = useStore((s) => s.aspect);
  const luminalKey = useStore((s) => s.luminalKey);
  const relay = useStore((s) => s.relay);
  const setSettings = useStore((s) => s.setSettings);
  const set = useStore((s) => s.set);
  const [flow, setFlow] = useState<'one' | 'two' | 'photo'>('one');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [recreate, setRecreate] = useState(true);
  const [changes, setChanges] = useState('');
  const [then, setThen] = useState<'picture' | 'describe' | 'place'>('place');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  const takePhoto = (f: File | undefined | null) => {
    if (!f || !f.type.startsWith('image/')) return;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhoto(f);
    setPhotoUrl(URL.createObjectURL(f));
  };
  const [prompt, setPrompt] = useState('');
  const [lighting, setLighting] = useState('');
  const [element, setElement] = useState('');
  const [title, setTitle] = useState('');
  const [baseKind, setBaseKind] = useState<'dark' | 'ambient' | 'lit'>('dark');
  const [more, setMore] = useState(false);
  const m = modelById(model);
  const res = m.resolutions.includes(resolution) ? resolution : m.resolutions.includes('1K') ? '1K' : m.resolutions[0];
  const price = priceOf(model, res);
  const kindNow = flow === 'photo' && then === 'describe' ? baseKind : baseKind === 'lit' ? 'dark' : baseKind;
  const photoImages = (recreate ? 1 : 0) + (then === 'picture' ? 0 : kindNow === 'ambient' ? 2 : 1);
  const n = flow === 'one' ? (element.trim() ? 4 : 2) : flow === 'two' ? (kindNow === 'ambient' ? 3 : 2) : photoImages;
  const ready = flow === 'photo' ? !!photo && (then !== 'describe' || lighting.trim().length > 2) : prompt.trim().length > 3;
  const go = () => {
    if (!key) { set({ sheet: 'settings' }); return; }
    if (!ready) return;
    tickSound();
    if (flow === 'one') void runCreate({ model, resolution: res, aspect, description: prompt, lighting, element: element.trim() || undefined, title: title.trim() || undefined });
    else if (flow === 'two') void runCreateBase({ model, resolution: res, aspect, description: prompt, lighting, kind: kindNow === 'ambient' ? 'ambient' : 'dark', title: title.trim() || undefined });
    else void runFromPhoto({ photo: photo!, recreate, changes, then, kind: kindNow, lighting, title: title.trim() || undefined });
  };
  const also3d = useStore((s) => s.also3d);
  const goLabel = !key ? 'Add your OpenRouter key' : flow === 'one' ? 'Make it' : flow === 'two' ? 'Make the picture' : then === 'describe' ? 'Light it up' : recreate ? 'Recreate it' : 'Use it';
  return (
    <Sheet title="New scene" onClose={onClose} wide
      footer={
        <div className="estimate">
          <p>{n ? <><strong>{n} image{n === 1 ? '' : 's'}</strong>, about {money(n * price)}{flow === 'two' || (flow === 'photo' && then === 'place') ? ' in total. You place the lights before the last.' : '.'}</> : <strong>No images to pay for.</strong>}</p>
          <button className="btn btn--primary btn--big" onClick={go} disabled={!!key && !ready} data-testid="create-go">
            <Icon name={key ? 'spark' : 'key'} /><span>{goLabel}</span>
          </button>
        </div>
      }>
      <Segmented label="How to make it" value={flow} onChange={(v) => { setFlow(v); tickSound(); }} options={[
        { value: 'one', label: 'In one go', hint: 'Describe the picture and its lights; the app does the rest' },
        { value: 'two', label: 'Picture, then lights', hint: 'See the picture, then click where the lights go' },
        { value: 'photo', label: 'From a photo', hint: 'A photo, a drawing you made, a place you saw' },
      ]} />
      <p className="flowhelp">{flow === 'one'
        ? 'The picture is made with its lights on, then again with them off. Every light in it becomes controllable.'
        : flow === 'two' ? 'First just the picture. Then you click where the lights go, say what each one is, and the app lights exactly those.'
          : 'Bring a photo, a scan of your artwork or a picture of a real place. The image model can recreate it first (exactly, or with changes), which edits more cleanly.'}</p>

      {flow === 'photo' && (
        <div className="field">
          <span className="field__label">Your picture</span>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => takePhoto(e.target.files?.[0])} data-testid="photo-input" />
          <button
            className={`dropzone${photoUrl ? ' has-photo' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); takePhoto(e.dataTransfer.files?.[0]); }}
          >
            {photoUrl ? <img src={photoUrl} alt="Your picture" /> : <span><Icon name="upload" /> Drop a photo here, or click to choose one</span>}
          </button>
          <Toggle on={recreate} onChange={setRecreate} label="Recreate it with the image model first (1 image)" />
          {recreate && (
            <textarea className="input" rows={2} value={changes} onChange={(e) => setChanges(e.target.value)} data-testid="photo-changes"
              placeholder="Changes, if any: “make it a pen sketch”, “at night in the rain”, “as a watercolour”. Leave empty for an identical copy." />
          )}
          <span className="field__label">Then</span>
          <Segmented label="What to make" value={then} onChange={setThen} options={[
            { value: 'picture', label: 'Just the picture', hint: 'Keep it in Scenes; place its lights later' },
            { value: 'place', label: 'Place the lights', hint: 'Click where the lights go' },
            { value: 'describe', label: 'Describe the lights', hint: 'Say what glows; the app finds it' },
          ]} />
        </div>
      )}

      {flow !== 'photo' && <div className="field">
        <label className="field__label" htmlFor="desc">The picture</label>
        <textarea id="desc" className="input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="create-prompt"
          placeholder="Anything, in any style: a pen sketch with ruled perspective lines, a photo, pixel art, an oil painting… Describe what is in it." />
        <div className="ideas">
          {IDEAS.map((idea) => (
            <button key={idea.title} className="chip" onClick={() => { setPrompt(idea.prompt); setLighting(idea.lighting); setElement(idea.element ?? ''); if (idea.element) setFlow('one'); tickSound(); }}>{idea.title}</button>
          ))}
        </div>
      </div>}

      {(flow !== 'photo' || then === 'describe') && <div className="field">
        <label className="field__label" htmlFor="lighting">The lights {flow === 'photo' ? '' : <em>optional</em>}</label>
        <textarea id="lighting" className="input" rows={2} value={lighting} onChange={(e) => setLighting(e.target.value)} data-testid="create-lighting"
          placeholder={flow === 'two' ? 'The overall feel of the light, e.g. “warm and soft” or “cold neon”. You place the lights next.' : 'What glows, and how: “the shop sign in pink neon, upstairs windows warm amber, a street lamp”'} />
      </div>}

      {(flow === 'two' || (flow === 'photo' && then !== 'picture')) && (
        <div className="field">
          <span className="field__label">{flow === 'photo' ? 'Your picture is' : 'The first picture is'}</span>
          <div className={`choices${flow === 'photo' && then === 'describe' ? ' choices--3' : ''}`}>
            {flow === 'photo' && then === 'describe' && (
              <button className={`choice${kindNow === 'lit' ? ' is-on' : ''}`} onClick={() => setBaseKind('lit')} aria-pressed={kindNow === 'lit'}>
                <strong>Its lights are on</strong>
                <span>A night photo, a painting with glowing windows or stars. The version with them off is made (1 image).</span>
              </button>
            )}
            <button className={`choice${kindNow === 'dark' ? ' is-on' : ''}`} onClick={() => setBaseKind('dark')} aria-pressed={kindNow === 'dark'}>
              <strong>{flow === 'photo' ? 'Its lights are off' : 'The lights-off version'}</strong>
              <span>{flow === 'photo' ? 'Your lights will shine in this very picture (1 image). Also right for drawings, where light can glow on the paper.' : 'Your lights will shine in this very picture. 2 images. Best for night scenes, and for drawings where light can glow on the paper.'}</span>
            </button>
            <button className={`choice${kindNow === 'ambient' ? ' is-on' : ''}`} onClick={() => setBaseKind('ambient')} aria-pressed={kindNow === 'ambient'}>
              <strong>An everyday picture</strong>
              <span>A darker version is made first, so the lights stand out; the original becomes a Daylight slider. {flow === 'photo' ? '2 images' : '3 images'}.</span>
            </button>
          </div>
        </div>
      )}

      {!(flow === 'photo' && then === 'picture') && (
        <Toggle on={also3d} onChange={(v) => set({ also3d: v })} label="Also make it 3D: Gaussian splats you can look around (free, in your browser)" />
      )}
      <button className="linkbtn" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Fewer options' : 'More options'}</button>
      {more && (
        <div className="moreopts">
          {flow === 'one' && (
            <div className="field">
              <label className="field__label" htmlFor="elem">Something that moves <em>optional</em></label>
              <input id="elem" className="input" value={element} onChange={(e) => setElement(e.target.value)} placeholder="e.g. the train" />
              <span className="field__hint">One thing that travels across the picture, seen from the side, looping forever as its own layer. 2 more images.</span>
            </div>
          )}
          <div className="field field--row">
            {flow !== 'photo' && (
              <div>
                <span className="field__label">Shape</span>
                <Segmented label="Shape" value={aspect} onChange={(v) => setSettings({ aspect: v })} options={ASPECTS} />
              </div>
            )}
            <div>
              <span className="field__label">Detail</span>
              <Segmented label="Detail" value={res} onChange={(v) => setSettings({ resolution: v })} options={m.resolutions.slice(0, 3).map((r) => ({ value: r, label: r === '768' ? 'Draft' : r === '1K' ? 'Normal' : 'Fine', hint: `${money(m.price[r])} per image` }))} />
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="title">Title <em>optional</em></label>
            <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Made from the description if left empty" />
          </div>
          {flow !== 'one' && (
            <p className="field__hint">{luminalKey && relayUrl(relay) ? 'The director’s model will read the picture to work out exactly what each light you place is.' : 'With a Luminal key, the app also reads the picture to work out exactly what each light you place is. Without it, your notes go to the image model as written.'}</p>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- settings

function useCheck() {
  return useState<{ state: 'idle' | 'busy' | 'ok' | 'bad'; text?: string }>({ state: 'idle' });
}

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const key = useStore((s) => s.key);
  const model = useStore((s) => s.model);
  const sound = useStore((s) => s.sound);
  const theme = useStore((s) => s.theme);
  const spend = useStore((s) => s.spend);
  const luminalKey = useStore((s) => s.luminalKey);
  const relay = useStore((s) => s.relay);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState(key);
  const [lum, setLum] = useState(luminalKey);
  const [rel, setRel] = useState(relay);
  const [show, setShow] = useState(false);
  const [check, setCheck] = useCheck();
  const [lcheck, setLcheck] = useCheck();
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
  const verifyLum = async () => {
    const k = lum.trim();
    setSettings({ luminalKey: k, relay: rel.trim() });
    if (!k) return;
    if (!relayUrl(rel)) { setLcheck({ state: 'bad', text: 'Saved. Add a relay URL so the published site can reach Luminal (see below).' }); return; }
    setLcheck({ state: 'busy' });
    try {
      const usd = await checkLuminal(k, rel);
      setLcheck({ state: 'ok', text: `Luminal works. ${money(usd)} in the wallet.` });
    } catch (err) {
      setLcheck({ state: 'bad', text: (err as Error).message });
    }
  };
  return (
    <Sheet title="Settings" onClose={onClose}>
      <section className="settings-group">
        <h3>Images <span>OpenRouter</span></h3>
        <div className="field">
          <label className="field__label" htmlFor="orkey">OpenRouter key</label>
          <div className="keyfield">
            <input id="orkey" className="input" type={show ? 'text' : 'password'} value={draft} autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" onChange={(e) => { setDraft(e.target.value); setCheck({ state: 'idle' }); }} onKeyDown={(e) => e.key === 'Enter' && verify()} data-testid="or-key" />
            <button className="textbtn" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
          </div>
          <div className="keyrow">
            <button className="btn btn--small" onClick={verify} disabled={!draft.trim() || check.state === 'busy'} data-testid="or-save">{check.state === 'busy' ? 'Checking…' : 'Save and check'}</button>
            {key && <button className="textbtn" onClick={() => { setSettings({ key: '' }); setDraft(''); setCheck({ state: 'idle' }); }}>Forget</button>}
          </div>
          {check.text && <p className={`notice notice--${check.state}`} role="status">{check.text}</p>}
          <span className="field__hint">Kept only in this browser. Images are requested straight from OpenRouter.</span>
        </div>
        <div className="field">
          <span className="field__label">Image model</span>
          <div className="models" role="radiogroup" aria-label="Image model">
            {MODELS.map((mm) => (
              <button key={mm.id} role="radio" aria-checked={model === mm.id} className={`model${model === mm.id ? ' is-on' : ''}`} onClick={() => setSettings({ model: mm.id })}>
                <span className="model__name">{mm.name}</span>
                <span className="model__price">{money(mm.price[mm.resolutions.includes('1K') ? '1K' : mm.resolutions[0]])} per image</span>
                <span className="model__note">{mm.note}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h3>Director and picture reading <span>Luminal</span></h3>
        <div className="field">
          <label className="field__label" htmlFor="lumkey">Luminal key</label>
          <input id="lumkey" className="input" type={show ? 'text' : 'password'} value={lum} autoComplete="off" spellCheck={false} placeholder="lum_live_…" onChange={(e) => { setLum(e.target.value); setLcheck({ state: 'idle' }); }} data-testid="lum-key" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="relay">Relay URL {import.meta.env.DEV && <em>built in while developing</em>}</label>
          <input id="relay" className="input" value={rel} spellCheck={false} placeholder={import.meta.env.DEV ? 'Not needed here (the dev server relays)' : 'https://your-relay.workers.dev'} onChange={(e) => { setRel(e.target.value); setLcheck({ state: 'idle' }); }} data-testid="lum-relay" />
          <span className="field__hint">Luminal doesn’t take calls straight from a web page, so they pass through a tiny relay that adds the missing permission. Running the app yourself (<code>npm run dev</code> or <code>npm run serve</code>) needs nothing. For this published site, <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/cybercryptixcoder/living-stills/tree/main/relay" target="_blank" rel="noreferrer">deploy the relay to a free Cloudflare account</a> (one click, or paste <a href="https://github.com/cybercryptixcoder/living-stills/blob/main/relay/worker.js" target="_blank" rel="noreferrer">relay/worker.js</a> into a new Worker) and put its address here. Your key passes through it and is not stored.</span>
        </div>
        <div className="keyrow">
          <button className="btn btn--small" onClick={verifyLum} disabled={lcheck.state === 'busy'} data-testid="lum-save">{lcheck.state === 'busy' ? 'Checking…' : 'Save and check'}</button>
        </div>
        {lcheck.text && <p className={`notice notice--${lcheck.state}`} role="status">{lcheck.text}</p>}
      </section>

      <section className="settings-group">
        <h3>This app</h3>
        <div className="field field--row">
          <Toggle on={sound} onChange={(v) => setSettings({ sound: v })} label="Switch sounds" />
          <Segmented label="Theme" value={theme} onChange={(v) => setSettings({ theme: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Paper' }, { value: 'dark', label: 'Ink' }]} />
        </div>
        <p className="muted">Spent on images in this visit: {money(spend)}.</p>
      </section>
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
    set({ picking: true });
    return () => set({ picking: false });
  }, [set]);
  if (!analysis) return null;
  const brightest = (n: number) => bestForEdits(analysis.lights, analysis.width, analysis.height, analysis.waterline, n);
  const cost = picked.length * priceOf(model, '768');
  return (
    <Sheet title="Repaint chosen lights" onClose={() => { set({ picked: [] }); onClose(); }}
      footer={
        <div className="estimate">
          <p><strong>{picked.length} edit{picked.length === 1 ? '' : 's'}</strong>, about {money(cost)}.</p>
          <button className="btn btn--primary btn--big" disabled={!picked.length || !key} onClick={() => { const ids = picked; set({ picked: [] }); void runRefine(ids); }}>
            <Icon name="spark" /><span>{key ? `Repaint ${picked.length || ''} light${picked.length === 1 ? '' : 's'}` : 'Add your key in Settings'}</span>
          </button>
        </div>
      }>
      <p className="lede">From two images, the app estimates how far each light reaches. Where lights overlap that estimate can be off. Repainting crops the picture around one light, asks the model to switch on just that light, and pastes the result back with soft edges: exact, at one image per light.</p>
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
      <p className="lede">Light adds up. With the same picture once with its lights on and once with them off, the difference is the light itself. Any mix of lights is the dark picture plus a share of that difference, worked out per light, every frame, on your graphics card.</p>
      <h3 className="subhead">Using it</h3>
      <dl className="methods">
        <dt>Click a light</dt>
        <dd>Its panel opens: switch it, dim it, recolour it, give it a behaviour. Choose “Its group” to control every light around it at once. Shift-click or Shift-drag to pick several.</dd>
        <dt>Effects</dt>
        <dd>How the lights respond to you: a torch that follows the cursor, a brush, a path a light travels along, waves, music.</dd>
        <dt>Presets</dt>
        <dd>Ready-made light shows: dusk, dawn, a power cut, twinkling.</dd>
        <dt>Director</dt>
        <dd>Describe a sequence in words (“the windows flicker four times, then the sign sparks on”). An agent writes it as a show and plays it. Save the ones you like as presets.</dd>
      </dl>
      <h3 className="subhead">How many images a scene needs</h3>
      <dl className="methods">
        <dt>2 images</dt>
        <dd>The usual case: lights on, lights off. Every light found in the difference is controllable; where two lights wash the same wall, their shares are estimated.</dd>
        <dt>+1 per repainted light</dt>
        <dd>Optional. The model repaints one light at a time so overlapping glows are exact.</dd>
        <dt>+1 for an everyday picture</dt>
        <dd>When you start from a daylight picture, a dark version is made so the lights stand out.</dd>
        <dt>+2 for something moving</dt>
        <dd>The scene without it, lit and unlit, so it can be cut out and loop.</dd>
      </dl>
      <h3 className="subhead">3D</h3>
      <dl className="methods">
        <dt>Make it 3D</dt>
        <dd>Depth is measured in your browser (free): a quick look in seconds, then full detail a minute or two later. Every pixel becomes a Gaussian splat at its depth, so the picture becomes a small space you can look around.</dd>
        <dt>Looking around</dt>
        <dd>Move the cursor over the picture (or tilt your phone), drag, or let it sway. Depth and Movement in the 3D menu set how deep the space is and how far you can move.</dd>
        <dt>Light in 3D</dt>
        <dd>Every light change shows in 3D at once. The brightest lights also glow at their place in space, hidden by whatever is in front of them, and catch on surfaces as you move.</dd>
      </dl>
      <h3 className="subhead">Keys</h3>
      <ul className="keys">
        {EFFECTS.map((m) => <li key={m.id}><kbd>{m.key}</kbd><span>{m.name}</span></li>)}
        <li><kbd>P</kbd><span>Presets</span></li>
        <li><kbd>D</kbd><span>Director</span></li>
        <li><kbd>A</kbd><span>All lights on</span></li>
        <li><kbd>O</kbd><span>All lights off</span></li>
        <li><kbd>Space</kbd><span>Play or pause motion</span></li>
        <li><kbd>[</kbd><kbd>]</kbd><span>Smaller or larger torch</span></li>
        <li><kbd>H</kbd><span>Hide everything but the picture</span></li>
        <li><kbd>N</kbd><span>New scene</span></li>
        <li><kbd>S</kbd><span>Scenes</span></li>
        <li><kbd>Esc</kbd><span>Close a panel</span></li>
      </ul>
    </Sheet>
  );
}

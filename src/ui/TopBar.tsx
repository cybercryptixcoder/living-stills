import { downloadScene, runRepaintOff } from '../live';
import { useStore } from '../state';
import { Icon } from './icons';
import { tickSound } from './sound';

export function money(usd: number) {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const c = usd * 100;
  return `${c < 10 ? c.toFixed(1) : Math.round(c)}¢`;
}

export function methodLine(doc: { method: string; cost: number; steps: { image?: string }[]; refinements?: unknown[]; grid?: { frames: number }; motion?: { element: string } }, lights?: number) {
  const n = doc.steps.filter((s) => s.image).length;
  const made = `Made from ${n} image${n === 1 ? '' : 's'} for ${money(doc.cost)}.`;
  switch (doc.method) {
    case 'split':
      return `${made} ${lights ? `${lights} lights found` : 'Lights found'} by comparing a lit and an unlit version.`;
    case 'perLight':
      return `${made} ${doc.refinements?.length ?? 0} lights have their own generated edit; the rest are split from the pair.`;
    case 'layered':
      return `${made} ${capital(doc.motion?.element ?? 'The element')} is cut out once and travels as its own layer.`;
    case 'grid':
      return `${made} Each light was painted again at ${doc.grid?.frames === 2 ? 'both' : `all ${doc.grid?.frames ?? 0}`} positions of the ${(doc.motion?.element ?? 'element').replace(/^the /, '')}.`;
    default:
      return made;
  }
}

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function TopBar() {
  const scene = useStore((s) => s.scene);
  const key = useStore((s) => s.key);
  const cinema = useStore((s) => s.cinema);
  const spend = useStore((s) => s.spend);
  const set = useStore((s) => s.set);
  const open = (sheet: 'scenes' | 'create' | 'settings' | 'refine' | 'grid' | 'help' | 'reflections') => { set({ sheet }); tickSound(); };
  return (
    <header className={`topbar${cinema ? ' is-hidden' : ''}`}>
      <div className="titlecard">
        {scene ? (
          <>
            <h1 className="titlecard__title">{scene.doc.title}</h1>
            <p className="titlecard__line">{methodLine(scene.doc, scene.lights)}</p>
            <nav className="titlecard__actions" aria-label="This scene">
              {(scene.doc.method === 'split' || scene.doc.method === 'perLight') && (
                <button onClick={() => open('refine')}>Real edits for chosen lights</button>
              )}
              {(scene.doc.method === 'layered' || scene.doc.method === 'grid') && (
                <button onClick={() => open('grid')}>Paint every frame</button>
              )}
              {scene.doc.method !== 'grid' && <button onClick={() => open('reflections')}>Lights and reflections</button>}
              {(scene.doc.method === 'split' || scene.doc.method === 'perLight') && (
                <button
                  onClick={() => {
                    const n = scene.doc.refinements?.length ?? 0;
                    const msg = `Ask the model for a new lights-off version (one image, about 1¢). Use this if lamps vanished instead of going dark.${n ? ` The ${n} per-light edits were made against the old one and will be dropped.` : ''}`;
                    if (useStore.getState().key && confirm(msg)) void runRepaintOff();
                    else if (!useStore.getState().key) set({ sheet: 'settings' });
                  }}
                >Repaint the dark version</button>
              )}
              <button onClick={() => void downloadScene()}>Download scene</button>
            </nav>
          </>
        ) : (
          <h1 className="titlecard__title">Living Stills</h1>
        )}
      </div>
      <div className="topbar__right">
        {spend > 0 && <span className="spend" title="Spent on image generation in this session">{money(spend)} spent</span>}
        <button className="btn btn--quiet" onClick={() => open('help')} aria-label="Help and shortcuts" title="Help and shortcuts (?)"><Icon name="help" /></button>
        <button className="btn btn--quiet" onClick={() => open('scenes')} title="Scenes (S)"><Icon name="scenes" /><span>Scenes</span></button>
        <button className="btn btn--primary" onClick={() => open('create')} title="Paint a new scene (N)"><Icon name="plus" /><span>New scene</span></button>
        <button className={`btn btn--key${key ? ' has-key' : ''}`} onClick={() => open('settings')} title={key ? 'Settings. Your OpenRouter key is set.' : 'Settings. Add your OpenRouter key to paint new scenes.'} aria-label="Settings">
          <Icon name="key" /><span className="keydot" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

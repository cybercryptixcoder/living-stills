import type { SceneDoc } from '../core/types';
import { useStore } from '../state';
import { Icon } from './icons';
import { tickSound } from './sound';

export function money(usd: number) {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const c = usd * 100;
  return `${c < 10 ? c.toFixed(1) : Math.round(c)}¢`;
}

export function methodLine(doc: SceneDoc, lights: number): string {
  const images = doc.steps.filter((s) => s.image).length || Object.keys(doc.images).length;
  const made = `${images} image${images === 1 ? '' : 's'}, ${money(doc.cost)}.`;
  const found = lights ? `${lights} light${lights === 1 ? '' : 's'}` : 'Lights';
  switch (doc.method) {
    case 'split':
      return doc.markers?.length
        ? `${made} ${doc.markers.length} light${doc.markers.length === 1 ? '' : 's'} placed by hand, ${found.toLowerCase()} found in them.`
        : `${made} ${found} found by comparing a lit and an unlit version.`;
    case 'perLight':
      return `${made} ${doc.refinements?.length ?? 0} lights repainted one by one; the rest split from the pair.`;
    case 'layered':
      return `${made} ${capital(doc.motion?.element ?? 'The moving element')} is cut out once and loops as its own layer.`;
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
  const luminalKey = useStore((s) => s.luminalKey);
  const cinema = useStore((s) => s.cinema);
  const spend = useStore((s) => s.spend);
  const set = useStore((s) => s.set);
  const open = (sheet: 'scenes' | 'create' | 'settings' | 'help') => { set({ sheet, menu: null }); tickSound(); };
  return (
    <header className={`topbar${cinema ? ' is-hidden' : ''}`}>
      <div className="topbar__brand">
        <h1 className="wordmark">Living Stills<span className="wordmark__dot">.</span></h1>
        <div className="topbar__scene">
          <h2 className="scene-title">{scene ? scene.doc.title : 'Choose a scene'}</h2>
          <p className="scene-line">{scene ? methodLine(scene.doc, scene.lights) : 'Or make a new one from a description.'}</p>
        </div>
      </div>
      <nav className="topbar__actions" aria-label="App">
        {spend > 0 && <span className="spendtag" title="Spent on images in this visit">{money(spend)}</span>}
        <button className="pill pill--ghost" onClick={() => open('help')} aria-label="How it works"><Icon name="help" /><span className="pill__label">Help</span></button>
        <button className="pill pill--ghost" onClick={() => open('scenes')} data-testid="open-scenes"><Icon name="scenes" /><span className="pill__label">Scenes</span></button>
        <button className="pill pill--ink" onClick={() => open('create')} data-testid="open-create"><Icon name="plus" /><span className="pill__label">New scene</span></button>
        <button
          className={`keybtn${key ? ' is-set' : ''}${key && luminalKey ? ' is-full' : ''}`}
          onClick={() => open('settings')}
          title={key ? 'Settings and keys' : 'Settings: add your OpenRouter key to make new scenes'}
          aria-label="Settings and keys"
          data-testid="open-settings"
        >
          <Icon name="key" />
        </button>
      </nav>
    </header>
  );
}

import { useEffect } from 'react';
import { detectRelay } from '../core/luminal';
import { ensureLabels, live, openEntry, playPreset, refreshLibrary } from '../live';
import { BUILT_IN } from '../play/presets';
import { useStore } from '../state';
import { Director } from './Director';
import { Dock, EFFECTS } from './Dock';
import { Inspector } from './Inspector';
import { JobOverlay } from './JobOverlay';
import { CreateSheet, HelpSheet, ReflectionsSheet, RefineSheet, ScenesSheet, SettingsSheet } from './Sheets';
import { switchSound, tickSound } from './sound';
import { Stage } from './Stage';
import { Studio } from './Studio';
import { TopBar } from './TopBar';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <p key={t.id} className={`toast toast--${t.kind ?? 'info'}`}>{t.text}</p>)}
    </div>
  );
}

function StatusLine() {
  const scene = useStore((s) => s.scene);
  const zones = useStore((s) => s.zones);
  if (!scene) return null;
  return (
    <p className="statusline" aria-live="off">
      <span className="statusline__lamp" aria-hidden="true" />
      <span data-lit-text>0%</span> lit · {scene.lights} light{scene.lights === 1 ? '' : 's'} in {zones.length} group{zones.length === 1 ? '' : 's'}
    </p>
  );
}

export function App() {
  const sheet = useStore((s) => s.sheet);
  const cinema = useStore((s) => s.cinema);
  const theme = useStore((s) => s.theme);
  const set = useStore((s) => s.set);
  const close = () => set({ sheet: null });

  // paper by day, ink by night
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = theme === 'auto' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = t;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#141210' : '#EEDCC2');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // first load: the last scene you had open, or the first example
  useEffect(() => {
    void (async () => {
      void detectRelay().then((r) => { if (r) void ensureLabels(); });
      const { examples, locals } = await refreshLibrary();
      let last: string | null = null;
      try { last = localStorage.getItem('living-stills:last'); } catch { /* ignore */ }
      const pick = [...locals, ...examples].find((e) => e.id === last && !e.doc.draft) ?? examples[0] ?? locals.find((e) => !e.doc.draft);
      if (pick) await openEntry(pick);
    })();
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      const st = useStore.getState();
      if (st.sheet && e.key !== 'Escape') return;
      const m = EFFECTS.find((x) => x.key === e.key);
      if (m) {
        if (live.engine.mode === 'show') live.engine.stopShow();
        st.set({ mode: m.id, playing: null, selection: m.id === 'hand' ? st.selection : null, menu: null });
        tickSound();
        return;
      }
      switch (e.key) {
        case ' ':
          e.preventDefault();
          st.set({ motion: { ...st.motion, playing: !st.motion.playing } });
          break;
        case 'a': case 'A': live.engine.setAll(1); switchSound(true); st.set({ rev: st.rev + 1 }); break;
        case 'o': case 'O': live.engine.setAll(0); switchSound(false); st.set({ rev: st.rev + 1 }); break;
        case 'p': case 'P': st.set({ menu: st.menu === 'presets' ? null : 'presets' }); break;
        case 'd': case 'D': st.set({ director: { ...st.director, open: !st.director.open } }); break;
        case 'u': case 'U': playPreset(BUILT_IN.find((p) => p.id === 'dusk')!); break;
        case 'h': case 'H': st.set({ cinema: !st.cinema }); break;
        case '[': st.set({ params: { ...st.params, radius: Math.max(0.03, st.params.radius / 1.15) } }); break;
        case ']': st.set({ params: { ...st.params, radius: Math.min(0.45, st.params.radius * 1.15) } }); break;
        case 'n': case 'N': st.set({ sheet: 'create' }); break;
        case 's': case 'S': st.set({ sheet: 'scenes' }); break;
        case '?': st.set({ sheet: 'help' }); break;
        case 'Escape':
          if (st.menu) st.set({ menu: null });
          else if (st.selection) st.set({ selection: null });
          else if (st.director.open) st.set({ director: { ...st.director, open: false } });
          else if (st.cinema) st.set({ cinema: false });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app${cinema ? ' is-cinema' : ''}`}>
      <div className="shell">
        <TopBar />
        <main className="board">
          <section className="panel panel--stage" aria-label="The picture">
            <div className="stage-wrap">
              <Stage />
              <Inspector />
              <Director />
            </div>
            <StatusLine />
          </section>
        </main>
        <Dock />
      </div>
      <Toasts />
      <JobOverlay />
      {sheet === 'scenes' && <ScenesSheet onClose={close} />}
      {sheet === 'create' && <CreateSheet onClose={close} />}
      {sheet === 'settings' && <SettingsSheet onClose={close} />}
      {sheet === 'refine' && <RefineSheet onClose={close} />}
      {sheet === 'help' && <HelpSheet onClose={close} />}
      {sheet === 'reflections' && <ReflectionsSheet onClose={close} />}
      {sheet === 'studio' && <Studio onClose={close} />}
      {cinema && <button className="cinema-exit" onClick={() => set({ cinema: false })}>Show controls</button>}
    </div>
  );
}

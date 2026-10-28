import { useEffect } from 'react';
import { live, openEntry, refreshLibrary } from '../live';
import { useStore } from '../state';
import { Console, MODES } from './Console';
import { JobOverlay } from './JobOverlay';
import { LightCard } from './LightCard';
import { CreateSheet, GridSheet, HelpSheet, ReflectionsSheet, RefineSheet, ScenesSheet, SettingsSheet } from './Sheets';
import { switchSound, tickSound } from './sound';
import { Stage } from './Stage';
import { TopBar } from './TopBar';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <p key={t.id} className={`toast toast--${t.kind ?? 'info'}`}>{t.text}</p>)}
    </div>
  );
}

export function App() {
  const sheet = useStore((s) => s.sheet);
  const cinema = useStore((s) => s.cinema);
  const set = useStore((s) => s.set);
  const close = () => set({ sheet: null });

  // first load: the last scene you had open, or the first example
  useEffect(() => {
    void (async () => {
      const { examples, locals } = await refreshLibrary();
      let last: string | null = null;
      try { last = localStorage.getItem('living-stills:last'); } catch { /* ignore */ }
      const pick = [...locals, ...examples].find((e) => e.id === last) ?? examples[0] ?? locals[0];
      if (pick) await openEntry(pick);
    })();
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      const st = useStore.getState();
      const m = MODES.find((x) => x.key === e.key);
      if (m && !st.sheet) { st.set({ mode: m.id, selected: null }); tickSound(); return; }
      switch (e.key) {
        case ' ':
          if (st.sheet) return;
          e.preventDefault();
          st.set({ motion: { ...st.motion, playing: !st.motion.playing } });
          break;
        case 'a': case 'A': live.engine.setAll(1); switchSound(true); break;
        case 'o': case 'O': live.engine.setAll(0); switchSound(false); break;
        case 'l': case 'L': st.set({ showLights: !st.showLights }); break;
        case 'h': case 'H': st.set({ cinema: !st.cinema }); break;
        case '[': st.set({ params: { ...st.params, radius: Math.max(0.03, st.params.radius / 1.15) } }); break;
        case ']': st.set({ params: { ...st.params, radius: Math.min(0.45, st.params.radius * 1.15) } }); break;
        case 'n': case 'N': st.set({ sheet: 'create' }); break;
        case 's': case 'S': st.set({ sheet: 'scenes' }); break;
        case '?': st.set({ sheet: 'help' }); break;
        case 'Escape':
          if (st.selected != null) st.set({ selected: null });
          else if (st.cinema) st.set({ cinema: false });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app${cinema ? ' is-cinema' : ''}`}>
      <Stage />
      <TopBar />
      <Console />
      <LightCard />
      <Toasts />
      <JobOverlay />
      {sheet === 'scenes' && <ScenesSheet onClose={close} />}
      {sheet === 'create' && <CreateSheet onClose={close} />}
      {sheet === 'settings' && <SettingsSheet onClose={close} />}
      {sheet === 'refine' && <RefineSheet onClose={close} />}
      {sheet === 'grid' && <GridSheet onClose={close} />}
      {sheet === 'help' && <HelpSheet onClose={close} />}
      {sheet === 'reflections' && <ReflectionsSheet onClose={close} />}
      {cinema && <button className="cinema-exit" onClick={() => set({ cinema: false })}>Show controls</button>}
    </div>
  );
}

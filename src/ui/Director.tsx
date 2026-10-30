// The director: describe a light sequence in words, an agent turns it into a show and plays it.
// Shows can be refined in follow-ups ("slower", "now in blue") and saved as presets.

import { useEffect, useRef } from 'react';
import { relayUrl } from '../core/luminal';
import { playShow, runDirector, stopShow } from '../live';
import { savePreset } from '../play/presets';
import { describeStep } from '../play/show';
import { useStore } from '../state';
import { Icon } from './icons';
import { tickSound } from './sound';

const EXAMPLES = [
  'Lights come on slowly from left to right, then everything breathes',
  'The top lights flicker four times together, then the biggest light sparks on',
  'A slow blue wave, then back to warm',
  'Bass on the bottom row, treble on the top, like a music visualiser',
];

export function Director() {
  const d = useStore((s) => s.director);
  const zones = useStore((s) => s.zones);
  const luminalKey = useStore((s) => s.luminalKey);
  const relay = useStore((s) => s.relay);
  const playing = useStore((s) => s.playing);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { if (d.open) input.current?.focus({ preventScroll: true }); }, [d.open]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [d.turns.length, d.busy]);
  if (!d.open) return null;
  const ready = !!luminalKey && !!relayUrl(relay);
  const upd = (patch: Partial<typeof d>) => set({ director: { ...useStore.getState().director, ...patch } });
  const send = () => {
    const text = (input.current?.value ?? d.draft).trim();
    if (!text || d.busy) return;
    void runDirector(text);
    tickSound();
  };
  const zoneName = (n: number) => zones[n - 1]?.name.toLowerCase() ?? `group ${n}`;

  return (
    <aside className="director" aria-label="Director" data-testid="director">
      <header className="director__head">
        <span className="director__mark"><Icon name="wand" /></span>
        <div>
          <h2>Director</h2>
          <p>Describe what the lights should do. It writes a show and plays it.</p>
        </div>
        <button className="iconbtn" onClick={() => upd({ open: false })} aria-label="Close the director"><Icon name="close" /></button>
      </header>

      {!ready && (
        <div className="director__setup">
          <p>{luminalKey ? 'The published site reaches the director through a small relay, because Luminal does not take calls from web pages.' : 'The director runs on Luminal (DeepSeek). Add your Luminal key in Settings.'}</p>
          <button className="btn btn--small" onClick={() => set({ sheet: 'settings' })}><Icon name="key" /> Open Settings</button>
        </div>
      )}

      <div className="director__log" ref={log}>
        {d.turns.length === 0 && ready && (
          <div className="director__examples">
            {EXAMPLES.map((x) => <button key={x} className="chip chip--wrap" onClick={() => { if (input.current) input.current.value = x; upd({ draft: x }); }}>{x}</button>)}
          </div>
        )}
        {d.turns.map((t, k) => (
          <div key={k} className={`turn turn--${t.role}`}>
            {t.role === 'you' ? <p>{t.text}</p> : (
              <>
                <p className="turn__name">{t.show?.name}</p>
                {t.show?.summary && <p className="turn__summary">{t.show.summary}</p>}
                {t.show && (
                  <ol className="turn__steps">
                    {t.show.steps.slice(0, 8).map((s, i) => <li key={i}><span>{s.at.toFixed(1)}s</span> {describeStep(s, zoneName)}</li>)}
                    {t.show.steps.length > 8 && <li className="more">and {t.show.steps.length - 8} more steps{t.show.loop ? ', then it repeats' : ''}</li>}
                  </ol>
                )}
                {t.show && (
                  <div className="turn__actions">
                    <button className="chip" onClick={() => { playShow(t.show!); tickSound(); }}><Icon name="play" /><span>{playing?.name === t.show.name ? 'Replay' : 'Play'}</span></button>
                    <button className="chip" onClick={() => { savePreset(t.show!, t.show!.summary ?? 'Made with the director'); toast(`Saved “${t.show!.name}” to Presets.`); tickSound(); }}><Icon name="presets" /><span>Save as preset</span></button>
                    {playing?.name === t.show.name && <button className="chip" onClick={() => stopShow()}><Icon name="stop" /><span>Stop</span></button>}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {d.busy && (
          <div className="turn turn--director turn--busy">
            <span className="filament-loader" aria-hidden="true" />
            <p>{d.thinking ? `Thinking… ${d.thinking.split(/\s+/).slice(-14).join(' ')}` : 'Reading the scene…'}</p>
          </div>
        )}
        {d.error && <p className="director__error" role="alert">{d.error}</p>}
      </div>

      <div className="director__compose">
        <textarea
          ref={input}
          rows={2}
          placeholder={d.turns.length ? 'Change it: “slower”, “now in blue”, “only the left side”…' : 'e.g. the windows on the left flicker 4 times, then the sign sparks on'}
          defaultValue={d.draft}
          disabled={!ready}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); if (input.current) input.current.value = ''; } }}
          aria-label="Describe the light sequence"
          data-testid="director-input"
        />
        <button className="btn" onClick={() => { send(); if (input.current) input.current.value = ''; }} disabled={!ready || d.busy} data-testid="director-send">
          {d.busy ? 'Working' : 'Play it'}
        </button>
      </div>
    </aside>
  );
}

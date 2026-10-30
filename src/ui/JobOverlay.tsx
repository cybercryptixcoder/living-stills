import { useEffect, useMemo, useState } from "react";
import { cancelJob } from '../live';
import type { JobStep } from '../core/pipeline';
import { useStore } from '../state';
import { Icon } from './icons';
import { money } from './TopBar';

function usePreviews(steps: JobStep[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    setUrls((prev) => {
      let next: Record<string, string> | null = null;
      for (const s of steps) if (s.preview && !prev[s.id]) (next ??= { ...prev })[s.id] = URL.createObjectURL(s.preview);
      return next ?? prev;
    });
  }, [steps]);
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return urls;
}

const NO_STEPS: JobStep[] = [];

function StepIcon({ s }: { s: JobStep }) {
  if (s.status === 'done') return <span className="stepicon is-done"><Icon name="check" /></span>;
  if (s.status === 'failed') return <span className="stepicon is-failed"><Icon name="close" /></span>;
  if (s.status === 'running') return <span className="stepicon is-running" aria-label="Working" />;
  return <span className="stepicon" />;
}

export function JobOverlay() {
  const job = useStore((s) => s.job);
  const steps = job?.steps ?? NO_STEPS;
  const urls = usePreviews(steps);
  const latest = useMemo(() => [...steps].reverse().find((s) => s.status === 'done' && urls[s.id]), [steps, urls]);
  if (!job) return null;
  const spent = steps.reduce((a, s) => a + (s.cost ?? 0), 0);
  const done = steps.filter((s) => s.status === 'done').length;

  return (
    <div className="job" role="dialog" aria-label={job.title} aria-live="polite">
      <div className="job__panel">
        <header className="job__head">
          <h2>{job.title}</h2>
          <p>{job.finding ? 'Finding the lights in the new images.' : `${done} of ${steps.length} steps, ${money(spent)} so far.`}</p>
        </header>
        {(
          <div className="job__body">
            <ol className="steps">
              {steps.map((s) => (
                <li key={s.id} className={`step is-${s.status}`}>
                  <StepIcon s={s} />
                  <span className="step__label">{s.label}</span>
                  <span className="step__meta">{s.status === 'done' ? `${s.cost ? money(s.cost) : 'free'}, ${((s.ms ?? 0) / 1000).toFixed(1)} s${s.error ? ` · ${s.error}` : ''}` : s.status === 'running' ? 'working' : ''}</span>
                </li>
              ))}
            </ol>
            <div className="job__preview">
              {latest ? <img key={latest.id} src={urls[latest.id]} alt={latest.label} /> : <span className="filament-loader filament-loader--big" aria-hidden="true" />}
            </div>
          </div>
        )}
        {job.error ? (
          <div className="job__error" role="alert">
            <p>{job.error}</p>
            <button className="btn" onClick={() => useStore.getState().set({ job: null })}>Close</button>
          </div>
        ) : (
          !job.finding && <button className="textbtn job__cancel" onClick={cancelJob}>Stop</button>
        )}
      </div>
    </div>
  );
}

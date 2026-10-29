// Tactile controls: sliders, channel levels, switches. All keyboard and pointer friendly.
import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function useDrag(onMove: (e: PointerEvent, el: HTMLElement) => void, onEnd?: () => void) {
  return useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    onMove(e.nativeEvent, el);
    const move = (ev: PointerEvent) => onMove(ev, el);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, [onMove, onEnd]);
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  def?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  title?: string;
}

/** A compact horizontal slider with its value in plain units. Double-click resets. */
export function Slider({ label, value, min, max, step = 0, def, format, onChange, title }: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const snap = (v: number) => (step ? Math.round(v / step) * step : v);
  const onDown = useDrag((e) => {
    const r = track.current!.getBoundingClientRect();
    onChange(snap(clamp(min + ((e.clientX - r.left) / r.width) * (max - min), min, max)));
  });
  const t = (value - min) / (max - min);
  const key = (e: KeyboardEvent) => {
    const s = step || (max - min) / 50;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { onChange(clamp(snap(value + s), min, max)); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { onChange(clamp(snap(value - s), min, max)); e.preventDefault(); }
  };
  return (
    <div className="slider" title={title}>
      <span className="slider__label">{label}</span>
      <div
        className="slider__track"
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : undefined}
        onPointerDown={onDown}
        onKeyDown={key}
        onDoubleClick={() => def != null && onChange(def)}
        style={{ ['--t' as string]: clamp(t, 0, 1) }}
      >
        <span className="slider__fill" />
        <span className="slider__knob" />
      </div>
      <span className="slider__value">{format ? format(value) : value.toFixed(2)}</span>
    </div>
  );
}

export interface LevelProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
  /** data-lamp lets the survey light this row's bulb at frame rate */
  lampId?: string;
  title?: string;
}

/** A horizontal channel level: drag anywhere on the bar, double-click to cut. */
export function Level({ value, onChange, label, lampId, title }: LevelProps) {
  const track = useRef<HTMLDivElement>(null);
  const onDown = useDrag((e) => {
    const r = track.current!.getBoundingClientRect();
    onChange(clamp((e.clientX - r.left) / r.width, 0, 1));
  });
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { onChange(clamp(value + step, 0, 1)); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { onChange(clamp(value - step, 0, 1)); e.preventDefault(); }
    if (e.key === 'Home') onChange(1);
    if (e.key === 'End') onChange(0);
  };
  return (
    <div
      className={`level${value < 0.02 ? ' is-down' : ''}`}
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      title={title ?? `${label} level`}
      onPointerDown={onDown}
      onKeyDown={key}
      onDoubleClick={() => onChange(value > 0.02 ? 0 : 1)}
      style={{ ['--v' as string]: clamp(value, 0, 1) }}
    >
      <span className="level__fill" />
      <span className="level__cap" />
      <span className="level__lamp" data-lamp={lampId} aria-hidden="true" />
    </div>
  );
}

export function Toggle({ on, onChange, label, title }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string }) {
  return (
    <button className={`toggle${on ? ' is-on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} title={title}>
      <span className="toggle__track"><span className="toggle__knob" /></span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; hint?: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)} title={o.hint}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

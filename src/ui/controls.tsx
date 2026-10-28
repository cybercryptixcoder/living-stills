// Tactile controls: faders, sliders, switches. All keyboard and pointer friendly.
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

export interface FaderProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
  sub?: string;
  title?: string;
  /** data-group lets the console light the little lamp at frame rate */
  lampId?: string;
  wide?: boolean;
  onHover?: (on: boolean) => void;
  onLabel?: () => void;
}

/** A vertical channel fader with a lamp that shows how lit its lights are right now. */
export function Fader({ value, onChange, label, sub, title, lampId, wide, onHover, onLabel }: FaderProps) {
  const track = useRef<HTMLDivElement>(null);
  const onDown = useDrag((e) => {
    const r = track.current!.getBoundingClientRect();
    onChange(clamp(1 - (e.clientY - r.top) / r.height, 0, 1));
  });
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.04;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { onChange(clamp(value + step, 0, 1)); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { onChange(clamp(value - step, 0, 1)); e.preventDefault(); }
    if (e.key === 'Home') onChange(1);
    if (e.key === 'End') onChange(0);
  };
  return (
    <div className={`fader${wide ? ' fader--wide' : ''}`} onPointerEnter={() => onHover?.(true)} onPointerLeave={() => onHover?.(false)}>
      <span className="fader__lamp" data-lamp={lampId} />
      <div
        className="fader__track"
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={title ?? label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        onPointerDown={onDown}
        onKeyDown={key}
        onDoubleClick={() => onChange(value > 0.02 ? 0 : 1)}
        onWheel={(e) => onChange(clamp(value - e.deltaY * 0.0015, 0, 1))}
        style={{ ['--v' as string]: value }}
        title={title}
      >
        <span className="fader__fill" />
        <span className="fader__cap" />
      </div>
      <button className="fader__label" onClick={onLabel} title={onLabel ? `Switch ${label} on or off` : undefined} tabIndex={onLabel ? 0 : -1}>
        {label}
      </button>
      {sub != null && <span className="fader__sub">{sub}</span>}
    </div>
  );
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

/** A compact horizontal slider with its value shown in plain units. Double-click resets. */
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

export function Toggle({ on, onChange, label, title }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string }) {
  return (
    <button className={`toggle${on ? ' is-on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} title={title}>
      <span className="toggle__track"><span className="toggle__knob" /></span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; hint?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)} title={o.hint}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

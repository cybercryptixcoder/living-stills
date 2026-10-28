// Small synthesised switch sounds. No audio files: a filtered noise burst plus a low thump.

import { useStore } from '../state';

let ctx: AudioContext | null = null;
let last = 0;

function audio(): AudioContext | null {
  if (!useStore.getState().sound) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function burst(c: AudioContext, t: number, freq: number, q: number, vol: number, len: number) {
  const n = Math.floor(c.sampleRate * len);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t);
}

function thump(c: AudioContext, t: number, f0: number, vol: number) {
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.06);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.1);
}

/** A light switch. */
export function switchSound(on: boolean) {
  const now = performance.now();
  if (now - last < 40) return;
  last = now;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.002;
  burst(c, t, on ? 2600 : 1900, 2.2, 0.32, 0.028);
  thump(c, t, on ? 170 : 130, 0.11);
}

/** A soft detent for keys and selections. */
export function tickSound() {
  const now = performance.now();
  if (now - last < 30) return;
  last = now;
  const c = audio();
  if (!c) return;
  burst(c, c.currentTime + 0.002, 3400, 4, 0.12, 0.012);
}

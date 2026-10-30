// Listens to music (microphone, or the sound of a browser tab / the screen) and turns it into a
// few smoothed numbers per frame that lights can follow.

export interface AudioFrame {
  level: number; // overall loudness 0..1 (adaptive)
  bass: number;
  mid: number;
  treble: number;
  beat: number; // 1 on a beat, decays to 0
  bands: Float32Array; // 12 log-spaced bands, 0..1, low to high
  beats: number; // beats counted since start
}

export type AudioSource = 'mic' | 'tab';

const BANDS = 12;

export class AudioReactor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private freq = new Uint8Array(0);
  private peak = new Float32Array(BANDS + 4).fill(0.2);
  private prevEnergy = 0;
  private avgFlux = 0;
  private lastBeat = 0;
  source: AudioSource | null = null;
  sensitivity = 1;
  frame: AudioFrame = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0, bands: new Float32Array(BANDS), beats: 0 };

  get active() {
    return !!this.analyser;
  }

  async start(source: AudioSource) {
    this.stop();
    let stream: MediaStream;
    if (source === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } else {
      // Chrome shares a tab's sound (tick "Share tab audio"); on Windows the whole system's.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true } as DisplayMediaStreamOptions);
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) throw new Error('No sound was shared. Pick a tab and tick "Share tab audio".');
    }
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    src.connect(an);
    this.ctx = ctx;
    this.analyser = an;
    this.stream = stream;
    this.freq = new Uint8Array(an.frequencyBinCount);
    this.source = source;
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => this.stop()));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.frame = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0, bands: new Float32Array(BANDS), beats: 0 };
  }

  /** Call once per frame. */
  update(dt: number): AudioFrame {
    const an = this.analyser, ctx = this.ctx;
    const f = this.frame;
    if (!an || !ctx) return f;
    an.getByteFrequencyData(this.freq);
    const nyq = ctx.sampleRate / 2, bins = this.freq.length;
    const bandOf = (lo: number, hi: number) => {
      const a = Math.max(1, Math.floor((lo / nyq) * bins)), b = Math.min(bins - 1, Math.ceil((hi / nyq) * bins));
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / Math.max(1, b - a + 1) / 255;
    };
    // adaptive gain: each band is measured against its own slowly falling peak
    const norm = (k: number, v: number) => {
      this.peak[k] = Math.max(v, this.peak[k] * Math.exp(-dt / 6), 0.04);
      return Math.min(1, Math.pow(v / this.peak[k], 1.6) * this.sensitivity);
    };
    const ease = (prev: number, v: number) => (v > prev ? prev + (v - prev) * 0.65 : prev + (v - prev) * Math.min(1, dt * 7));
    const raw = [bandOf(25, 160), bandOf(160, 2000), bandOf(2000, 11000)];
    f.bass = ease(f.bass, norm(0, raw[0]));
    f.mid = ease(f.mid, norm(1, raw[1]));
    f.treble = ease(f.treble, norm(2, raw[2]));
    const lvl = 0.5 * raw[0] + 0.35 * raw[1] + 0.15 * raw[2];
    f.level = ease(f.level, norm(3, lvl));
    for (let k = 0; k < BANDS; k++) {
      const lo = 30 * Math.pow(12000 / 30, k / BANDS), hi = 30 * Math.pow(12000 / 30, (k + 1) / BANDS);
      f.bands[k] = ease(f.bands[k], norm(4 + k, bandOf(lo, hi)));
    }
    // beats: a jump in low-end energy well above its recent average
    const e = raw[0] * 0.7 + raw[1] * 0.3;
    const flux = Math.max(0, e - this.prevEnergy);
    this.prevEnergy = e;
    this.avgFlux = this.avgFlux * 0.93 + flux * 0.07;
    const now = ctx.currentTime;
    if (flux > Math.max(0.012, this.avgFlux * 2.4) && now - this.lastBeat > 0.22) {
      this.lastBeat = now;
      f.beat = 1;
      f.beats++;
    } else f.beat = Math.max(0, f.beat - dt * 4.5);
    return f;
  }
}

export const audio = new AudioReactor();

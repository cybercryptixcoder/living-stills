// App state (zustand). Per-light runtime state lives in the Engine; this holds what the UI shows.

import { create } from 'zustand';
import type { SceneEntry } from './core/library';
import type { AnalysisResult, SceneDoc, SceneLabels } from './core/types';
import type { JobStep } from './core/pipeline';
import { DEFAULT_MODEL } from './core/openrouter';
import { DEFAULT_PARAMS, type ModeId, type ModeParams, type SwitchFeel } from './play/engine';
import type { Show } from './play/show';
import type { Zone } from './play/zones';

export type Sheet = null | 'scenes' | 'create' | 'settings' | 'help' | 'reflections' | 'refine' | 'studio';
export type Menu = null | 'effects' | 'presets' | 'look' | 'capture' | 'scene';

export interface View {
  ambient: number;
  exposure: number;
  glow: number;
  haze: number;
  grain: number;
  warmth: number;
  daylight: number;
}

export const DEFAULT_VIEW: View = { ambient: 1, exposure: 1, glow: 0.5, haze: 0.3, grain: 0.5, warmth: 0, daylight: 0 };

export interface Job {
  title: string;
  steps: JobStep[];
  error?: string;
  finding?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind?: 'info' | 'error';
}

export interface SceneState {
  doc: SceneDoc;
  source: 'example' | 'local';
  lights: number;
  hasElement: boolean;
  elementName?: string;
  editedLayer?: number;
  waterline: number | null;
  signed: boolean;
  hasDaylight: boolean;
}

/** What the light panel is controlling. Indices are engine indices. */
export interface Selection {
  anchor: number;
  scope: 'light' | 'zone' | 'picked';
  picked: number[]; // shift-click / box selection
}

export interface DirectorTurn {
  role: 'you' | 'director';
  text: string;
  show?: Show;
}

export interface DirectorState {
  open: boolean;
  busy: boolean;
  draft: string;
  thinking: string;
  turns: DirectorTurn[];
  error?: string;
}

export type Survey = 'heat' | 'dots' | 'off';
export type Theme = 'auto' | 'light' | 'dark';

interface Settings {
  key: string;
  model: string;
  resolution: string;
  aspect: string;
  sound: boolean;
  feel: SwitchFeel;
  theme: Theme;
  survey: Survey;
  luminalKey: string;
  relay: string;
}

const SETTINGS_KEY = 'living-stills:settings';

function loadSettings(): Settings {
  const d: Settings = {
    key: '', model: DEFAULT_MODEL, resolution: '1K', aspect: '16:9', sound: true, feel: 'filament', theme: 'auto', survey: 'off',
    luminalKey: '', relay: '',
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...d, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return d;
}

export function saveSettings(s: Partial<Settings>) {
  try {
    const cur = loadSettings();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, ...s }));
  } catch { /* storage unavailable */ }
}

export interface Store extends Settings {
  spend: number;
  examples: SceneEntry[];
  locals: SceneEntry[];
  currentId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  statusText: string;
  scene: SceneState | null;
  analysis: AnalysisResult | null;
  zones: Zone[];
  labels: SceneLabels | null;
  mode: ModeId;
  params: ModeParams;
  master: number;
  view: View;
  motion: { playing: boolean; speed: number };
  variant: 'estimate' | 'edits';
  cinema: boolean;
  selection: Selection | null;
  hovered: number | null;
  /** bumps when per-light state changes outside React (the light panel re-reads the engine) */
  rev: number;
  sheet: Sheet;
  menu: Menu;
  job: Job | null;
  toasts: Toast[];
  picking: boolean; // choosing lights for real edits
  picked: number[]; // light ids chosen for real edits
  recording: boolean;
  previewWaterline: number | null;
  routeReady: boolean;
  /** the show playing now (a preset or the director's) */
  playing: { name: string; id?: string; loop: boolean } | null;
  music: { source: 'mic' | 'tab' | null; error?: string; sensitivity: number };
  director: DirectorState;
  set: (p: Partial<Store>) => void;
  setSettings: (p: Partial<Settings>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
}

let toastSeq = 0;

export const useStore = create<Store>((set, get) => ({
  ...loadSettings(),
  spend: 0,
  examples: [],
  locals: [],
  currentId: null,
  status: 'idle',
  statusText: '',
  scene: null,
  analysis: null,
  zones: [],
  labels: null,
  mode: 'hand',
  params: { ...DEFAULT_PARAMS },
  master: 1,
  view: { ...DEFAULT_VIEW },
  motion: { playing: true, speed: 1 },
  variant: 'edits',
  cinema: false,
  selection: null,
  hovered: null,
  rev: 0,
  sheet: null,
  menu: null,
  job: null,
  toasts: [],
  picking: false,
  picked: [],
  recording: false,
  previewWaterline: null,
  routeReady: false,
  playing: null,
  music: { source: null, sensitivity: 1 },
  director: { open: false, busy: false, draft: '', thinking: '', turns: [] },
  set: (p) => set(p),
  setSettings: (p) => { saveSettings(p); set(p); },
  toast: (text, kind = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3600);
  },
}));

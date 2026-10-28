// App state (zustand). Per-light runtime state lives in the Engine; this holds what the UI shows.

import { create } from 'zustand';
import type { SceneEntry } from './core/library';
import type { AnalysisResult, SceneDoc } from './core/types';
import type { JobStep } from './core/pipeline';
import { DEFAULT_MODEL } from './core/openrouter';
import { DEFAULT_PARAMS, type ModeId, type ModeParams, type SwitchFeel } from './play/engine';

export type Sheet = null | 'scenes' | 'create' | 'settings' | 'refine' | 'grid' | 'help' | 'reflections';

export interface View {
  ambient: number;
  exposure: number;
  glow: number;
  haze: number;
  grain: number;
  warmth: number;
}

export const DEFAULT_VIEW: View = { ambient: 1, exposure: 1, glow: 0.5, haze: 0.3, grain: 0.5, warmth: 0 };

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
  groups: { name: string; count: number; kind?: 'static' | 'moving' }[];
  hasElement: boolean;
  elementName?: string;
  frames: number;
  editedLayer?: number;
  waterline: number | null;
}

interface Settings {
  key: string;
  model: string;
  resolution: string;
  aspect: string;
  sound: boolean;
  feel: SwitchFeel;
}

const SETTINGS_KEY = 'living-stills:settings';

function loadSettings(): Settings {
  const d: Settings = { key: '', model: DEFAULT_MODEL, resolution: '1K', aspect: '16:9', sound: true, feel: 'filament' };
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
  mode: ModeId;
  params: ModeParams;
  groups: number[];
  master: number;
  elementFader: number;
  view: View;
  motion: { playing: boolean; speed: number; blend: number };
  variant: 'estimate' | 'edits';
  showLights: boolean;
  cinema: boolean;
  selected: number | null; // engine light index
  hovered: number | null;
  hoverGroup: number | null;
  sheet: Sheet;
  job: Job | null;
  toasts: Toast[];
  picking: boolean; // choosing lights for real edits
  picked: number[]; // light ids chosen for real edits
  recording: boolean;
  /** image-px y of a waterline being previewed in the Reflections sheet */
  previewWaterline: number | null;
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
  mode: 'hand',
  params: { ...DEFAULT_PARAMS },
  groups: [],
  master: 1,
  elementFader: 1,
  view: { ...DEFAULT_VIEW },
  motion: { playing: true, speed: 1, blend: 0.6 },
  variant: 'edits',
  showLights: false,
  cinema: false,
  selected: null,
  hovered: null,
  hoverGroup: null,
  sheet: null,
  job: null,
  toasts: [],
  picking: false,
  picked: [],
  recording: false,
  previewWaterline: null,
  set: (p) => set(p),
  setSettings: (p) => { saveSettings(p); set(p); },
  toast: (text, kind = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3600);
  },
}));

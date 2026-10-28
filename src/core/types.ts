// Shared types for scenes, analysis results and rendering.

export type Vec3 = [number, number, number];
export type Rect = [number, number, number, number]; // x, y, w, h (image pixels)

/** How a scene's light layers were produced. */
export type Method = 'split' | 'perLight' | 'layered' | 'grid';

export interface StepLog {
  label: string;
  model?: string;
  cost: number; // USD
  ms: number;
  image?: string; // image key produced by this step
}

/** A per-light edit: the light was switched on by the image model inside a crop. */
export interface Refinement {
  lightId: number;
  /** Where the light was (its centre), so the edit finds its light again if lights are re-found. */
  at?: [number, number];
  crop: Rect;
  image: string; // image key of the edited crop
}

export interface MotionSpec {
  element: string; // e.g. "the train"
  rect: Rect; // where the element sits in the "on" image
  dir: 1 | -1; // +1 moves right
  speed: number; // image px per second at 1x
}

export interface GridGroupSpec {
  id: number; // light id used in the grid scene (1..n)
  name: string;
  kind: 'static' | 'moving';
  region?: Rect; // static groups: region the edit is allowed to light
  lights?: number[]; // light ids from the plate analysis that formed this group
}

export interface GridCell {
  f: number;
  g: number; // group id
  crop: Rect;
  image: string;
}

export interface GridSpec {
  frames: number;
  offsets: number[]; // element x offset per frame (px)
  groups: GridGroupSpec[];
  cells: GridCell[];
}

export interface AnalysisParams {
  /** Multiplier on the automatic noise floor; higher removes more faint change. */
  cleanup: number;
  /** Multiplier on the core threshold; higher finds fewer, brighter lights. */
  coreStrictness: number;
  /** Max number of lights. */
  maxLights: number;
}

export const DEFAULT_ANALYSIS: AnalysisParams = { cleanup: 1, coreStrictness: 1, maxLights: 240 };

export interface SceneDoc {
  version: 1;
  id: string;
  title: string;
  prompt: string;
  style?: string;
  createdAt: string;
  model: string;
  resolution: string;
  width: number;
  height: number;
  method: Method;
  /** image key -> file name inside the bundle (or URL for demos) */
  images: Record<string, string>;
  waterline?: number | null;
  analysis?: Partial<AnalysisParams>;
  refinements?: Refinement[];
  motion?: MotionSpec;
  grid?: GridSpec;
  steps: StepLog[];
  cost: number;
  demo?: {
    blurb?: string;
    view?: Partial<{ ambient: number; exposure: number; glow: number; haze: number; grain: number; warmth: number }>;
    route?: [number, number][];
    startMode?: string;
    order?: number;
  };
}

export interface LightInfo {
  id: number; // 1..255, 0 is reserved for the far-field remainder
  x: number;
  y: number;
  bbox: [number, number, number, number]; // x0, y0, x1, y1 inclusive
  area: number;
  flux: number; // summed linear luminance of its light core
  peak?: number; // brightest added light in the core (emitters peak high, lit walls do not)
  color: Vec3; // original light chromaticity (max channel = 1)
  group: number;
  refined?: boolean;
  /** Per-frame centroid for grid scenes where a light moves. */
  framePos?: [number, number][];
}

export interface GroupInfo {
  id: number;
  name: string;
  lights: number[];
  x: number;
  y: number;
  kind?: 'static' | 'moving';
}

/** One frame of light layers ready for the GPU. */
export interface LayerData {
  base: Uint8ClampedArray; // RGBA sRGB, lights-off image (aligned, gain matched)
  delta: Float32Array; // RGBA linear, light added when every light is at 1
  ids: Uint8Array; // RGBA: up to 4 light ids per pixel
  weights: Uint8Array; // RGBA: matching weights (sum 255)
}

export interface SpriteData {
  rect: Rect; // integer rect in image px where the sprite sits at offset 0
  lit: Float32Array; // RGBA linear premultiplied, element with its lights on
  dark: Float32Array; // RGBA linear premultiplied, element with its lights off
  spillRect: Rect;
  spill: Float32Array; // RGBA linear additive light the element casts (moves with it)
  /** Flux and colour of the element's own light (for the UI). */
  flux: number;
  color: Vec3;
}

export interface AnalysisResult {
  width: number;
  height: number;
  layers: LayerData[]; // frames (grid) or variants (perLight: [estimate, edits])
  lights: LightInfo[];
  groups: GroupInfo[];
  sprite?: SpriteData;
  waterline: number | null;
  stats: {
    shift: [number, number];
    gain: number;
    noise: number;
    cores: number;
    ms: number;
  };
  /** Grid only: which frame layer each frame index uses. */
  frameOffsets?: number[];
  /** Per-light edit scenes: layer index of the edited variant. */
  editedLayer?: number;
}

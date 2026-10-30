// Shared types for scenes, analysis results and rendering.

export type Vec3 = [number, number, number];
export type Rect = [number, number, number, number]; // x, y, w, h (image pixels)

/** How a scene's light layers were produced. */
export type Method = 'split' | 'perLight' | 'layered';

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

/** A light the user placed by hand (two-stage scenes): it becomes one controllable light group. */
export interface Marker {
  n: number; // 1, 2, 3 ... as shown on the picture
  x: number; // image px
  y: number;
  note: string; // what the user wrote ("only the rubber of the front tyre")
  color?: string; // #rrggbb the user asked for
  /** Filled in by the lighting planner (vision model): what is at the marker and where it ends. */
  object?: string;
  box?: [number, number, number, number]; // x0, y0, x1, y1 image px
}

/** What the vision model saw: names for zones of lights, used by the director and the inspector. */
export interface SceneLabels {
  summary: string;
  zones: Record<string, string>; // zone number -> "paper lanterns above the door"
  /** fingerprint of the zones these labels were made for */
  key: string;
}

export interface AnalysisParams {
  /** Multiplier on the automatic noise floor; higher removes more faint change. */
  cleanup: number;
  /** Multiplier on the core threshold; higher finds fewer, brighter lights. */
  coreStrictness: number;
  /** Max number of lights. */
  maxLights: number;
  /** Lights may also darken or recolour (a glow on white paper): keep negative change. Auto when unset. */
  signed?: boolean;
}

export const DEFAULT_ANALYSIS: AnalysisParams = { cleanup: 1, coreStrictness: 1, maxLights: 240 };

export interface SceneDoc {
  version: 1;
  id: string;
  title: string;
  prompt: string;
  /** How the user asked for the lighting to look (free text). */
  lighting?: string;
  /** Two-stage scenes: the lights the user placed. */
  markers?: Marker[];
  /** Vision labels for the director (optional). */
  labels?: SceneLabels;
  /** The 3D space: views of the same place from around it (image keys orbit<angle>On / Off / Depth). */
  orbit?: { angles: number[]; mode?: 'around' | 'panorama'; layout?: string; align?: { angle: number; scale: number; yaw: number }[] };
  /** Set while a two-stage scene waits for its lights to be placed (only the picture exists). */
  draft?: { kind: 'dark' | 'ambient'; aspect: string };
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
  steps: StepLog[];
  cost: number;
  demo?: {
    blurb?: string;
    view?: Partial<{ ambient: number; exposure: number; glow: number; haze: number; grain: number; warmth: number }>;
    route?: [number, number][];
    startMode?: string;
    order?: number;
    /** open in the 3D view */
    start3d?: boolean;
    /** open in the 3D space */
    startSpace?: boolean;
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
  /** Two-stage scenes: the marker number this light belongs to (0 = found but not placed). */
  marker?: number;
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
  layers: LayerData[]; // variants (perLight: [estimate, edits])
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
  /** Light may darken as well as brighten (signed difference). */
  signed?: boolean;
  /** Daylight version (sRGB RGBA), when the scene has one. */
  ambient?: Uint8ClampedArray;
  /** Per-light edit scenes: layer index of the edited variant. */
  editedLayer?: number;
}

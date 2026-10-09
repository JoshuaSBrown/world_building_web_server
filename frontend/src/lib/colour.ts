/**
 * Ramps and layer definitions.
 *
 * A colour scale is only legitimate if the viewer can see what it means,
 * so every layer carries its own legend text: what the ends of the ramp
 * are, in the units the server recorded. `LayerDef.domain` is the fixed
 * range each ramp spans — fixed, not per-frame, because a scale that
 * renormalises every frame makes a planet in steady state look like it
 * is churning.
 */

export type RGB3 = readonly [number, number, number];
export type Stop = readonly [number, number, number];

/** Piecewise-linear lookup with the input clamped to [0, 1]. */
export function ramp(stops: readonly Stop[], t: number): RGB3 {
  const n = stops.length;
  const first = stops[0];
  const last = stops[n - 1];
  if (!first || !last) return [0, 0, 0];
  if (!(t > 0)) return first;      // also catches NaN — absent draws as the low end
  if (t >= 1) return last;
  const x = t * (n - 1);
  const i = Math.floor(x);
  const a = stops[i] ?? first;
  const b = stops[i + 1] ?? last;
  const k = x - i;
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

export const RAMPS = {
  land: [
    [0.24, 0.35, 0.22], [0.42, 0.47, 0.26], [0.60, 0.54, 0.34],
    [0.55, 0.44, 0.34], [0.72, 0.71, 0.70], [0.97, 0.97, 0.98],
  ],
  bathy: [
    [0.02, 0.05, 0.12], [0.04, 0.12, 0.26], [0.06, 0.24, 0.42],
    [0.10, 0.38, 0.55], [0.22, 0.54, 0.64],
  ],
  temp: [
    [0.18, 0.30, 0.62], [0.32, 0.62, 0.72], [0.86, 0.84, 0.62],
    [0.88, 0.53, 0.26], [0.72, 0.18, 0.16],
  ],
  crust: [
    [0.16, 0.22, 0.30], [0.32, 0.38, 0.44], [0.82, 0.76, 0.62],
  ],
  age: [
    [0.86, 0.30, 0.24], [0.90, 0.70, 0.32], [0.38, 0.62, 0.50], [0.20, 0.28, 0.48],
  ],
} as const satisfies Record<string, readonly Stop[]>;

export type RampId = keyof typeof RAMPS;

/**
 * A boundary's colour, by the name the PHYSICS gave it.
 *
 * `Segment.label()` decides what a segment is, from its own normal and
 * tangential velocities — the two thresholds in that method are the only
 * conventions in the classification path, and they live in the simulation. This
 * table only says which colour stands for which word: the display classifies
 * nothing.
 *
 * Warm where crust is destroyed, cool where it is made, and yellow where plates
 * slide past — the convention the plate map has always used.
 */
/**
 * The order boundaries are listed in, always.
 *
 * A legend sorted by how many of each a step happens to contain reshuffles
 * itself as the run evolves, so the reader has to find the row again every
 * frame. This order is physical — closing, through sliding, to opening — and it
 * does not depend on the step.
 */
export const BOUNDARY_ORDER: readonly string[] = [
  "convergent", "oblique-convergent", "transform",
  "oblique-divergent", "divergent", "unclassified",
];

export const BOUNDARY_COLOURS: Readonly<Record<string, RGB3>> = {
  convergent: [1.0, 0.42, 0.26],
  "oblique-convergent": [1.0, 0.66, 0.38],
  transform: [0.97, 0.86, 0.36],
  "oblique-divergent": [0.50, 0.86, 0.78],
  divergent: [0.32, 0.80, 0.82],
  // The physics records this where a plate has no Euler vector yet, so no
  // sample classified the contact. Grey: it is an absence, not a kind.
  unclassified: [0.55, 0.57, 0.60],
};

/**
 * What a label this display has never heard of is drawn as.
 *
 * Magenta, because it must not pass for one of the five. A run that classifies
 * a segment some new way should be visible as unhandled, not quietly coloured
 * like something it is not.
 */
export const BOUNDARY_UNKNOWN: RGB3 = [0.85, 0.24, 0.72];

/** Distinct hues for plate identity. Categorical — the index carries no order. */
export const PLATE_HUES: readonly RGB3[] = [
  [0.85, 0.42, 0.35], [0.40, 0.62, 0.78], [0.78, 0.70, 0.38],
  [0.46, 0.72, 0.55], [0.70, 0.50, 0.78], [0.85, 0.62, 0.40],
  [0.42, 0.74, 0.74], [0.76, 0.48, 0.58], [0.56, 0.66, 0.40],
  [0.52, 0.54, 0.80], [0.80, 0.56, 0.30], [0.38, 0.68, 0.64],
];

export type BaseLayerId =
  | "topo" | "bathy" | "temp" | "tempgrad" | "plate" | "crust" | "age"
  | "density" | "thickness";
export type OverlayId =
  | "water" | "boundaries" | "motion" | "graticule" | "points";

export interface LayerDef<Id> {
  id: Id;
  name: string;
  /** What the colour means, in plain language. Rendered under the ramp. */
  blurb: string;
  /**
   * The dataset in the RUN FILE this layer draws, by the name the file gives it.
   * It is what the client asks the API for, and what the rail cites on screen —
   * the chain from a colour back to an array stays visible.
   */
  dataset: string;
  /** How the values become colour. `category` is a label, never a scale. */
  kind: "scalar" | "category" | "binary";
  /** Which ramp continuous layers use; `null` for categorical ones. */
  ramp: RampId | null;
  /**
   * How a VECTOR dataset becomes one number per element.
   *
   * `magnitude` is the Euclidean length of each row — a display transform on a
   * recorded field, the same kind as taking a speed from a velocity, and
   * labelled as one. A layer without it can only draw a scalar.
   */
  reduce?: "magnitude";
  /** Layers that mean nothing without a sea level, which no run records yet. */
  needsSeaLevel?: boolean;
}

export const BASE_LAYERS: readonly LayerDef<BaseLayerId>[] = [
  {
    id: "topo", name: "Topography",
    blurb: "Height of the solid surface, relative to the run's reference level (0 m). No sea level is recorded, so no shoreline is drawn.",
    dataset: "elevation", kind: "scalar", ramp: "land",
  },
  {
    id: "bathy", name: "Bathymetry",
    blurb: "Ocean depth only. Needs a sea level, which no run records yet.",
    dataset: "elevation", kind: "scalar", ramp: "bathy", needsSeaLevel: true,
  },
  {
    id: "temp", name: "Mantle temperature",
    blurb: "The mantle's thermal field, in kelvin — THIS is the heat map. Plume heating, diffusion, and relaxation toward the deep interior temperature; hot spots are the hot patches, and plume material arrives at most 300 K above the mantle it rises through. One value per thermal-mesh vertex, which is a coarser grid than the point cloud and a different domain from it.",
    dataset: "temperature", kind: "scalar", ramp: "temp",
  },
  {
    id: "tempgrad", name: "Mantle temp. gradient |∇T|",
    blurb: "How fast that temperature CHANGES with distance — kelvin per metre, the first derivative of the layer above. It is zero wherever the field is flat, which is most of the planet, so only the rims of plumes light up: it answers 'where does a hot spot end', not 'where is it'. For the heat itself, use Mantle temperature.",
    dataset: "gradient", kind: "scalar", ramp: "temp", reduce: "magnitude",
  },
  {
    id: "plate", name: "Plates",
    blurb: "Which rigid plate owns each cell. Colours are labels, not a scale.",
    dataset: "plate_id", kind: "category", ramp: null,
  },
  {
    id: "crust", name: "Crust type",
    blurb: "Oceanic against continental. The run reserves the flag; nothing sets it yet, so expect one value everywhere.",
    dataset: "oceanic", kind: "binary", ramp: "crust",
  },
  {
    id: "density", name: "Column density",
    blurb: "The column's density, in kg/m³ — recorded, not derived. Elevation is Airy freeboard, thickness × (1 − ρ/ρ_mantle), so a column's HEIGHT is governed by this far more than by how thick it is: near the mantle's own density the freeboard collapses to zero and changes sign. Compare this with topography when the relief looks odd.",
    dataset: "density", kind: "scalar", ramp: "crust",
  },
  {
    id: "thickness", name: "Column thickness",
    blurb: "Metres of lithosphere in each column — volume divided by the cell's own Voronoi area. Thick is not the same as high: a thick, dense column sits low.",
    dataset: "thickness", kind: "scalar", ramp: "age",
  },
  {
    id: "age", name: "Crust age",
    blurb: "Time since the crust last formed at a ridge. Recorded in seconds; the rail states the range in view.",
    dataset: "age", kind: "scalar", ramp: "age",
  },
];

export const OVERLAYS: readonly LayerDef<OverlayId>[] = [
  {
    id: "water", name: "Ocean",
    blurb: "Sea level cut through the elevation field. No run records a sea level yet, so there is nothing to cut.",
    dataset: "seaLevel", kind: "binary", ramp: null,
  },
  {
    id: "boundaries", name: "Plate boundaries",
    blurb: "Where plates converge and diverge. The run records boundaries as segments, a domain this viewer does not draw yet.",
    dataset: "boundaries", kind: "category", ramp: null,
  },
  {
    id: "points", name: "Cloud points",
    blurb: "The simulation's own cells, where they are this step. They are created at ridges and consumed at trenches, and the plates carry them — so stepping through a run shows the point cloud moving, which is the model's own resolution rather than a picture of it.",
    dataset: "pos", kind: "category", ramp: null,
  },
  {
    id: "motion", name: "Plate motion",
    blurb: "Which way each plate is sliding, and how fast. One arrow per plate, from the middle of it, drawn at a FIXED scale so a plate that speeds up over a run shows a longer arrow rather than the picture rescaling under it.",
    dataset: "plates/velocity", kind: "category", ramp: null,
  },
  {
    id: "graticule", name: "Graticule",
    blurb: "Parallels and meridians every 30°. A reference grid, not data.",
    dataset: "", kind: "category", ramp: null,
  },
];

/** CSS gradient for a layer's legend swatch. */
export function rampCss(id: BaseLayerId): string {
  const layer = BASE_LAYERS.find(l => l.id === id);
  if (!layer || layer.ramp === null) {
    const n = PLATE_HUES.length;
    return `linear-gradient(90deg, ${PLATE_HUES.map(
      (h, i) => `${css(h)} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`,
    ).join(", ")})`;
  }
  const stops: readonly Stop[] = RAMPS[layer.ramp];
  return `linear-gradient(90deg, ${stops
    .map((s, i) => `${css(s)} ${(i / (stops.length - 1)) * 100}%`)
    .join(", ")})`;
}

function css(c: RGB3 | Stop): string {
  return `rgb(${c.map(v => Math.round(v * 255)).join(" ")})`;
}

/** Thousands separators, fixed decimals. Presentation only. */
export function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

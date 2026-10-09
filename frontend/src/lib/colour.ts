/**
 * Colour strips ("ramps") and the description card for each map layer.
 *
 * Worked example — the Topography layer:
 *
 *   The run records `elevation` in metres for every cell. Say step 10 runs
 *   from −4,000 m (deepest basin) to +3,000 m (highest peak). The layer card
 *   below says Topography uses the `land` strip: dark green → olive → tan →
 *   brown → grey → snow white. So −4,000 m is painted dark green, +3,000 m
 *   snow white, and a cell at 0 m — 4/7 of the way up — falls between the
 *   tan and brown chips:
 *
 *     ramp(RAMPS.land, (0 - -4000) / (3000 - -4000))   // t = 4/7 ≈ 0.571
 *     // → [0.557, 0.454, 0.34]   a mid brown (red, green, blue, each 0–1)
 *
 *     ramp(RAMPS.land, 0)   // → [0.24, 0.35, 0.22]   dark green, the bottom chip
 *     ramp(RAMPS.land, 1)   // → [0.97, 0.97, 0.98]   snow white, the top chip
 *
 *   The side panel prints "−4,000 m … 3,000 m", "Scale: auto" and "dataset
 *   elevation", so the viewer can always read a colour back to a number and
 *   the array it came from.
 *
 *   Why "Hold this scale" exists: in auto mode step 11 is re-stretched to its
 *   own lowest and highest values. If the whole planet rose 500 m, step 11
 *   would look identical to step 10 — the rise is hidden, like a bathroom
 *   scale that re-zeroes itself each time you step on. Holding keeps step
 *   10's −4,000…3,000 m range, so the rise shows as the planet getting paler.
 *   A peak that then reaches 3,500 m stays snow white rather than being given
 *   a colour off the end of the strip, and the panel shows "Scale: held
 *   (frozen across frames)":
 *
 *     ramp(RAMPS.land, (3500 - -4000) / (3000 - -4000))   // t = 15/14 ≈ 1.07
 *     // → [0.97, 0.97, 0.98]   snow white, clamped at the top chip
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

/**
 * The colour strips. Each entry is one chip, [red, green, blue], each 0–1.
 * The first chip is the LOWEST value on the scale in view (t = 0), the last
 * chip the HIGHEST (t = 1); `ramp` blends neighbouring chips in between.
 */
export const RAMPS = {
  /**
   * Height of the solid surface (Topography layer; the land in the map view
   * and catalogue discs). Low ground is vegetation green, rising through bare
   * earth and rock to snow on the highest peaks — the colours of a relief map.
   */
  land: [
    [0.24, 0.35, 0.22],   // dark forest green — the lowest ground
    [0.42, 0.47, 0.26],   // olive green
    [0.60, 0.54, 0.34],   // tan / khaki
    [0.55, 0.44, 0.34],   // light brown
    [0.72, 0.71, 0.70],   // light grey — bare rock
    [0.97, 0.97, 0.98],   // snow white — the highest peaks
  ],
  /**
   * Depth of water (Bathymetry layer; the water surface on the globe and the
   * sea in the map view). Here t = 0 is the DEEPEST water and t = 1 the
   * shallowest, so the sea darkens as it deepens, as it does in a real ocean.
   */
  bathy: [
    [0.02, 0.05, 0.12],   // near-black navy — the deepest water
    [0.04, 0.12, 0.26],   // dark navy
    [0.06, 0.24, 0.42],   // deep blue
    [0.10, 0.38, 0.55],   // ocean blue
    [0.22, 0.54, 0.64],   // light teal blue — the shallowest water
  ],
  /**
   * Heat (Mantle temperature, and its rate of change). Cold is blue and hot
   * is red, like the two taps on a sink, passing through pale cream so that
   * the middle of the range reads as neither.
   */
  temp: [
    [0.18, 0.30, 0.62],   // cool blue — the coldest
    [0.32, 0.62, 0.72],   // light cyan-teal
    [0.86, 0.84, 0.62],   // pale cream — the middle of the range
    [0.88, 0.53, 0.26],   // orange
    [0.72, 0.18, 0.16],   // brick red — the hottest
  ],
  /**
   * Crust type and Column density. Low values are dark slate, high values
   * pale sand. For the Crust type flag (0 or 1) only the two ends are used.
   */
  crust: [
    [0.16, 0.22, 0.30],   // dark slate blue-grey — the lowest value
    [0.32, 0.38, 0.44],   // slate grey
    [0.82, 0.76, 0.62],   // pale sand / beige — the highest value
  ],
  /**
   * Crust age and Column thickness. Low values (young, or thin) are a hot
   * red-orange, cooling through gold and sage green to dark indigo for the
   * highest values (old, or thick).
   */
  age: [
    [0.86, 0.30, 0.24],   // red-orange — the lowest value (youngest / thinnest)
    [0.90, 0.70, 0.32],   // golden yellow
    [0.38, 0.62, 0.50],   // sage green
    [0.20, 0.28, 0.48],   // dark indigo blue — the highest value (oldest / thickest)
  ],
} as const satisfies Record<string, readonly Stop[]>;

export type RampId = keyof typeof RAMPS;

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
export const BOUNDARY_COLOURS: Readonly<Record<string, RGB3>> = {
  convergent: [1.0, 0.42, 0.26],            // red-orange — plates pushing together
  "oblique-convergent": [1.0, 0.66, 0.38],  // light orange — closing at an angle
  transform: [0.97, 0.86, 0.36],            // yellow — plates sliding past
  "oblique-divergent": [0.50, 0.86, 0.78],  // mint / aqua — opening at an angle
  divergent: [0.32, 0.80, 0.82],            // turquoise — plates pulling apart
  // The physics records this where a plate has no Euler vector yet, so no
  // sample classified the contact. Grey: it is an absence, not a kind.
  unclassified: [0.55, 0.57, 0.60],         // mid grey — no classification
};

/**
 * What a label this display has never heard of is drawn as.
 *
 * Magenta, because it must not pass for one of the five. A run that classifies
 * a segment some new way should be visible as unhandled, not quietly coloured
 * like something it is not.
 */
export const BOUNDARY_UNKNOWN: RGB3 = [0.85, 0.24, 0.72];   // magenta

/** Distinct hues for plate identity. Categorical — the index carries no order. */
export const PLATE_HUES: readonly RGB3[] = [
  [0.85, 0.42, 0.35],   //  0 terracotta / coral red
  [0.40, 0.62, 0.78],   //  1 steel blue
  [0.78, 0.70, 0.38],   //  2 mustard
  [0.46, 0.72, 0.55],   //  3 fern green
  [0.70, 0.50, 0.78],   //  4 lavender
  [0.85, 0.62, 0.40],   //  5 apricot
  [0.42, 0.74, 0.74],   //  6 teal
  [0.76, 0.48, 0.58],   //  7 dusty rose
  [0.56, 0.66, 0.40],   //  8 olive green
  [0.52, 0.54, 0.80],   //  9 periwinkle
  [0.80, 0.56, 0.30],   // 10 amber
  [0.38, 0.68, 0.64],   // 11 sea green
];

export type BaseLayerId =
  | "topo" | "bathy" | "temp" | "tempgrad" | "plate" | "crust" | "age"
  | "density" | "thickness";
export type OverlayId =
  | "water" | "boundaries" | "motion" | "graticule" | "points";

/**
 * The description card every layer fills in — one card per layer, and the
 * button, tooltip, data request, colours and legend all follow from it.
 * `Id` is the list the name comes from: `BaseLayerId` or `OverlayId`.
 *
 * Each box: what goes in it, an example (Topography), and what it does on screen.
 *
 * - `id` — the layer's code name. e.g. `"topo"`
 *     The handle every part of the app uses.
 *
 * - `name` — what the button says. e.g. `"Topography"`
 *     The button label in the side panel.
 *
 * - `blurb` — what the colour means, in plain words. e.g. "Height of the solid surface…"
 *     The tooltip shown when hovering over the button.
 *
 * - `dataset` — the dataset in the RUN FILE, by the name the file gives it. e.g. `"elevation"`
 *     What the client asks the API for, and what the panel cites ("dataset elevation"),
 *     so the chain from a colour back to an array stays visible.
 *
 * - `kind` — how the values become colour. e.g. `"scalar"`
 *     `scalar` = a measuring scale, painted through a ramp.
 *     `category` = name tags, painted from `PLATE_HUES` — a label, never a scale.
 *     `binary` = a yes/no flag.
 *
 * - `ramp` — which colour strip in `RAMPS`. e.g. `"land"`
 *     The strip that paints the globe and the bar in the panel; `null` for categorical layers.
 *
 * - `reduce` (optional) — how a VECTOR dataset becomes one number per element.
 *   e.g. none for Topography; Mantle temp. gradient uses `"magnitude"`
 *     `magnitude` is the Euclidean length of each row — a display transform on a recorded
 *     field, like taking a speed from a velocity — and the panel adds "(magnitude)" to the
 *     name. A layer without it can only draw a scalar.
 *
 * - `needsSeaLevel` (optional) — the layer means nothing without a sea level.
 *   e.g. none for Topography; Bathymetry sets `true`
 *     The button is disabled and says why, since no run records a sea level yet.
 *
 * Not yet honoured: `kind` is set on the card, not read from the `kind`
 * attribute the run file declares on each dataset (`web_server/CLAUDE.md`),
 * and `binary` is not one of the file's kinds — it is drawn through a ramp
 * exactly like `scalar`.
 */
export interface LayerDef<Id> {
  id: Id;
  name: string;
  blurb: string;
  dataset: string;
  kind: "scalar" | "category" | "binary";
  ramp: RampId | null;
  reduce?: "magnitude";
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

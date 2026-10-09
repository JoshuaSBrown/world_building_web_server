// Extensions on purpose: these modules are loaded by `node --test` as well as
// by vite, and node resolves ESM specifiers literally.
import type { BaseLayerId, LayerDef } from "./colour.ts";
import { BASE_LAYERS, BOUNDARY_COLOURS, BOUNDARY_ORDER, BOUNDARY_UNKNOWN } from "./colour.ts";
import { nearestMap } from "./nearest.ts";
import type { Frame } from "../api/types.ts";

/**
 * Turning one recorded step into one drawable layer.
 *
 * Everything here is *display*: choosing a colour range, projecting cloud cells
 * onto the mesh, converting a unit for a label. Nothing is derived — every value
 * that reaches the screen came out of a dataset the run wrote, and a layer whose
 * dataset the run did not record is reported unavailable rather than filled in.
 */

/**
 * Why a layer cannot be drawn, or null if it can.
 *
 * Asked of `available` — what the step HOLDS — and never of `fields`, which is
 * only what this request asked for. A frame fetched for topography carries one
 * field, and judging by it greyed out every other layer on a run that had
 * recorded them all: the picker could never leave the layer it was already on.
 */
export function unavailableBecause(layer: LayerDef<BaseLayerId>, frame: Frame | null): string | null {
  if (!frame) return "no step is loaded yet";
  if (layer.needsSeaLevel && frame.seaLevel === null) {
    return "this run records no sea level — it carries no water inventory";
  }
  if (!frame.available.includes(layer.dataset)) {
    return `this run did not record ${layer.dataset}`;
  }
  return null;
}

export function availableLayers(frame: Frame | null): BaseLayerId[] {
  return BASE_LAYERS.filter(l => unavailableBecause(l, frame) === null).map(l => l.id);
}

/** The colour range in effect, and where it came from. */
export interface Scale {
  min: number;
  max: number;
  units: string;
  /** `auto` recomputes per frame; `held` keeps the numbers across frames. */
  mode: "auto" | "held";
}

/**
 * One layer of one frame, sampled onto the display mesh.
 *
 * `values` is one number per display vertex, and `elevation` is always supplied
 * separately because the globe displaces its surface by it whatever layer is
 * being coloured.
 */
export interface Sampled {
  values: Float32Array;
  elevation: Float32Array;
  scale: Scale;
  kind: "scalar" | "category" | "binary";
  units: string;
  longName: string;
  /** Cloud points this frame held — the resolution of the SURFACE. */
  cells: number;
  /**
   * Elements of the active layer's OWN domain, and its name.
   *
   * Not the same as `cells`: the thermal field is one value per mesh vertex
   * (642) while the cloud is one per simulated point (~500), and reporting the
   * cloud's count beside a temperature map overstates what that map resolves.
   */
  elements: number;
  domain: string;
  /**
   * How much of the field sits in the bottom twentieth of its own range.
   *
   * A gradient is zero wherever its field is flat, so |∇T| is near zero over
   * most of a planet and its map reads as black with a few bright rims. That is
   * the field's shape, not a fault in the scale, and the rail says so rather
   * than leaving it to look like a broken layer.
   */
  skew: number;
}

/** A cache of one nearest-point map, keyed by the positions it was built from. */
export interface MapCache {
  /** Which step and domain the stored map belongs to. */
  key: string;
  map: Int32Array;
}

function mapFor(
  cache: Map<string, Int32Array>,
  key: string,
  vertices: Float32Array,
  pos: readonly (readonly number[])[],
): Int32Array {
  const hit = cache.get(key);
  if (hit && hit.length === vertices.length / 3) return hit;
  const map = nearestMap(vertices, pos);
  cache.set(key, map);
  return map;
}

/**
 * One number per element, from a scalar array or a vector one.
 *
 * A vector's magnitude is a display transform on a recorded field — the same
 * kind as reading a speed off a velocity — so the layer declares it and the rail
 * says so. Nothing else is derived: the components are the run's own.
 */
function reduceValues(
  raw: number[] | number[][],
  reduce: "magnitude" | undefined,
): number[] {
  if (!Array.isArray(raw[0])) return raw as number[];
  const rows = raw as number[][];
  if (reduce !== "magnitude") {
    // A vector layer with no stated reduction cannot be coloured, and guessing
    // a component would draw one axis of a field as if it were the field.
    return rows.map(() => Number.NaN);
  }
  return rows.map(r => Math.hypot(...r));
}

/** Spread a per-cell array over the vertices that belong to those cells. */
function spread(values: readonly number[], map: Int32Array): Float32Array {
  const out = new Float32Array(map.length);
  for (let i = 0; i < map.length; i++) {
    const k = map[i]!;
    // A vertex with no nearest cell is NaN, which every ramp renders as the
    // "not recorded" colour. It is never quietly zero.
    out[i] = k >= 0 ? (values[k] ?? Number.NaN) : Number.NaN;
  }
  return out;
}

/** Share of the values inside `[from, to]`. */
function share(values: readonly number[], from: number, to: number): number {
  let n = 0, inside = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    n++;
    if (v >= from && v <= to) inside++;
  }
  return n === 0 ? 0 : inside / n;
}

function limits(values: readonly number[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  // A constant field would otherwise divide by zero; widen it symmetrically so
  // the colour sits mid-ramp instead of at an arbitrary end.
  return lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi];
}

/**
 * Sample `layer` out of `frame` onto `vertices`.
 *
 * `held` freezes the colour range: during playback an auto scale recomputed
 * every frame renormalises each one, which makes a planet in steady state appear
 * to churn and flattens a real trend. The caller passes the range it is holding
 * and the rail says which mode is in effect.
 */
export function sampleFrame(
  frame: Frame,
  layerId: BaseLayerId,
  vertices: Float32Array,
  cache: Map<string, Int32Array>,
  held: Scale | null,
): Sampled | null {
  const layer = BASE_LAYERS.find(l => l.id === layerId);
  if (!layer) return null;

  const elevationField = frame.fields["elevation"];
  const cloud = frame.domains["cloud"];
  if (!elevationField || !cloud) return null;

  const cloudMap = mapFor(cache, `cloud:${frame.step}`, vertices, cloud.pos);
  const elevation = spread(elevationField.values as number[], cloudMap);

  const field = frame.fields[layer.dataset];
  if (!field) return null;

  const domain = frame.domains[field.domain];
  const map = field.domain === "cloud"
    ? cloudMap
    : domain
      ? mapFor(cache, `${field.domain}:${frame.step}`, vertices, domain.pos)
      : null;
  if (!map) return null;

  const raw = reduceValues(field.values, layer.reduce);
  const values = spread(raw, map);
  const [lo, hi] = limits(raw);
  const scale: Scale = held ?? { min: lo, max: hi, units: field.units, mode: "auto" };

  return {
    values,
    elevation,
    scale,
    kind: layer.kind,
    units: field.units,
    longName: layer.reduce === "magnitude"
      ? `${field.longName} (magnitude)`
      : field.longName,
    cells: (elevationField.values as number[]).length,
    elements: raw.length,
    domain: field.domain,
    skew: share(raw, lo, lo + (hi - lo) * 0.05),
  };
}

/**
 * The run's own points, ready to draw: where its cells ARE.
 *
 * Every other layer shows a field sampled onto a display mesh, which is a
 * picture of the surface but says nothing about the resolution behind it. These
 * are the simulated cells themselves — created at ridges, consumed at trenches,
 * carried by the plates — so watching them across steps is watching the model's
 * own discretisation move, not an animation of one.
 *
 * Positions are the recorded unit vectors, unchanged. Elevations ride along so
 * each point can sit on the surface it belongs to rather than on the sphere.
 */
export function cloudSites(
  frame: Frame | null,
): { pos: Float32Array; elevation: Float32Array } | null {
  const cloud = frame?.domains["cloud"];
  const field = frame?.fields["elevation"];
  if (!cloud || !field) return null;
  const rows = cloud.pos;
  const pos = new Float32Array(rows.length * 3);
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i]!;
    pos[i * 3] = p[0] ?? 0; pos[i * 3 + 1] = p[1] ?? 0; pos[i * 3 + 2] = p[2] ?? 0;
  }
  // A point with no elevation recorded sits at the reference radius rather than
  // being dropped: its POSITION is the fact being shown.
  const values = field.values as number[];
  const elevation = Float32Array.from(
    { length: rows.length }, (_, i) => values[i] ?? 0,
  );
  return { pos, elevation };
}

/**
 * The plate boundaries of one step: the interface's own edges, coloured by what
 * the physics called each contact.
 *
 * These are `boundary_edges` — the Voronoi edges between cells of different
 * plates, recorded by the writer. Adjacent edges share their endpoints, so they
 * close into curves with nothing chained here: the display draws the geometry
 * the tessellation already had.
 *
 * It used to draw a tick at each boundary SAMPLE instead. A sample sits at its
 * cell's centre — that is where the classification is computed — so the result
 * was two rows of unconnected marks either side of every boundary. Samples are
 * where the physics measures; edges are where the interface runs.
 *
 * The colour comes from the recorded `label`. This module classifies nothing.
 */
export function boundarySegments(frame: Frame | null): {
  /** Two vertices per edge: 6 floats each. */
  pos: Float32Array;
  colour: Float32Array;
  count: number;
  /** Classifications present in this step, in a fixed order — for the legend. */
  labels: string[];
  /** Labels this display has no colour for. Drawn, but reported. */
  unknown: string[];
} | null {
  const starts = frame?.fields["boundary_edges/start"];
  const ends = frame?.fields["boundary_edges/end"];
  const classes = frame?.fields["boundary_edges/label"];
  if (!starts || !ends || !classes) return null;

  const a = starts.values as number[][];
  const b = ends.values as number[][];
  const l = classes.values as unknown as string[];
  const n = Math.min(a.length, b.length, l.length);
  if (n === 0) return null;

  const pos = new Float32Array(n * 6);
  const colour = new Float32Array(n * 6);
  const counts = new Map<string, number>();
  const unknown = new Set<string>();

  for (let i = 0; i < n; i++) {
    const name = l[i] ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const rgb = BOUNDARY_COLOURS[name];
    if (!rgb) unknown.add(name);
    const col = rgb ?? BOUNDARY_UNKNOWN;
    const ends2 = [a[i]!, b[i]!];
    for (let e = 0; e < 2; e++) {
      const p = ends2[e]!;
      const k = (i * 2 + e) * 3;
      pos[k] = p[0] ?? 0; pos[k + 1] = p[1] ?? 0; pos[k + 2] = p[2] ?? 0;
      colour[k] = col[0]; colour[k + 1] = col[1]; colour[k + 2] = col[2];
    }
  }

  // Listed in the fixed physical order, not by how many of each this step has:
  // a legend that reshuffles itself every frame has to be re-read every frame.
  // Anything the order does not know goes last, so a new kind is still shown.
  const present = [...counts.keys()];
  const labels = [
    ...BOUNDARY_ORDER.filter(k => counts.has(k)),
    ...present.filter(k => !BOUNDARY_ORDER.includes(k)).sort(),
  ];
  return { pos, colour, count: n, labels, unknown: [...unknown] };
}

/** Seconds in a year, for turning m/s into the cm/yr a plate speed is quoted in. */
const SECONDS_PER_YEAR = 3.15576e7;

/**
 * How long an arrow is drawn per centimetre-per-year of plate speed, in units
 * of the planet's radius.
 *
 * **Fixed, never fitted to the frame.** A scale recomputed each step would make
 * every step's fastest plate the same length on screen, so a planet whose plates
 * were steadily speeding up would look unchanged and one in steady state would
 * appear to churn — the same reason a colour ramp is not silently renormalised
 * per frame. With this constant an arrow means the same speed in every step of
 * every run, which is what makes watching motion over time worth anything.
 *
 * The value is a legibility choice and nothing more: Earth-like plates run a few
 * centimetres a year, and 0.05 radii per cm/yr puts those at a visible fraction
 * of the globe without covering it.
 */
export const ARROW_RADII_PER_CM_YR = 0.05;

/** Plate speed in centimetres per year, from a velocity in metres per second. */
export function cmPerYear(vx: number, vy: number, vz: number): number {
  return Math.hypot(vx, vy, vz) * 100 * SECONDS_PER_YEAR;
}

/**
 * One arrow per plate: which way it is sliding, and how fast.
 *
 * The run records `plates/velocity` — the plate's rotation evaluated at its own
 * middle, tangent to the surface — and `centroid`, where that middle is. Both
 * are read, neither is computed here: the axis a plate turns about (`omega`) is
 * also in the file, and an arrow drawn from THAT would point along the axle
 * rather than the way the rim travels.
 *
 * Each arrow is three line segments — a shaft and two barbs — so it reads as a
 * direction rather than a stick. Everything is built on the unit sphere and
 * lifted clear of the surface by the caller.
 */
export function plateArrows(frame: Frame | null): {
  /** Two vertices per segment, 6 floats each: shaft, then two barbs. */
  pos: Float32Array;
  count: number;
  /** Fastest plate this step, cm/yr — reported, never used to scale anything. */
  fastest: number;
  plates: number;
} | null {
  const velocity = frame?.fields["plates/velocity"];
  const home = frame?.domains["plates"];
  if (!velocity || !home) return null;

  const v = velocity.values as number[][];
  const at = home.pos;
  const n = Math.min(v.length, at.length);
  if (n === 0) return null;

  const SEGMENTS = 3;
  const pos = new Float32Array(n * SEGMENTS * 6);
  let count = 0;
  let fastest = 0;

  for (let i = 0; i < n; i++) {
    const vel = v[i]!;
    const c = at[i]!;
    const [vx, vy, vz] = [vel[0] ?? 0, vel[1] ?? 0, vel[2] ?? 0];
    const speed = cmPerYear(vx, vy, vz);
    if (speed > fastest) fastest = speed;

    // A plate that is not moving gets no arrow. A zero-length one would draw as
    // a dot indistinguishable from a slow plate pointing at the camera.
    const mag = Math.hypot(vx, vy, vz);
    if (!(mag > 0)) continue;

    const dir: [number, number, number] = [vx / mag, vy / mag, vz / mag];
    const len = speed * ARROW_RADII_PER_CM_YR;
    const base: [number, number, number] = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    const tip: [number, number, number] = [
      base[0] + dir[0] * len, base[1] + dir[1] * len, base[2] + dir[2] * len,
    ];

    // The barbs sit in the surface, so they stay visible however the globe is
    // turned: `side` is perpendicular to both the arrow and the outward normal.
    const side: [number, number, number] = [
      base[1] * dir[2] - base[2] * dir[1],
      base[2] * dir[0] - base[0] * dir[2],
      base[0] * dir[1] - base[1] * dir[0],
    ];
    const sm = Math.hypot(side[0], side[1], side[2]) || 1;
    const head = len * 0.3;
    const wing = head * 0.55;

    const put = (a: readonly number[], b: readonly number[]) => {
      const k = count * 6;
      pos[k] = a[0]!; pos[k + 1] = a[1]!; pos[k + 2] = a[2]!;
      pos[k + 3] = b[0]!; pos[k + 4] = b[1]!; pos[k + 5] = b[2]!;
      count++;
    };
    put(base, tip);
    for (const sign of [1, -1]) {
      put(tip, [
        tip[0] - dir[0] * head + (side[0] / sm) * wing * sign,
        tip[1] - dir[1] * head + (side[1] / sm) * wing * sign,
        tip[2] - dir[2] * head + (side[2] / sm) * wing * sign,
      ]);
    }
  }

  if (count === 0) return null;
  return { pos: pos.subarray(0, count * 6), count, fastest, plates: n };
}

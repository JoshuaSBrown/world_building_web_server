/**
 * The contract with the Rust server.
 *
 * Every shape here is something the server produces. Nothing in this file
 * is computed in the browser — the display layer derives no physics, so a
 * quantity that is not on one of these types is a quantity the client
 * cannot show. Absent stays absent: optional fields are `| null`, never
 * defaulted to zero.
 *
 * Units are in the field name, and the name is the unit of record: `M` is
 * metres, `K` is kelvin, `Gyr` is gigayears, `M` on `waterGelM` is metres
 * of global equivalent layer. Elevation is dimensionless field units;
 * `reliefM` converts it for display and nowhere else.
 */

/** Initial conditions. Every one of these is an input the simulation consumes. */
export interface PlanetParams {
  name: string;
  seed: string;
  diameterM: number;
  /** Kelvin. Where the two-layer energy balance BEGINS — the post-magma-ocean
   *  initial condition, not the present-day temperature a run evolves to. That
   *  is an outcome and cannot be set. */
  startMantleTemperatureK: number;
  ageGyr: number;
  waterGelM: number;
  /** Size of the simulated point cloud, 100–10000. The surface is a cloud of
   *  points, each owning a Voronoi cell; this cap fixes the finest simulated scale. */
  maxPoints: number;
}

/** Quantities the server derived from the params. The client never recomputes these. */
export interface PlanetDerived {
  radiusM: number;
  massKg: number;
  surfaceGravity: number;
  escapeVelocityMs: number;
  surfaceAreaM2: number;
  cells: number;
  /** Centre-to-centre spacing of simulated cells. Nothing smaller than this was simulated. */
  simCellM: number;
  /** Metres of relief per unit of the dimensionless elevation field. The only
   *  legitimate way to put a metre figure on screen. */
  reliefM: number;
}

/**
 * One simulation that has been run for a planet.
 *
 * A planet is not one run: a simulation can be re-run, and later ones consume
 * what earlier ones produced. This list is what the chooser reads to know
 * whether a simulation's inputs exist.
 */
/**
 * The numerical choices one run was made with.
 *
 * Class (b) every one — a resolution, a step size, a cadence — which is why
 * they belong to the RUN and not to the planet. The planet's givens (diameter,
 * seed, starting temperature) are class (a) and fixed at creation.
 */
export interface RunSettings {
  /** Points the surface cloud starts with. The finest scale the physics sees. */
  nPoints: number;
  steps: number;
  /** Millions of years per step. Exercised for convergence, never tuned. */
  dtMyr: number;
  /** Steps between checkpoints; also how far behind the live view runs. */
  checkpointEverySteps: number;
}

export interface RunRef {
  /** Which simulation, e.g. `core-surface-formation`. */
  kind: string;
  jobId: string;
  startedAt: string;
  /** What it was run with. Absent on runs recorded before settings were kept. */
  settings?: RunSettings;
}

export interface PlanetSummary {
  id: string;
  params: PlanetParams;
  derived: PlanetDerived;
  /** ISO 8601, from the server clock. */
  createdAt: string;
  /** The most recent run; `runs` is the full story and this is its last entry. */
  jobId: string | null;
  /** Every run of this body, oldest first. Absent on planets made before runs
   *  were recorded — an empty list, never a fabricated one. */
  runs?: RunRef[];
  /** Parameters stored but used by no simulation, so a value the user set is
   *  never silently dropped. */
  unappliedParams?: string[];
}

/** A rectangle on the sphere. Produced by the server's geodesy, never by the client. */
export interface PatchSpec {
  centreLat: number;
  centreLon: number;
  widthM: number;
  heightM: number;
  bearingDeg: number;
  /** Worst-case scale distortion of the projection over the patch, as a fraction. */
  scaleError: number;
}

/**
 * `stepsTotal` is on every variant because it belongs to the job, not to the
 * state: a run is that many iterations long from the moment it is queued. So the
 * display reads one field in every state rather than remembering the last value
 * it happened to see, and can still say "40 of 40" once the run is over.
 */
export type JobStatus =
  | { state: "queued"; position: number; stepsTotal: number }
  | {
      state: "running";
      stage: string;
      progress: number;
      /** The last iteration the run has recorded, as the run reports it. */
      step: number;
      stepsTotal: number;
    }
  | { state: "complete"; elapsedSeconds: number; stepsTotal: number }
  | { state: "failed"; code: string; stepsTotal: number }
  /**
   * Stopped on purpose. Neither a failure nor a completion.
   *
   * `step` is how far it got, which is what a reader wants after stopping a run:
   * everything up to it was recorded and stays viewable.
   */
  | { state: "cancelled"; step: number; stepsTotal: number };

/**
 * One field of one recorded step, with what the RUN FILE says about it.
 *
 * The four attributes are the contract; the group names are not. A colour bar
 * labelled from `units` says what the run said, and `units: ""` means the run
 * declared none — which the UI reports rather than filling in.
 */
export interface FieldData {
  /** One entry per element of `domain`; a row per element when `kind` is vector. */
  values: number[] | number[][];
  units: string;
  kind: "scalar" | "vector" | "category";
  domain: string;
  longName: string;
}

/**
 * One recorded step, fetched by the client after the event stream announces it.
 *
 * Values are one per SIMULATED CELL, not per display vertex — the model's own
 * cells. `domains[…].pos` says where those cells are, and the display projects
 * them onto its mesh by nearest-point lookup (`lib/nearest.ts`).
 */
export interface Frame {
  step: number;
  /** Fraction of the run's steps, 0–1. */
  t: number;
  /** Simulated time of this step, as the run recorded it. */
  timeMyr?: number;
  /** Kept for the original contract: elevation per cloud cell, in metres. */
  elevation: number[];
  /** `null` when the run recorded none. Absent is drawn as absent, never as 0. */
  seaLevel: number | null;
  schemaMajor: number;
  /** Keyed by the dataset's own name in the run file — `plate_id`, not `plateId`. */
  fields: Record<string, FieldData>;
  /** Where each returned domain's elements sit, as unit vectors. */
  domains: Record<string, { pos: number[][] }>;
  /**
   * Every dataset this step holds, by name — including ones this request did
   * not ask for.
   *
   * A frame answers two questions and they are not the same: what was asked for
   * (`fields`) and what is there (this). The display fetches only the field it
   * draws, so judging availability from `fields` would report every layer but
   * the one on screen as unrecorded.
   */
  available: string[];
  /** Requested names the run did not record. */
  absent: string[];
}

export type Engine = "unity" | "unreal" | "generic";

/** What the client asks the server to bake, alongside the patch. */
export interface ExportSpec {
  engine: Engine;
  resolution: number;
  tiles: number;
  detailOctaves: number;
  atTime: number;
}


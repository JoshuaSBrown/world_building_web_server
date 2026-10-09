/**
 * The simulations this project runs, and the step arithmetic the tape needs.
 *
 * This replaces a table of invented life-stages — accretion, differentiation,
 * first lid, plate tectonics, erosion & climate — painted as bands whose widths
 * were a made-up share of simulated time. Two things were wrong with it, and both
 * are the display layer's cardinal sin: **it drew what the model never
 * computed.** No run declares a stage schedule, and nothing in `tectonics/`
 * erodes anything at all, so "Erosion & climate" was a band a planet could sit
 * inside while no erosion existed.
 *
 * What a run really reports is a **step count**, and that is what the tape shows.
 * Erosion and climate become what they are: a separate simulation, listed here as
 * not yet built rather than quietly dropped.
 */
import type { JobStatus } from "../api/types";

export interface Simulation {
  id: string;
  name: string;
  /** Plain language, for a reader who is not a geophysicist. */
  blurb: string;
  /**
   * Simulations whose output this one consumes. A run cannot start until each
   * has a FINISHED run for that planet — checked against the run directories on
   * disk, never assumed.
   */
  requires: readonly string[];
  /** False for a simulation that does not exist yet. Never rendered as running. */
  available: boolean;
}

/** Ids are the wire values the server accepts, so they are named once. */
const CORE_SURFACE_FORMATION_ID = "core-surface-formation";

/** What `evolve.py` does today: the run every planet in the catalogue came from. */
export const CORE_SURFACE_FORMATION: Simulation = {
  id: CORE_SURFACE_FORMATION_ID,
  name: "Core & surface formation",
  blurb:
    "A hot interior cools on its own energy balance. Crust thins as it does, " +
    "until the lid can finally sink — and the surface separates into young " +
    "shallow ridges, old deep basins, and thickened stacks.",
  requires: [],
  available: true,
};

/** Named so the gap is visible, not so it can be selected. */
export const EROSION_CLIMATE: Simulation = {
  id: "erosion-climate",
  name: "Erosion & climate",
  blurb:
    "Water and weather taking relief back down as fast as tectonics builds it. " +
    "A separate simulation, and not yet built: nothing in a run so far erodes. " +
    "It reads a finished surface, so core & surface formation has to run first.",
  requires: [CORE_SURFACE_FORMATION_ID],
  available: false,
};

export const SIMULATIONS: readonly Simulation[] = [
  CORE_SURFACE_FORMATION,
  EROSION_CLIMATE,
];

/**
 * Which step a scrub position lands on.
 *
 * The server defines `t = step / stepsTotal` for a recorded step, so this is that
 * relation read backwards and nothing more. Steps count from 1 — the first
 * recorded iteration — and `t = 0` is the state before any step ran.
 */
export function stepAt(t: number, stepsTotal: number): number {
  if (!(stepsTotal > 0)) return 0;
  const clamped = Math.min(1, Math.max(0, t));
  return Math.round(clamped * stepsTotal);
}

/** Where a step sits on the tape, in [0, 1]. The inverse of `stepAt`. */
export function fractionOf(step: number, stepsTotal: number): number {
  if (!(stepsTotal > 0)) return 0;
  return Math.min(1, Math.max(0, step / stepsTotal));
}

/**
 * Whether a run is still going, and so can be stopped.
 *
 * `queued` counts: a run waiting its turn is one a user still wants to call off,
 * and refusing until it starts would be a control that works only once it is too
 * late to be useful.
 */
export function underway(status: JobStatus | null): boolean {
  return status !== null && (status.state === "queued" || status.state === "running");
}

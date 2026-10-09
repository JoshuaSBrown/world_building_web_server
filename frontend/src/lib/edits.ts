/**
 * Terrain edits: the one sanctioned entry of art direction.
 *
 * `docs/09-planet-timelines.md` defines what an edit *is* — "a recorded delta
 * applied to elevation state at the checkpoint" — and where it is applied: in
 * the **engine**, at the start of the next segment, never in the server and
 * never in the display. This module only authors the delta.
 *
 * Three consequences, all deliberate:
 *
 * * The delta is keyed by the run's own **cell index**, not by display vertex.
 *   It has to be expressible against the state the engine holds, or it could
 *   never be applied to anything.
 * * It is art, and is labelled art everywhere it appears. A planet carrying one
 *   is `contains manual edits` forever, and that never washes out by evolving
 *   further.
 * * Editing elevation makes every derived layer stale. Nothing here recomputes
 *   temperature, plates or crust age from a moved surface — that is physics, and
 *   inventing it in the browser is the exact failure this repo is organised
 *   against.
 */

/** Metres added to the recorded elevation of a cell, by cell index. */
export type EditDelta = ReadonlyMap<number, number>;

export const EMPTY_DELTA: EditDelta = new Map();

/**
 * Raise or lower the cells within `radiusRad` of a point on the sphere.
 *
 * The falloff is a raised cosine: full strength at the centre, zero at the edge.
 * It is a brush shape, not a physical law, and it is chosen so repeated strokes
 * accumulate smoothly rather than leaving terraces.
 */
export function paintDelta(
  delta: EditDelta,
  pos: readonly (readonly number[])[],
  at: readonly [number, number, number],
  radiusRad: number,
  amountM: number,
): EditDelta {
  const next = new Map(delta);
  const cosR = Math.cos(radiusRad);
  for (let k = 0; k < pos.length; k++) {
    const p = pos[k]!;
    const d = at[0] * (p[0] ?? 0) + at[1] * (p[1] ?? 0) + at[2] * (p[2] ?? 0);
    if (d <= cosR) continue;
    // How far in, 0 at the rim and 1 at the centre.
    const inward = (d - cosR) / (1 - cosR);
    const weight = 0.5 - 0.5 * Math.cos(Math.PI * inward);
    const value = (next.get(k) ?? 0) + amountM * weight;
    if (Math.abs(value) < 1e-9) next.delete(k);
    else next.set(k, value);
  }
  return next;
}

/** The recorded values with the edit applied, for display only. */
export function withDelta(values: readonly number[], delta: EditDelta): number[] {
  if (delta.size === 0) return values as number[];
  const out = values.slice();
  for (const [cell, d] of delta) {
    if (cell >= 0 && cell < out.length) out[cell] = (out[cell] ?? 0) + d;
  }
  return out;
}

/** How much was moved, for the badge: cells touched and the largest change. */
export function summarise(delta: EditDelta): { cells: number; peakM: number } {
  let peak = 0;
  for (const d of delta.values()) if (Math.abs(d) > Math.abs(peak)) peak = d;
  return { cells: delta.size, peakM: peak };
}

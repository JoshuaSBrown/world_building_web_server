import { RAMPS, ramp } from "./colour.ts";
import { nearestMap } from "./nearest.ts";
// One definition of where a planet is looked at from, so a card shows the
// hemisphere its planet opens on.
import { INITIAL_PHI, INITIAL_THETA } from "./view.ts";

/**
 * The planet as a small disc: the recorded surface, not a decoration.
 *
 * A catalogue card used to carry a grey gradient labelled "placeholder shading".
 * Honest, but useless — you could not tell two worlds apart, which is the one
 * job a thumbnail has. This draws the same thing the globe does: the run's own
 * elevation, the same ramp, the same auto range, from the same viewpoint. What
 * you pick out of the grid is what opens.
 *
 * Orthographic rather than perspective. At this size the difference is under a
 * pixel, and it keeps the projection something that can be stated in one line:
 * the hemisphere facing the camera, straight on.
 */



/** Pixels across. A card's disc is ~110 CSS px; more is invisible and costs a
 *  nearest-point search per pixel. A declared display resolution. */
export const DISC_SIZE = 112;

/** Raw RGBA, so the drawing is testable without a DOM. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * One planet, drawn into `size × size` RGBA pixels. Outside the disc is
 * transparent, so the card's own shading still frames it.
 *
 * `values` are the cloud's elevations and `pos` its unit vectors. A pixel with
 * no cell behind it stays transparent rather than taking a plausible colour.
 */
export function renderDisc(
  size: number,
  pos: readonly (readonly number[])[],
  values: readonly number[],
): Pixels {
  const img: Pixels = {
    width: size, height: size,
    data: new Uint8ClampedArray(size * size * 4),
  };
  if (pos.length === 0) return img;

  // The camera direction, and a frame to lay the disc out in. `up` is the
  // world's pole, so north is up on the card exactly as it is on the globe.
  const c: [number, number, number] = [
    Math.sin(INITIAL_PHI) * Math.cos(INITIAL_THETA),
    Math.cos(INITIAL_PHI),
    Math.sin(INITIAL_PHI) * Math.sin(INITIAL_THETA),
  ];
  const right = norm(cross([0, 1, 0], c));
  const up = cross(c, right);

  // Directions for every pixel inside the disc, and where each one is.
  const dirs: number[] = [];
  const at: number[] = [];
  for (let y = 0; y < size; y++) {
    // +1 at the top of the image: screen y grows downward.
    const py = 1 - (2 * (y + 0.5)) / size;
    for (let x = 0; x < size; x++) {
      const px = (2 * (x + 0.5)) / size - 1;
      const r2 = px * px + py * py;
      if (r2 > 1) continue;
      const pz = Math.sqrt(1 - r2);
      dirs.push(
        px * right[0] + py * up[0] + pz * c[0],
        px * right[1] + py * up[1] + pz * c[1],
        px * right[2] + py * up[2] + pz * c[2],
      );
      at.push(y * size + x);
    }
  }

  const map = nearestMap(Float32Array.from(dirs), pos);

  // The same auto range the viewer opens on, so the colours match rather than
  // merely resemble.
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;

  for (let i = 0; i < at.length; i++) {
    const cell = map[i]!;
    if (cell < 0) continue;
    const v = values[cell];
    if (v === undefined || !Number.isFinite(v)) continue;
    const col = ramp(RAMPS.land, span > 0 ? (v - lo) / span : 0.5);
    const k = at[i]! * 4;
    img.data[k] = col[0] * 255;
    img.data[k + 1] = col[1] * 255;
    img.data[k + 2] = col[2] * 255;
    img.data[k + 3] = 255;
  }
  return img;
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

import { nearestMap } from "./nearest.ts";
import type { PatchSpec } from "../api/types.ts";

/**
 * A rectangle on the sphere, and the grid it projects onto.
 *
 * The projection is **plate carrée**: latitude and longitude spaced evenly on
 * the two axes. It is the simplest thing that can be stated exactly, and stating
 * it is the point — every map lies somewhere, and a viewer that does not say
 * where is the one telling the worse lie. `scaleError` reports how much the
 * east-west scale stretches across the patch, so a tall patch says on screen
 * that its top and bottom are not to the same scale.
 *
 * This used to live in Rust and reach the browser as WebAssembly, so the viewer
 * and the exporter could not disagree about where a rectangle was. That crate
 * was never built, and `previewPatch` therefore never returned anything: the map
 * view has shown nothing since it was written. The geometry is small and
 * separable, so it is here — and when the exporter arrives, this is the
 * behaviour it has to match rather than a blank the two could differ over.
 */

const DEG = Math.PI / 180;

export interface Bounds {
  minLat: number; maxLat: number;
  minLon: number; maxLon: number;
}

/** Unit vector for a latitude and longitude, in the globe's own axes. */
export function toVector(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const c = Math.cos(lat);
  // Matches the inverse the viewer uses on a picked point: y is the pole.
  return [c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon)];
}

/** Latitude and longitude of a unit vector. The inverse of `toVector`. */
export function toLatLon(p: readonly [number, number, number]): [number, number] {
  return [
    Math.asin(Math.min(1, Math.max(-1, p[1]))) / DEG,
    Math.atan2(p[2], p[0]) / DEG,
  ];
}

/**
 * The patch two dragged corners describe.
 *
 * Axis-aligned in latitude and longitude, which is what the drag expresses; a
 * rotated patch would need a bearing the pointer never gave. Sizes are true
 * distances on the sphere at the patch's centre latitude, so the map's aspect
 * ratio is metrically honest even though the projection stretches within it.
 */
export function patchFromCorners(
  a: readonly [number, number],
  b: readonly [number, number],
  radiusM: number,
): PatchSpec {
  const minLat = Math.min(a[0], b[0]);
  const maxLat = Math.max(a[0], b[0]);
  let west = a[1], east = b[1];
  // A drag across the antimeridian is a short patch, not a 350° one.
  if (Math.abs(east - west) > 180) {
    if (west < east) west += 360; else east += 360;
  }
  const minLon = Math.min(west, east);
  const maxLon = Math.max(west, east);

  const centreLat = (minLat + maxLat) / 2;
  const centreLon = wrapLon((minLon + maxLon) / 2);
  const heightM = radiusM * (maxLat - minLat) * DEG;
  const widthM = radiusM * Math.cos(centreLat * DEG) * (maxLon - minLon) * DEG;

  // Plate carrée keeps every row the same width on screen, but a row at
  // latitude φ is really cos φ as wide. This is the worst mismatch inside the
  // patch, as a fraction — 0 at the equator, large near a pole.
  const centre = Math.cos(centreLat * DEG);
  const edge = Math.min(
    Math.cos(minLat * DEG),
    Math.cos(maxLat * DEG),
  );
  const scaleError = centre > 0 ? Math.abs(1 - edge / centre) : 1;

  return { centreLat, centreLon, widthM, heightM, bearingDeg: 0, scaleError };
}

/** Longitude folded back into (−180, 180]. */
export function wrapLon(lon: number): number {
  let v = ((lon + 180) % 360 + 360) % 360 - 180;
  if (v === -180) v = 180;
  return v;
}

/** The patch's edges, recovered from its centre and its true extents. */
export function boundsOf(patch: PatchSpec, radiusM: number): Bounds {
  const halfLat = (patch.heightM / radiusM) / 2 / DEG;
  const cos = Math.cos(patch.centreLat * DEG);
  const halfLon = cos > 1e-9
    ? (patch.widthM / (radiusM * cos)) / 2 / DEG
    : 180;
  return {
    minLat: Math.max(-90, patch.centreLat - halfLat),
    maxLat: Math.min(90, patch.centreLat + halfLat),
    minLon: patch.centreLon - halfLon,
    maxLon: patch.centreLon + halfLon,
  };
}

/** Unit-sphere points tracing the patch edge, for the outline on the globe. */
export function patchOutline(
  patch: PatchSpec, radiusM: number, perSide = 24,
): Float32Array {
  const b = boundsOf(patch, radiusM);
  const pts: number[] = [];
  const push = (lat: number, lon: number) => pts.push(...toVector(lat, wrapLon(lon)));
  for (let i = 0; i <= perSide; i++) {
    push(b.minLat, b.minLon + ((b.maxLon - b.minLon) * i) / perSide);
  }
  for (let i = 0; i <= perSide; i++) {
    push(b.minLat + ((b.maxLat - b.minLat) * i) / perSide, b.maxLon);
  }
  for (let i = 0; i <= perSide; i++) {
    push(b.maxLat, b.maxLon - ((b.maxLon - b.minLon) * i) / perSide);
  }
  for (let i = 0; i <= perSide; i++) {
    push(b.maxLat - ((b.maxLat - b.minLat) * i) / perSide, b.minLon);
  }
  return Float32Array.from(pts);
}

/**
 * Sample one recorded field over the patch, `w` × `h`, row 0 at the top.
 *
 * **Nearest cell, never an interpolation.** It is the same rule the globe
 * follows and for the same reason: a cloud cell is a Voronoi region the model
 * owns, and blending two of them would draw terrain that was never computed.
 * The visible consequence is honest — cell edges show as facets at high zoom,
 * which is the resolution the run actually has.
 */
export function sampleGrid(
  patch: PatchSpec,
  radiusM: number,
  w: number,
  h: number,
  pos: readonly (readonly number[])[],
  values: readonly number[],
): Float32Array {
  const b = boundsOf(patch, radiusM);
  const dirs = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    // Row 0 is the northern edge: on screen, up is north.
    const lat = b.maxLat - ((b.maxLat - b.minLat) * j) / Math.max(1, h - 1);
    for (let i = 0; i < w; i++) {
      const lon = b.minLon + ((b.maxLon - b.minLon) * i) / Math.max(1, w - 1);
      const v = toVector(lat, wrapLon(lon));
      const k = (j * w + i) * 3;
      dirs[k] = v[0]; dirs[k + 1] = v[1]; dirs[k + 2] = v[2];
    }
  }

  const map = nearestMap(dirs, pos);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const cell = map[i]!;
    // No cell is NaN, which draws as "not recorded" rather than as sea level.
    out[i] = cell >= 0 ? (values[cell] ?? Number.NaN) : Number.NaN;
  }
  return out;
}

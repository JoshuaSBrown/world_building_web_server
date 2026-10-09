/**
 * Putting a run's own cells onto the display mesh.
 *
 * A run's surface is an unstructured cloud — a few hundred points, each owning a
 * Voronoi cell — and the globe is an icosphere of tens of thousands of vertices.
 * Something has to relate the two, and **which something is a correctness
 * question, not a taste one**: nearest-point lookup reproduces exactly the cell
 * each point owns, which is the model's own notion of the surface. Interpolating
 * between cloud points would draw intermediate topography that nothing computed.
 *
 * (Before this existed, the globe indexed `elevation[i]` by *vertex* index while
 * the array had one entry per *cloud point*, so all but the first few hundred
 * vertices read `undefined`.)
 */

/**
 * For every display vertex, the index of the nearest cloud point.
 *
 * Both are unit vectors, so "nearest on the sphere" is "largest dot product" —
 * the angle is monotonic in it and no square roots or trigonometry are needed.
 *
 * Brute force, V × N. It is the clear statement of what nearest-point means, and
 * the cost is bounded instead by asking for a display mesh proportionate to the
 * cloud (see `displayLevelFor`) rather than by a cleverer search.
 */
export function nearestMap(
  vertices: Float32Array,
  pos: readonly (readonly number[])[],
): Int32Array {
  const v = vertices.length / 3;
  const out = new Int32Array(v);
  if (pos.length === 0) return out.fill(-1);

  // Flat copy: indexing a nested array per candidate is what makes the naive
  // version slow, and it costs one pass to avoid.
  const px = new Float64Array(pos.length);
  const py = new Float64Array(pos.length);
  const pz = new Float64Array(pos.length);
  for (let k = 0; k < pos.length; k++) {
    const p = pos[k]!;
    px[k] = p[0] ?? 0; py[k] = p[1] ?? 0; pz[k] = p[2] ?? 0;
  }

  for (let i = 0; i < v; i++) {
    const j = i * 3;
    const x = vertices[j]!, y = vertices[j + 1]!, z = vertices[j + 2]!;
    let best = -Infinity, bestK = -1;
    for (let k = 0; k < px.length; k++) {
      const d = x * px[k]! + y * py[k]! + z * pz[k]!;
      if (d > best) { best = d; bestK = k; }
    }
    out[i] = bestK;
  }
  return out;
}

/** Vertices of an icosphere at `level`. 10·4^level + 2. */
export function verticesAt(level: number): number {
  return 10 * 4 ** level + 2;
}

/**
 * The display mesh to draw `points` cloud cells on.
 *
 * Enough vertices to render a cell's outline crisply and no more: past that the
 * extra vertices carry no information the run produced, and every one of them
 * costs a nearest-point search per frame. `TARGET_PER_CELL` is a class-(b)
 * choice — a resolution, declared and shown on screen, not tuned to make
 * anything look right.
 */
export const TARGET_PER_CELL = 40;
export const MAX_LEVEL = 6;
export const MIN_LEVEL = 3;

export function displayLevelFor(points: number): number {
  const wanted = Math.max(1, points) * TARGET_PER_CELL;
  for (let level = MIN_LEVEL; level < MAX_LEVEL; level++) {
    if (verticesAt(level) >= wanted) return level;
  }
  return MAX_LEVEL;
}

/**
 * Icosphere topology.
 *
 * The deliberate exception to "geometry comes from the server": this is
 * pure topology, formula-derived from the subdivision level and identical
 * for every planet. There are no free parameters, so there is nothing for
 * a Rust copy and a TypeScript copy to disagree about — and shipping
 * 40 962 vertices to describe something with no free parameters would be
 * silly.
 *
 * It carries no physics. Vertex i here is cell i in every array the
 * server sends; that index correspondence is the whole contract.
 *
 *   level 4 →   2 562 vertices    level 6 →  40 962
 *   level 5 →  10 242             level 7 → 163 842
 */
export interface Mesh {
  /** Unit-sphere xyz triples. */
  vertices: Float32Array;
  /** Triangle corner indices, three per face. */
  indices: Uint32Array;
}

export function icosphere(level: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(normalise);

  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let pass = 0; pass < level; pass++) {
    // One shared vertex per edge, so the result stays a closed manifold:
    // every edge belongs to exactly two faces and V − E + F = 2.
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const found = midpoints.get(key);
      if (found !== undefined) return found;
      const va = verts[a]!, vb = verts[b]!;
      verts.push(normalise([va[0]! + vb[0]!, va[1]! + vb[1]!, va[2]! + vb[2]!]));
      const index = verts.length - 1;
      midpoints.set(key, index);
      return index;
    };

    const next: number[][] = [];
    for (const f of faces) {
      const [a, b, c] = [f[0]!, f[1]!, f[2]!];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  const vertices = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => {
    vertices[i * 3] = v[0]!;
    vertices[i * 3 + 1] = v[1]!;
    vertices[i * 3 + 2] = v[2]!;
  });

  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => {
    indices[i * 3] = f[0]!;
    indices[i * 3 + 1] = f[1]!;
    indices[i * 3 + 2] = f[2]!;
  });

  return { vertices, indices };
}

function normalise(v: number[]): number[] {
  const len = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / len, v[1]! / len, v[2]! / len];
}

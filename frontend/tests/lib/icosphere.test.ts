import assert from "node:assert/strict";
import { test } from "node:test";
import { icosphere } from "../../src/lib/icosphere.ts";

test("icosphere is a closed manifold with the expected vertex count", () => {
  for (const level of [0, 1, 4, 5]) {
    const { vertices, indices } = icosphere(level);

    const V = vertices.length / 3;
    const F = indices.length / 3;
    assert.equal(V, 10 * 4 ** level + 2, `level ${level} vertex count`);

    // Every edge belongs to exactly two faces, and V − E + F = 2.
    const edges = new Map<string, number>();
    for (let f = 0; f < F; f++) {
      const c = [indices[f * 3]!, indices[f * 3 + 1]!, indices[f * 3 + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = c[k]!, b = c[(k + 1) % 3]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of edges) {
      assert.equal(count, 2, `edge ${key} at level ${level} is in exactly 2 faces`);
    }
    assert.equal(V - edges.size + F, 2, `Euler characteristic at level ${level}`);

    // Every vertex sits on the unit sphere, to machine precision.
    for (let i = 0; i < V; i++) {
      const r = Math.hypot(vertices[i * 3]!, vertices[i * 3 + 1]!, vertices[i * 3 + 2]!);
      assert.ok(Math.abs(r - 1) < 1e-6, `vertex ${i} at level ${level} has radius ${r}`);
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { displayLevelFor, nearestMap, verticesAt } from "../../src/lib/nearest.ts";

test("a vertex takes the value of the nearest cloud cell, not its own index", () => {
  // Two cells at the poles; four vertices, two in each hemisphere.
  const cells = [[0, 1, 0], [0, -1, 0]];
  const vertices = Float32Array.from([
    0, 1, 0,      // exactly on the north cell
    0.3, 0.95, 0, // northern
    0, -1, 0,     // exactly on the south cell
    -0.3, -0.95, 0,
  ]);
  assert.deepEqual([...nearestMap(vertices, cells)], [0, 0, 1, 1]);

  // The bug this replaced: a display mesh far larger than the cloud used to
  // index past the end of the value array. Every vertex must map to a real cell.
  const many = new Float32Array(3 * 500);
  for (let i = 0; i < 500; i++) {
    const a = (i / 500) * Math.PI * 2;
    many[i * 3] = Math.cos(a); many[i * 3 + 1] = 0; many[i * 3 + 2] = Math.sin(a);
  }
  const map = nearestMap(many, cells);
  assert.equal(map.length, 500);
  assert.ok([...map].every(k => k === 0 || k === 1), "every vertex resolves to a cell");
});

test("an empty cloud maps to nothing, and nothing is invented", () => {
  const map = nearestMap(Float32Array.from([1, 0, 0]), []);
  assert.deepEqual([...map], [-1], "-1 becomes NaN downstream, never cell 0");
});

test("the display mesh is sized to the cloud it draws", () => {
  // Enough vertices to resolve each cell, and never more than the cap.
  for (const points of [100, 300, 500, 3000, 10000]) {
    const level = displayLevelFor(points);
    assert.ok(level >= 3 && level <= 6, `level ${level} for ${points} points`);
    if (level < 6) {
      assert.ok(verticesAt(level) >= points * 40, `level ${level} resolves ${points} cells`);
      assert.ok(verticesAt(level - 1) < points * 40, `level ${level} is the smallest that does`);
    }
  }
  assert.equal(displayLevelFor(10000), 6, "the cap holds for a large cloud");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_DELTA, paintDelta, summarise, withDelta } from "../../src/lib/edits.ts";

test("a brush stroke moves cells near it and leaves the rest recorded", () => {
  const pos = [[0, 1, 0], [0, -1, 0], [1, 0, 0]];
  const delta = paintDelta(EMPTY_DELTA, pos, [0, 1, 0], (20 * Math.PI) / 180, 500);
  assert.equal(delta.size, 1, "only the cell under the brush moved");
  assert.ok(Math.abs((delta.get(0) ?? 0) - 500) < 1e-9, "full strength at the centre");

  const values = [10, 20, 30];
  assert.deepEqual(withDelta(values, delta), [510, 20, 30]);
  assert.deepEqual(values, [10, 20, 30], "the recorded array is never mutated");
  assert.deepEqual(withDelta(values, EMPTY_DELTA), values, "no edit changes nothing");

  const { cells, peakM } = summarise(delta);
  assert.equal(cells, 1);
  assert.equal(Math.round(peakM), 500);
});

test("strokes accumulate and cancel exactly", () => {
  const pos = [[0, 1, 0]];
  const up = paintDelta(EMPTY_DELTA, pos, [0, 1, 0], 0.5, 300);
  const down = paintDelta(up, pos, [0, 1, 0], 0.5, -300);
  assert.equal(down.size, 0, "an undone edit leaves no delta, so provenance clears");
});

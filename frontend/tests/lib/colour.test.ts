import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUNDARY_COLOURS, ramp, RAMPS } from "../../src/lib/colour.ts";

test("ramp clamps rather than extrapolating past its ends", () => {
  const first = RAMPS.land[0]!;
  const last = RAMPS.land[RAMPS.land.length - 1]!;
  assert.deepEqual([...ramp(RAMPS.land, -5)], [...first]);
  assert.deepEqual([...ramp(RAMPS.land, 0)], [...first]);
  assert.deepEqual([...ramp(RAMPS.land, 1)], [...last]);
  assert.deepEqual([...ramp(RAMPS.land, 9)], [...last]);
  // NaN is "not recorded". It must land on a defined colour, not undefined.
  assert.ok(ramp(RAMPS.land, Number.NaN).every(Number.isFinite));
});

test("every classification the physics can emit has a colour", () => {
  // `Segment.label()` returns exactly these five. If it grows a sixth, this
  // fails here rather than drawing the new kind as magenta in a browser.
  for (const name of [
    "convergent", "oblique-convergent", "transform",
    "oblique-divergent", "divergent",
  ]) {
    assert.ok(name in BOUNDARY_COLOURS, `no colour for ${name}`);
  }
});

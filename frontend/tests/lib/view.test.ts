import assert from "node:assert/strict";
import { test } from "node:test";
import { INITIAL_PHI, INITIAL_PITCH, INITIAL_THETA, INITIAL_YAW } from "../../src/lib/view.ts";

test("turning the globe starts on the same face the card shows", () => {
  // The globe rotates the PLANET under a fixed camera on +Z; the catalogue disc
  // renders the hemisphere around a direction. Both must open on the same face,
  // or picking a planet out of the grid shows you somewhere else.
  const facing = [
    Math.sin(INITIAL_PHI) * Math.cos(INITIAL_THETA),
    Math.cos(INITIAL_PHI),
    Math.sin(INITIAL_PHI) * Math.sin(INITIAL_THETA),
  ];
  // Yaw about Y, then pitch about X — the order the render loop composes them.
  const ry = (v: number[], a: number) =>
    [v[0]! * Math.cos(a) + v[2]! * Math.sin(a), v[1]!, -v[0]! * Math.sin(a) + v[2]! * Math.cos(a)];
  const rx = (v: number[], a: number) =>
    [v[0]!, v[1]! * Math.cos(a) - v[2]! * Math.sin(a), v[1]! * Math.sin(a) + v[2]! * Math.cos(a)];

  const seen = rx(ry(facing, INITIAL_YAW), INITIAL_PITCH);
  assert.ok(Math.hypot(seen[0]!, seen[1]!, seen[2]! - 1) < 1e-9,
    `that face should sit at +Z, got ${seen.map(v => v.toFixed(4)).join(", ")}`);
});

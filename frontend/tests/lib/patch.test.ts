import assert from "node:assert/strict";
import { test } from "node:test";
import { boundsOf, patchFromCorners, sampleGrid, toLatLon, toVector, wrapLon } from "../../src/lib/patch.ts";

const EARTH_R = 6_371_000;

test("a dragged rectangle survives the round trip to a patch and back", () => {
  const patch = patchFromCorners([10, -20], [30, 5], EARTH_R);
  const b = boundsOf(patch, EARTH_R);
  assert.ok(Math.abs(b.minLat - 10) < 1e-6, `minLat ${b.minLat}`);
  assert.ok(Math.abs(b.maxLat - 30) < 1e-6, `maxLat ${b.maxLat}`);
  assert.ok(Math.abs(b.minLon - -20) < 1e-6, `minLon ${b.minLon}`);
  assert.ok(Math.abs(b.maxLon - 5) < 1e-6, `maxLon ${b.maxLon}`);
  const flipped = patchFromCorners([30, 5], [10, -20], EARTH_R);
  assert.deepEqual(flipped, patch, "corner order does not change the rectangle");
});

test("a drag that describes no area reports none", () => {
  // Caught while checking the heatmap: a span of exactly 360° folds to a single
  // meridian under the short-way-round rule, and a patch of zero width would
  // sample a line and draw it as a map. Callers reject a non-positive extent.
  const collapsed = patchFromCorners([-80, -180], [80, 180], EARTH_R);
  assert.equal(collapsed.widthM, 0, "the corners share a meridian");
  const still = patchFromCorners([12, 34], [12, 34], EARTH_R);
  assert.equal(still.widthM, 0);
  assert.equal(still.heightM, 0);
});

test("a drag across the antimeridian is a short patch, not a 350-degree one", () => {
  const patch = patchFromCorners([0, 175], [0, -175], EARTH_R);
  assert.ok(patch.widthM < 1.2e6, `${(patch.widthM / 1000).toFixed(0)} km wide`);
  assert.ok(Math.abs(Math.abs(patch.centreLon) - 180) < 1e-6, `centre ${patch.centreLon}`);
});

test("a patch reports how much the projection stretches it", () => {
  const equator = patchFromCorners([-5, 0], [5, 10], EARTH_R);
  const polar = patchFromCorners([60, 0], [80, 10], EARTH_R);
  assert.ok(equator.scaleError < 0.01, "plate carrée is honest at the equator");
  assert.ok(polar.scaleError > 0.4, `a polar patch says it is not: ${polar.scaleError}`);
});

test("a direction and a latitude/longitude are inverses", () => {
  for (const [lat, lon] of [[0, 0], [45, 90], [-30, -170], [89, 12]] as const) {
    const [gotLat, gotLon] = toLatLon(toVector(lat, lon));
    assert.ok(Math.abs(gotLat - lat) < 1e-6, `lat ${gotLat} vs ${lat}`);
    assert.ok(Math.abs(wrapLon(gotLon - lon)) < 1e-6, `lon ${gotLon} vs ${lon}`);
  }
});

test("the map grid takes each pixel from the nearest recorded cell", () => {
  const pos = [toVector(20, 0), toVector(-20, 0)];
  const values = [1000, -500];
  const patch = patchFromCorners([-40, -10], [40, 10], EARTH_R);
  const grid = sampleGrid(patch, EARTH_R, 5, 5, pos, values);

  // Row 0 is the NORTHERN edge: up is north, as on every map.
  assert.equal(grid[0], 1000, "top row takes the northern cell");
  assert.equal(grid[grid.length - 1], -500, "bottom row takes the southern one");
  assert.ok([...grid].every(v => v === 1000 || v === -500), "nearest cell, never a blend");
});

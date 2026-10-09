import assert from "node:assert/strict";
import { test } from "node:test";
import { ramp, RAMPS } from "../../src/lib/colour.ts";
import { icosphere } from "../../src/lib/icosphere.ts";
import { fractionOf, SIMULATIONS, stepAt, underway } from "../../src/lib/simulations.ts";

import { displayLevelFor, nearestMap, verticesAt } from "../../src/lib/nearest.ts";
import { boundsOf, patchFromCorners, sampleGrid, toLatLon, toVector, wrapLon } from "../../src/lib/patch.ts";
import { DISC_SIZE, renderDisc } from "../../src/lib/disc.ts";
import { INITIAL_PHI, INITIAL_PITCH, INITIAL_THETA, INITIAL_YAW } from "../../src/lib/view.ts";
import { EMPTY_DELTA, paintDelta, summarise, withDelta } from "../../src/lib/edits.ts";
import { BASE_LAYERS, BOUNDARY_COLOURS, BOUNDARY_ORDER } from "../../src/lib/colour.ts";
import {
  boundarySegments, cloudSites, plateArrows, sampleFrame, unavailableBecause,
} from "../../src/lib/frames.ts";
import { readFileSync } from "node:fs";
import type { Frame } from "../../src/api/types.ts";

/**
 * The three things in `lib/` that are provable rather than visual.
 *
 * Run with `npm test` — Node strips the types, so there is no test
 * framework and no build step to keep in sync.
 */

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

test("a scrub position and a step number are inverses of each other", () => {
  const total = 40;
  for (const step of [0, 1, 7, 39, 40]) {
    assert.equal(stepAt(fractionOf(step, total), total), step, `step ${step}`);
  }
  // The ends are the ends: no rounding off either edge of the tape.
  assert.equal(stepAt(0, total), 0);
  assert.equal(stepAt(1, total), total);
  assert.equal(stepAt(-3, total), 0, "a drag past the left edge clamps");
  assert.equal(stepAt(9, total), total, "and past the right edge");
});

test("a run with no reported total is not turned into one", () => {
  // Before the first status arrives the client knows no total. Inventing a
  // denominator would put a fabricated step count on screen.
  assert.equal(stepAt(0.5, 0), 0);
  assert.equal(fractionOf(12, 0), 0);
});

test("only simulations that exist are marked available", () => {
  const erosion = SIMULATIONS.find(s => s.id === "erosion-climate");
  assert.ok(erosion, "the missing simulation is still listed, so the gap shows");
  assert.equal(erosion.available, false, "nothing in a run erodes yet");
  assert.ok(SIMULATIONS.some(s => s.id === "core-surface-formation" && s.available));
});

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


/**
 * A step `PlanetBuilder` really wrote, fetched through the real endpoint.
 *
 * A golden fixture rather than a hand-built object: the point is that the
 * display path survives what the writer actually produces — the field names, the
 * declared units, and the two domains with different lengths. A drift in the run
 * format fails here rather than in a browser.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/step.json", import.meta.url), "utf8"),
) as Frame;

test("every layer either samples a real field or says why it cannot", () => {
  const { vertices } = icosphere(displayLevelFor(FIXTURE.elevation.length));
  const cache = new Map<string, Int32Array>();
  const drawn: string[] = [];

  for (const layer of BASE_LAYERS) {
    const why = unavailableBecause(layer, FIXTURE);
    if (why) {
      assert.ok(why.length > 10, `${layer.id} must say WHY, got "${why}"`);
      continue;
    }
    const s = sampleFrame(FIXTURE, layer.id, vertices, cache, null)!;
    assert.ok(s, `${layer.id} sampled`);
    assert.equal(s.values.length, vertices.length / 3, `${layer.id}: one value per vertex`);
    // The bug this guards: a display mesh larger than the cloud used to leave
    // most vertices reading past the end of the array.
    assert.ok([...s.values].every(Number.isFinite), `${layer.id}: no vertex left unfilled`);
    assert.ok(s.scale.max > s.scale.min, `${layer.id}: a scale with width`);
    assert.ok(s.units.length > 0, `${layer.id}: the run declared a unit`);
    drawn.push(layer.id);
  }

  assert.ok(drawn.includes("topo"), "topography must always be drawable");
  assert.ok(drawn.includes("temp"), "temperature comes from a different domain");
  assert.ok(drawn.includes("tempgrad"), "so does its gradient, as a magnitude");
  assert.ok(drawn.includes("plate"), "plate identity is categorical and still drawable");
  // The fixture fetches every dataset the layers draw, so a layer the run
  // records must sample here. If it does not, the frame and the layer registry
  // have drifted apart.
  assert.equal(drawn.length + 1, BASE_LAYERS.length, "bathymetry alone is refused");
});

test("a frame fetched for ONE layer still knows the others are there", () => {
  // The bug this guards: the viewer fetches only the dataset it draws, and
  // availability was judged from that same frame — so on a run that recorded
  // everything, every layer but the one on screen greyed out and the picker
  // could never leave it. `available` is what the step HOLDS; `fields` is only
  // what was asked for.
  const asTopographyOnly: Frame = {
    ...FIXTURE,
    fields: { elevation: FIXTURE.fields["elevation"]! },
  };
  for (const id of ["temp", "tempgrad", "plate", "age"] as const) {
    const layer = BASE_LAYERS.find(l => l.id === id)!;
    assert.equal(
      unavailableBecause(layer, asTopographyOnly), null,
      `${id} is recorded by this run and must stay offerable`,
    );
  }
  // And a run that genuinely lacks a field still says so.
  const withoutTemperature: Frame = {
    ...asTopographyOnly,
    available: FIXTURE.available.filter(n => n !== "temperature"),
  };
  const temp = BASE_LAYERS.find(l => l.id === "temp")!;
  assert.match(String(unavailableBecause(temp, withoutTemperature)), /did not record/);
});

test("bathymetry is refused while no run records a sea level", () => {
  const bathy = BASE_LAYERS.find(l => l.id === "bathy")!;
  assert.equal(FIXTURE.seaLevel, null, "the fixture run recorded none");
  const why = unavailableBecause(bathy, FIXTURE);
  assert.match(String(why), /sea level/, "and the reason names it");
});

test("a field is paired with the positions of its own domain", () => {
  // Temperature is one value per MESH VERTEX and elevation one per cloud cell:
  // different lengths, and pairing either with the other's positions would draw
  // a plausible planet that is wrong everywhere.
  const temp = FIXTURE.fields["temperature"]!;
  const elev = FIXTURE.fields["elevation"]!;
  assert.notEqual(temp.domain, elev.domain);
  assert.equal((temp.values as number[]).length, FIXTURE.domains[temp.domain]!.pos.length);
  assert.equal((elev.values as number[]).length, FIXTURE.domains[elev.domain]!.pos.length);
  assert.notEqual((temp.values as number[]).length, (elev.values as number[]).length);
});


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


test("a catalogue disc draws the recorded surface, and only inside the circle", () => {
  const pos = [toVector(0, 40), toVector(0, -140), toVector(80, 0), toVector(-80, 0)];
  const values = [4000, -2000, 1000, -500];
  const { width, data } = renderDisc(DISC_SIZE, pos, values);
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3]!;

  assert.equal(alpha(0, 0), 0, "the corner is outside the sphere and stays clear");
  assert.equal(alpha(width - 1, 0), 0);
  assert.ok(alpha(width >> 1, width >> 1) > 0, "the centre is on the planet");

  // Two worlds must not look alike: the same geometry with a different field
  // has to produce different pixels, or the thumbnail says nothing.
  const other = renderDisc(DISC_SIZE, pos, [-2000, 4000, -500, 1000]);
  assert.notDeepEqual([...other.data], [...data]);
});

test("a disc with nothing recorded draws nothing", () => {
  const { data } = renderDisc(DISC_SIZE, [], []);
  assert.ok([...data].every(v => v === 0), "no cloud means no surface, not a grey ball");
});


test("a vector field is drawn as a magnitude, and says so", () => {
  const { vertices } = icosphere(displayLevelFor(FIXTURE.elevation.length));
  const cache = new Map<string, Int32Array>();
  const grad = sampleFrame(FIXTURE, "tempgrad", vertices, cache, null)!;
  assert.ok(grad, "the gradient layer samples");
  assert.match(grad.longName, /magnitude/i, "the transform is named, not silent");
  assert.equal(grad.units, "K/m", "the run's own unit, unchanged by the reduction");
  assert.ok([...grad.values].every(v => Number.isFinite(v) && v >= 0), "a magnitude");

  // Against the raw rows: the transform is a length, not a component.
  const rows = FIXTURE.fields["gradient"]!.values as number[][];
  const longest = Math.max(...rows.map(r => Math.hypot(...r)));
  assert.ok(Math.abs(grad.scale.max - longest) < 1e-9, "the scale spans the real range");
});

test("hot spots stand out on the mantle temperature scale", () => {
  const { vertices } = icosphere(displayLevelFor(FIXTURE.elevation.length));
  const temp = sampleFrame(FIXTURE, "temp", vertices, new Map(), null)!;
  // A field with hot spots in it has a wide range, and the auto scale spans
  // exactly that range — so the plumes reach the top of the ramp instead of
  // sitting in a narrow band of one colour. A flat field would mean the layer
  // is showing nothing worth looking at.
  //
  // Not bounded above: plume superheat is capped at 300 K over the CURRENT deep
  // mantle temperature, which is not the same as the field's own span — the
  // mantle cools while the field relaxes toward it with a 100 Myr constant, so
  // the cold end drifts. Asserting 300 K here would be asserting a claim the
  // physics does not make (this fixture spans 312 K).
  const span = temp.scale.max - temp.scale.min;
  assert.ok(span > 50, `the field spans ${span.toFixed(0)} K`);
  assert.equal(temp.units, "K");
});


test("the cloud's own points come through unchanged, on the unit sphere", () => {
  const sites = cloudSites(FIXTURE)!;
  const cells = FIXTURE.elevation.length;
  assert.equal(sites.pos.length, cells * 3, "one position per simulated cell");
  assert.equal(sites.elevation.length, cells, "and its elevation beside it");

  // Positions are the run's own unit vectors: not renormalised, not projected.
  for (let i = 0; i < cells; i++) {
    const r = Math.hypot(sites.pos[i * 3]!, sites.pos[i * 3 + 1]!, sites.pos[i * 3 + 2]!);
    assert.ok(Math.abs(r - 1) < 1e-5, `point ${i} is on the sphere: |p| = ${r}`);
  }
  const first = FIXTURE.domains["cloud"]!.pos[0]!;
  assert.ok(Math.abs(sites.pos[0]! - first[0]!) < 1e-6, "the first point is the first point");
});

test("a frame with no cloud draws no points", () => {
  assert.equal(cloudSites(null), null);
  assert.equal(cloudSites({ ...FIXTURE, domains: {} }), null);
});


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


test("boundaries are drawn as the interface's own edges, and they join up", () => {
  const b = boundarySegments(FIXTURE)!;
  assert.ok(b, "the fixture step has boundary edges");
  assert.equal(b.pos.length, b.count * 6, "two vertices per edge");
  assert.equal(b.colour.length, b.count * 6);

  // Both ends of every edge sit on the sphere: a boundary is ON the planet.
  for (let i = 0; i < b.count * 2; i++) {
    const r = Math.hypot(b.pos[i * 3]!, b.pos[i * 3 + 1]!, b.pos[i * 3 + 2]!);
    assert.ok(Math.abs(r - 1) < 1e-5, `vertex ${i} off the sphere: ${r}`);
  }

  // The labels are the run's own words, and each one this display draws has a
  // colour of its own — no two kinds share one, or the map cannot be read.
  assert.ok(b.labels.length > 0, `labels present: ${b.labels.join(", ")}`);
  for (const name of b.labels) {
    assert.ok(name in BOUNDARY_COLOURS, `no colour for the run's label "${name}"`);
  }
  assert.deepEqual(b.unknown, [], "nothing in this run is unclassified by the viewer");
  const used = b.labels.map(n => BOUNDARY_COLOURS[n]!.join(","));
  assert.equal(new Set(used).size, used.length, "each kind has its own colour");

  // The point of using edges rather than samples: they SHARE endpoints, so what
  // is drawn is a closed curve round each plate rather than a scatter of marks.
  const ends = new Map<string, number>();
  for (let i = 0; i < b.count * 2; i++) {
    const k = [b.pos[i * 3]!, b.pos[i * 3 + 1]!, b.pos[i * 3 + 2]!]
      .map(v => v.toFixed(6)).join(",");
    ends.set(k, (ends.get(k) ?? 0) + 1);
  }
  let joined = 0;
  for (const count of ends.values()) if (count >= 2) joined += count;
  assert.ok(joined / (b.count * 2) > 0.9,
    `only ${((joined / (b.count * 2)) * 100).toFixed(0)}% of edge ends meet another edge`);
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

test("a step with no boundaries draws none", () => {
  assert.equal(boundarySegments(null), null);
  assert.equal(boundarySegments({ ...FIXTURE, fields: {} }), null);
});


test("the legend keeps one order, whatever a step happens to contain", () => {
  const b = boundarySegments(FIXTURE)!;
  // Physical order — closing, through sliding, to opening — and not by count,
  // which changes every step and would reshuffle the legend under the reader.
  const rank = (n: string) => BOUNDARY_ORDER.indexOf(n);
  for (let i = 1; i < b.labels.length; i++) {
    assert.ok(rank(b.labels[i - 1]!) < rank(b.labels[i]!),
      `${b.labels[i - 1]} should come before ${b.labels[i]}`);
  }
  // Every kind the physics can emit has a place in that order, including the
  // one it uses when a plate has no Euler vector yet.
  for (const name of Object.keys(BOUNDARY_COLOURS)) {
    assert.ok(BOUNDARY_ORDER.includes(name), `${name} has no place in the order`);
  }
});


test("a layer reports ITS OWN resolution, not the cloud's", () => {
  const { vertices } = icosphere(displayLevelFor(FIXTURE.elevation.length));
  const cache = new Map<string, Int32Array>();
  const topo = sampleFrame(FIXTURE, "topo", vertices, cache, null)!;
  const temp = sampleFrame(FIXTURE, "temp", vertices, cache, null)!;

  assert.equal(topo.domain, "cloud");
  assert.equal(temp.domain, "surface");
  assert.notEqual(temp.elements, topo.elements,
    "the thermal mesh and the point cloud are different grids");
  assert.equal(topo.elements, FIXTURE.elevation.length);
  // Reporting the cloud's count beside a temperature map would overstate what
  // that map resolves — 642 mesh vertices is not 562 simulated cells.
  assert.equal(temp.elements, (FIXTURE.fields["temperature"]!.values as number[]).length);
});

test("a field that is flat almost everywhere says so", () => {
  const { vertices } = icosphere(displayLevelFor(FIXTURE.elevation.length));
  const grad = sampleFrame(FIXTURE, "tempgrad", vertices, new Map(), null)!;
  const temp = sampleFrame(FIXTURE, "temp", vertices, new Map(), null)!;
  // |∇T| is zero wherever T is flat, which is most of a planet: the rail
  // reports the skew so a nearly black map does not read as a broken layer.
  assert.ok(grad.skew > 0.7, `gradient skew ${grad.skew.toFixed(2)} should be high`);
  assert.ok(temp.skew > 0.5, `the temperature field is flat away from plumes too`);
});

test("plateArrows draws each plate's motion at a fixed scale", () => {
  // Two plates, the second twice as fast. Positions are unit vectors and the
  // velocities are tangent to them, as the run records them.
  const frame = {
    fields: {
      "plates/velocity": {
        values: [[0, 1e-9, 0], [0, 2e-9, 0]],
        units: "m/s", kind: "vector", domain: "plates", longName: "Surface velocity",
      },
    },
    domains: { plates: { pos: [[1, 0, 0], [1, 0, 0]] } },
  } as unknown as Frame;

  const a = plateArrows(frame)!;
  assert.ok(a, "two moving plates must produce arrows");
  assert.equal(a.plates, 2);
  assert.equal(a.count, 6, "three segments per plate: a shaft and two barbs");

  // The shafts are segments 0 and 3. Twice the speed must draw twice the arrow,
  // because the scale is fixed rather than fitted to the frame.
  const shaft = (i: number) => {
    const k = i * 6;
    return Math.hypot(
      a.pos[k + 3]! - a.pos[k]!, a.pos[k + 4]! - a.pos[k + 1]!,
      a.pos[k + 5]! - a.pos[k + 2]!,
    );
  };
  assert.ok(Math.abs(shaft(3) / shaft(0) - 2) < 1e-6,
    "arrow length must be proportional to speed");

  // And the same speed must draw the same length in a frame where it is now the
  // SLOWEST plate -- the property a per-frame rescale would destroy.
  const faster = {
    fields: {
      "plates/velocity": {
        values: [[0, 1e-9, 0], [0, 9e-9, 0]],
        units: "m/s", kind: "vector", domain: "plates", longName: "Surface velocity",
      },
    },
    domains: { plates: { pos: [[1, 0, 0], [1, 0, 0]] } },
  } as unknown as Frame;
  const b = plateArrows(faster)!;
  const shaftB = Math.hypot(
    b.pos[3]! - b.pos[0]!, b.pos[4]! - b.pos[1]!, b.pos[5]! - b.pos[2]!,
  );
  assert.ok(Math.abs(shaftB - shaft(0)) < 1e-12,
    "an unchanged plate must draw an unchanged arrow when a faster one appears");
});

test("plateArrows reports absence rather than drawing a still planet", () => {
  const nothing = { fields: {}, domains: {} } as unknown as Frame;
  assert.equal(plateArrows(nothing), null);

  // A plate at rest gets no arrow: a zero-length one is indistinguishable from
  // a slow plate pointing straight at the camera.
  const still = {
    fields: {
      "plates/velocity": {
        values: [[0, 0, 0]],
        units: "m/s", kind: "vector", domain: "plates", longName: "Surface velocity",
      },
    },
    domains: { plates: { pos: [[1, 0, 0]] } },
  } as unknown as Frame;
  assert.equal(plateArrows(still), null);
});

test("a run can only be stopped while it is actually going", () => {
  // The button appears for these, and nothing else. A control that is present
  // but disabled most of the time reads as a feature that is usually broken.
  assert.equal(underway({ state: "running", stage: "evolving", progress: 0.5, step: 5, stepsTotal: 10 }), true);
  assert.equal(underway({ state: "queued", position: 1, stepsTotal: 10 }), true);

  assert.equal(underway({ state: "complete", elapsedSeconds: 1, stepsTotal: 10 }), false);
  assert.equal(underway({ state: "failed", code: "exit_1", stepsTotal: 10 }), false);
  assert.equal(underway({ state: "cancelled", step: 5, stepsTotal: 10 }), false,
    "an already-stopped run has nothing left to stop");
  assert.equal(underway(null), false, "a run with no status yet cannot be stopped");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { Frame } from "../../src/api/types.ts";
import { BASE_LAYERS, BOUNDARY_COLOURS, BOUNDARY_ORDER } from "../../src/lib/colour.ts";
import { icosphere } from "../../src/lib/icosphere.ts";
import { displayLevelFor } from "../../src/lib/nearest.ts";
import {
  boundarySegments, cloudSites, plateArrows, sampleFrame, unavailableBecause,
} from "../../src/lib/frames.ts";

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

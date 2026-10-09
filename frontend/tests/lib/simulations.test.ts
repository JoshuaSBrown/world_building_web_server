import assert from "node:assert/strict";
import { test } from "node:test";
import { fractionOf, SIMULATIONS, stepAt, underway } from "../../src/lib/simulations.ts";

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

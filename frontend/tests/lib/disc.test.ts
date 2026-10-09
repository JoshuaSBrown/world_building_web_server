import assert from "node:assert/strict";
import { test } from "node:test";
import { DISC_SIZE, renderDisc } from "../../src/lib/disc.ts";
import { toVector } from "../../src/lib/patch.ts";

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

import type { PatchSpec } from "../api/types";
import { fmt } from "../lib/colour";
import { Row } from "./ui";

/**
 * The export region.
 *
 * Drawn by dragging on the globe, then adjusted numerically. The numbers edited
 * here are the *spec* — centre and extent — and `lib/patch.ts` turns them into
 * the outline on the globe and the grid the map view samples, so the rectangle
 * you see is exactly the one that gets projected.
 *
 * Bearing is not editable: a rotated patch is not something a corner-to-corner
 * drag expresses, and the sampler projects an axis-aligned rectangle. A control
 * that set a number nothing honoured would be the failure this repo is
 * organised against.
 */
export function RegionControls(props: {
  armed: boolean;
  patch: PatchSpec | null;
  simCellM: number;
  onArm: (armed: boolean) => void;
  onPatchChange: (p: PatchSpec) => void;
  onOpenMap: () => void;
  onClear: () => void;
}) {
  const p = props.patch;
  const edit = (k: "widthM" | "heightM", v: number) => {
    if (p && Number.isFinite(v) && v > 0) props.onPatchChange({ ...p, [k]: v });
  };

  return (
    <>
      <div className="rule" />
      <h4>Region</h4>
      <button
        className={props.armed ? "btn btn--armed btn--block" : "btn btn--block"}
        aria-pressed={props.armed}
        onClick={() => props.onArm(!props.armed)}
      >
        {props.armed ? "Drag on the globe…" : "Draw region"}
      </button>

      {p ? (
        <>
          <div className="numrow">
            <input
              type="text" aria-label="Width in kilometres"
              value={(p.widthM / 1000).toFixed(0)}
              onChange={e => edit("widthM", Number(e.currentTarget.value) * 1000)}
            />
            <input
              type="text" aria-label="Height in kilometres"
              value={(p.heightM / 1000).toFixed(0)}
              onChange={e => edit("heightM", Number(e.currentTarget.value) * 1000)}
            />
          </div>
          <div className="ramp__labels"><span>km wide</span><span>km tall</span></div>

          <Row
            label="Simulated cells across"
            value={`≈ ${fmt(p.widthM / props.simCellM, 1)}`}
          />
          <p className="note">
            Anything finer than {(props.simCellM / 1000).toFixed(0)} km was never
            simulated. Plate carrée: east–west scale varies by{" "}
            {(p.scaleError * 100).toFixed(1)} % across this patch.
          </p>

          <button className="btn btn--block" style={{ marginTop: 8 }} onClick={props.onOpenMap}>
            Open map view
          </button>
          <button className="btn btn--block" style={{ marginTop: 6 }} onClick={props.onClear}>
            Clear region
          </button>
        </>
      ) : (
        <p className="note">No region drawn.</p>
      )}
    </>
  );
}

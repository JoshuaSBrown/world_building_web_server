import { fmt } from "../lib/colour";
import { Slider } from "./ui";

/**
 * The terrain brush.
 *
 * Editing is **art**, and this panel says so rather than letting it pass for a
 * result. `docs/09-planet-timelines.md` calls a terrain edit "the one sanctioned
 * entry of art direction": a recorded delta, stored verbatim, applied by the
 * engine at the start of the next segment, and flipping the planet's provenance
 * to `contains manual edits` for good.
 *
 * The provenance consequence is not repeated here in prose — the info panel
 * carries it as a state ("contains manual edits"), which is where a reader looks
 * for what a planet is rather than at the tool that made it.
 *
 * Two things this panel deliberately does not do:
 *
 * * **It does not recompute anything.** Moving the surface makes temperature,
 *   plates and crust age stale, and deriving new ones in the browser is exactly
 *   the invention this repo is organised against. They stay locked until a
 *   recalculation the engine performs.
 * * **It does not pretend the edit has landed.** Nothing downstream can apply
 *   one yet, and the button says that plainly instead of appearing to work.
 */
export function EditPanel(props: {
  open: boolean;
  brush: { radiusDeg: number; strengthM: number; lower: boolean };
  onBrush: (b: { radiusDeg: number; strengthM: number; lower: boolean }) => void;
  cells: number;
  peakM: number;
  onClear: () => void;
  onRecalculate: () => void;
}) {
  const b = props.brush;
  return (
    <aside className="panel rail" data-open={props.open}>
      <h4>Terrain brush</h4>
      <div role="radiogroup" aria-label="Brush direction">
        {([false, true] as const).map(lower => (
          <button
            key={String(lower)}
            className="layer"
            role="radio"
            aria-checked={b.lower === lower}
            data-on={b.lower === lower}
            onClick={() => props.onBrush({ ...b, lower })}
          >
            <span className="layer__key" />
            {lower ? "Lower" : "Raise"}
          </button>
        ))}
      </div>

      <Slider
        label="Brush radius" min={2} max={30} step={1}
        value={b.radiusDeg} display={`${b.radiusDeg}°`}
        about="Angular radius on the sphere. Cells inside it move, most at the centre."
        onChange={v => props.onBrush({ ...b, radiusDeg: v })}
      />
      <Slider
        label="Strength" min={50} max={3000} step={50}
        value={b.strengthM} display={`${fmt(b.strengthM)} m per stroke`}
        about="Metres added to the recorded elevation of a cell at the centre of the brush."
        onChange={v => props.onBrush({ ...b, strengthM: v })}
      />

      <div className="rule" />
      <h4>This edit</h4>
      <p className="note">
        {props.cells === 0
          ? "Nothing edited. Click the globe to raise or lower the surface."
          : `${props.cells} cell${props.cells === 1 ? "" : "s"} moved · largest change ${
              props.peakM > 0 ? "+" : ""}${fmt(props.peakM)} m`}
      </p>
      <p className="note">
        Only topography can be edited, and while an edit is pending every other
        layer is stale: they describe the surface before it moved.
      </p>

      <button className="btn btn--block" disabled={props.cells === 0} onClick={props.onClear}>
        Discard edit
      </button>
      <button
        className="btn btn--primary btn--block"
        style={{ marginTop: 8 }}
        disabled={props.cells === 0}
        onClick={props.onRecalculate}
      >
        Recalculate from here
      </button>
    </aside>
  );
}

import {
  BASE_LAYERS, BOUNDARY_COLOURS, BOUNDARY_UNKNOWN, OVERLAYS, fmt, rampCss,
  type BaseLayerId, type OverlayId,
} from "../lib/colour";

/** An RGB triple as CSS, for a legend swatch. */
function cssColour(c: readonly [number, number, number]): string {
  return `rgb(${c.map(v => Math.round(v * 255)).join(" ")})`;
}
import { ARROW_RADII_PER_CM_YR, type Scale } from "../lib/frames";

/** The legend's reference speed, and how long that is on screen. */
const ARROW_LEGEND_CM_YR = 5;
const ARROW_LEGEND_PX = `${Math.round(ARROW_LEGEND_CM_YR * ARROW_RADII_PER_CM_YR * 260)}px`;
import { Slider } from "./ui";

/** A limit of the scale, with the unit the run declared for it. */
function fmtValue(v: number, units: string): string {
  const digits = Math.abs(v) >= 100 || v === 0 ? 0 : 2;
  const shown = Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-2)
    ? v.toExponential(2)
    : fmt(v, digits);
  // `""` means the run declared no unit. Reported, never guessed at.
  return units ? `${shown} ${units}` : `${shown} (no unit declared)`;
}

/**
 * Layer controls.
 *
 * Base layers are a radio group and overlays are checkboxes: water is a
 * cut through the elevation field, not a peer of topography, and the
 * control shape says so before any caption does.
 *
 * The active layer's scale is always on screen — the ramp, its two ends in real
 * units, and the dataset the numbers came from. That is data about what is being
 * drawn, so it stays visible.
 *
 * What a layer *means* is a tooltip on the layer itself. It was a paragraph
 * under the ramp, which put a description of one control in the space of
 * another and pushed the presentation sliders off the panel.
 */
export function LayerRail(props: {
  open: boolean;
  baseLayer: BaseLayerId;
  overlays: Record<OverlayId, boolean>;
  exaggeration: number;
  seaOffsetM: number;
  /** The colour range in effect for the active layer, from the frame on screen. */
  scale: Scale | null;
  /** Elements of the active layer's own domain, and its name. */
  cells: number | null;
  domain: string | null;
  /** Share of the field in the bottom twentieth of its own range, or null. */
  skew: number | null;
  /** Vertices of the display mesh — a drawing choice, sized to the run. */
  meshVertices: number;
  lighting: "sun" | "flat";
  onLighting: (mode: "sun" | "flat") => void;
  /** Which boundary kinds this step contains, most common first. */
  boundaryLabels: string[] | null;
  /** Kinds the physics emitted that this display has no colour for. */
  boundaryUnknown: string[];
  /** True while the active layer's data has not arrived. */
  pending: boolean;
  /** What the plate-motion arrows show this step, or null if the run has none. */
  motion: { fastest: number; plates: number } | null;
  /** Why each layer cannot be picked, keyed by id. Absent means it can. */
  unavailable: Partial<Record<BaseLayerId, string>>;
  onBaseLayer: (id: BaseLayerId) => void;
  onToggleOverlay: (id: OverlayId) => void;
  onExaggeration: (v: number) => void;
  onSeaOffset: (v: number) => void;
  onHoldScale?: () => void;
  children?: React.ReactNode;
}) {
  const active = BASE_LAYERS.find(l => l.id === props.baseLayer);

  return (
    <aside className="panel rail" data-open={props.open}>
      <h4>Base layer</h4>
      <div role="radiogroup" aria-label="Base layer">
        {BASE_LAYERS.map(l => (
          <button
            key={l.id}
            className="layer"
            role="radio"
            aria-checked={props.baseLayer === l.id}
            data-on={props.baseLayer === l.id}
            // A layer with no data behind it is offered greyed out rather than
            // hidden or drawn from nothing. Greyed out is the message; the
            // reason is in the tooltip, where it costs the panel no space.
            disabled={props.unavailable[l.id] !== undefined}
            // What the layer means lives here rather than in a paragraph under
            // the ramp: the rail is a set of controls, and the description of a
            // control belongs to the control. The blocking reason is appended
            // rather than replacing it — a disabled layer still has a meaning.
            title={props.unavailable[l.id]
              ? `${l.blurb} — ${props.unavailable[l.id]}`
              : l.blurb}
            onClick={() => props.onBaseLayer(l.id)}
          >
            <span className="layer__key" />
            {l.name}
          </button>
        ))}
      </div>

      {active && props.pending ? (
        <p className="note note--warn">
          Fetching <code>{active.dataset}</code> for this step — the globe is
          still showing the previous layer.
        </p>
      ) : null}

      {active ? (
        <>
          <div className="ramp" style={{ background: rampCss(active.id), marginTop: 10 }} />
          <div className="ramp__labels">
            {props.scale && active.kind !== "category"
              ? <>
                  <span>{fmtValue(props.scale.min, props.scale.units)}</span>
                  <span>{fmtValue(props.scale.max, props.scale.units)}</span>
                </>
              : <span>categorical — colour is a label, not a scale</span>}
          </div>
          <p className="note">
            Scale: {props.scale ? props.scale.mode : "—"}
            {props.scale && props.scale.mode === "held" ? " (frozen across frames)" : ""}
            {" · dataset "}<code>{active.dataset}</code>
            {props.cells !== null
              ? ` · ${props.cells} ${props.domain ?? ""} elements`.trimEnd()
              : ""}
            {` · drawn on ${fmt(props.meshVertices)} mesh vertices`}
          </p>
          {props.skew !== null && props.skew > 0.7 ? (
            <p className="note">
              {(props.skew * 100).toFixed(0)} % of this field sits in the bottom
              twentieth of the range, so most of the planet is at one end of the
              ramp and only the extremes show. That is the field, not the scale:
              a gradient is zero wherever its field is flat.
            </p>
          ) : null}

          {/* The mesh is sized to the run, but it has a ceiling. Past it a cell
              gets too few vertices to draw a clean edge, and the picture starts
              under-reporting the resolution the physics had. Stated, like every
              other display choice, rather than left to look like the data. */}
          {props.cells !== null && props.cells > 0
            && props.meshVertices / props.cells < 8 ? (
            <p className="note note--warn">
              The display mesh is coarser than this run:{" "}
              {(props.meshVertices / props.cells).toFixed(1)} vertices per cell.
              Cell edges are approximate — the simulation is finer than the
              picture, not the other way round.
            </p>
          ) : null}

          {props.onHoldScale ? (
            <button className="btn btn--block" onClick={props.onHoldScale}>
              {props.scale?.mode === "held" ? "Rescale to this step" : "Hold this scale"}
            </button>
          ) : null}
        </>
      ) : null}

      <div className="rule" />
      <h4>Overlays</h4>
      {props.overlays.boundaries && props.boundaryLabels ? (
        <>
          {/* The colours stand for words the SIMULATION chose. `Segment.label()`
              classifies a segment from its own normal and tangential
              velocities; nothing here decides what a boundary is. */}
          {props.boundaryLabels.map(name => (
            <div className="legend" key={name}>
              <span
                className="legend__key"
                style={{ background: cssColour(BOUNDARY_COLOURS[name] ?? BOUNDARY_UNKNOWN) }}
              />
              {name}
            </div>
          ))}
          {props.boundaryUnknown.length > 0 ? (
            <p className="note note--warn">
              This run classified segments this viewer has no colour for:{" "}
              {props.boundaryUnknown.join(", ")}. They are drawn magenta rather
              than dressed up as one of the kinds above.
            </p>
          ) : null}
          <p className="note">
            Warm where crust is destroyed, cool where it is made, yellow where
            plates slide past. The classification is the run's, from each
            segment's own velocities.
          </p>
        </>
      ) : null}

      {OVERLAYS.map(o => (
        <button
          key={o.id}
          className="layer layer--check"
          role="checkbox"
          aria-checked={props.overlays[o.id]}
          data-on={props.overlays[o.id]}
          title={o.blurb}
          onClick={() => props.onToggleOverlay(o.id)}
        >
          <span className="layer__key" />
          {o.name}
        </button>
      ))}

      {/* The arrows are drawn at a FIXED length per unit speed, so the scale is
          a fact about the picture and belongs on screen beside it. Without it an
          arrow is a direction and nothing more, and a reader has no way to tell
          a fast plate from a slow one. */}
      {props.overlays.motion ? (
        props.motion ? (
          <div className="scalebar">
            <div className="scalebar__bar" style={{ width: ARROW_LEGEND_PX }} />
            <span>= {fmt(ARROW_LEGEND_CM_YR)} cm/yr</span>
            <p className="note">
              One arrow per plate, from the middle of it, pointing the way it is
              sliding. Length is speed at a fixed scale — the same in every step,
              so a plate that speeds up draws a longer arrow instead of the
              picture rescaling. Fastest here: {fmt(props.motion.fastest, 2)} cm/yr
              across {props.motion.plates} plate{props.motion.plates === 1 ? "" : "s"}.
            </p>
          </div>
        ) : (
          <p className="note note--warn">
            This step records no plate motion — runs written before the format
            carried a velocity per plate have none, and it is reported rather
            than drawn as still.
          </p>
        )
      ) : null}

      <div className="rule" />
      <h4>Presentation</h4>
      <div role="radiogroup" aria-label="Lighting">
        {([["sun", "Sunlit"], ["flat", "Flat"]] as const).map(([mode, name]) => (
          <button
            key={mode}
            className="layer"
            role="radio"
            aria-checked={props.lighting === mode}
            data-on={props.lighting === mode}
            title={mode === "sun"
              ? "A fixed lamp behind the viewer. The planet turns under it, so the face you are looking at is always lit — relief reads, but shading multiplies every colour."
              : "Even light. A colour on screen is the recorded value with nothing applied on top; relief goes flat, and the exaggeration slider does nothing for the eye."}
            onClick={() => props.onLighting(mode)}
          >
            <span className="layer__key" />
            {name}
          </button>
        ))}
      </div>
      <Slider
        label="Relief exaggeration" min={0} max={60}
        value={props.exaggeration}
        display={props.exaggeration === 0 ? "true scale" : `×${(props.exaggeration / 6).toFixed(1)}`}
        hint="Radial only, and only on screen. At true scale Earth's whole relief is thinner than the line drawn around this planet."
        onChange={props.onExaggeration}
      />
      <Slider
        label="Sea level offset" min={-2000} max={2000} step={50}
        value={props.seaOffsetM}
        display={`${props.seaOffsetM >= 0 ? "+" : ""}${props.seaOffsetM} m`}
        hint="Re-cuts the coastline through the same solved topography. It does not re-run anything."
        onChange={props.onSeaOffset}
      />

      {props.children}
    </aside>
  );
}

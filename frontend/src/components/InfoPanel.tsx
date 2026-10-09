import type { PlanetSummary } from "../api/types";
import { fmt } from "../lib/colour";
import { Row } from "./ui";

/**
 * One cell, as picked on the globe.
 *
 * Elevation plus **the layer being looked at**, rather than a fixed list of
 * quantities: the panel used to name plate, crust type, crust age and
 * temperature whether the run had recorded them or not. What it shows now is
 * what the frame on screen actually carries, in the units the run declared, and
 * it names the dataset the number came from so a reading can be traced back to
 * an array.
 */
export interface CellSample {
  latitude: number;
  longitude: number;
  /** Metres, from `cloud/elevation` of the step on screen. */
  elevationM: number;
  /** The active layer's `long_name`, as the run file states it. */
  layerName: string;
  layerValue: number;
  /** The run's own unit for it; empty means the run declared none. */
  layerUnits: string;
  /** The dataset in the run file this layer draws. */
  dataset: string;
  step: number;
}

/**
 * Planet stats and the picked-cell readout.
 *
 * A quantity the run has not produced reads "not recorded". It never
 * reads zero — zero is a measurement, and the difference between "the sea
 * is at 0 m" and "there is no sea level yet" is the whole point.
 */
export function InfoPanel(props: {
  open: boolean;
  planet: PlanetSummary;
  sample: CellSample | null;
  /** True once a manual edit is pending. Provenance, not decoration. */
  edited: boolean;
}) {
  const d = props.planet.derived;
  const p = props.planet.params;

  return (
    <aside className="panel info" data-open={props.open}>
      <h3 className="pname">{p.name}</h3>
      <p className="eyebrow" style={{ marginTop: 4 }}>seed {p.seed}</p>

      <div className="rule" />
      <h4>Body</h4>
      <Row label="Diameter" value={`${fmt(p.diameterM / 1000)} km`} />
      <Row label="Surface gravity" value={`${d.surfaceGravity.toFixed(2)} m/s²`} />
      <Row label="Simulated cell" value={`${fmt(d.simCellM / 1000)} km`} />

      {/* Physics-pure is the normal case and says nothing worth the space: every
          other panel already shows values that came out of the run. An EDIT is
          the exception, and it is never silent -- a planet carrying one is
          labelled from then on (docs/09, REQ-P04). */}
      {props.edited ? (
        <>
          <div className="rule" />
          <p className="note note--warn">
            Contains manual edits: art applied on top of the recorded surface,
            not a result. Every other layer is stale until a recalculation.
          </p>
        </>
      ) : null}

      <div className="rule" />
      <h4>Picked cell</h4>
      {props.sample ? (
        <>
          <Row label="Position" value={latLon(props.sample)} />
          <Row label="Step" value={`#${props.sample.step}`} />
          <Row label="Elevation" value={value(props.sample.elevationM, "m")} />
          <Row
            label={props.sample.layerName || props.sample.dataset}
            value={value(props.sample.layerValue, props.sample.layerUnits)}
          />
          <p className="note">
            From <code>{props.sample.dataset}</code> of step {props.sample.step}.
          </p>
        </>
      ) : (
        <p className="note">Tap the globe to read a cell.</p>
      )}
    </aside>
  );
}

const notRecorded = <span style={{ opacity: 0.55 }}>not recorded</span>;

/** A number in the unit the RUN declared. An absent unit is said, not guessed. */
function value(v: number, units: string) {
  if (!Number.isFinite(v)) return notRecorded;
  const shown = Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-2)
    ? v.toExponential(3)
    : fmt(v, Math.abs(v) >= 100 ? 0 : 2);
  return units ? `${shown} ${units}` : `${shown} (no unit declared)`;
}

function latLon(s: CellSample) {
  return `${Math.abs(s.latitude).toFixed(2)}°${s.latitude >= 0 ? "N" : "S"} ` +
    `${Math.abs(s.longitude).toFixed(2)}°${s.longitude >= 0 ? "E" : "W"}`;
}

import { useMemo, useState } from "react";
import type { PlanetParams } from "../api/types";
import { fmt } from "../lib/colour";
import { Row, Slider, TextField } from "./ui";

const DEFAULTS: PlanetParams = {
  name: "Vesper",
  seed: "0x5F3A21",
  diameterM: 12_742_000,
  startMantleTemperatureK: 1780,
  ageGyr: 4.54,
  waterGelM: 2700,
  maxPoints: 500,
};

/**
 * Creation form.
 *
 * The layout enforces a rule: everything on the LEFT is an input the
 * simulation consumes; everything on the RIGHT is derived and read-only.
 * Showing consequences as outputs, updating live as they drag, teaches
 * the model better than a tooltip would.
 */
export function CreatePlanet(props: {
  initial?: PlanetParams;
  submitting: boolean;
  serverErrors: string[];
  onSubmit: (p: PlanetParams) => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState<PlanetParams>(props.initial ?? DEFAULTS);
  const set = <K extends keyof PlanetParams>(k: K, v: PlanetParams[K]) =>
    setP(prev => ({ ...prev, [k]: v }));

  const derived = useMemo(() => {
    const r = p.diameterM / 2;
    const area = 4 * Math.PI * r * r;
    return {
      area,
      simCellKm: Math.sqrt(area / p.maxPoints) / 1000,
    };
  }, [p]);

  /**
   * Physical consequences the user should see BEFORE spending compute.
   * Deliberately consequences, not validation: these are all legal
   * planets, they just will not produce what the user probably wants.
   */
  const advisory = useMemo(() => {
    if (p.startMantleTemperatureK < 1450 && p.ageGyr > 3) return "This mantle starts cool enough for a stagnant lid. Relief will come from impacts and volcanism, not plate boundaries.";
    if (p.waterGelM > 7000) return "This much water drowns any plausible relief. Expect a global ocean with no land.";
    return null;
  }, [p]);

  return (
    <div className="create">
      <h1 className="pname">New body</h1>
      <p className="create__lede">
        These are the initial conditions for <b>core &amp; surface formation</b> —
        the one simulation there is today. Relief, coastlines and plate count are
        derived by it and cannot be set directly. Erosion and climate are a
        separate simulation and are not run at all yet.
      </p>

      <div className="create__cols">
        <div>
          <fieldset>
            <legend>Identity</legend>
            <TextField label="Name" value={p.name} onChange={v => set("name", v)} />
            <TextField
              label="Seed"
              value={p.seed}
              onChange={v => set("seed", v)}
              hint="The same seed and parameters always produce the same body."
              action={
                <button
                  type="button"
                  className="field__value"
                  onClick={() => set("seed", "0x" + Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, "0"))}
                >
                  reroll ↻
                </button>
              }
            />
          </fieldset>

          <fieldset>
            <legend>Bulk properties</legend>
            <Slider
              label="Diameter" min={3_000_000} max={24_000_000} step={100_000}
              value={p.diameterM} display={`${fmt(p.diameterM / 1000)} km`}
              onChange={v => set("diameterM", v)}
            />
          </fieldset>

          <fieldset>
            <legend>Thermal state</legend>
            <Slider
              label="Starting mantle temperature" min={1300} max={2400} step={10}
              value={p.startMantleTemperatureK} display={`${fmt(p.startMantleTemperatureK)} K`}
              hint="Where the mantle begins, straight out of the magma ocean. Hotter → thinner, weaker lid → more, smaller plates and faster early overturn. The temperature it cools to is a result of the run and cannot be set."
              onChange={v => set("startMantleTemperatureK", v)}
            />
            <Slider
              label="Simulated age" min={0.2} max={9} step={0.02}
              value={p.ageGyr} display={`${p.ageGyr.toFixed(2)} Gyr`}
              onChange={v => set("ageGyr", v)}
            />
          </fieldset>

          <fieldset>
            <legend>Volatiles</legend>
            <Slider
              label="Water inventory" min={0} max={9000} step={50}
              value={p.waterGelM} display={`${fmt(p.waterGelM)} m GEL`}
              hint="Global equivalent layer: the ocean depth on a perfectly smooth body. Sea level is solved from this and the finished hypsometry, and can be re-cut afterwards without re-running."
              onChange={v => set("waterGelM", v)}
            />
          </fieldset>

          <fieldset>
            <legend>Run</legend>
            <Slider
              label="Maximum points" min={100} max={10_000} step={100}
              value={p.maxPoints}
              display={`${fmt(p.maxPoints)} points`}
              hint={`The surface is a point cloud; this caps its size and so the accuracy of the run. Points are about ${derived.simCellKm.toFixed(0)} km apart. Nothing smaller than that is simulated.`}
              onChange={v => set("maxPoints", v)}
            />
          </fieldset>
        </div>

        <aside className="derived">
          <h4>Derived</h4>
          <div className="rule" />
          <Row label="Surface area" value={`${fmt(derived.area / 1e12, 1)} M km²`} />
          <Row label="Point spacing" value={`${derived.simCellKm.toFixed(0)} km`} />
          <p className="note">
            Closed-form consequences of the inputs — surface area from the
            diameter, point spacing from area and point count. Plate count,
            relief and runtime are results of the run and are not predicted
            here.
          </p>

          {advisory ? <p className="note note--warn">{advisory}</p> : null}

          {props.serverErrors.length > 0 ? (
            <ul className="note note--block" style={{ paddingLeft: 14 }}>
              {props.serverErrors.map(e => <li key={e}>{e}</li>)}
            </ul>
          ) : null}

          <button
            className="btn btn--primary btn--block"
            style={{ marginTop: 16 }}
            disabled={props.submitting}
            onClick={() => props.onSubmit(p)}
          >
            {props.submitting ? "Queueing…" : "Run simulation"}
          </button>
          <button
            className="btn btn--block"
            style={{ marginTop: 8 }}
            onClick={props.onCancel}
          >
            Back to catalogue
          </button>
        </aside>
      </div>
    </div>
  );
}

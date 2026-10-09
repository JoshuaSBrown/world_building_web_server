import type { PlanetSummary } from "../api/types";
import { fmt } from "../lib/colour";
import { PlanetDisc } from "./PlanetDisc";

/**
 * Saved worlds.
 *
 * The disc on each card is the body's own recorded surface, drawn from the last
 * step of its run with the viewer's colours and viewpoint — so the card is a
 * picture of what opens. It was a grey gradient labelled "placeholder shading":
 * honest, and useless, since two worlds looked identical.
 */
export function Catalogue(props: {
  planets: PlanetSummary[];
  loading: boolean;
  error: string | null;
  onOpen: (p: PlanetSummary) => void;
  onNew: () => void;
}) {
  return (
    <div className="catalogue">
      <div className="catalogue__head">
        <h1>Bodies</h1>
        <p>
          Each one is a physics run: initial conditions in, a planet out. Nothing
          about the surface is drawn by hand.
        </p>
      </div>

      <div className="catalogue__bar">
        <span className="eyebrow">
          {props.loading ? "reading" : `${props.planets.length} recorded`}
        </span>
        <div className="spacer" />
        <button className="btn" onClick={props.onNew}>New body</button>
      </div>

      {props.error ? (
        <p className="note note--block" role="alert">
          {props.error} No bodies are listed — the catalogue is unknown, not empty.
        </p>
      ) : null}

      <div className="grid">
        {props.planets.map(p => (
          <button key={p.id} className="card" onClick={() => props.onOpen(p)}>
            <PlanetDisc jobId={p.jobId} name={p.params.name} />
            <h3>{p.params.name}</h3>
            <div className="card__meta">
              <span>Diameter</span><b>{fmt(p.params.diameterM / 1000)} km</b>
              <span>Age</span><b>{p.params.ageGyr.toFixed(2)} Gyr</b>
              <span>Points</span><b>{fmt(p.derived.cells)}</b>
              <span>Seed</span><b>{p.params.seed}</b>
            </div>
          </button>
        ))}

        <button className="card card--new" onClick={props.onNew}>
          <span style={{ fontSize: 26, lineHeight: 1 }}>+</span>
          <span className="eyebrow">New body</span>
        </button>
      </div>
    </div>
  );
}

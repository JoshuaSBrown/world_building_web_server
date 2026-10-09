import { useState } from "react";
import type { JobStatus, PlanetSummary, RunSettings } from "../api/types";
import { SIMULATIONS, underway, type Simulation } from "../lib/simulations";
import { fmt } from "../lib/colour";
import { Slider } from "./ui";

/**
 * What has been run for this planet, and what can be run next.
 *
 * The page exists because a planet is not one simulation. Core & surface
 * formation produces the state later simulations consume, so the list is a
 * dependency graph, and **an entry is offered only when what it needs actually
 * exists**. "Exists" means a finished run on disk, not an assumption: the
 * planet's own run list says which simulations it has been through, and the
 * job's status says whether the last one finished.
 *
 * A blocked entry says what is missing rather than going quietly grey — a
 * control that cannot be pressed and does not say why is a worse answer than no
 * control at all.
 *
 * **The numbers are filled in here, per run.** Point count, run length, step
 * size and checkpoint cadence are class (b) — resolutions and cadences — and
 * they belong to the run, not to the body: the same planet can be evolved
 * coarsely to see the shape of it and finely to trust the detail. The body's own
 * givens (diameter, seed, starting temperature) stay fixed, because a planet
 * that changed those between runs would not be one planet.
 *
 * So the settings sit **inside the simulation they configure**, beside the
 * button that acts on them, and only where that button can be pressed. They used
 * to live in the side card next to the body's givens, which read as a property
 * of the page — putting a per-run choice and an unchangeable given in one panel
 * says they are the same kind of thing, and they are not.
 */
export interface RunState {
  /** Runs recorded against this planet, newest last. */
  jobId: string | null;
  status: JobStatus | null;
}

/** Whether a simulation's inputs are on disk, and why not when they are not. */
export function blockedBecause(
  sim: Simulation,
  planet: PlanetSummary,
  statuses: Record<string, JobStatus | null>,
): string | null {
  if (!sim.available) {
    return "not built yet — no engine runs this";
  }
  for (const needed of sim.requires) {
    const run = [...(planet.runs ?? [])].reverse().find(r => r.kind === needed);
    const name = SIMULATIONS.find(s => s.id === needed)?.name ?? needed;
    if (!run) return `needs ${name}, which has not been run for this planet`;
    const status = statuses[run.jobId];
    if (!status) return `needs ${name}; its run has not reported yet`;
    if (status.state !== "complete") {
      return `needs ${name} to finish — it is ${status.state}`;
    }
  }
  return null;
}

export function Simulations(props: {
  planet: PlanetSummary;
  /** Status of each run this planet has, by job id. */
  statuses: Record<string, JobStatus | null>;
  /** What a run starts with unless this form says otherwise. */
  defaults: RunSettings | null;
  starting: string | null;
  error: string | null;
  onRun: (kind: string, settings: RunSettings) => void;
  /** Stop a run that is under way. What it has already recorded is kept. */
  onStop: (jobId: string) => void;
  /** The job a stop has been asked for and not yet acknowledged. */
  stopping: string | null;
  onOpenViewer: (jobId: string) => void;
  onBack: () => void;
}) {
  const p = props.planet;
  const runs = p.runs ?? [];

  // The form starts from what this body was last run with, else the server's
  // defaults, else the point count it was created with. Never a number this
  // file invented: a form showing a default the server does not use is a lie
  // that only shows up in the results.
  const last = [...runs].reverse().find(r => r.settings)?.settings;
  const initial: RunSettings = last ?? {
    nPoints: p.params.maxPoints,
    steps: props.defaults?.steps ?? 0,
    dtMyr: props.defaults?.dtMyr ?? 0,
    checkpointEverySteps: props.defaults?.checkpointEverySteps ?? 0,
  };
  const [settings, setSettings] = useState<RunSettings>(initial);
  const set = <K extends keyof RunSettings>(k: K, v: RunSettings[K]) =>
    setSettings(prev => ({ ...prev, [k]: v }));
  const ready = props.defaults !== null || last !== undefined;

  return (
    <div className="create">
      <h1 className="pname">{p.params.name}</h1>
      <p className="create__lede">
        Simulations for this body. Each one reads what the ones before it wrote,
        so an entry stays out of reach until its inputs exist — and says what it
        is waiting for.
      </p>

      <div className="create__cols">
        <div>
          {SIMULATIONS.map(sim => {
            const blocked = blockedBecause(sim, p, props.statuses);
            const mine = runs.filter(r => r.kind === sim.id);
            const latest = mine[mine.length - 1];
            const status = latest ? props.statuses[latest.jobId] ?? null : null;
            return (
              <fieldset key={sim.id} data-blocked={blocked !== null}>
                <legend>{sim.name}</legend>
                <p className="note">{sim.blurb}</p>

                <p className="note">
                  {mine.length === 0
                    ? "Never run for this planet."
                    : `${mine.length} run${mine.length === 1 ? "" : "s"} · latest ${
                        status ? describe(status) : "status unknown"}`}
                  {latest?.settings ? ` · ${describeSettings(latest.settings)}` : ""}
                </p>

                {blocked ? (
                  <p className="note note--warn">{blocked}</p>
                ) : (
                  <div className="runset">
                    <h4 className="runset__head">Run settings</h4>
                    {ready ? (
                      <>
                        <Slider
                          label="Cloud points" min={100} max={10_000} step={100}
                          value={settings.nPoints} display={fmt(settings.nPoints)}
                          about="Points the surface cloud STARTS with — the finest scale the physics ever sees. The run creates them at ridges and consumes them at trenches, so the count moves during a run."
                          onChange={v => set("nPoints", v)}
                        />
                        <Slider
                          label="Steps" min={1} max={2_000} step={1}
                          value={settings.steps} display={fmt(settings.steps)}
                          about="How many iterations to run. Simulated time is steps × Myr per step."
                          onChange={v => set("steps", v)}
                        />
                        <Slider
                          label="Myr per step" min={0.5} max={50} step={0.5}
                          value={settings.dtMyr} display={`${settings.dtMyr} Myr`}
                          about="The time step. The physics must not depend on it — it is exposed so convergence can be exercised and a run traded against wall clock, never to tune an outcome."
                          onChange={v => set("dtMyr", v)}
                        />
                        <Slider
                          label="Checkpoint every" min={1} max={50} step={1}
                          value={settings.checkpointEverySteps}
                          display={`${settings.checkpointEverySteps} steps`}
                          about="Steps between checkpoint files. A step becomes viewable only when the file holding it closes, so this is also how far behind the live view runs."
                          onChange={v => set("checkpointEverySteps", v)}
                        />

                        <Row
                          label="Simulated span"
                          value={`${fmt((settings.steps * settings.dtMyr) / 1000, 2)} Gyr`}
                        />
                        <Row
                          label="Cell spacing"
                          value={`≈ ${fmt(
                            Math.sqrt(p.derived.surfaceAreaM2 / Math.max(1, settings.nPoints)) / 1000,
                          )} km`}
                        />
                        <p className="note">
                          Nothing finer than the cell spacing is simulated. Both
                          figures follow from the numbers above; neither is a target.
                        </p>
                      </>
                    ) : (
                      <p className="note">Reading the server's defaults…</p>
                    )}
                  </div>
                )}

                <div className="numrow">
                  <button
                    className="btn btn--primary"
                    disabled={blocked !== null || props.starting !== null || !ready}
                    title={blocked ?? `Start ${sim.name} with the settings above`}
                    onClick={() => props.onRun(sim.id, settings)}
                  >
                    {props.starting === sim.id
                      ? "Starting…"
                      : mine.length > 0 ? "Run again" : "Run"}
                  </button>
                  <button
                    className="btn"
                    disabled={!latest}
                    title={latest ? "Watch this run" : "Nothing to watch yet"}
                    onClick={() => latest && props.onOpenViewer(latest.jobId)}
                  >
                    Open in viewer
                  </button>
                  {/* Only while there is something to stop. A button that is
                      always there and usually disabled reads as a feature that
                      is usually broken. */}
                  {latest && underway(status) ? (
                    <button
                      className="btn"
                      disabled={props.stopping === latest.jobId}
                      title="Stop this run. It finishes the step it is on and keeps everything recorded so far — the steps already written stay viewable."
                      onClick={() => props.onStop(latest.jobId)}
                    >
                      {props.stopping === latest.jobId ? "Stopping…" : "Stop"}
                    </button>
                  ) : null}
                </div>
              </fieldset>
            );
          })}

          {props.error ? <p className="note note--block">{props.error}</p> : null}
        </div>

        <aside className="derived">
          <h4>This body</h4>
          <div className="rule" />
          <Row label="Seed" value={p.params.seed} />
          <Row label="Diameter" value={`${fmt(p.params.diameterM / 1000)} km`} />
          <Row label="Start mantle T" value={`${fmt(p.params.startMantleTemperatureK)} K`} />
          <p className="note">
            The givens every run of this body starts from. They cannot be changed
            after creation: a planet that quietly changed its givens between runs
            would not be reproducible from its seed.
          </p>
          {p.unappliedParams && p.unappliedParams.length > 0 ? (
            <p className="note note--warn">
              Stored but not used by any simulation: {p.unappliedParams.join(", ")}.
            </p>
          ) : null}

          <button className="btn btn--block" style={{ marginTop: 16 }} onClick={props.onBack}>
            Back to catalogue
          </button>
        </aside>
      </div>
    </div>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div className="row">
      <span>{props.label}</span>
      <b>{props.value}</b>
    </div>
  );
}

/** What a run was made with, in one line. */
function describeSettings(s: RunSettings): string {
  return `${fmt(s.nPoints)} points · ${s.steps} × ${s.dtMyr} Myr`;
}

function describe(s: JobStatus): string {
  switch (s.state) {
    case "queued": return `queued at position ${s.position}`;
    case "running": return `running · step ${s.step} of ${s.stepsTotal}`;
    case "complete": return `complete · ${s.stepsTotal} steps`;
    case "failed": return `failed (${s.code})`;
    // Not "failed": nothing went wrong, and how far it got is the useful part.
    case "cancelled":
      return `stopped at step ${s.step} of ${s.stepsTotal}`;
  }
}

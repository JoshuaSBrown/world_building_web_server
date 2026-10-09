import { useCallback, useRef } from "react";
import type { JobStatus } from "../api/types";
import { CORE_SURFACE_FORMATION, fractionOf } from "../lib/simulations";

/**
 * The run tape.
 *
 * A progress bar is dead pixels the moment a run finishes. This is the same
 * widget in two lifecycles: while the job runs it fills with the steps the
 * simulation reports; once every step is readable it becomes a scrubber and a
 * projector — the recorded steps played in order, which is the only honest kind
 * of movie here. Each frame is a step the run actually wrote; nothing is
 * interpolated between them to smooth the motion.
 *
 * **Steps, not a percentage and not an invented schedule.** The tape used to be
 * divided into bands — accretion, differentiation, first lid, plate tectonics,
 * erosion & climate — sized by a made-up share of simulated time. No run
 * declares a stage schedule, and erosion and climate are a separate simulation
 * that does not exist yet; what that simulation is and why it cannot run belongs
 * on the planet's simulations page, not on a strip above the planet.
 *
 * **One row, and it does not cover the globe.** The viewer is for looking at a
 * planet: the transport, the track and the step readout sit on a single thin
 * strip, and the globe's canvas ends above it rather than continuing underneath.
 */
export function Timeline(props: {
  status: JobStatus | null;
  connected: boolean;
  jobId: string | null;
  /** The recorded step on screen, or null before one has arrived. */
  step: number | null;
  /** Its simulated time, as the run recorded it. */
  timeMyr: number | null;
  /** Every step that can be opened right now. */
  steps: number[];
  scrubbable: boolean;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onScrub: (t: number) => void;
  children?: React.ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const scrubTo = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || !props.scrubbable) return;
    const r = el.getBoundingClientRect();
    props.onScrub(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  }, [props.scrubbable, props.onScrub]);

  const state = props.status?.state ?? "idle";
  const stepsTotal = props.status?.stepsTotal ?? 0;
  const sim = CORE_SURFACE_FORMATION;
  const shownStep = props.step ?? 0;

  // Filled to where the RUN has got; the playhead marks the step ON SCREEN.
  // While a run is live those differ by up to one part, because a step becomes
  // readable only when the file holding it closes. That gap is the live-view
  // latency, and showing it beats picking one number and implying the other.
  const runFill = props.status?.state === "running"
    ? props.status.progress
    : props.status?.state === "complete" ? 1
    : fractionOf(shownStep, stepsTotal);
  const playhead = fractionOf(shownStep, stepsTotal);
  const fill = props.scrubbable ? playhead : runFill;

  const label =
    props.status === null ? (props.jobId ? "connecting" : "idle")
    : props.status.state === "queued" ? `queued · position ${props.status.position}`
    : props.status.state === "running"
      ? `${props.status.stage} · step ${props.status.step} of ${props.status.stepsTotal}` +
        (props.connected ? "" : " · reconnecting")
    : props.status.state === "complete"
      ? `complete · ${props.status.stepsTotal} steps in ${props.status.elapsedSeconds.toFixed(1)} s`
    : props.status.state === "cancelled"
      ? `stopped at step ${props.status.step} of ${props.status.stepsTotal}`
    : `failed at step ${shownStep} of ${props.status.stepsTotal} · ${props.status.code}`;

  /** Move by whole recorded steps: a step is the unit the run reports. */
  const nudge = (by: number) => {
    if (props.steps.length === 0) return;
    const i = Math.max(0, props.steps.indexOf(shownStep));
    const next = Math.min(props.steps.length - 1, Math.max(0, i + by));
    props.onScrub(next / Math.max(1, props.steps.length - 1));
  };

  return (
    <div className="panel tape">
      <div className="tape__job" data-state={state} title={label}>
        <i />
        <span>{label}</span>
      </div>

      <button
        className="btn btn--icon"
        disabled={!props.scrubbable}
        title={props.scrubbable
          ? "Play the recorded steps in order"
          : "Available once the run has finished and every step is readable"}
        onClick={props.playing ? props.onPause : props.onPlay}
      >
        {props.playing ? "❚❚" : "▶"}
      </button>
      <button className="btn btn--icon" disabled={!props.scrubbable} onClick={() => nudge(-1)} title="Previous step">‹</button>
      <button className="btn btn--icon" disabled={!props.scrubbable} onClick={() => nudge(1)} title="Next step">›</button>

      <div
        ref={trackRef}
        className="track"
        data-scrubbable={props.scrubbable}
        role="slider"
        aria-label={`${sim.name} — simulated step`}
        aria-valuemin={0}
        aria-valuemax={stepsTotal}
        aria-valuenow={shownStep}
        aria-valuetext={`step ${shownStep} of ${stepsTotal}`}
        title={sim.name}
        tabIndex={props.scrubbable ? 0 : -1}
        onPointerDown={e => {
          if (!props.scrubbable) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          scrubTo(e.clientX);
        }}
        onPointerMove={e => { if (dragging.current) scrubTo(e.clientX); }}
        onPointerUp={() => { dragging.current = false; }}
        onKeyDown={e => {
          if (!props.scrubbable) return;
          if (e.key === "ArrowLeft") nudge(e.shiftKey ? -10 : -1);
          if (e.key === "ArrowRight") nudge(e.shiftKey ? 10 : 1);
          if (e.key === "Home") props.onScrub(0);
          if (e.key === "End") props.onScrub(1);
        }}
      >
        <span className="track__fill" style={{ transform: `scaleX(${fill})` }} />
        <span className="playhead" style={{ left: `${playhead * 100}%` }} />
      </div>

      <div className="tape__clock">
        <span className="tabular">{props.step ?? "—"}</span>
        <em>/</em>
        <span className="tabular">{stepsTotal || "—"}</span>
        {props.timeMyr !== null && Number.isFinite(props.timeMyr) ? (
          <> · <span className="tabular">{props.timeMyr.toFixed(0)}</span> <em>Myr</em></>
        ) : null}
      </div>

      {props.children}
    </div>
  );
}

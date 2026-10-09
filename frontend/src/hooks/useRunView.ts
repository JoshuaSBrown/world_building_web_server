import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Frame, JobStatus } from "../api/types";

/**
 * The step on screen, however it got there: live, scrubbed, or played.
 *
 * One hook rather than three, because all three answer the same question — which
 * recorded step is being displayed — and splitting them left two owners fighting
 * over it.
 *
 * **The browser pulls; the server never pushes payloads.** The SSE stream carries
 * notifications only ("step N landed"), and this decides whether it still wants
 * step N. While a fetch is in flight only the newest announcement is remembered,
 * so a run that outruns the display skips ahead instead of queueing — backpressure
 * with nothing buffered on either side.
 */

/** Frames kept in memory. A step is a few hundred numbers per field, so this is
 *  a small cache; it exists so replaying a movie does not refetch every loop. */
const CACHE_LIMIT = 240;

/**
 * Steps per second during playback.
 *
 * One rate, not a control. A speed picker offered five numbers and answered no
 * question anyone had: what a viewer wants is to see the run evolve, and the
 * step buttons already cover looking at one frame closely. It is a display
 * cadence, so it is declared here rather than tuned on screen.
 */
const PLAYBACK_FPS = 6;

export type Playback = { playing: boolean };

export interface RunView {
  status: JobStatus | null;
  connected: boolean;
  /** The frame being displayed, or null before one has arrived. */
  frame: Frame | null;
  /** Steps that can be opened right now, ascending. */
  steps: number[];
  /** True once the run is over and the whole tape can be replayed. */
  replayable: boolean;
  playback: Playback;
  play: () => void;
  pause: () => void;
  /** Show a specific recorded step. Ignored if it is not readable. */
  seek: (step: number) => void;
  /** Show the step nearest a position on the tape, 0–1. */
  seekFraction: (t: number) => void;
  error: string | null;
}

export function useRunView(jobId: string | null, datasets: readonly string[]): RunView {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [steps, setSteps] = useState<number[]>([]);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The field list is a value, not an identity: re-fetching every frame because
  // a caller passed a fresh array literal would be a subtle, expensive bug.
  const key = datasets.join(",");

  // Read through a ref, so `load` and the stream do NOT depend on it.
  //
  // They used to: picking a layer changed the field list, which changed `load`,
  // which tore down the event stream, blanked the frame and refetched the step
  // list — a lot of machinery to change which arrays a request asks for, and
  // every link in it a chance for the view to sit on the old picture. Changing
  // layers now refetches one step and nothing else moves.
  const fieldsRef = useRef<string[]>([]);
  fieldsRef.current = key.split(",").filter(Boolean);

  const cache = useRef(new Map<string, Frame>());
  const following = useRef(true);      // live runs track the newest step
  const wanted = useRef<number | null>(null);
  /** The step being displayed, so a change of fields can refetch exactly it. */
  const shown = useRef<number | null>(null);
  /**
   * Which display request is the newest.
   *
   * Several things ask for a frame — the live stream, the scrubber, playback,
   * a change of layer — and they can be in flight at once. Without an order,
   * whichever RESPONSE lands last wins, so an older step can arrive after a
   * newer one and the view walks backwards. Points that are drifting steadily
   * then look like they are bouncing between two positions, which is a lie
   * about the physics: the run's own cells turn with a straightness of ~0.7.
   *
   * Every request that intends to display takes a ticket; only the newest one
   * may set the frame. A stale response is dropped, not drawn.
   */
  const ticket = useRef(0);

  const load = useCallback(async (step: number, show: boolean) => {
    if (!jobId) return null;
    const mine = show ? ++ticket.current : 0;
    const newest = () => !show || mine === ticket.current;
    // Keyed by step AND field list: a frame fetched for topography has no
    // temperature in it, and handing it back for the temperature layer is how
    // a viewer ends up showing the previous layer's colours.
    const id = `${step}|${fieldsRef.current.join(",")}`;
    const hit = cache.current.get(id);
    if (hit) {
      if (newest() && show) { shown.current = step; setFrame(hit); }
      return hit;
    }
    try {
      const f = await api.step(jobId, step, fieldsRef.current);
      cache.current.set(id, f);
      if (cache.current.size > CACHE_LIMIT) {
        // Oldest first: a replay walks forward, so the frames just behind the
        // playhead are the least likely to be wanted next.
        const oldest = cache.current.keys().next().value;
        if (oldest !== undefined) cache.current.delete(oldest);
      }
      // A response for a step the view has already moved past is kept in the
      // cache and NOT drawn: it is still good data, just no longer the answer
      // to the question on screen.
      if (newest() && show) { shown.current = step; setFrame(f); }
      setError(null);
      return f;
    } catch (e) {
      // A step that cannot be read is a skipped step, not a stalled viewer.
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [jobId]);

  // ── the live stream ────────────────────────────────────────────────
  useEffect(() => {
    setStatus(null); setConnected(false); setFrame(null); setSteps([]);
    cache.current.clear();
    following.current = true;
    shown.current = null;
    if (!jobId) return;

    const source = new EventSource(api.eventsUrl(jobId));
    let live = true;
    let fetching = false;

    const drain = async () => {
      if (fetching || wanted.current === null) return;
      fetching = true;
      const step = wanted.current;
      wanted.current = null;
      await load(step, true);
      fetching = false;
      if (live) void drain();
    };

    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("status", e => {
      const next = JSON.parse((e as MessageEvent<string>).data) as JobStatus;
      setStatus(next);
      if (next.state === "complete" || next.state === "failed") {
        // The whole tape is readable now, so the scrubber and playback can work
        // from the list rather than from whatever happened to arrive live.
        void api.steps(jobId).then(r => { if (live) setSteps(r.steps); }).catch(() => {});
      }
    });
    source.addEventListener("step", e => {
      const { step } = JSON.parse((e as MessageEvent<string>).data) as { step: number };
      setSteps(prev => (prev.includes(step) ? prev : [...prev, step].sort((a, b) => a - b)));
      if (following.current) { wanted.current = step; void drain(); }
    });

    // A run that finished before this view opened announces nothing, so ask.
    void api.jobStatus(jobId).then(s => {
      if (!live) return;
      setStatus(s);
      if (s.state === "complete" || s.state === "failed") {
        void api.steps(jobId).then(r => { if (live) setSteps(r.steps); }).catch(() => {});
      }
    }).catch(() => {});

    return () => { live = false; source.close(); };
  }, [jobId, load]);

  // A different set of fields is the SAME step, drawn from more of what the run
  // wrote. Refetch exactly the step on screen: the scrub position, the stream
  // and the step list all stay where they were.
  useEffect(() => {
    const step = shown.current;
    if (step !== null) void load(step, true);
  }, [key, load]);

  const replayable =
    (status?.state === "complete" || status?.state === "failed") && steps.length > 0;

  // Show something as soon as a finished run's steps are known.
  useEffect(() => {
    if (frame === null && steps.length > 0) void load(steps[steps.length - 1]!, true);
  }, [frame, steps, load]);

  const seek = useCallback((step: number) => {
    if (!steps.includes(step)) return;
    following.current = false;
    void load(step, true);
  }, [steps, load]);

  const seekFraction = useCallback((t: number) => {
    if (steps.length === 0) return;
    const clamped = Math.min(1, Math.max(0, t));
    const i = Math.round(clamped * (steps.length - 1));
    seek(steps[i]!);
  }, [steps, seek]);

  // ── playback ───────────────────────────────────────────────────────
  //
  // Self-pacing rather than a fixed timer: each frame waits for the one before
  // it to be on screen, so a slow fetch stretches the movie instead of piling up
  // requests the display has already passed.
  useEffect(() => {
    if (!playing || !replayable || steps.length === 0) return;
    let live = true;
    let index = Math.max(0, steps.indexOf(frame?.step ?? steps[0]!));

    const tick = async () => {
      while (live) {
        index = (index + 1) % steps.length;
        const started = performance.now();
        await load(steps[index]!, true);
        // Read one ahead while the current frame is on screen.
        void load(steps[(index + 1) % steps.length]!, false);
        const wait = Math.max(0, 1000 / PLAYBACK_FPS - (performance.now() - started));
        await new Promise(r => setTimeout(r, wait));
      }
    };
    void tick();
    return () => { live = false; };
    // `frame` deliberately absent: it changes every tick and would restart the
    // loop. The starting index is read once, when playback begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, replayable, steps, load]);

  return {
    status, connected, frame, steps, replayable,
    playback: { playing },
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    seek, seekFraction, error,
  };
}

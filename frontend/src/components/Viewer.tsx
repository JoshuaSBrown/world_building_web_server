import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchSpec, PlanetSummary } from "../api/types";
import { useRunView } from "../hooks/useRunView";
import { useViewerState } from "../state/useViewerState";
import { BASE_LAYERS, type BaseLayerId } from "../lib/colour";
import { EMPTY_DELTA, paintDelta, summarise, withDelta, type EditDelta } from "../lib/edits";
import {
  boundarySegments, cloudSites, plateArrows, sampleFrame, unavailableBecause,
  type Scale,
} from "../lib/frames";
import { icosphere } from "../lib/icosphere";
import { displayLevelFor, verticesAt } from "../lib/nearest";
import { patchFromCorners, patchOutline, toLatLon } from "../lib/patch";
import { Globe, type CellData, type GlobeHandle } from "./Globe";
import { EditPanel } from "./EditPanel";
import type { ViewerMode } from "./ModeSwitch";
import { InfoPanel, type CellSample } from "./InfoPanel";
import { LayerRail } from "./LayerRail";
import { RegionControls } from "./RegionControls";
import { Timeline } from "./Timeline";
import { Toast } from "./ui";

/**
 * Viewer.
 *
 * Two modes, and the difference between them is not cosmetic:
 *
 * * **Simulation** — every layer the run recorded, over any recorded step.
 *   Scrub the tape, or play it as a movie once the run is over.
 * * **Edit** — topography only, because an edit moves the surface and every
 *   other layer describes the surface *before* it moved. They are not hidden to
 *   keep the screen tidy; they are withheld because showing them would pair a
 *   physical field with a surface it never belonged to. Getting them back needs
 *   a recalculation, which is the engine's job and not the browser's.
 *
 * Frames arrive per recorded step and are sampled onto the display mesh by
 * nearest-point lookup — the model's own cells, not an interpolation between
 * them.
 */
export function Viewer(props: {
  planet: PlanetSummary;
  jobId: string | null;
  /** Which mode the header's switch has selected. */
  mode: ViewerMode;
  onOpenMap: (patch: PatchSpec) => void;
  /** The recorded step on screen, so another view can open on the same one. */
  onStepChange: (step: number | null) => void;
  /** The rectangle drawn on the globe, for the map view in the header. */
  onPatchChange: (patch: PatchSpec | null) => void;
}) {
  const [vs, dispatch] = useViewerState();
  const globeRef = useRef<GlobeHandle>(null);
  const [sample, setSample] = useState<CellSample | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [regionArmed, setRegionArmed] = useState(false);
  const [patch, setPatch] = useState<PatchSpec | null>(null);
  const dragAnchor = useRef<[number, number, number] | null>(null);

  // ── edit state ─────────────────────────────────────────────────────
  const [delta, setDelta] = useState<EditDelta>(EMPTY_DELTA);
  const [brush, setBrush] = useState({ radiusDeg: 8, strengthM: 300, lower: false });
  const edited = delta.size > 0;

  // ── what to fetch ──────────────────────────────────────────────────
  //
  // Elevation always (the globe displaces by it), plus whatever the active layer
  // draws. Asking for only what is drawn is what keeps a movie cheap.
  const layer = BASE_LAYERS.find(l => l.id === vs.baseLayer) ?? BASE_LAYERS[0]!;
  const showBoundaries = vs.overlays.boundaries;
  const showMotion = vs.overlays.motion;
  const datasets = useMemo(
    () => [...new Set([
      "elevation",
      layer.dataset,
      // The boundary overlay is three more arrays per step, so they are asked
      // for only while it is on.
      // Qualified: `position` and `label` exist in several groups, and the
      // interface's own edges are the ones being drawn.
      ...(showBoundaries
        ? ["boundary_edges/start", "boundary_edges/end", "boundary_edges/label"]
        : []),
      // One vector per plate, and only while the arrows are on. `centroid`
      // rides along as the `plates` domain's positions, so it is not asked for
      // by name.
      ...(showMotion ? ["plates/velocity"] : []),
    ])].filter(Boolean),
    [layer.dataset, showBoundaries, showMotion],
  );

  const run = useRunView(props.jobId, datasets);
  const frame = run.frame;

  // ── the display mesh, sized to THIS run ────────────────────────────
  //
  // A run chooses its own point count, so the mesh cannot be fixed at the
  // planet's creation value: a 1 200-cell run drawn on a mesh picked for 500
  // looks coarser than it is, and a 200-cell run on a mesh picked for 10 000
  // pays a nearest-point search per vertex for detail nothing computed.
  //
  // It only ever goes UP within a run. The cell count moves every step as points
  // are created and consumed, and a mesh that followed it exactly would rebuild
  // — and reset the camera — whenever the count crossed a boundary.
  const [level, setLevel] = useState(() => displayLevelFor(props.planet.params.maxPoints));
  useEffect(() => {
    setLevel(displayLevelFor(props.planet.params.maxPoints));
  }, [props.jobId, props.planet.params.maxPoints]);
  useEffect(() => {
    const cells = frame?.elevation.length;
    if (!cells) return;
    const want = displayLevelFor(cells);
    setLevel(prev => (want > prev ? want : prev));
  }, [frame]);
  const geometry = useMemo(() => icosphere(level), [level]);

  // ── sampling onto the display mesh ─────────────────────────────────
  const mapCache = useRef(new Map<string, Int32Array>());
  const [held, setHeld] = useState<Scale | null>(null);

  const sampled = useMemo(() => {
    if (!frame) return null;
    const elevation = frame.fields?.["elevation"];
    const shown = edited && elevation
      // The edit is applied to the run's own cells before sampling, so what is
      // on screen is the recorded field plus a delta labelled as art.
      ? {
          ...frame,
          fields: {
            ...frame.fields,
            elevation: { ...elevation, values: withDelta(elevation.values as number[], delta) },
          },
        }
      : frame;
    return sampleFrame(shown, vs.baseLayer, geometry.vertices, mapCache.current, held);
  }, [frame, geometry, vs.baseLayer, held, delta, edited]);

  // Push to the globe. Never through React state: these are tens of thousands
  // of floats that end in a GPU buffer.
  useEffect(() => {
    if (!sampled) return;
    globeRef.current?.setCells({
      elevation: sampled.elevation,
      seaLevel: frame?.seaLevel == null ? Number.NaN : frame.seaLevel + vs.seaOffsetM,
      values: sampled.values,
      scale: { min: sampled.scale.min, max: sampled.scale.max },
      kind: sampled.kind,
      ramp: layer.ramp,
    } satisfies CellData);
  }, [sampled, frame, vs.seaOffsetM, layer.ramp, level]);

  // The run's own cells for this step. Pushed separately from the coloured
  // field because they are a different thing: where the model IS, rather than
  // what it computed there.
  useEffect(() => {
    globeRef.current?.setCloud(cloudSites(frame));
  }, [frame, level]);

  // The step's boundaries, coloured by what the physics called each segment.
  const boundaries = useMemo(
    () => (showBoundaries ? boundarySegments(frame) : null),
    [frame, showBoundaries],
  );
  useEffect(() => {
    globeRef.current?.setBoundaries(boundaries);
  }, [boundaries, level]);

  // One arrow per plate, from the middle of it, at a fixed scale.
  const motion = useMemo(
    () => (showMotion ? plateArrows(frame) : null),
    [frame, showMotion],
  );
  useEffect(() => {
    globeRef.current?.setPlateMotion(motion);
  }, [motion, level]);

  // Which layers this frame can offer, and why not when it cannot.
  const unavailable = useMemo(() => {
    const out: Partial<Record<BaseLayerId, string>> = {};
    for (const l of BASE_LAYERS) {
      const why = unavailableBecause(l, frame);
      if (why) out[l.id] = why;
      else if (props.mode === "edit" && l.id !== "topo") {
        out[l.id] = edited
          ? "stale — the surface was edited; needs a recalculation"
          : "not available while editing — only topography can be edited";
      }
    }
    return out;
  }, [frame, props.mode, edited]);

  // A held scale is a range in one field's units. Metres of elevation mean
  // nothing for K/m of temperature gradient, and keeping them would colour a
  // whole planet one flat shade — indistinguishable from a layer that failed to
  // draw. Changing layer drops the hold and the new layer scales to itself.
  useEffect(() => { setHeld(null); }, [vs.baseLayer]);

  // Entering edit mode forces topography: it is the only field an edit can
  // touch, and the others describe a surface the edit is about to invalidate.
  // The rule follows the mode wherever the control lives.
  useEffect(() => {
    if (props.mode === "edit") dispatch({ type: "baseLayer", id: "topo" });
  }, [props.mode, dispatch]);

  // A layer that stops being available must not stay selected: the globe would
  // keep drawing the last thing it had.
  useEffect(() => {
    if (unavailable[vs.baseLayer] !== undefined && vs.baseLayer !== "topo") {
      dispatch({ type: "baseLayer", id: "topo" });
    }
  }, [unavailable, vs.baseLayer, dispatch]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Report the step on screen upward, so the map view opens on the same one.
  const onStepChange = props.onStepChange;
  useEffect(() => { onStepChange(frame?.step ?? null); }, [frame, onStepChange]);

  // ── region drawing ─────────────────────────────────────────────────
  const radiusM = props.planet.derived.radiusM;

  const onRegionDragStart = useCallback((p: [number, number, number]) => {
    dragAnchor.current = p;
    dispatch({ type: "sheet", sheet: "none" });
  }, [dispatch]);

  const onRegionDragMove = useCallback((p: [number, number, number]) => {
    const a = dragAnchor.current;
    if (!a) return;
    // Corner to corner, axis-aligned in latitude and longitude — which is what
    // a drag expresses. The outline is drawn from the patch itself, so what is
    // on the globe is exactly the rectangle the map view will sample.
    const spec = patchFromCorners(toLatLon(a), toLatLon(p), radiusM);
    // A drag that has not moved yet, or one whose corners share a meridian,
    // describes no area. Nothing is set until it does: a zero-width patch would
    // sample a line and draw it as a map.
    if (!(spec.widthM > 0 && spec.heightM > 0)) return;
    setPatch(spec);
    globeRef.current?.setRegionOutline(patchOutline(spec, radiusM));
  }, [dispatch, radiusM]);

  const onRegionDragEnd = useCallback(() => {
    dragAnchor.current = null;
    setRegionArmed(false);
  }, []);

  // The header owns the map-view button, so the patch has to reach it.
  const onPatchChange = props.onPatchChange;
  useEffect(() => { onPatchChange(patch); }, [patch, onPatchChange]);

  // Clearing the patch clears what is drawn on the globe with it.
  useEffect(() => {
    if (patch === null) globeRef.current?.setRegionOutline(null);
  }, [patch]);

  // ── picking, and the brush ─────────────────────────────────────────
  const onPickCell = useCallback((index: number) => {
    const geo = geometry;
    if (!frame || !sampled) return;
    const j = index * 3;
    const x = geo.vertices[j]!, y = geo.vertices[j + 1]!, z = geo.vertices[j + 2]!;

    if (props.mode === "edit") {
      const pos = frame.domains?.["cloud"]?.pos;
      if (!pos) return;
      setDelta(d => paintDelta(
        d, pos, [x, y, z],
        (brush.radiusDeg * Math.PI) / 180,
        brush.lower ? -brush.strengthM : brush.strengthM,
      ));
      return;
    }

    setSample({
      latitude: (Math.asin(Math.min(1, Math.max(-1, y))) * 180) / Math.PI,
      longitude: (Math.atan2(z, x) * 180) / Math.PI,
      elevationM: sampled.elevation[index]!,
      layerName: sampled.longName,
      layerValue: sampled.values[index]!,
      layerUnits: sampled.units,
      dataset: layer.dataset,
      step: frame.step,
    });
    if (window.innerWidth < 820) dispatch({ type: "sheet", sheet: "info" });
  }, [geometry, frame, sampled, props.mode, brush, layer.dataset, dispatch]);

  const overlaysMemo = useMemo(() => vs.overlays, [vs.overlays]);
  const editSummary = summarise(delta);

  return (
    <>
      <Globe
        // A new vertex set is a new mesh: the globe builds its buffers once, so
        // it is remounted rather than reshaped.
        key={level}
        ref={globeRef}
        vertices={geometry.vertices}
        indices={geometry.indices}
        overlays={overlaysMemo}
        exaggeration={vs.exaggeration}
        lighting={vs.lighting}
        reliefM={props.planet.derived.reliefM}
        regionMode={regionArmed}
        onPickCell={onPickCell}
        onRegionDragStart={onRegionDragStart}
        onRegionDragMove={onRegionDragMove}
        onRegionDragEnd={onRegionDragEnd}
      />

      {props.mode === "edit" ? (
        <EditPanel
          open={vs.sheet === "rail"}
          brush={brush}
          onBrush={setBrush}
          cells={editSummary.cells}
          peakM={editSummary.peakM}
          onClear={() => setDelta(EMPTY_DELTA)}
          onRecalculate={() => setToast(
            "Nothing can apply this edit yet. An edit is a delta the ENGINE applies at " +
            "the start of the next segment (docs/09); that path is not built, so the " +
            "other layers stay stale rather than being recomputed in the browser.",
          )}
        />
      ) : (
        <LayerRail
          open={vs.sheet === "rail"}
          baseLayer={vs.baseLayer}
          overlays={vs.overlays}
          motion={motion}
          exaggeration={vs.exaggeration}
          seaOffsetM={vs.seaOffsetM}
          scale={sampled?.scale ?? null}
          cells={sampled?.elements ?? null}
          domain={sampled?.domain ?? null}
          skew={sampled?.skew ?? null}
          meshVertices={verticesAt(level)}
          // Nothing is drawn for this layer yet. Said out loud, because the
          // globe still carries the last layer's colours and a viewer that
          // does not say so is showing one layer under another's name.
          pending={sampled === null || frame?.fields?.[layer.dataset] === undefined}
          unavailable={unavailable}
          boundaryLabels={boundaries?.labels ?? null}
          boundaryUnknown={boundaries?.unknown ?? []}
          onBaseLayer={id => dispatch({ type: "baseLayer", id })}
          onToggleOverlay={id => dispatch({ type: "overlay", id })}
          lighting={vs.lighting}
          onExaggeration={v => dispatch({ type: "exaggeration", v })}
          onSeaOffset={v => dispatch({ type: "seaOffset", v })}
          onLighting={mode => dispatch({ type: "lighting", mode })}
          onHoldScale={() => setHeld(
            held ? null : sampled ? { ...sampled.scale, mode: "held" } : null,
          )}
        >
          <RegionControls
            armed={regionArmed}
            patch={patch}
            simCellM={props.planet.derived.simCellM}
            onArm={setRegionArmed}
            onPatchChange={setPatch}
            onOpenMap={() => patch && props.onOpenMap(patch)}
          onClear={() => setPatch(null)}
          />
        </LayerRail>
      )}

      <InfoPanel
        open={vs.sheet === "info"}
        planet={props.planet}
        sample={sample}
        edited={edited}
      />

      <Timeline
        status={run.status}
        connected={run.connected}
        jobId={props.jobId}
        step={frame?.step ?? null}
        timeMyr={frame?.timeMyr ?? null}
        steps={run.steps}
        scrubbable={run.replayable}
        playing={run.playback.playing}
        onPlay={run.play}
        onPause={run.pause}
        onScrub={run.seekFraction}
      >
        {/* Only the panels of this screen. Navigation lives in the header: the
            strip is the run's, and a control that leaves the page is not. */}
        <button className="btn btn--icon mobile-only" onClick={() => dispatch({ type: "sheet", sheet: "rail" })}>
          {props.mode === "edit" ? "Brush" : "Layers"}
        </button>
        <button className="btn btn--icon mobile-only" onClick={() => dispatch({ type: "sheet", sheet: "info" })}>Info</button>
      </Timeline>

      <Toast message={run.error ?? toast} />
    </>
  );
}

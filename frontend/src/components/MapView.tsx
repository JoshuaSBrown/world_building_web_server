import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Frame, PatchSpec, PlanetSummary } from "../api/types";
import { useExportJob } from "../hooks/useExportJob";
import { sampleGrid } from "../lib/patch";
import { RAMPS, ramp, rampCss, BASE_LAYERS, type BaseLayerId } from "../lib/colour";
import { useRegion } from "../state/regionStore";
import { ExportPanel } from "./ExportPanel";
import { Slider, Toast } from "./ui";

/**
 * Map view: the patch, flat.
 *
 * Rendered to a 2D canvas rather than WebGL. It is a static raster with
 * hillshading — no camera, no lighting model, no geometry — and canvas
 * keeps it debuggable and cheap. The 3D globe earns WebGL; this does not.
 *
 * The preview grid is capped well below export resolution. Anything the
 * user would actually import goes through the server; this is for
 * deciding whether the region is the right region.
 */
const PREVIEW_MAX = 384;

/**
 * The grid carries elevation and nothing else, so only the layers that read
 * elevation are offered. Colouring "plates" or "temperature" from height would
 * draw a plausible-looking wrong thing, which is worse than not drawing it.
 */
const PREVIEW_LAYERS = BASE_LAYERS.filter(l => l.dataset === "elevation");

export function MapView(props: {
  planet: PlanetSummary;
  patch: PatchSpec;
  /** The run and the recorded step the globe was showing. */
  jobId: string | null;
  step: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseLayer, setBaseLayer] = useState<BaseLayerId>("topo");
  const [sunAzimuth, setSunAzimuth] = useState(315);
  const [verticalExag, setVerticalExag] = useState(30);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const gridRef = useRef<{ w: number; h: number; e: Float32Array } | null>(null);
  const [heightRangeM, setHeightRangeM] = useState<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);

  const region = useRegion(props.planet.derived.simCellM, props.planet.derived.radiusM);
  const exportJob = useExportJob();

  // Keep the shared region state in step with the patch we were handed.
  useEffect(() => { region.setPatch(props.patch); }, [props.patch]);

  const reliefM = props.planet.derived.reliefM;

  // The same recorded step the globe was showing, fetched again rather than
  // handed over: a view is a function of the files, so this URL draws the same
  // map on a reload with nothing kept in memory between them.
  useEffect(() => {
    if (!props.jobId || props.step === null) return;
    const ctrl = new AbortController();
    api.step(props.jobId, props.step, ["elevation"], ctrl.signal)
      .then(f => { if (!ctrl.signal.aborted) setFrame(f); })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setToast(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [props.jobId, props.step]);

  /**
   * Sample the recorded cloud over the patch.
   *
   * Nearest cell per pixel, which is the globe's rule and the model's own notion
   * of its surface. Nothing is interpolated between cells and no detail is
   * synthesised: at high zoom the facets ARE the resolution the run has, and a
   * smooth-looking map would be showing terrain nothing computed.
   */
  const compute = useCallback(() => {
    const cloud = frame?.domains["cloud"];
    const elevation = frame?.fields["elevation"];
    if (!frame || !cloud || !elevation) return;
    const ar = props.patch.widthM / props.patch.heightM;
    const w = ar >= 1 ? PREVIEW_MAX : Math.max(16, Math.round(PREVIEW_MAX * ar));
    const h = ar >= 1 ? Math.max(16, Math.round(PREVIEW_MAX / ar)) : PREVIEW_MAX;
    const e = sampleGrid(
      props.patch, props.planet.derived.radiusM, w, h,
      cloud.pos, elevation.values as number[],
    );
    gridRef.current = { w, h, e };
    let lo = Infinity, hi = -Infinity;
    for (const v of e) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    // The range actually in view, not a padded one: this is a measurement.
    setHeightRangeM(Number.isFinite(lo) ? (hi - lo) * reliefM : null);
    draw();
  }, [frame, props.patch, props.planet.derived.radiusM, reliefM]);

  useEffect(() => { compute(); }, [compute]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const g = gridRef.current;
    if (!canvas || !g) return;
    const host = canvas.parentElement;
    if (!host) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = host.clientWidth * dpr;
    canvas.height = host.clientHeight * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#04070a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const off = document.createElement("canvas");
    off.width = g.w; off.height = g.h;
    const octx = off.getContext("2d");
    if (!octx) return;
    const img = octx.createImageData(g.w, g.h);
    const d = img.data;

    const az = (sunAzimuth * Math.PI) / 180;
    const alt = (42 * Math.PI) / 180;
    const sx = Math.cos(alt) * Math.sin(az);
    const sy = Math.cos(alt) * Math.cos(az);
    const sz = Math.sin(alt);
    const mpp = props.patch.widthM / (g.w - 1);
    const ve = verticalExag / 10;

    for (let j = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++) {
        const k = j * g.w + i;
        const e = g.e[k]!;
        const col = colourFor(baseLayer, e);

        // Central-difference slope, in real metres per metre, so the
        // shading reads consistently regardless of patch size.
        const xa = g.e[j * g.w + Math.max(0, i - 1)]!;
        const xb = g.e[j * g.w + Math.min(g.w - 1, i + 1)]!;
        const ya = g.e[Math.max(0, j - 1) * g.w + i]!;
        const yb = g.e[Math.min(g.h - 1, j + 1) * g.w + i]!;
        const dzx = ((xb - xa) * reliefM) / (2 * mpp) * ve;
        const dzy = ((yb - ya) * reliefM) / (2 * mpp) * ve;
        const nl = Math.hypot(dzx, dzy, 1);
        const lambert = Math.min(1, Math.max(0, (-dzx * sx + dzy * sy + sz) / nl));
        const shade = 0.30 + 1.05 * lambert;

        d[k * 4] = Math.min(255, col[0] * shade * 255);
        d[k * 4 + 1] = Math.min(255, col[1] * shade * 255);
        d[k * 4 + 2] = Math.min(255, col[2] * shade * 255);
        d[k * 4 + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);

    // Fit while preserving the patch's true aspect ratio — the whole
    // point of the projection is that the shape is metrically honest.
    const pad = 76 * dpr;
    const aw = canvas.width - pad * 2;
    const ah = canvas.height - pad * 2;
    const ar = props.patch.widthM / props.patch.heightM;
    let dw = aw, dh = aw / ar;
    if (dh > ah) { dh = ah; dw = ah * ar; }
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, dx, dy, dw, dh);
    ctx.strokeStyle = "#22323f";
    ctx.lineWidth = dpr;
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw, dh);

    drawScaleBar(ctx, dx, dy + dh + 18 * dpr, dw, props.patch.widthM, dpr);

    ctx.fillStyle = "#516878";
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "right";
    ctx.fillText(
      `${Math.abs(props.patch.centreLat).toFixed(2)}°${props.patch.centreLat >= 0 ? "N" : "S"}  ` +
      `${Math.abs(props.patch.centreLon).toFixed(2)}°${props.patch.centreLon >= 0 ? "E" : "W"}  ` +
      `bearing ${props.patch.bearingDeg}°`,
      dx + dw, dy + dh + 21 * dpr,
    );
    ctx.textAlign = "left";
  }, [baseLayer, sunAzimuth, verticalExag, props.patch]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  return (
    <>
      <div className="map__canvas"><canvas ref={canvasRef} /></div>

      <aside className="panel rail" data-open={sheetOpen}>
        <h4>Base layer</h4>
        {PREVIEW_LAYERS.map(l => (
          <button
            key={l.id}
            className="layer"
            role="radio"
            aria-checked={baseLayer === l.id}
            data-on={baseLayer === l.id}
            title={l.blurb}
            onClick={() => setBaseLayer(l.id)}
          >
            <span className="layer__key" />
            {l.name}
          </button>
        ))}
        <div className="ramp" style={{ background: rampCss(baseLayer), marginTop: 10 }} />
        <p className="note">
          Dataset <code>elevation</code>, step {props.step ?? "—"}, sampled by
          nearest cell — the run's own cells, never interpolated between.
          Projection: plate carrée, east–west scale varying by{" "}
          {(props.patch.scaleError * 100).toFixed(1)} % across the patch.
        </p>
        <p className="note">
          Plates, crust and temperature are not offered here: this grid carries
          elevation only, and colouring them from height would be a guess.
        </p>

        <div className="rule" />
        <h4>Relief shading</h4>
        <Slider
          label="Sun azimuth" min={0} max={359} step={5}
          value={sunAzimuth} display={`${sunAzimuth}°`}
          onChange={setSunAzimuth}
        />
        <Slider
          label="Vertical exaggeration" min={1} max={80}
          value={verticalExag} display={`${(verticalExag / 10).toFixed(1)}×`}
          onChange={setVerticalExag}
        />

      </aside>

      {/* The strip carries this screen's own controls only. Moving between
          views is the header's job, on both views, so it reads the same. */}
      <div className="panel tape">
        <button className="btn btn--icon" onClick={() => setSheetOpen(o => !o)}>
          {sheetOpen ? "Hide panels" : "Layers & export"}
        </button>
        <div className="tape__job">
          <span>
            plate carrée · {(props.patch.widthM / 1000).toFixed(0)} ×{" "}
            {(props.patch.heightM / 1000).toFixed(0)} km · step {props.step ?? "—"}
          </span>
        </div>
      </div>

      <ExportPanel
        open={sheetOpen}
        patch={props.patch}
        engine={region.engine}
        sizes={region.sizes}
        resolution={region.resolution}
        tiles={region.tiles}
        detailOctaves={region.detailOctaves}
        groundSampleM={region.groundSampleM}
        scaleError={region.scaleError}
        warnings={region.warnings}
        blocked={region.blocked}
        simCellM={props.planet.derived.simCellM}
        heightRangeM={heightRangeM}
        job={exportJob.status}
        onEngine={region.chooseEngine}
        onResolution={region.setResolution}
        onTiles={region.setTiles}
        onDetailOctaves={region.setDetailOctaves}
        onMakeSquare={region.makeSquare}
        onExport={() => {
          // The export cuts the step on screen. `atTime` is the run fraction
          // that step sits at, which is what the exporter's contract asks for.
          void exportJob.start(props.planet.id, props.patch, {
            ...region.spec, atTime: frame?.t ?? 0,
          });
        }}
        onDownload={exportJob.download}
      />

      <Toast message={exportJob.error ?? toast} />
    </>
  );
}

/** Only the elevation-sourced layers reach here; see PREVIEW_LAYERS. */
function colourFor(layer: BaseLayerId, e: number): [number, number, number] {
  switch (layer) {
    case "bathy": {
      const r = e < 0 ? ramp(RAMPS.bathy, Math.max(0, 1 + e / 1.1)) : ([.16, .15, .14] as const);
      return [r[0], r[1], r[2]];
    }
    default: {
      const r = e >= 0
        ? ramp(RAMPS.land, Math.min(1, e / 0.9))
        : ramp(RAMPS.bathy, Math.max(0, 1 + e / 0.9));
      return [r[0], r[1], r[2]];
    }
  }
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, drawnWidth: number, patchWidthM: number, dpr: number,
) {
  const targetKm = (patchWidthM * 0.22) / 1000;
  const pow = 10 ** Math.floor(Math.log10(targetKm));
  const nice = [1, 2, 5, 10]
    .map(m => m * pow)
    .reduce((a, b) => (Math.abs(b - targetKm) < Math.abs(a - targetKm) ? b : a));
  const barPx = ((nice * 1000) / patchWidthM) * drawnWidth;

  ctx.strokeStyle = "#7b8fa0";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(x, y - 4 * dpr);
  ctx.lineTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.lineTo(x + barPx, y - 4 * dpr);
  ctx.stroke();

  ctx.fillStyle = "#7b8fa0";
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.fillText(nice >= 1 ? `${nice} km` : `${nice * 1000} m`, x + barPx + 8 * dpr, y + 3 * dpr);
}

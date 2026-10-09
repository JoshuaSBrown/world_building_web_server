import type { Engine, JobStatus, PatchSpec } from "../api/types";
import { fmt } from "../lib/colour";
import type { RegionWarning } from "../state/regionStore";
import { Progress, Row, Slider } from "./ui";

/**
 * Export configuration.
 *
 * Two things here are the difference between a file that imports
 * correctly and one that does not, and neither is guessable:
 *
 *  - resolution tables per engine (Unity 2ⁿ+1, Unreal's Landscape sizes)
 *  - the computed Z scale / terrain height, shown as literal values to
 *    paste into the importer
 *
 * The synthesis note is deliberately blunt. Users will otherwise assume
 * every ridge came from the tectonic solver, and at a 40 km tile almost
 * none of it did.
 */
export function ExportPanel(props: {
  open: boolean;
  patch: PatchSpec | null;
  engine: Engine;
  sizes: readonly number[];
  resolution: number;
  tiles: number;
  detailOctaves: number;
  groundSampleM: number | null;
  scaleError: number;
  warnings: RegionWarning[];
  blocked: boolean;
  simCellM: number | null;
  heightRangeM: number | null;
  job: JobStatus | null;
  onEngine: (e: Engine) => void;
  onResolution: (n: number) => void;
  onTiles: (n: number) => void;
  onDetailOctaves: (n: number) => void;
  onMakeSquare: () => void;
  onExport: () => void;
  onDownload: () => void;
}) {
  const running = props.job?.state === "running" || props.job?.state === "queued";
  const done = props.job?.state === "complete";
  const posts = props.resolution ** 2 * props.tiles ** 2;
  const finestM = props.simCellM ? props.simCellM / 2 ** props.detailOctaves : null;

  return (
    <aside className="panel export" data-open={props.open}>
      <h4>Export</h4>
      <div className="rule" />

      <label className="field__name" htmlFor="engine">Target engine</label>
      <select
        id="engine"
        value={props.engine}
        onChange={e => props.onEngine(e.currentTarget.value as Engine)}
        style={{ marginBottom: 10 }}
      >
        <option value="unity">Unity — Terrain (.raw)</option>
        <option value="unreal">Unreal — Landscape (16-bit .png)</option>
        <option value="generic">Generic — 16-bit .png</option>
      </select>

      <label className="field__name" htmlFor="res">Heightmap resolution</label>
      <select
        id="res"
        value={props.resolution}
        onChange={e => props.onResolution(Number(e.currentTarget.value))}
        style={{ marginBottom: 10 }}
      >
        {props.sizes.map(n => <option key={n} value={n}>{n} × {n}</option>)}
      </select>

      <label className="field__name" htmlFor="tiles">Tiles</label>
      <select
        id="tiles"
        value={props.tiles}
        onChange={e => props.onTiles(Number(e.currentTarget.value))}
        style={{ marginBottom: 10 }}
      >
        {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} × {n}</option>)}
      </select>

      <Slider
        label="Detail octaves" min={0} max={10}
        value={props.detailOctaves} display={String(props.detailOctaves)}
        onChange={props.onDetailOctaves}
      />

      {props.simCellM && props.detailOctaves > 0 ? (
        <p className="note note--warn">
          Synthesising {(props.simCellM / 1000).toFixed(0)} km down to{" "}
          {((finestM ?? 0) / 1000).toFixed(2)} km. Everything below{" "}
          {(props.simCellM / 1000).toFixed(0)} km is invented, not simulated.
        </p>
      ) : props.simCellM ? (
        <p className="note">
          No synthesis. Below {(props.simCellM / 1000).toFixed(0)} km the map is
          interpolated from simulated cells and will look smooth.
        </p>
      ) : null}

      <div className="rule" />
      <Row
        label="Ground sample"
        value={props.groundSampleM === null ? "—"
          : props.groundSampleM >= 1000
            ? `${(props.groundSampleM / 1000).toFixed(2)} km/post`
            : `${props.groundSampleM.toFixed(1)} m/post`}
      />
      <Row
        label="Extent"
        value={props.patch === null ? "—"
          : `${(props.patch.widthM / 1000).toFixed(1)} × ${(props.patch.heightM / 1000).toFixed(1)} km`}
      />
      <Row label="Total posts" value={fmt(posts)} />
      <Row
        label="Projection error"
        value={props.scaleError < 1e-4 ? "< 0.01 %" : `${(props.scaleError * 100).toFixed(2)} %`}
      />
      <Row
        label="Height range"
        value={props.heightRangeM === null ? "—" : `${fmt(props.heightRangeM)} m`}
      />

      <div className="rule" />
      <ImportSettings
        engine={props.engine}
        patch={props.patch}
        tiles={props.tiles}
        resolution={props.resolution}
        heightRangeM={props.heightRangeM}
      />

      {props.warnings.map(w => (
        <p key={w.message} className={w.level === "block" ? "note note--block" : "note note--warn"}>
          {w.message}
        </p>
      ))}

      {running ? (
        <Progress value={props.job?.state === "running" ? props.job.progress : null} />
      ) : null}

      {done ? (
        <button className="btn btn--primary btn--block" style={{ marginTop: 12 }} onClick={props.onDownload}>
          Download archive
        </button>
      ) : (
        <button
          className="btn btn--primary btn--block"
          style={{ marginTop: 12 }}
          disabled={props.blocked || running || props.patch === null}
          onClick={props.onExport}
        >
          {running ? "Exporting…" : "Export heightmap"}
        </button>
      )}

      <button className="btn btn--block" style={{ marginTop: 8 }} onClick={props.onMakeSquare}>
        Make region square
      </button>
    </aside>
  );
}

/**
 * The literal numbers to type into the importer.
 *
 * Computed, not guessed. Unreal's Z scale in particular is the single
 * most common cause of terrain that imports at the wrong height, and it
 * is not something a user can derive from the file.
 */
function ImportSettings(props: {
  engine: Engine;
  patch: PatchSpec | null;
  tiles: number;
  resolution: number;
  heightRangeM: number | null;
}) {
  if (!props.patch || props.heightRangeM === null) return null;
  const tw = props.patch.widthM / props.tiles;
  const tl = props.patch.heightM / props.tiles;

  if (props.engine === "unity") {
    return (
      <div className="settings">
        <div className="settings__head">Unity — Import Raw</div>
        <Row label="Depth" value="16 bit" />
        <Row label="Resolution" value={`${props.resolution} × ${props.resolution}`} />
        <Row label="Byte order" value="Windows" />
        <div className="settings__head" style={{ marginTop: 9 }}>Terrain settings</div>
        <Row label="Terrain Width" value={`${fmt(tw)} m`} />
        <Row label="Terrain Length" value={`${fmt(tl)} m`} />
        <Row label="Terrain Height" value={`${fmt(props.heightRangeM)} m`} />
      </div>
    );
  }

  if (props.engine === "unreal") {
    // Epic: cm × 1/512, because Landscape spans −256..256 units.
    const scaleZ = (props.heightRangeM * 100) / 512;
    const scaleXY = (tw / (props.resolution - 1)) * 100;
    return (
      <div className="settings">
        <div className="settings__head">Unreal — Landscape import</div>
        <Row label="Format" value="16-bit greyscale PNG" />
        <Row label="Overall resolution" value={`${props.resolution} × ${props.resolution}`} />
        <Row label="Scale X / Y" value={scaleXY.toFixed(3)} />
        <Row label="Scale Z" value={scaleZ.toFixed(3)} />
        <p className="note">
          Z scale is range × 100 ÷ 512. Value 32768 sits at the midpoint of the
          exported range, not at sea level.
        </p>
      </div>
    );
  }

  return (
    <div className="settings">
      <div className="settings__head">Generic</div>
      <Row label="Format" value="16-bit greyscale PNG" />
      <Row label="Row order" value="north first" />
      <Row label="Range" value={`${fmt(props.heightRangeM)} m across 0…65535`} />
    </div>
  );
}

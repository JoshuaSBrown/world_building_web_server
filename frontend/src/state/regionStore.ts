import { useCallback, useMemo, useState } from "react";
import type { Engine, ExportSpec, PatchSpec } from "../api/types";

/**
 * The patch and its export settings.
 *
 * Everything here is arithmetic on numbers the server already produced —
 * counting posts, dividing an extent by a post count, comparing one
 * length against another. No geodesy: the patch's own geometry, including
 * `scaleError`, arrives from the Rust side and is passed through.
 *
 * The warnings exist because two settings decide whether a file imports
 * correctly, and neither is guessable from the UI alone.
 */

export interface RegionWarning {
  level: "warn" | "block";
  message: string;
}

/**
 * Legal heightmap sizes per engine. These are the engines' own
 * constraints, not a preference: Unity wants 2ⁿ+1, Unreal's Landscape has
 * a fixed recommended set, and a generic 16-bit PNG has neither.
 */
const SIZES: Record<Engine, readonly number[]> = {
  unity: [33, 65, 129, 257, 513, 1025, 2049, 4097],
  unreal: [127, 253, 505, 1009, 2017, 4033],
  generic: [256, 512, 1024, 2048, 4096],
};

/** Above this the browser's own preview and the archive both get unreasonable. */
const MAX_POSTS = 64e6;

export function useRegion(simCellM: number | null, radiusM: number) {
  const [patch, setPatch] = useState<PatchSpec | null>(null);
  const [engine, setEngine] = useState<Engine>("unity");
  const [resolution, setResolution] = useState(1025);
  const [tiles, setTiles] = useState(1);
  const [detailOctaves, setDetailOctaves] = useState(0);

  const sizes = SIZES[engine];

  /** Switching engine snaps the resolution to the nearest legal size for it. */
  const chooseEngine = useCallback((e: Engine) => {
    setEngine(e);
    setResolution(prev => nearest(SIZES[e], prev));
  }, []);

  /** Equal extents in metres. The server re-derives the outline from the edited spec. */
  const makeSquare = useCallback(() => {
    setPatch(p => (p ? { ...p, heightM: p.widthM } : p));
  }, []);

  const posts = resolution * tiles;
  const groundSampleM = patch ? patch.widthM / (posts - 1) : null;

  const warnings = useMemo<RegionWarning[]>(() => {
    const out: RegionWarning[] = [];
    if (!patch) {
      out.push({ level: "block", message: "Draw a region on the globe before exporting." });
      return out;
    }
    if (posts ** 2 > MAX_POSTS) {
      out.push({
        level: "block",
        message: `${fmtInt(posts ** 2)} posts is beyond what this build will bake. Reduce the resolution or the tile count.`,
      });
    }
    if (simCellM !== null && groundSampleM !== null && detailOctaves === 0
        && groundSampleM < simCellM / 4) {
      out.push({
        level: "warn",
        message: `Posts are ${(simCellM / groundSampleM).toFixed(0)}× finer than the ${(simCellM / 1000).toFixed(0)} km simulated cell. With no synthesis the extra posts are interpolated, not new information.`,
      });
    }
    if (patch.scaleError > 0.02) {
      out.push({
        level: "warn",
        message: `The projection stretches this patch by up to ${(patch.scaleError * 100).toFixed(1)} %. A smaller region, or one nearer the equator, distorts less.`,
      });
    }
    if (patch.widthM > radiusM) {
      out.push({
        level: "warn",
        message: "This region spans a large fraction of the body. A flat heightmap cannot represent it without visible distortion.",
      });
    }
    return out;
  }, [patch, posts, simCellM, groundSampleM, detailOctaves, radiusM]);

  const spec = useMemo<Omit<ExportSpec, "atTime">>(
    () => ({ engine, resolution, tiles, detailOctaves }),
    [engine, resolution, tiles, detailOctaves],
  );

  return {
    patch, setPatch,
    engine, chooseEngine, sizes,
    resolution, setResolution,
    tiles, setTiles,
    detailOctaves, setDetailOctaves,
    groundSampleM,
    scaleError: patch?.scaleError ?? 0,
    warnings,
    blocked: warnings.some(w => w.level === "block"),
    makeSquare,
    spec,
  };
}

function nearest(options: readonly number[], value: number): number {
  return options.reduce(
    (best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best),
    options[0] ?? value,
  );
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

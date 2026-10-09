import { useReducer } from "react";
import type { BaseLayerId, OverlayId } from "../lib/colour";

/**
 * Presentation settings for the viewer — and only presentation settings.
 *
 * Elevation arrays never come near this reducer; they go straight into a
 * GPU buffer. What lives here is what the user chose to look at, which
 * changes at human speed.
 *
 * Base layers are a radio group and overlays are checkboxes. Water is a
 * cut through the elevation field, not a peer of topography, and the
 * control shape encodes that.
 */
export interface ViewerState {
  baseLayer: BaseLayerId;
  overlays: Record<OverlayId, boolean>;
  /** 0–60, a display exaggeration of radial relief. Labelled in the UI. */
  exaggeration: number;
  /** Metres added to the solved sea level, for re-cutting the coastline. */
  seaOffsetM: number;
  /** How the globe is lit. `flat` shows the value; `sun` shows the shape. */
  lighting: "sun" | "flat";
  /** Simulated fraction currently on screen, 0–1. */
  t: number;
  /** Which panel is open. On a phone the panels are bottom sheets, one at a time. */
  sheet: "none" | "rail" | "info";
}

export type ViewerAction =
  | { type: "baseLayer"; id: BaseLayerId }
  | { type: "overlay"; id: OverlayId }
  | { type: "exaggeration"; v: number }
  | { type: "seaOffset"; v: number }
  | { type: "lighting"; mode: ViewerState["lighting"] }
  | { type: "time"; t: number }
  | { type: "sheet"; sheet: ViewerState["sheet"] };

const INITIAL: ViewerState = {
  baseLayer: "topo",
  overlays: {
    water: true, boundaries: false, motion: false, graticule: false, points: false,
  },
  exaggeration: 18,
  seaOffsetM: 0,
  lighting: "sun",
  t: 0,
  sheet: "rail",
};

function reduce(s: ViewerState, a: ViewerAction): ViewerState {
  switch (a.type) {
    case "baseLayer": return { ...s, baseLayer: a.id };
    case "overlay": return { ...s, overlays: { ...s.overlays, [a.id]: !s.overlays[a.id] } };
    case "exaggeration": return { ...s, exaggeration: a.v };
    case "seaOffset": return { ...s, seaOffsetM: a.v };
    case "lighting": return { ...s, lighting: a.mode };
    case "time": return { ...s, t: a.t };
    case "sheet": return { ...s, sheet: s.sheet === a.sheet ? "none" : a.sheet };
  }
}

export function useViewerState() {
  return useReducer(reduce, INITIAL);
}

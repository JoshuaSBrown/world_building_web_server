# Orrery — web client

React + TypeScript. Four screens: catalogue, create, viewer, map view.

Read `web_server/CLAUDE.md` first, then the superproject's. The one rule that
shapes every file here: **this repo derives nothing.** Every number on screen
came from a dataset the simulation wrote, and anything the run did not record
is drawn as absent rather than as zero.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # logic tests, node --test, no framework
npm run typecheck    # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run build        # typecheck, then a production bundle in dist/
```

The client is complete and runs today. **The Rust server is not built yet**, so
`/api` has nothing behind it: the catalogue reports that the list is unknown
rather than showing an empty shelf, and the viewer draws the icosphere grid with
every quantity reading "not recorded". That is the intended state — the
alternative is inventing a planet, which is the one thing this repo forbids.

Everything that does not need the server is live: the creation form and its
derived column, all four routes, globe orbit / zoom / pick, layer and overlay
toggles, the timeline bands, and the export panel's engine tables.

`vite.config.ts` proxies `/api` to `http://127.0.0.1:8080`. Point it elsewhere
with `VITE_API_TARGET`, or set `VITE_API_BASE` to skip the proxy entirely.

## Layout

```
src/
  App.tsx                shell + routing
  main.tsx               entry
  styles.css             design tokens (no Tailwind — see below)

  api/
    types.ts             the contract with the Rust server
    client.ts            the only module that knows the server exists

  components/
    Header.tsx           nav
    Catalogue.tsx        saved worlds
    CreatePlanet.tsx     parameter form; inputs left, derived right
    Viewer.tsx           container: stream → globe → panels
    Globe.tsx            Three.js, imperative handle (React does not own the loop)
    LayerRail.tsx        base layers (radio) + overlays (checkbox) + the scale
    InfoPanel.tsx        planet stats + picked-cell readout
    Timeline.tsx         stratigraphic tape: progress bar AND scrubber
    RegionControls.tsx   draw / size / rotate the patch
    MapView.tsx          flat patch, canvas 2D hillshade
    ExportPanel.tsx      engine profiles + computed import settings
    ui.tsx               Slider, TextField, Row, Toast, Progress

  hooks/
    useSimulationStream.ts  SSE events, frames pulled by GET, via callback not state
    usePlanetField.ts       WASM field lifecycle (+ free() on teardown)
    useExportJob.ts         polled export job

  state/
    useRouter.ts         four routes, no library
    useViewerState.ts    reducer: layers, exaggeration, time, sheet
    regionStore.ts       patch + export config + client-side validation

  lib/
    colour.ts            ramps, layer defs, legend text
    stages.ts            timeline bands
    icosphere.ts         topology only (positions, not physics)
    lib.test.ts          the provable parts of lib/
```

## Decisions

**SSE for events, ordinary GET for data.** `web_server/CLAUDE.md` settles this:
the stream carries "status changed" and "step N landed", never a payload. The
browser then decides whether it still wants step N. If the simulation outruns
the display, `useSimulationStream` overwrites its pending step and skips to the
newest — backpressure with nothing buffered anywhere. Pushing arrays down the
event stream would queue them in the server instead.

**Globe is imperative.** React owns a `GlobeHandle`, not the render loop or the
buffers. Frames arrive at ~6 Hz and vertex colours change on every toggle;
routing either through state re-renders the viewer tree for work that ends in a
GPU upload. Props for rare changes, methods for frequent ones.

**Frames never enter React state.** `useSimulationStream` takes an `onFrame`
callback. 40 000 floats going into a `BufferAttribute` have no business in a
`useState`.

**The colour scale is fixed and always on screen.** Every base layer declares
its two ends in real units, plus the dataset the numbers came from, and the rail
prints both. A silent per-frame autoscale would make a planet in steady state
appear to churn.

**Timeline is one component with two lifecycles.** Progress bar while running,
scrubber when done. A progress bar that vanishes on completion is dead pixels.

**Base layers are a radio group, overlays are checkboxes.** Water is a cut
through the elevation field, not a peer of topography. The control shape encodes
that.

**Geodesy stays in Rust.** `patchFromDrag`, `patchOutline` and `previewPatch`
are WASM calls into the same crate the exporter runs. A TypeScript copy would
eventually disagree with the exporter about where the user's rectangle is, and
the user would never be told which one to believe.

`icosphere.ts` is the deliberate exception: pure topology, formula-derived,
identical for every planet. Geometry is not physics, so there is no drift
risk — and shipping 40 000 vertices to describe something with no free
parameters would be silly. Vertex *i* is cell *i* in every array the server
sends; that index correspondence is the whole contract.

**No Tailwind.** The palette is small and the rule "amber means live, cyan means
finished" is enforceable in one token file. Utility classes would scatter it.

## What the rules cost, concretely

Three things in the original draft drew values the model never produced. They
are gone, and the reasoning is worth keeping:

- `CreatePlanet` predicted **plate count** (`5 + 22 × heat`) and **runtime**.
  Both were class-(c) coefficients picked to look right, presented to the user
  as forecasts. Removed. Mass, gravity, escape velocity and cell spacing stay —
  those are closed-form consequences of the form's own inputs, and watching
  gravity move as you drag density is what teaches the model.
- `Viewer` scaled crust age by a bare `0.42` on its way to gigayears. Now it is
  the recorded fraction times the body's age: a unit conversion, nothing more.
- `MapView` coloured its **plate** and **temp** layers from elevation, because
  the preview buffer only carries elevation. Those layers are no longer offered
  there, and the panel says why. A plausible-looking wrong thing is worse than a
  missing one.

`reliefM` — metres of relief per unit of the dimensionless field — was a bare
`9000` in two files. It is a property of the run, so it now arrives as
`derived.reliefM` and the client only multiplies.

## Verification

```
npm run typecheck    # clean
npm test             # 3 passing
npm run build        # clean
```

`noUncheckedIndexedAccess` earns its keep across `Globe.paint` and the icosphere
subdivision, where an out-of-range index would otherwise become a silent `NaN`
in a vertex buffer.

`lib.test.ts` covers the parts of `lib/` that are provable rather than visual:
ramp clamping (including `NaN`, which is how "not recorded" reaches a colour
function), timeline bands tiling [0, 1] with no gap or overlap, and icosphere
topology — closed manifold (every edge in exactly two faces), Euler
characteristic V − E + F = 2, and every vertex on the unit sphere.

The five screens that do not need WebGL were checked by server-rendering them;
the globe and the hillshade canvas have not been verified in a browser here,
because none is available in this environment.

## Known gaps

- **No backend.** Every `api/client.ts` route is a proposal until the Rust
  server implements it. `SCHEMA_MAJOR` is checked on step payloads; keep a
  golden fixture run directory in the server's tests so a schema drift in
  `PlanetBuilder` fails there rather than in a browser.
- **`pkg/orrery_wasm.js` does not exist.** `usePlanetField` reports its absence
  and every caller draws nothing. Build it with `wasm-pack build --target web`
  and generate the `.d.ts` — do not hand-write a stub, which is a compile-time
  lie.
- **`CreatePlanet`'s advisory text** states physical thresholds (escape velocity
  for water retention, the density above which no mantle remains, the mantle
  temperature below which a stagnant lid forms) with no source. They are prose,
  not plotted values, but they are still unsourced physics in the display layer.
  They should come from the server, or cite the notebook they came from.
- **`lib/stages.ts` shares are a display default.** A run should declare its own
  stage schedule and the server should send it; the table here is the fallback.
- **No error boundary around `Viewer`.** A WASM throw currently surfaces as a
  toast; it should degrade to the streamed preview.
- **Rule 5 is not wired.** `PlanetBuilder` owes a before/after/difference view
  per physics module, and this is where those get seen. Nothing in the UI steps
  through one module's contribution yet. When it lands, the pair must share one
  colour scale — the union of both frames — and the difference view must be
  symmetric about zero.

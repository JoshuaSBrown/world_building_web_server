# web_server — orientation

An interactive display of a planet's surface: launches simulation runs and shows what
they produce, live, as the files land.

Read the superproject's `CLAUDE.md` first. The five rules apply here — this file states
what each one means for a display layer, because several of them bite harder here than
they do in the physics code.

---

## The rules, translated

### 1. This repo contains no physics

The physics rule for `PlanetBuilder` is "derive it from fundamental principles". The
display-layer form of the same rule is stronger: **derive nothing at all.** Every number
shown comes from a dataset the simulation wrote. The server does not compute elevation,
does not estimate a density, does not fill a gap with a plausible value.

The failure this prevents is specific and easy to commit: **drawing something the model
never computed.** `view_planet.py` already settled the canonical case — maps use
nearest-point lookup, not smooth interpolation, because nearest-point reproduces exactly
the Voronoi cell each point owns, which is the model's own notion of the surface.
Interpolating would draw topography that does not exist. Follow that everywhere:

- no interpolation, smoothing, or resampling that invents intermediate values;
- no extrapolation past the recorded range;
- no "cleaning" of outliers — an outlier is a result, and hiding it was
  `PROBLEMS.md` audit item #8;
- no default that silently substitutes for missing data. Absent is drawn as absent.

Unit conversion and projection to screen coordinates are display, not derivation, and
are fine — labelled with the units they came from.

### 2. Show the model's own quantities, honestly labelled

The exact-form rule becomes: what is on screen is the recorded quantity, and any
transform applied for legibility is **visible in the UI**, not baked in silently.

- Radial exaggeration is labelled and toggleable against true scale — `view_planet.py`
  offers EXAGGERATED / TRUE SCALE, and that is the standard.
- **The colour scale is explicit, controllable, and always displayed.** Both modes are
  legitimate — `auto` (from the data in view) and a fixed `(min, max)` — and the viewer
  can switch between them and set limits **interactively, on the fly**. What is not
  legitimate is a scale that changes without saying so: a silent per-frame autoscale
  makes a planet in steady state appear to churn and flattens a real trend, because
  every frame is renormalized to look the same. So the mode and the limits in effect are
  on screen at all times, and when a fixed scale clips, the number of values beyond it is
  reported rather than hidden.
- **Two frames being compared share one scale.** Before/after pairs autoscale over the
  *union* of both frames, never independently — two scales is precisely the case where
  auto is wrong, because the comparison is the point. Difference views are symmetric
  about zero in either mode.
- Every layer states its units and its source dataset. A number without a unit is not
  data — the writer already carries units as an attribute on every array, so pass them
  through to the UI rather than re-deriving them.
- Anything the run did not record is reported as not recorded, never as zero.

### 3. Every displayed quantity is traceable

The identifier rule's form here: a viewer can always answer *where did this number come
from*. Each layer names the run, the step, the file, the dataset path, and the units it
is drawing — in the UI, not only in code comments. If a value passed through a
simulation law with a notebook identifier, surfacing that identifier is better still:
it closes the chain from pixel back to equation.

### 4. Interfaces are king

The same tree discipline, the same executable intent:

- **`web_server` never imports `tectonics`.** It is a sibling of `PlanetBuilder`, and
  siblings do not import siblings. The run directory is the entire interface. A
  simulation run is a **subprocess**, never an in-process call — which also means a
  crashing run cannot take the server down.
- Layers of this repo talk through interfaces the same way: `store` (read the run
  directory) → `api` (HTTP/SSE) → `ui` (browser). The reader knows nothing about HTTP;
  the UI knows nothing about HDF5; nothing skips a layer.
- **Interfaces are stable by default.** The HTTP API and the run-directory schema are
  both public contracts — extend them (new endpoint, new field, new dataset), do not
  change or repurpose what exists. A changed response shape breaks a client you cannot
  see; a repurposed dataset breaks every stored run.
- **Modularity is the test.** A new visualization layer — a new field, a new overlay, a
  new chart — must be addable **without touching any other layer**. Same bar the physics
  strategies meet: new capability as a new implementation of an existing protocol,
  selected by configuration. If adding a layer means edits scattered through unrelated
  modules, the coupling is the bug.
- Keep interfaces small. A layer that needs one array and a colour range should be
  handed one array and a colour range.

### 5. Show what each thing contributes

`PlanetBuilder` owes a before/after/difference view for every physics module. **This is
where those get seen.** The natural home for rule 5 is a UI that can step through
iterations and toggle one module's contribution at a time, on a shared colour scale,
with the difference available as its own view.

The display-layer form of the rule stands on its own too: every layer is independently
toggleable, so a viewer can always isolate what one thing contributes rather than
inferring it from a composite.

---

## Pure observer — extended, not weakened

`Observatory` is a pure observer of the physics: no output can influence a result. The
web server extends that guarantee to a process boundary and must not weaken it.

- **The server may start a run and may stop it. It may never steer one.** No poking the
  planet mid-run, no adjusting a parameter between steps, no feedback of any kind from
  the display into the simulation. That would destroy both the pure-observer property
  and seeded reproducibility, which are load-bearing everywhere else in this project.
- **A run produces identical results whether anything is watching or not.** Same seed,
  same config, same numbers — observed live, replayed later, or run headless.
- **A view is a function of the files.** Given a run directory and a step, the display is
  reproducible. Nothing is stored only in the server's memory, so a restart loses no
  result and the same URL always shows the same thing.

---

## The run directory is the interface

The simulation writes a directory; the server watches it. There is no shared database,
no socket protocol into the simulator, no HDF5 concurrency.

```
runs/<run_id>/
  run.json          once at launch: schema_version, config, seed, models
  status.json       atomically rewritten: state, last step, heartbeat, exit code
  manifest.jsonl    append-only, one line per completed step + its scalar diagnostics
  steps/000123.h5   one file per recorded step
  effects/          rule-5 before/after/difference images
  run.log           subprocess stdout/stderr
```

Two properties make this safe to read while it is being written, with no locking:

- **Step files are written to a temp name and renamed into place.** `rename()` is atomic,
  so a reader sees a complete file or no file — never half of one.
- **The manifest is append-only JSONL.** Tailing is safe; a torn final line is invalid
  JSON, so skip it and re-read on the next poll.

Read the timeline from `manifest.jsonl` — it carries each step's scalar diagnostics, so
charts and the scrubber stream without opening a single `.h5`. Open a step file only for
the step actually being displayed.

**`schema_version` is checked before anything is drawn.** An unknown major version is
refused with a clear message; half-rendering a file you do not understand is how a
viewer starts lying. Keep a golden fixture run directory in the tests, so a schema drift
in `PlanetBuilder` fails here as a test rather than in a browser.

---

## Layout

The tree rule, applied:

```
web_server/
  store/       reads run directories: manifest, step files, status. Knows no HTTP.
  runner/      launches and supervises simulation subprocesses. Knows no HTTP, no HDF5 semantics.
  api/         HTTP endpoints + SSE. Knows no HDF5 and no rendering.
  ui/          browser: rendering, layers, controls. Knows no filesystem.
  schema/      the run-directory contract + version checks, shared by store and runner
```

Siblings do not import siblings. `ui` receives typed payloads over HTTP because the
browser cannot read HDF5 — that translation is `api`'s job and nobody else's.

---

## Clarity over performance

Same stance as the rest of the project: this is a prototype. Readable request handling
and obvious data flow beat a fast pipeline that nobody can follow. Performance work
happens later, in its own codebase, against a specification this one makes correct.

If a view is too slow, reduce what it asks for — fewer points, a coarser grid, a thinner
step cadence — and **say so on screen**, the same way the simulation declares a
resolution choice. Silently downsampling and presenting the result as the full picture
is the display-layer version of a fudge factor.

## Explain it to a layman

The notebooks are written so a non-specialist can follow the physics. The UI is where
that pays off, and it carries the same obligation:

- terms explained where they appear — lithosphere, asthenosphere, subduction, Euler
  pole. A tooltip or a glossary panel, not an assumption;
- every layer captioned with what it shows and why it matters, in plain language;
- legends that say what a colour *means*, with units and the physical range;
- annotate Earth reference values where they help — **as comparisons, never as targets**,
  exactly as the figures do.

## Changes are as small as the change

No drive-by reformatting, no restructuring a working view because a different framework
appeals. Touch what the task needs. Replacing a working implementation requires a stated
justification, not a preference — and that goes double for anything that changes a
public contract, since the run schema and the HTTP API both have consumers you cannot
see from here.

---

## Things that will be rejected

- Any physics computed, estimated, or interpolated in this repo.
- Drawing a value the model never produced — including a smoothed or gap-filled one.
- A scale whose mode or limits are not shown on screen — including an autoscale the
  viewer cannot see is happening.
- Two frames compared side by side on two different scales.
- An unlabelled transform: exaggeration, downsampling, or unit conversion presented as
  the raw result.
- `import tectonics`, or any in-process call into the simulator.
- Anything that lets the display influence a running simulation.
- Rendering a file whose `schema_version` is not understood.
- A new layer that required edits to unrelated modules.
- A changed API response shape or run-directory field where a new one would have done.

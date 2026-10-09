# web_server — orientation

## Talk to the user in plain English — every repo, every reply

A standing instruction from the user, and it applies no matter which directory
the work is in:

> "Can you please speak in plain english not geological terms. Don't assume I
> have expertise in this area, when you are describing geology compare it to
> house hold items if necessary so I can understand the principals."

In practice: no geological or geophysical term goes unexplained — define it in
ordinary words at first use, or replace it entirely. Do not assume prior
expertise in this area. Where a mechanism is hard to picture, compare it to a
household thing (skin forming on cooling soup, a cracker snapping, honey
sheeting off a spoon, an ice cube shrinking as it floats). Abbreviations and
symbols get the same treatment: spell out what they stand for and what they
mean before leaning on them. The notebooks already owe this to their lay
reader; conversation, explanations, and reports owe it too.

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

## Three pages, and two modes in the viewer

- **Catalogue → planet → viewer.** Choosing a body opens its *simulations* page,
  not the globe: a planet is not one run. The page lists what has been run for
  that body and what can be run next, and an entry whose inputs do not exist is
  **offered as blocked with the reason** rather than hidden or quietly greyed. A
  control that cannot be pressed and does not say why is worse than no control.
- **Prerequisites are checked against the files.** "Core & surface formation has
  finished for this planet" means a run directory that says `complete`, asked of
  the server — never inferred from the planet existing.
- **The viewer has a simulation mode and an edit mode**, and the difference is
  not cosmetic. Simulation mode offers every layer the run recorded and can play
  the recorded steps in order. Edit mode offers **topography only**: an edit
  moves the surface, and every other layer describes the surface before it moved.
  They are withheld rather than hidden — pairing a physical field with a surface
  it never belonged to is exactly the lie this repo is organised against — and
  getting them back needs a **recalculation**, which the engine performs and the
  browser never simulates.
- **An edit is art and says so.** It is a delta on the run's own cells, kept
  verbatim, and the planet reads `contains manual edits` while one is pending
  (`docs/09`). Nothing downstream can apply one yet, and the button says that
  instead of appearing to work.
- **A movie is the recorded steps, in order.** Nothing is interpolated between
  them to smooth the motion, and playback only exists once every step is
  readable. The colour scale can be **held** across frames, because an auto scale
  recomputed per frame makes a planet in steady state appear to churn.

## The launch config is the input

A run has exactly one input: a TOML launch config, described by
`planet_run_schema/schema/config-v1.0.json`. `runner` writes one per job into
`CONFIGS_DIR` (default `./configs`) as `<jobId>.toml` and spawns
`evolve.py --config <that file>` — there is no other flag, so a parameter can never
be set somewhere the simulation forgets to read.

- **The config directory is not the run directory.** The run directory belongs to
  the writer and its layout is the run format's; a config is this server's own
  output, so where they are collected is a deployment's choice.
- **It is validated before anything is spawned**, by running the contract's own
  `validate_config.py` — not a second implementation of the same rules in Rust,
  because two checkers drift and the one that matters is the one `evolve.py` is
  held to. No validator, no run: a config nobody checked is how a parameter gets
  dropped unnoticed. `RUN_SCHEMA` points at the `planet_run_schema` checkout.
- **A request parameter the config has no key for is reported**, in
  `unappliedParams`, never quietly dropped.
- **Paths in it are absolute**, because the simulation is a subprocess with its own
  working directory, and the file is reusable by hand: `python evolve.py --config
  configs/<jobId>.toml` reproduces the run.

## The run directory is the interface

The simulation writes a directory; the server watches it. There is no shared database
and no socket into the simulator. The full contract is `PlanetBuilder/RUN_FORMAT.md`,
which the writer owns; the essentials:

```
runs/<run_id>/
  run.json          once at launch: schema_version, config, seed, models
  status.json       atomically rewritten: state, last step, heartbeat, exit code
  manifest.jsonl    append-only: a line per recorded step, a line per CLOSED part
  parts/run_p003.h5 the recorded iterations, `split_every` per file
  figures/          rule-5 before/after/difference images
  run.log           subprocess stdout/stderr
```

### What you may assume, and what you must ask the file

**Assume exactly six things.** `schema_version` and `radius_m` in a part's root attrs,
`time_s`/`time_myr` on each step, and `cloud/{pos, elevation, plate_id}` — geometry,
topography, plate identity. That is the required core, guaranteed in *every* recorded
step, and it is enough for both headline views. Anything else may be absent from a
given run, and absent is drawn as absent.

**Ask the file about everything else.** Every dataset declares itself in four
attributes, and they are the contract — the group names are not:

| attribute | use it for |
|---|---|
| `units` | the label and the legend. CF's attribute, udunits-parseable, `"1"` dimensionless. Never hardcode a unit you assume; `""` means *undeclared*, so report it rather than invent one |
| `kind` | `scalar` → continuous colour scale; `vector` → trailing axis is components; `category` → colour by identity, never interpolate, difference only as changed/unchanged |
| `domain` | **what the field is one-per.** Pair a field with `pos` only when the domains match |
| `long_name` | what to call it on screen, so the UI does not carry its own name for a field |

**`domain` is not the group name, and the difference matters.** `cloud/strain` sits
beside `cloud/pos` and is *not* co-indexed with it — it is computed before the step
creates and consumes points. It declares `domain="cloud_pre_transport"`. A length check
would not save you: the lengths agree on the steps where nothing was created or
consumed, and a field drawn one point out of register looks entirely plausible.

**The flexibility is in the file, not in this server.** Endpoints and wire types stay
hand-written per field: a new physics field never breaks a reader, but it appears in the
UI when someone adds it here, deliberately. That is the trade — the *contract* never has
to be renegotiated, and the display stays explicit about what it shows rather than
surfacing whatever it happens to find.

**The unit of publication is a part, not an iteration.** A closed HDF5 file is safe
for unlimited concurrent readers; a file still open for writing is not, and SWMR --
HDF5's answer to that -- is unavailable here because the writer creates a group per
iteration and SWMR freezes a file's structure. So:

- **Read a part only after its `part` line appears in the manifest.** The in-progress
  file is on disk and must be ignored; a directory listing is not the index.
- **The manifest is append-only JSONL**, safe to tail. A torn final line is invalid
  JSON: skip it and re-read on the next poll.
- **Live latency is `split_every` iterations**, and that is a configuration knob rather
  than something to engineer around.

**Read the timeline from the manifest.** Its `step` lines carry the scalar diagnostics
every recorded iteration, so charts and the scrubber stay live at full rate without
opening a single `.h5`. Open a part only for the step actually being displayed.

## Reading HDF5 without linking HDF5

`libhdf5` is a C library that serializes every call in a process behind one global
lock, so threads do not read in parallel however many files they open. **Separate
processes do.**

So this server keeps a **hot pool of worker processes**, each with `h5py` already
imported, and hands them "read step N from part file F" jobs. Two things fall out:

- **The server never links `libhdf5`.** No C dependency, no cross-compilation problem,
  and no global lock in the request path.
- **Reads are genuinely parallel**, one per worker, and a corrupt file kills one
  worker rather than the server.

Keep the pool warm: a cold Python process paying `import h5py` costs a few hundred
milliseconds, which is invisible per step and very visible while scrubbing a timeline.
Cap the pool, and treat a worker that stops answering as a failed read, not a hang.

## Talking to the browser

Two channels, both plain HTTP. Neither pushes bulk data.

- **Events: SSE.** One long-lived `GET /runs/:id/events` streaming short lines as steps
  and parts land. Browsers have `EventSource` built in and it reconnects itself.
  WebSockets are bidirectional machinery this does not need.
- **Data: ordinary GET.** `GET /runs/:id/steps/124/cloud` returns that step's arrays.

**The browser pulls; the server never pushes payloads.** If the simulation outruns the
display, the client skips to the newest step and never asks for what it missed --
backpressure with nothing buffered server-side. Pushing data down the event stream
would queue it in the server instead.

**JSON first.** At a few thousand points a step is a few hundred KB of JSON, parses in
milliseconds, and can be read in a browser tab while debugging. Move to raw typed
arrays when the point count makes that hurt -- around 50-100k points -- behind the same
URL via content negotiation, so the switch costs no redesign. Casting f64 to f32 for
the wire is a display-layer transform and gets declared like any other.

**`schema_version` is checked before anything is drawn.** An unknown MAJOR is refused
with a clear message; half-rendering a file you do not understand is how a viewer
starts lying. Keep a golden fixture run directory in the tests, so a schema drift in
`PlanetBuilder` fails here as a test rather than in a browser.

**The contract is executable, and this side should run it.** `planet_run_schema` holds
the format as machine-readable YAML plus `validate.py`; point it at the golden fixture in
the test suite so a drift is caught by the same checker the writer is held to, rather
than by a second reading of the prose:

```bash
python planet_run_schema/validate.py --strict-vocabulary tests/golden/parts/run_p000.h5
```

That repo is a shared leaf, not a sibling: depending on it is allowed and importing
`tectonics` still is not.

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

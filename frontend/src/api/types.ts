/**
 * The contract with the Rust server.
 *
 * The shapes are GENERATED from `web_server/api/openapi.yaml` into
 * `./generated/openapi.ts` (`npm run gen:api`); this file gives them the names
 * the rest of the client uses. A field is defined once, in the spec, and a
 * disagreement with the server is a type error rather than a wrong picture.
 * Never edit `./generated/` by hand — change the spec and regenerate.
 *
 * Every shape here is something the server produces. Nothing in this file
 * is computed in the browser — the display layer derives no physics, so a
 * quantity that is not on one of these types is a quantity the client
 * cannot show. Absent stays absent: optional fields are `| null` or
 * omitted, never defaulted to zero.
 *
 * Units are in the field name, and the name is the unit of record: `M` is
 * metres, `K` is kelvin, `Gyr` is gigayears, `M` on `waterGelM` is metres
 * of global equivalent layer. Elevation is dimensionless field units;
 * `reliefM` converts it for display and nowhere else.
 */
import type { components } from "./generated/openapi";

type Schemas = components["schemas"];

/** Initial conditions. Every one of these is an input the simulation consumes.
 *  `startMantleTemperatureK` is where the two-layer energy balance BEGINS — the
 *  post-magma-ocean initial condition, not the present-day temperature a run
 *  evolves to. `maxPoints` (100–10000) fixes the finest simulated scale. */
export type PlanetParams = Schemas["PlanetParams"];

/** Quantities the server derived from the params. The client never recomputes
 *  these. `simCellM`: nothing smaller was simulated. `reliefM`: the only
 *  legitimate way to put a metre figure on screen. */
export type PlanetDerived = Schemas["PlanetDerived"];

/**
 * The numerical choices one run was made with.
 *
 * Class (b) every one — a resolution, a step size, a cadence — which is why
 * they belong to the RUN and not to the planet. The planet's givens (diameter,
 * seed, starting temperature) are class (a) and fixed at creation.
 */
export type RunSettings = Schemas["RunSettings"];

/**
 * One simulation that has been run for a planet.
 *
 * A planet is not one run: a simulation can be re-run, and later ones consume
 * what earlier ones produced. This list is what the chooser reads to know
 * whether a simulation's inputs exist. `settings` is absent on runs recorded
 * before settings were kept.
 */
export type RunRef = Schemas["RunRef"];

/** A planet in the catalogue. `jobId` is the most recent run; `runs` is the full
 *  story, absent on planets made before runs were recorded — never fabricated. */
export type PlanetSummary = Schemas["PlanetSummary"];

/** A rectangle on the sphere. Produced by the server's geodesy, never by the client. */
export type PatchSpec = Schemas["PatchSpec"];

/**
 * `stepsTotal` is on every variant because it belongs to the job, not to the
 * state: a run is that many iterations long from the moment it is queued. So the
 * display reads one field in every state rather than remembering the last value
 * it happened to see, and can still say "40 of 40" once the run is over.
 * `cancelled` is stopped on purpose — neither a failure nor a completion.
 */
export type JobStatus = Schemas["JobStatus"];

/**
 * One field of one recorded step, with what the RUN FILE says about it.
 *
 * The four attributes are the contract; the group names are not. A colour bar
 * labelled from `units` says what the run said, and `units: ""` means the run
 * declared none — which the UI reports rather than filling in. `values` is
 * untyped in the spec (flat numbers, a row per element, or labels), so a reader
 * states which it expects where it reads it.
 */
export type FieldData = Schemas["FieldData"];

/**
 * One recorded step, fetched by the client after the event stream announces it.
 *
 * Values are one per SIMULATED CELL, not per display vertex — the model's own
 * cells. `domains[…].pos` says where those cells are, and the display projects
 * them onto its mesh by nearest-point lookup (`lib/nearest.ts`).
 *
 * `fields`, `domains`, `available` and `absent` are OMITTED by the server when
 * empty. `available` is every dataset the step holds; `fields` is only what this
 * request asked for — judging availability from `fields` would report every
 * layer but the one on screen as unrecorded.
 */
export type Frame = Schemas["CloudFrame"];

export type Engine = ExportSpec["engine"];

/** What the client asks the server to bake, alongside the patch. */
export type ExportSpec = Schemas["ExportSpec"];

/** A request the server refused before any handler ran (RFC 9457). */
export type Problem = Schemas["Problem"];

/** The error body of every other failing endpoint. */
export type ServerError = Schemas["Error"];

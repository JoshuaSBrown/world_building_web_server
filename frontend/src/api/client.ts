import type {
  ExportSpec, Frame, JobStatus, PatchSpec, PlanetParams, PlanetSummary, Problem, RunSettings,
  ServerError,
} from "./types";

/**
 * The only module that knows the server exists.
 *
 * Two channels, both plain HTTP, exactly as `web_server/CLAUDE.md`
 * specifies: an SSE stream carrying *notifications*, and ordinary GETs
 * carrying data. The server never pushes a payload — `eventsUrl` yields
 * "step N landed" and the caller decides whether it still wants step N.
 */
const BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";

/** The MAJOR the client understands. Anything else is refused, not half-drawn. */
export const SCHEMA_MAJOR = 1;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The error for a response that was not OK, carrying the server's own reason.
 *
 * Two shapes come back, both from the spec: a request the generated checks
 * refused before any handler ran is `application/problem+json` (`Problem`), with
 * one entry per offending field — `maxPoints is outside the allowed range`;
 * anything a handler refused is `Error`, whose `message` is written for a user.
 * A body that is neither still reports the status, never an invented reason.
 */
async function failure(res: Response, path: string): Promise<ApiError> {
  const fallback = `${res.status} ${res.statusText} — ${path}`;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new ApiError(fallback, res.status);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/problem+json")) {
    const problem = body as Problem;
    // `/body/maxPoints` → `maxPoints`: the field's name as the form knows it.
    const fields = (problem.errors ?? []).map(e =>
      `${e.location.replace(/^\/body\//, "") || "request"} ${e.message}`);
    return new ApiError(fields.length > 0 ? fields.join("; ") : problem.title, res.status);
  }
  const error = body as Partial<ServerError>;
  return new ApiError(typeof error.message === "string" ? error.message : fallback, res.status);
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, signal ? { signal } : {});
  } catch {
    throw new ApiError(`No response from the server at ${BASE}. Is it running?`, 0);
  }
  if (!res.ok) throw await failure(res, path);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`No response from the server at ${BASE}. Is it running?`, 0);
  }
  if (!res.ok) throw await failure(res, path);
  return (await res.json()) as T;
}

async function del(path: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  } catch {
    throw new ApiError(`No response from the server at ${BASE}. Is it running?`, 0);
  }
  if (!res.ok) throw await failure(res, path);
}

export const api = {
  listPlanets: (signal?: AbortSignal) =>
    get<PlanetSummary[]>("/planets", signal),

  createPlanet: (params: PlanetParams) =>
    post<{ planet: PlanetSummary; jobId: string }>("/planets", params),

  /**
   * Start one simulation for a planet that already exists.
   *
   * Anything omitted from `settings` falls back to the server's default, so the
   * client never has to keep a second copy of them.
   */
  startRun: (planetId: string, kind: string, settings?: Partial<RunSettings>) =>
    post<{ planet: PlanetSummary; jobId: string }>(
      `/planets/${planetId}/runs`, { kind, ...settings },
    ),

  /** Liveness, and what a run defaults to. */
  health: (signal?: AbortSignal) =>
    get<{ status: string; schemaMajor: number; exporter: boolean; runDefaults: RunSettings }>(
      "/health", signal,
    ),

  /**
   * Stop a run that is under way.
   *
   * The server signals the simulation rather than killing it, so it finishes the
   * step it is on, closes and publishes the checkpoint it was filling, and
   * records that it was stopped. Everything computed up to then stays viewable
   * -- stopping a run is not discarding it.
   */
  stopRun: (jobId: string) =>
    del(`/jobs/${jobId}`),

  /** Long-lived SSE stream: `status` and `step` events, no payloads. */
  eventsUrl: (jobId: string) => `${BASE}/jobs/${jobId}/events`,

  /**
   * One recorded step, with the fields this view actually draws.
   *
   * `fields` names datasets by the run file's own names, so a layer's request
   * cites the array it will colour. Asking for only what is drawn is what keeps
   * a movie of topography cheap: a run records twenty arrays per point.
   */
  step: async (
    jobId: string, step: number, fields: readonly string[] = ["elevation"],
    signal?: AbortSignal,
  ): Promise<Frame> => {
    const query = `?fields=${encodeURIComponent(fields.join(","))}`;
    const raw = await get<Frame>(`/jobs/${jobId}/steps/${step}/cloud${query}`, signal);
    if (raw.schemaMajor !== SCHEMA_MAJOR) {
      throw new ApiError(
        `Run schema MAJOR ${raw.schemaMajor}; this client understands ${SCHEMA_MAJOR}.`, 0,
      );
    }
    // Relayed as it arrived. Absent fields stay absent, units stay the run's
    // own, and nothing is renamed on the way through.
    return {
      ...raw,
      fields: raw.fields ?? {},
      domains: raw.domains ?? {},
      available: raw.available ?? [],
      absent: raw.absent ?? [],
    };
  },

  /** Which steps of a run are readable right now. */
  steps: (jobId: string, signal?: AbortSignal) =>
    get<{ steps: number[] }>(`/jobs/${jobId}/steps`, signal),

  jobStatus: (jobId: string, signal?: AbortSignal) =>
    get<JobStatus>(`/jobs/${jobId}`, signal),

  startExport: (planetId: string, patch: PatchSpec, spec: ExportSpec) =>
    post<{ id: string }>("/exports", { planetId, patch, spec }),

  exportStatus: (id: string) => get<JobStatus>(`/exports/${id}`),

  exportArchiveUrl: (id: string) => `${BASE}/exports/${id}/archive`,
};

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api/client";
import type { JobStatus, PatchSpec, PlanetParams, PlanetSummary, RunSettings } from "./api/types";
import { Catalogue } from "./components/Catalogue";
import { CreatePlanet } from "./components/CreatePlanet";
import { Header } from "./components/Header";
import { MapView } from "./components/MapView";
import { ModeSwitch, type ViewerMode } from "./components/ModeSwitch";
import { Simulations } from "./components/Simulations";
import { Viewer } from "./components/Viewer";
import { useRouter } from "./state/useRouter";

/**
 * The shell.
 *
 * It owns exactly three things the screens cannot own between them: the
 * catalogue, which job each planet is streaming from, and the icosphere
 * for the body on screen. Everything else belongs to a screen.
 *
 * The mesh is built here rather than in the viewer because the map view
 * needs the same body, and rebuilding 40 962 vertices on a route change
 * would be work for nothing.
 */
export function App() {
  const [route, go] = useRouter();
  const [planets, setPlanets] = useState<PlanetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createErrors, setCreateErrors] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [patch, setPatch] = useState<PatchSpec | null>(null);
  /** The recorded step the viewer is showing, so the map opens on the same one. */
  const [atStep, setAtStep] = useState<number | null>(null);
  /** Status of every run of the planet on screen, by job id. */
  const [statuses, setStatuses] = useState<Record<string, JobStatus | null>>({});
  const [starting, setStarting] = useState<string | null>(null);
  /** The run a stop has been asked for, until its status says it landed. */
  const [stopping, setStopping] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  /** Simulation or edit. Held here because its control lives in the header. */
  const [mode, setMode] = useState<ViewerMode>("simulation");
  /** What a run starts with unless the form says otherwise — the server's own
   *  numbers, asked for rather than copied, so the form cannot drift from them. */
  const [runDefaults, setRunDefaults] = useState<RunSettings | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api.listPlanets(ctrl.signal)
      .then(setPlanets)
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setListError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    api.health(ctrl.signal)
      .then(h => { if (!ctrl.signal.aborted) setRunDefaults(h.runDefaults); })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const planet = useMemo(
    () => ("planetId" in route ? planets.find(p => p.id === route.planetId) ?? null : null),
    [route, planets],
  );

  // The runs this planet has been through. Asked of the server rather than
  // assumed: a simulation is available only if what it needs actually finished.
  useEffect(() => {
    if (!planet) return;
    const ctrl = new AbortController();
    const ids = (planet.runs ?? []).map(r => r.jobId);
    void Promise.all(ids.map(async id => {
      try { return [id, await api.jobStatus(id, ctrl.signal)] as const; }
      catch { return [id, null] as const; }
    })).then(entries => {
      if (!ctrl.signal.aborted) setStatuses(Object.fromEntries(entries));
    });
    return () => ctrl.abort();
  }, [planet]);

  const onRun = useCallback(async (planetId: string, kind: string, settings: RunSettings) => {
    setStarting(kind);
    setRunError(null);
    try {
      const { planet: updated, jobId } = await api.startRun(planetId, kind, settings);
      setPlanets(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      setJobs(prev => ({ ...prev, [updated.id]: jobId }));
      go({ name: "viewer", planetId: updated.id, jobId });
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  }, [go]);

  /**
   * Ask a run to stop.
   *
   * The server signals the simulation rather than killing it: it finishes the
   * step it is on, closes and publishes the checkpoint it was filling, and says
   * it was stopped. So the button is not the end of the story -- the run's own
   * status is, and the flag clears when that arrives rather than when the
   * request returns.
   */
  const onStop = useCallback(async (jobId: string) => {
    setStopping(jobId);
    setRunError(null);
    try {
      await api.stopRun(jobId);
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : String(e));
      setStopping(null);
    }
  }, []);

  // Stopping is over when the run says so, not when the request came back.
  useEffect(() => {
    if (stopping === null) return;
    const s = statuses[stopping];
    if (s && s.state !== "running" && s.state !== "queued") setStopping(null);
  }, [statuses, stopping]);

  const onSubmit = useCallback(async (params: PlanetParams) => {
    setSubmitting(true);
    setCreateErrors([]);
    try {
      const { planet: created, jobId } = await api.createPlanet(params);
      setPlanets(prev => [created, ...prev]);
      setJobs(prev => ({ ...prev, [created.id]: jobId }));
      go({ name: "viewer", planetId: created.id, jobId });
    } catch (e) {
      setCreateErrors([e instanceof ApiError ? e.message : String(e)]);
    } finally {
      setSubmitting(false);
    }
  }, [go]);

  // A different body, or a different run, starts in simulation mode. An edit
  // belongs to the surface it was painted on and does not follow the user to
  // another one.
  useEffect(() => { setMode("simulation"); }, [route.name === "viewer" ? route.planetId : null]);

  // Which run is being watched: the one named in the URL, else the last one
  // this session started, else the planet's most recent.
  const jobId = route.name === "viewer" && route.jobId
    ? route.jobId
    : planet ? jobs[planet.id] ?? planet.jobId : null;


  /**
   * The header for either view of a planet.
   *
   * One builder, so the two views cannot drift into different chrome: the same
   * buttons, in the same order, with the current view marked rather than
   * missing. A control that disappears when you change view makes the header
   * something to re-read instead of something to rely on.
   */
  const planetNav = (p: PlanetSummary, view: "globe" | "map") => (
    <>
      <button className="btn btn--nav" onClick={() => go({ name: "catalogue" })}>
        Catalogue
      </button>
      <button className="btn btn--nav" onClick={() => go({ name: "planet", planetId: p.id })}>
        Simulations
      </button>
      <span className="header__group">
        <button
          className="btn btn--nav"
          data-on={view === "globe"}
          aria-current={view === "globe" ? "page" : undefined}
          onClick={() => go({ name: "viewer", planetId: p.id })}
        >
          Globe View
        </button>
        <button
          className="btn btn--nav"
          data-on={view === "map"}
          aria-current={view === "map" ? "page" : undefined}
          disabled={patch === null}
          title={patch === null
            ? "Draw a region on the globe first — the map view shows a patch, not a planet"
            : "Project the drawn region onto a flat map"}
          onClick={() => go({ name: "map", planetId: p.id })}
        >
          Map View
        </button>
      </span>
    </>
  );

  if (route.name === "create") {
    return (
      <div className="app">
        <Header title="New body" crumb="create" />
        <div className="stage"><div className="scroll">
          <CreatePlanet
            submitting={submitting}
            serverErrors={createErrors}
            onSubmit={p => void onSubmit(p)}
            onCancel={() => go({ name: "catalogue" })}
          />
        </div></div>
      </div>
    );
  }

  if ((route.name === "viewer" || route.name === "map" || route.name === "planet") && !planet) {
    return (
      <div className="app">
        <Header title="Unknown body" />
        <div className="stage">
          <div className="fallback">
            <h2>{loading ? "Reading the catalogue" : "No such body"}</h2>
            <p>
              {loading
                ? "Waiting for the server to list what has been recorded."
                : `Nothing in the catalogue has the id "${route.planetId}".`}
            </p>
            <button className="btn" onClick={() => go({ name: "catalogue" })}>Catalogue</button>
          </div>
        </div>
      </div>
    );
  }

  if (route.name === "planet" && planet) {
    return (
      <div className="app">
        <Header
          title={planet.params.name}
          crumb="simulations"
          nav={
            <button className="btn btn--nav" onClick={() => go({ name: "catalogue" })}>
              Catalogue
            </button>
          }
        />
        <div className="stage"><div className="scroll">
          <Simulations
            planet={planet}
            statuses={statuses}
            defaults={runDefaults}
            starting={starting}
            error={runError}
            onRun={(kind, settings) => void onRun(planet.id, kind, settings)}
            onStop={jobId => void onStop(jobId)}
            stopping={stopping}
            onOpenViewer={id => go({ name: "viewer", planetId: planet.id, jobId: id })}
            onBack={() => go({ name: "catalogue" })}
          />
        </div></div>
      </div>
    );
  }

  if (route.name === "viewer" && planet) {
    return (
      <div className="app">
        <Header title={planet.params.name} nav={planetNav(planet, "globe")} />
        {/* Tabs OF Globe View, so they appear under it and only with it. */}
        <ModeSwitch mode={mode} onMode={setMode} />
        <div className="stage">
          <Viewer
            key={planet.id}
            planet={planet}
            jobId={jobId}
            mode={mode}
            onOpenMap={p => { setPatch(p); go({ name: "map", planetId: planet.id }); }}
            onStepChange={setAtStep}
            onPatchChange={setPatch}
          />
        </div>
      </div>
    );
  }

  if (route.name === "map" && planet && patch) {
    return (
      <div className="app">
        <Header
          title={planet.params.name}
          crumb="region"
          nav={planetNav(planet, "map")}
        />
        <div className="stage">
          <MapView
            planet={planet}
            patch={patch}
            jobId={jobId}
            step={atStep}
          />
        </div>
      </div>
    );
  }

  if (route.name === "map" && planet) {
    return (
      <div className="app">
        <Header
          title={planet.params.name}
          crumb="region"
          nav={planetNav(planet, "map")}
        />
        <div className="stage">
          <div className="fallback">
            <h2>No region</h2>
            <p>Draw one on the globe first — the map view shows a patch, not a planet.</p>
            <button className="btn" onClick={() => go({ name: "viewer", planetId: planet.id })}>Globe</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Header title="Catalogue" />
      <div className="stage"><div className="scroll">
        <Catalogue
          planets={planets}
          loading={loading}
          error={listError}
          onOpen={p => go({ name: "planet", planetId: p.id })}
          onNew={() => go({ name: "create" })}
        />
      </div></div>
    </div>
  );
}

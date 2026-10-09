import { useCallback, useEffect, useState } from "react";

/**
 * Five routes, no library.
 *
 * The route lives in the hash so a view is a URL: the same address always
 * shows the same thing, and a reload loses nothing. Nothing is kept only
 * in memory.
 */
export type Route =
  | { name: "catalogue" }
  | { name: "create" }
  /** The simulations for one body: what has been run, and what can be next. */
  | { name: "planet"; planetId: string }
  /** Watching one RUN of one body. The job is in the URL because a planet can
   *  have several, and "the latest" is not a stable thing to link to. */
  | { name: "viewer"; planetId: string; jobId?: string }
  | { name: "map"; planetId: string };

function parse(hash: string): Route {
  const [name, id, extra] = hash.replace(/^#\/?/, "").split("/");
  if (name === "create") return { name: "create" };
  if (name === "planet" && id) return { name: "planet", planetId: id };
  if (name === "viewer" && id) {
    return extra ? { name: "viewer", planetId: id, jobId: extra }
                 : { name: "viewer", planetId: id };
  }
  if (name === "map" && id) return { name: "map", planetId: id };
  return { name: "catalogue" };
}

function toHash(r: Route): string {
  switch (r.name) {
    case "catalogue": return "#/";
    case "create": return "#/create";
    case "planet": return `#/planet/${r.planetId}`;
    case "viewer": return r.jobId
      ? `#/viewer/${r.planetId}/${r.jobId}`
      : `#/viewer/${r.planetId}`;
    case "map": return `#/map/${r.planetId}`;
  }
}

export function useRouter(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((r: Route) => { window.location.hash = toHash(r); }, []);
  return [route, go];
}

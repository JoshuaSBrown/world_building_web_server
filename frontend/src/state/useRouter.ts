import { useCallback, useEffect, useState } from "react";

/**
 * The route lives in the hash so a view is a URL: the same address always
 * shows the same thing, and a reload loses nothing. Nothing is kept only
 * in memory.
 *
 * The routes, each with the address it is written as:
 *
 * - `catalogue` — `#/`
 *     The shelf of saved planets; the home page.
 *
 * - `create` — `#/create`
 *     The form for making a new planet.
 *
 * - `planet` — `#/planet/<planetId>`
 *     The simulations for one body: what has been run, and what can be next.
 *
 * - `viewer` — `#/viewer/<planetId>/<jobId>`, or `#/viewer/<planetId>`
 *     Watching one RUN of one body on the globe. The job is in the URL because a
 *     planet can have several, and "the latest" is not a stable thing to link to.
 *     `jobId` is optional.
 *
 * - `map` — `#/map/<planetId>`
 *     A flat map of a patch of one body.
 */
export type Route =
  | { name: "catalogue" }
  | { name: "create" }
  | { name: "planet"; planetId: string }
  | { name: "viewer"; planetId: string; jobId?: string }
  | { name: "map"; planetId: string };

/**
 * Read the address bar's hash and say which screen it means.
 *
 * Why it is needed: the address bar holds TEXT, and the rest of the app works with a
 * `Route`. Whenever the address may have changed without the app changing it — the
 * page opening from a bookmark or a shared link, a reload, the browser's back and
 * forward buttons, an address typed by hand — this turns the text back into a screen.
 * `toHash` is the same translation run the other way.
 *
 * Example — a bookmarked run of Earth on the globe:
 *
 *   parse("#/viewer/earth/job_1be323851")
 *
 *     strip the leading "#/"   →  "viewer/earth/job_1be323851"
 *     cut at each "/"          →  ["viewer", "earth", "job_1be323851"]
 *     name the first three     →  name = "viewer", id = "earth", extra = "job_1be323851"
 *
 *   → { name: "viewer", planetId: "earth", jobId: "job_1be323851" }
 *
 * More examples:
 *
 *   parse("#/create")         → { name: "create" }
 *   parse("#/planet/earth")   → { name: "planet", planetId: "earth" }
 *   parse("#/viewer/earth")   → { name: "viewer", planetId: "earth" }   (no run named)
 *   parse("#/")               → { name: "catalogue" }
 *
 * Anything it does not recognise also becomes the catalogue, without saying so: a typo
 * (`#/plnaet/earth`), a route missing its id (`#/planet`), or a screen that no longer
 * exists. Pieces past the third are ignored (`#/planet/earth/x` opens Earth's page), and
 * ids are used exactly as written — nothing decodes them, so an id containing "/" would
 * be cut in two.
 */
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

/**
 * Write the address for a screen — `parse` run the other way.
 *
 * Why it is needed: the app never switches screen directly. A button asks for a `Route`,
 * this writes it into the address bar, and the screen follows the address. Switching the
 * screen without updating the address would break "a view is a URL": a reload would
 * return to wherever the address still pointed.
 *
 * Example — the "open the globe" button for a run of Earth:
 *
 *   toHash({ name: "viewer", planetId: "earth", jobId: "job_1be323851" })
 *
 *     pick the case by name    →  "viewer"
 *     a run is named, so       →  `#/viewer/${planetId}/${jobId}`
 *     fill in the blanks       →  "#/viewer/earth/job_1be323851"
 *
 *   → "#/viewer/earth/job_1be323851"
 *
 * More examples:
 *
 *   toHash({ name: "catalogue" })                      → "#/"
 *   toHash({ name: "create" })                         → "#/create"
 *   toHash({ name: "planet", planetId: "earth" })      → "#/planet/earth"
 *   toHash({ name: "viewer", planetId: "earth" })      → "#/viewer/earth"   (no run named)
 *   toHash({ name: "map", planetId: "earth" })         → "#/map/earth"
 *
 * There is no fallback case on purpose: every route must have an address, and a route
 * added to `Route` without a case here fails the type check rather than reaching the
 * browser. `parse` has no such guard — a route it is not taught falls to the catalogue.
 *
 * Ids are written in exactly as they are, the mirror of `parse` reading them: for simple
 * ids `parse(toHash(route))` gives back the same route, but an id containing "/", "#" or
 * a space would not survive the round trip.
 */
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

/**
 * Connects React to the browser's address bar, so the screen follows the address.
 *
 * The browser owns the address bar; React cannot see it change on its own. The
 * "hashchange" listener is the only link: without it, Back, Forward, a typed address, or
 * `go` would change the address but leave the screen where it was.
 *
 * `onHash` is only defined here, not run. The browser calls it later, each time the part
 * after `#` changes: it reads the address, `parse`s it, and records it with `setRoute`.
 * `useEffect(…, [])` registers it once, after the first draw.
 *
 * `go` only writes the address; the listener then updates the screen. `setRoute` redraws
 * only when given a different value, but `parse` builds a new object each time, so each
 * address change redraws once.
 */
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

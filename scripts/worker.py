#!/usr/bin/env python
"""A pool worker: reads HDF5 and asks PlanetBuilder for derived properties.

This is the ONLY place in `web_server` that touches HDF5 or imports `tectonics`,
and it is a separate process on purpose.

* `libhdf5` serialises every call in a process behind one global lock, so threads
  reading it never run in parallel. Separate processes do not contend, so the
  server keeps a pool of these and gets real parallel reads.
* Keeping it out of process also keeps the C library out of the server binary
  entirely, and confines a corrupt file to one worker.

Protocol: one JSON request per line on stdin, one JSON response per line on
stdout. Kept line-oriented so a worker can be driven by hand:

    echo '{"op":"read_step","file":"run_p000.h5","step":0}' | python worker.py

A request that fails answers `{"error": "..."}` and the worker stays alive; only
an unreadable stdin ends it. Errors are never answered with a plausible-looking
default -- the server reports a missing value as missing, and it can only do that
if this worker tells the truth.
"""

from __future__ import annotations

import json
import math
import sys
import traceback


def _derive(params: dict) -> dict:
    """Derived planet properties, computed by PlanetBuilder.

    The web server does not calculate gravity, mass or cell spacing: that is
    physics, and physics lives on this side of the boundary. Every number below
    comes from `tectonics`' own laws, so a planet's properties and the run that
    evolves it can never disagree.
    """
    import tectonics as T
    # not re-exported at the top level; taken from the package rather than
    # written out here, so this can never disagree with the physics
    from tectonics.common import G_NEWTON

    diameter = float(params["diameterM"])
    max_points = int(params["maxPoints"])

    # density and core fraction are no longer user inputs; the package's own
    # class-(a) defaults (PREM) apply, so these numbers still come from the
    # laws the run itself will use
    core = T.Core(diameter=diameter)

    # the run's surface is a point cloud seeded with `max_points` points, each
    # owning a Voronoi cell; the count and its spacing come from that cap, not
    # from a mesh the run does not use
    cells = max_points
    area = float(core.surface_area)
    spacing = math.sqrt(area / cells) if cells else float("nan")

    escape = math.sqrt(2.0 * G_NEWTON * float(core.mass) / float(core.radius))

    # The elevation field is recorded in metres already, so one unit is one
    # metre. Stated explicitly rather than assumed by the client.
    relief_m = 1.0

    return {
        "radiusM": float(core.radius),
        "massKg": float(core.mass),
        "surfaceGravity": float(core.gravity),
        "escapeVelocityMs": float(escape),
        "surfaceAreaM2": area,
        "cells": cells,
        "simCellM": float(spacing),
        "reliefM": relief_m,
    }


#: Where a field lives, and what carries the positions of the things it is one
#: value per. A field is paired with the positions of its OWN domain and never
#: with another's -- `cloud/strain` sits beside `cloud/pos` and is not
#: co-indexed with it, which a length check would not catch on most steps.
_DOMAIN_POSITIONS = {
    "cloud": ("cloud", "pos"),
    "surface": ("surface", "vertices"),
    # A boundary segment is one element, and `position` is where it sits. Its
    # orientation travels separately, in `t_hat`.
    "boundaries": ("boundaries", "position"),
    # An edge has two ends; `start` is where the domain's elements are said to
    # be, and `end` travels as a field of its own. A line needs both, and
    # inventing a midpoint to satisfy a one-position-per-element rule would be
    # recording something the run never wrote.
    "boundary_edges": ("boundary_edges", "start"),
    # A plate is one element, and `centroid` is its volume-weighted middle --
    # where an arrow showing its motion belongs. Recorded from run format 1.2;
    # before that a plate had no position in the file at all.
    "plates": ("plates", "centroid"),
}


def _attr(dataset, name: str, fallback: str = "") -> str:
    """One self-describing attribute, as text. Absent stays empty, never guessed."""
    value = dataset.attrs.get(name, fallback)
    return value.decode() if isinstance(value, bytes) else str(value)


def _find(grp, name: str):
    """The dataset called `name`, with the group it was found in.

    Accepts `group/name` as well as a bare name, and the qualified form is not a
    convenience: `position` exists in `boundaries`, `interactions` AND `slabs`,
    and a bare lookup returns whichever group HDF5 happens to iterate first. A
    caller that means one of them must be able to say so.

    A bare name still works and takes the first match -- the response says which
    domain it came from, so the answer is never silently ambiguous.
    """
    if "/" in name:
        group_name, _, field = name.partition("/")
        group = grp.get(group_name)
        if group is not None and hasattr(group, "keys") and field in group:
            return group_name, group[field]
        return None, None
    for group_name in grp:
        group = grp[group_name]
        if hasattr(group, "keys") and name in group:
            return group_name, group[name]
    return None, None


def _values(dataset):
    """A dataset as plain JSON: numbers, rows of numbers, or strings.

    Strings are how the writer records a CLASSIFICATION -- `label` on a boundary
    segment is `convergent`, `transform` and so on, decided by the physics from
    the segment's own velocities. They are relayed as the words the run wrote,
    not mapped to numbers on the way out: a reader colouring a map by them is
    then using the simulation's judgement rather than making its own.
    """
    array = dataset[...]
    if array.dtype.kind in ("S", "U", "O"):
        return [v.decode() if isinstance(v, bytes) else str(v)
                for v in array.reshape(-1)]
    if array.ndim == 1:
        return [float(v) for v in array]
    return [[float(v) for v in row] for row in array]


def _read_step(path: str, step: int, fields: list[str] | None = None) -> dict:
    """One recorded step, out of a CLOSED part file.

    The caller guarantees closure by only passing files the manifest has listed;
    this worker does not second-guess that, but it does open read-only so it can
    never modify a run.

    `fields` names the datasets the display actually wants, so a movie of
    elevation does not pay for temperature. Each one comes back with the four
    attributes the file declares -- `units`, `kind`, `domain`, `long_name` -- and
    NOT with a unit this worker invented: the client labels a colour bar from
    what the run said, or reports that the run said nothing.

    Positions travel per DOMAIN. A field is one value per something, and the
    reader must know per what: `cloud` fields are one per simulated point and
    `surface` fields one per mesh vertex, so pairing a field with the wrong
    positions would draw a plausible planet that is wrong everywhere.

    A field the run did not record comes back in `absent`, never as zeros.
    """
    import h5py

    wanted = list(fields) if fields else ["elevation"]
    out: dict = {"step": step, "fields": {}, "domains": {},
                 "available": [], "absent": []}

    with h5py.File(path, "r") as f:
        key = f"{step:06d}"
        steps = f.get("steps")
        if steps is None or key not in steps:
            return {"error": f"step {step} is not in {path}"}
        grp = steps[key]
        cloud = grp.get("cloud")
        if cloud is None or "elevation" not in cloud:
            return {"error": f"step {step} recorded no cloud/elevation"}

        out["timeMyr"] = float(grp.attrs.get("time_myr", float("nan")))
        # Every dataset this step holds, by name and NOT by value.
        #
        # A reader asks for the fields it draws, so the frame it gets back says
        # nothing about the ones it did not ask for -- and a display that judged
        # "does this run record temperature" from such a frame would answer no
        # for every layer except the one already on screen. Names are cheap;
        # values are not.
        for group_name in grp:
            group = grp[group_name]
            if hasattr(group, "keys"):
                out["available"].extend(sorted(group.keys()))
        out["available"] = sorted(set(out["available"]))
        # The existing contract: elevation, flat, at the top level. Kept exactly
        # as it was so every client that reads it still works.
        out["elevation"] = _values(cloud["elevation"])
        out["units"] = _attr(cloud["elevation"], "units", "unknown")

        domains_needed = set()
        for name in wanted:
            group_name, dataset = _find(grp, name)
            if dataset is None:
                out["absent"].append(name)
                continue
            domain = _attr(dataset, "domain", group_name)
            out["fields"][name] = {
                "values": _values(dataset),
                "units": _attr(dataset, "units"),
                "kind": _attr(dataset, "kind"),
                "domain": domain,
                "longName": _attr(dataset, "long_name", name),
            }
            domains_needed.add(domain)

        # Positions for every domain a returned field belongs to. A domain whose
        # positions are not recorded is reported, because a field with nowhere to
        # put it is undrawable and saying so beats drawing it somewhere wrong.
        for domain in sorted(domains_needed):
            where = _DOMAIN_POSITIONS.get(domain)
            if where is None:
                out["absent"].append(f"positions for domain {domain!r}")
                continue
            group_name, name = where
            group = grp.get(group_name)
            if group is None or name not in group:
                out["absent"].append(f"{group_name}/{name}")
                continue
            out["domains"][domain] = {"pos": _values(group[name])}

    # No sea level is recorded by any run: the simulation carries no water
    # inventory. Reported as absent rather than defaulted to zero, which the
    # client would draw as a shoreline that does not exist.
    out["seaLevel"] = None
    return out


def handle(req: dict) -> dict:
    op = req.get("op")
    if op == "derive":
        return {"derived": _derive(req["params"])}
    if op == "read_step":
        return _read_step(req["file"], int(req["step"]), req.get("fields"))
    if op == "ping":
        return {"ok": True}
    return {"error": f"unknown op {op!r}"}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            response = handle(json.loads(line))
        except Exception as exc:                      # noqa: BLE001
            # One bad request must not kill a warm worker, but it must not be
            # silent either: the detail goes to stderr for the run log.
            traceback.print_exc(file=sys.stderr)
            response = {"error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

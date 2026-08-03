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
    bulk_density = float(params["bulkDensity"])
    level = int(params["gridLevel"])

    core = T.Core(diameter=diameter, bulk_density=bulk_density,
                  core_fraction=float(params["coreFraction"]))
    surface = T.Surface(level=level, radius=core.radius)

    # cells and their spacing come from the mesh the run will actually use, not
    # from a formula repeated here that could drift away from it
    cells = int(surface.mesh.N)
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


def _read_step(path: str, step: int) -> dict:
    """One recorded step's surface field, out of a CLOSED part file.

    The caller guarantees closure by only passing files the manifest has listed;
    this worker does not second-guess that, but it does open read-only so it can
    never modify a run.
    """
    import h5py

    with h5py.File(path, "r") as f:
        key = f"{step:06d}"
        steps = f.get("steps")
        if steps is None or key not in steps:
            return {"error": f"step {step} is not in {path}"}
        grp = steps[key]
        cloud = grp.get("cloud")
        if cloud is None or "elevation" not in cloud:
            return {"error": f"step {step} recorded no cloud/elevation"}

        elevation = cloud["elevation"][...]
        out = {
            "step": step,
            "elevation": [float(v) for v in elevation],
            "units": cloud["elevation"].attrs.get("units", "unknown"),
            "timeMyr": float(grp.attrs.get("time_myr", float("nan"))),
        }

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
        return _read_step(req["file"], int(req["step"]))
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

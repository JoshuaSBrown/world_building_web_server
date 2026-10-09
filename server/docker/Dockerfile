# The server image: the Rust binary, and the Python environment it spawns.
#
# One image holds both because the server does not talk to the simulation over a
# network -- it *starts processes*. The HDF5 worker pool and `evolve.py` are child
# processes of this container, so the interpreter and the pinned scientific stack
# have to be here beside the binary.
#
# The build context is the SUPERPROJECT root, because the image needs
# `PlanetBuilder/requirements.txt`: the container's Python must be the same pinned
# environment a run is reproducible in, and copying the pins is how it stays that
# way rather than drifting into a second list.
#
# What is NOT baked in: `PlanetBuilder`, `planet_run_schema`, and this repo's
# `scripts/` and `api/`. Those are mounted, so editing a notebook-derived law or a
# worker script does not mean rebuilding an image.

# ---- the binary -------------------------------------------------------------
FROM rust:1-slim-bookworm AS build
WORKDIR /src

# Dependencies first, against a stub main, so a source edit does not re-download
# and re-compile the whole crate graph.
COPY web_server/server/Cargo.toml web_server/server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release

COPY web_server/server/src ./src
# Cargo keys on mtime; the stub's timestamp would otherwise look newer.
RUN touch src/main.rs && cargo build --release

# ---- the runtime ------------------------------------------------------------
FROM python:3.12-slim-bookworm

# The simulation's pins, not a fresh resolution of them: a run is required to be
# bit-identical for a given seed, and a library version is part of the result.
COPY PlanetBuilder/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY --from=build /src/target/release/world_building_web_server /usr/local/bin/

# Everything below is mounted by compose; the directories exist so a missing
# mount fails as an empty directory rather than a confusing path error.
WORKDIR /app/web_server
RUN mkdir -p /app/web_server/scripts /app/web_server/api \
             /app/web_server/runs /app/web_server/configs \
             /app/PlanetBuilder /app/planet_run_schema

ENV PYTHON=python3 \
    PLANET_BUILDER=/app/PlanetBuilder \
    RUN_SCHEMA=/app/planet_run_schema \
    WORKER_SCRIPT=/app/web_server/scripts/worker.py \
    OPENAPI=/app/web_server/api/openapi.yaml \
    RUNS_DIR=/app/web_server/runs \
    CONFIGS_DIR=/app/web_server/configs \
    BIND=0.0.0.0 \
    # the source tree is mounted read-only, and matplotlib insists on a cache
    PYTHONDONTWRITEBYTECODE=1 \
    MPLCONFIGDIR=/tmp/matplotlib

EXPOSE 8080
CMD ["world_building_web_server"]

# Description

This is the location for the web server for viewing the physics simulations run.

## Running the stack

```bash
docker compose -f web_server/compose/compose.yml up -d --build server frontend
```

- display: <http://localhost:5173>
- API: <http://localhost:8080/api/v1/health>, spec at `/openapi.yaml`

Run it from the **superproject** checkout: the server starts `PlanetBuilder/evolve.py`
as a subprocess and checks its launch config against `planet_run_schema`, and both are
mounted from beside this repo.

What lands on the host as a run proceeds:

| path | what it is |
|---|---|
| `web_server/configs/<jobId>.toml` | the launch config the run was started from — the whole of its input. `python evolve.py --config <it>` reproduces the run |
| `web_server/runs/<jobId>/` | the run directory: `manifest.jsonl`, `status.json`, `parts/`, `figures/`, `run.log` |
| `web_server/runs/planets/` | the catalogue, one JSON file per planet |

Knobs, all with defaults (`STEPS=40`, `DT_MYR=8.0`, `SPLIT_EVERY=2`, `WORKERS=4`,
`SERVER_PORT`, `FRONTEND_PORT`). `SPLIT_EVERY` is the live-view latency: a step is
visible once the part holding it closes.

Postgres is in the stack but nothing uses it yet; it needs `POSTGRES_PASSWORD` set
before `docker compose up postgresql`.

It can be defined in the compose directory in an .env file.

Without Docker, the same two processes: `cargo run` from `server/` (with `PLANET_BUILDER`,
`RUN_SCHEMA`, `PYTHON` pointing at the checkout) and `npm run dev` from `frontend/`.

## The API is generated from its spec

`api/openapi.yaml` is the only place the HTTP interface is written down. Both sides
are generated from it, and the generated code is committed:

| side | generator (pinned) | output | regenerate | stale check |
|---|---|---|---|---|
| server | `openapi-to-rust` **0.22.0** | `server/src/generated/` | `server/scripts/gen-api.sh generate` | `server/scripts/gen-api.sh check` |
| browser | `openapi-typescript` **7.13.0** | `frontend/src/api/generated/openapi.ts` | `npm run gen:api` (in `frontend/`) | `npm run gen:api:check` |

- **Never edit a generated file.** Change the spec, regenerate both sides, review the
  diff, then `cargo test` and `npm run typecheck && npm test`.
- The server's generator installs itself, at exactly the pinned version, into
  `server/.tools/` (git-ignored); the browser's is an exact devDependency. Upgrading
  either is a deliberate edit of that pin, never a side effect.
- The server checks every request body against the spec before a handler runs. A
  request that breaks it gets a `422` `application/problem+json` body naming each
  offending field; the browser shows those reasons.
- `server/tests/golden/` holds the JSON the server sent before generation began, and
  three real catalogue files; `cargo test` proves the generated types still read and
  write them unchanged.

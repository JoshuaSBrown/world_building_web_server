# Description

This is the location for the web server for viewing the physics simulations run.

## Running the stack

```bash
docker compose -f web_server/compose/compose.yml up -d --build server frontend
```

- display: <http://localhost:5173>
- API: <http://localhost:8080/api/health>, spec at `/openapi.yaml`

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

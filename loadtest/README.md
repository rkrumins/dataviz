# Synodic Load Tester

A standalone Locust-based load-testing harness for the Synodic backend. Lives at the repo root in `loadtest/` and is decoupled from `backend/` — install it in its own venv and point it at any running backend (local, staging, prod).

Used by the perf plan ([../docs/audits/](../docs/audits/) / `~/.claude/plans/`) to validate each slice against measurable SLOs. Generic enough to extend for any future perf work — add scenarios as new modules under `scenarios/`.

## Layout

```
loadtest/
├── README.md                # this file
├── Makefile                 # smoke-run targets — `make smoke` runs each scenario + mixed
├── requirements.txt         # locust >= 2.27 (no backend deps)
├── locustfile.py            # default entry point — composes the plan's production mix
├── config.py                # env-driven settings (host, auth, think time)
├── lib/
│   ├── auth.py              # bearer-token or cookie-login auth
│   ├── data.py              # workspace/datasource ID discovery + pool
│   └── slo.py               # post-run SLO check (standalone script; `--smoke` flag)
├── runners/
│   ├── views.py             # HttpUser wrapper around ViewsTasks (for `-f`)
│   ├── cached_stats.py      # HttpUser wrapper around CachedStatsTasks
│   ├── announcements.py     # HttpUser wrapper around AnnouncementsTasks
│   ├── aggregation_jobs.py  # HttpUser wrapper around AggregationJobsTasks (heavy)
│   ├── graph_schema.py      # HttpUser wrapper around GraphSchemaTasks (heavy)
│   ├── graph_lineage.py     # HttpUser wrapper around GraphLineageTasks (Tier-1 stress)
│   ├── graph_walks.py       # HttpUser wrapper around GraphWalksTasks (Tier-1 stress)
│   ├── graph_children.py    # HttpUser wrapper around GraphChildrenTasks (Tier-1 stress)
│   └── canvas_open.py       # HttpUser wrapper around CanvasOpenTasks (the view open)
└── scenarios/
    ├── views.py             # GET /views/ + /views/popular
    ├── workspaces.py        # GET /admin/workspaces/.../cached-stats
    ├── announcements.py     # GET /announcements
    ├── aggregation_jobs.py  # GET /admin/aggregation-jobs              (Tier-2 heavy)
    ├── graph_schema.py      # GET /{ws}/graph/metadata/schema          (Tier-2 heavy)
    ├── graph_lineage.py     # POST /{ws}/graph/trace/v2                (Tier-1 stress)
    ├── graph_walks.py       # GET /{ws}/graph/nodes/{urn}/ancestors    (Tier-1 stress)
    │                        # GET /{ws}/graph/nodes/{urn}/descendants
    ├── graph_children.py    # GET /{ws}/graph/nodes/{urn}/children     (Tier-1 stress)
    │                        # GET /{ws}/graph/nodes/{urn}/children-with-edges
    └── canvas_open.py       # POST /{ws}/graph/nodes/query ×N + /edges/between (the view open)
```

## Install

```bash
cd loadtest
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The harness has **one** dependency (Locust). It does not import anything from `backend/`.

## Configure

All knobs are env vars — no config files. The full set:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SYNODIC_HOST` | yes | `http://localhost:8000` | Backend base URL |
| `SYNODIC_BEARER_TOKEN` | one of | — | Pre-issued JWT/service token (sent as `Authorization: Bearer ...`) |
| `SYNODIC_USER` + `SYNODIC_PASSWORD` | one of | — | Cookie-login credentials (calls `/api/v1/auth/login`) |
| `SYNODIC_ID_POOL_LIMIT` | no | `50` | How many workspace IDs to discover per user |
| `SYNODIC_URN_POOL_WORKSPACES` | no | `5` | How many workspaces to fetch node URNs from (for graph stress scenarios) |
| `SYNODIC_URNS_PER_WORKSPACE` | no | `20` | How many node URNs to sample per workspace |
| `SYNODIC_THINK_MIN` / `SYNODIC_THINK_MAX` | no | `0.5` / `2.5` | Per-task think time range (seconds) |
| `SYNODIC_FALLBACK_WS_ID` / `SYNODIC_FALLBACK_DS_ID` | no | — | Static ID list when admin discovery is denied (comma-separated) |
| `SYNODIC_LOG_FAILURES` | no | `false` | If `true`, log every non-2xx response (chatty) |

Auth picks bearer first, falls back to cookie login, and aborts if neither is set.

## Run

### Plan-mix workload (the production simulation)

```bash
.venv/bin/locust -f locustfile.py --headless \
    --users 200 --spawn-rate 20 --run-time 5m \
    --csv results/run --html results/run.html
```

- `--users` = peak concurrent VUs
- `--spawn-rate` = users/sec ramp-up
- `--run-time` = total duration
- `--csv` writes `<prefix>_stats.csv`, `<prefix>_stats_history.csv`, `<prefix>_failures.csv` — consumed by the SLO checker
- `--html` writes a self-contained report you can attach to a PR

### A single scenario (focused validation)

Each scenario module is self-contained — point Locust at it directly to drive one endpoint group only. Useful for validating a single workstream's success gate.

```bash
# Validate WS-1: hammer /views/?limit=20
.venv/bin/locust -f scenarios/views.py --headless \
    --users 200 --spawn-rate 50 --run-time 2m \
    --csv results/views

# Validate WS-2 / WS-7: hammer /cached-stats
.venv/bin/locust -f scenarios/workspaces.py --headless \
    --users 200 --spawn-rate 50 --run-time 2m \
    --csv results/cached_stats
```

Note: standalone scenario files don't include the `SynodicUser` class. To run a scenario solo, you can either (a) use the `locustfile.py` entry point and adjust the `MIXED_TASKS` dict, or (b) wrap the scenario in a thin `HttpUser` in a separate file. The plan-mix entry point is the common case; standalone wrappers are a 10-line copy of `locustfile.py` with `tasks = {ViewsTasks: 1}`.

### Web UI (interactive)

Omit `--headless` to get the Locust web UI at `http://localhost:8089`:

```bash
.venv/bin/locust -f locustfile.py
```

## Smoke runs

For a quick local check that every scenario actually drives traffic against the running backend, use the Makefile. Each target invokes Locust headlessly for a short run, then runs `lib.slo --smoke` to gate pass/fail with relaxed thresholds suitable for a dev backend.

```bash
# Bring up the backend yourself first (docker-compose, uvicorn, whatever),
# then set auth env vars in the same shell:
export SYNODIC_HOST=http://localhost:8000
export SYNODIC_USER=admin@synodic.local
export SYNODIC_PASSWORD=changeme

cd loadtest
make help        # list targets and current settings
make smoke       # run all four: announcements → views → cached-stats → mixed
```

Run a single scenario:

```bash
make smoke-announcements
make smoke-views
make smoke-cached-stats        # will surface as failed SLO if no workspaces are seeded
make smoke-aggregation-jobs    # Tier-2 heavy: admin jobs list (full-table scan)
make smoke-graph-schema        # Tier-2 heavy: workspace schema introspection
make smoke-canvas-open         # the view open: nodes/query batches + edges/between
make smoke-mixed
```

Override defaults via env:

```bash
SMOKE_USERS=20 SMOKE_RUN_TIME=1m make smoke-mixed
SMOKE_HOST=http://localhost:8000 make smoke-views
PYTHON=.venv/bin/python LOCUST=.venv/bin/locust make smoke   # if using the venv
```

CSVs land under `results/smoke/<scenario>/` so you can inspect a run after the fact. `make smoke-clean` wipes the directory.

Smoke mode uses the relaxed `SMOKE_SLOS` from [lib/slo.py](lib/slo.py): per-endpoint `p95 < 1000–1500 ms`, aggregate failure rate `< 5%`, and `min_request_count = 1` (we just want to confirm the endpoint was actually hit). The full production SLOs in `DEFAULT_SLOS` are used by the unflagged `python -m lib.slo` invocation below.

## Concurrency sweep

For "how does the backend scale?" runs, `make sweep` walks the production traffic mix through a configurable list of user counts and gates each tier on its own SLO thresholds (`TIER_SLOS` in [lib/slo.py](lib/slo.py)). Defaults run 10 → 100 → 500 → 1000 users at 60 s per tier; total wall time ≈ 6 minutes plus ramp.

```bash
cd loadtest
make sweep                                          # default tiers [10, 100, 500, 1000]
SWEEP_TIERS='10 50 200' make sweep                  # custom tiers
SWEEP_RUN_TIME=3m SWEEP_SPAWN_RATE=200 make sweep   # longer, faster ramp
```

Per-tier CSVs land at `results/sweep/tier_<N>/run_stats.csv`. The sweep stops at the first tier whose SLO check fails (so you find the breaking point without burning the rest of the budget). `make sweep-clean` removes the directory.

### Tier-aware SLOs

`TIER_SLOS` in [lib/slo.py](lib/slo.py) encodes a degradation curve: the same `views:list` endpoint is gated at `p95 < 150 ms` at 10 users, `< 300 ms` at 100, `< 600 ms` at 500, `< 1200 ms` at 1000. Failure rate is allowed to rise from 0.1 % to 3 % over the same range. Tiers not in the table fall back to the next-lower tier (so `--tier 250` uses the 100-user thresholds).

These are starting points — re-tune them once you have CSVs at each tier. To run the SLO check on a CSV after the fact:

```bash
python -m lib.slo --tier 500 results/sweep/tier_500/run_stats.csv
```

### Heavy + graph scenarios in the mix

`make sweep` runs [locustfile.py](locustfile.py), which now includes the graph stress scenarios alongside the original read-heavy mix:

| Scenario | Weight | Endpoint | Tier |
|---|---|---|---|
| `ViewsTasks` | 5 | `GET /views/` + `/views/popular` | read-heavy |
| `CachedStatsTasks` | 3 | `GET /admin/workspaces/.../cached-stats` | read-heavy |
| `AnnouncementsTasks` | 1 | `GET /announcements` | read-heavy |
| `AggregationJobsTasks` | 1 | `GET /admin/aggregation-jobs` | **Tier-2 heavy** — full-table scan |
| `GraphSchemaTasks` | 1 | `GET /{ws}/graph/metadata/schema` | **Tier-2 heavy** — graph introspection |
| `GraphLineageTasks` | 1 | `POST /{ws}/graph/trace/v2` | **Tier-1 stress** — multi-hop traversal |
| `GraphWalksTasks` | 1 | `GET /{ws}/graph/nodes/{urn}/ancestors` and `/descendants` | **Tier-1 stress** |
| `GraphChildrenTasks` | 1 | `GET /{ws}/graph/nodes/{urn}/children` and `/children-with-edges` | **Tier-1 stress** |
| `CanvasOpenTasks` | 2 | `POST /{ws}/graph/nodes/query` (100 URNs per request, 4 in flight) then `POST /{ws}/graph/edges/between` | **the view open** — the hydration path every canvas session starts with |

The graph scenarios pick from a per-process pool of `(workspace, urn)` pairs discovered via `POST /{ws}/graph/nodes/query` (tunable via `SYNODIC_URN_POOL_WORKSPACES` and `SYNODIC_URNS_PER_WORKSPACE`). When the pool is empty — i.e. no graph data is seeded for any workspace — the scenarios emit a single `graph-*:no-node` stat row per call instead of 404-storming the backend, so a `make sweep` against an empty cluster still completes (and `lib.slo --tier N` will flag the missing graph rows under non-smoke gating).

### The view open

`CanvasOpenTasks` reproduces what the frontend does when a user opens a curated
view (`useGraphHydration`): the assigned entities are fetched by URN, 100 per
`POST /nodes/query` with four requests in flight, then one `POST /edges/between`
asks for the edges among everything that loaded. Two stat rows: `canvas-open:nodes`
(per batch) and `canvas-open:edges` (per open). The "view" is the pool's URN sample
for the workspace, so its size is `SYNODIC_URNS_PER_WORKSPACE` — the default 20 is
one batch; set 500 to emulate a 500-entity view (five batches plus the edge scan).

A 429 counts as a failure here on purpose. The real canvas retries a shed request
in place, but under load the shed *is* the signal: it means the pod's per-data-source
slots (`PROVIDER_MAX_CONCURRENCY`, 8 per worker process) or FalkorDB's own queue
(`MAX_QUEUED_QUERIES`) ran out. After a run, read `GET /api/v1/health/deps` on the
backend: its `resilience` block carries process counters that say *where* capacity
ran out — `breaker_opens` must stay at 0 (load never counts as an outage),
`queue_full_not_counted` is FalkorDB rejecting at its queue cap, `slots_shed_*` is
the pod shedding before the database, and `deadline_timeouts_not_counted` is
queries exceeding their budgets.

## Per-graph-endpoint stress

When the mixed sweep shows a graph regression, isolate it with `make stress-*`. Each target re-uses the sweep tier list but hammers exactly one graph endpoint shape:

```bash
make stress-trace         # POST /graph/trace/v2 only, at 10 → 1000 users
make stress-walks         # ancestors + descendants only
make stress-children      # children + children-with-edges only
make stress-canvas        # the view open (nodes/query batches + edges/between) only
make stress               # all four sequentially
```

Stress runs reuse `SWEEP_TIERS` / `SWEEP_RUN_TIME` / `SWEEP_SPAWN_RATE` by default; override with `STRESS_*` to vary independently of the mixed sweep:

```bash
STRESS_TIERS='100 500' STRESS_RUN_TIME=2m make stress-trace
```

CSVs land under `results/stress/<endpoint>/tier_<N>/`. Each tier is gated by the same `TIER_SLOS` table as the mixed sweep — the per-endpoint p95 entries (`graph-trace:v2`, `graph-ancestors:get`, `graph-descendants:get`, `graph-children:get`, `graph-children-edges:get`) carry deliberately loose ceilings at the 500 / 1000 tiers (these endpoints are FalkorDB-bound and high tail variance is expected), and so do `canvas-open:nodes` / `canvas-open:edges`. Re-tune the per-tier thresholds in [lib/slo.py](lib/slo.py) once you have a real baseline.

`make stress-clean` removes `results/stress/`.

### Troubleshooting: 429 / 500 from `/auth/login`

The backend rate-limits `POST /api/v1/auth/login` at 10 requests/minute (slowapi `@limiter.limit("10/minute")`). The harness compensates by doing **one shared login per Locust process** and copying the resulting cookies + CSRF header into every spawned user ([lib/auth.py](lib/auth.py)) — so a 200-user smoke run still only fires one login, well under the limit.

Separately, if you see HTTP 500 on `/auth/login` with `AttributeError: 'State' object has no attribute 'limiter'` in the backend traceback, that's a backend bug: slowapi's exception handler requires `app.state.limiter = limiter` to be registered during FastAPI startup. Fix it in `backend/app/main.py` near where the limiter is created — once that's wired the backend correctly returns 429 instead of 500.

### Troubleshooting: 401 on every admin call

The backend ships with `AUTH_COOKIE_SECURE=true` by default, so the `nx_access` JWT cookie is set with the `Secure` flag. Over plain `http://localhost:…`, Python's `requests` cookie jar stores those cookies but refuses to resend them, and every authenticated call 401s. The harness compensates by stripping the `Secure` flag after a successful cookie login on `http://` hosts ([lib/auth.py](lib/auth.py)) — you'll see an `INFO` line `Stripped Secure flag from N session cookie(s)…` when it kicks in. To avoid the workaround entirely, run the backend with `AUTH_COOKIE_SECURE=false` for local dev (see [backend/auth_service/cookies.py](../backend/auth_service/cookies.py)).

## Validate the run — SLO check

After a run, validate against the plan's thresholds:

```bash
.venv/bin/python -m lib.slo results/run_stats.csv
```

Exit code `0` = all SLOs met, `1` = at least one violation (with details on stderr).

Default SLOs (defined in [lib/slo.py](lib/slo.py)):

| Endpoint | p95 SLO | Notes |
|---|---|---|
| Aggregated (all) | < 500 ms | Plan's end-to-end gate |
| `views:list` | < 150 ms | WS-1 success gate (down from ~5s baseline) |
| `views:popular` | < 150 ms | Same N+1 fix |
| `cached-stats:get` | < 300 ms | WS-2 JSONB + ETag |
| `announcements:list` | < 100 ms | Trivial endpoint, no excuses |

Aggregate failure rate must be `< 0.1%` (no 5xx storm).

Edit `DEFAULT_SLOS` in `lib/slo.py` to tighten/relax targets for a specific run.

## Extending

To add a new endpoint scenario:

1. Create `scenarios/<thing>.py` with a `TaskSet` subclass and `@task`-decorated methods. Use stable `name=` kwargs on every `client.get/post` so stats group correctly.
2. Import it in `locustfile.py`, add to `MIXED_TASKS` with a weight.
3. Add an `SLO(name="thing:action", p95_ms_max=...)` entry in `lib/slo.py`.

Scenarios get the per-user `IdPool` via `self.user.id_pool` — call `pool.pick_workspace()` / `pool.pick_ws_ds()` for realistic targets.

## Scaling beyond one box

A single load-gen machine can sustain a few thousand Locust VUs. For more, run in distributed mode:

```bash
# Master
locust -f locustfile.py --master

# Workers (on each load-gen box, pointing at the master)
locust -f locustfile.py --worker --master-host=<master>
```

Aggregated stats are reported on the master. The plan calls for 2000 VUs — a single 4-core load-gen box handles that comfortably.

## What this harness deliberately does NOT do

- **No backend imports.** This is so the same harness runs against any deployed version, including ones that diverge from the current source tree.
- **No data seeding.** Use the backend's seed scripts (`backend/scripts/...`) or hit a staging clone of prod. Load tests should be repeatable, but the seed is the backend's responsibility.
- **No assertions during the run.** Locust runs to completion; SLO assertions happen post-run from the CSV. Keeps the request path tight and avoids per-request overhead.
- **No retries inside scenarios.** If the backend fails, that's the signal — we want it visible in the failure rate, not papered over.

# Developer Guide

**What this is:** the contributor's map of the platform — its architecture, process roles, and the subsystems (aggregation, versioning, insights) you'll touch when adding features. **Who it's for:** engineers working on the backend or frontend source, whether running it all-in-one or as separate processes.

> [!TIP]
> Just want it running? Jump to [Local Development Setup](#local-development-setup). Read on here for the why behind the architecture.

## What is the platform?

The platform is a graph lineage visualization system. It connects to graph databases (FalkorDB, Neo4j, DataHub), lets teams model data lineage through ontologies, and provides interactive visualization of how data flows through systems. The "aggregation" engine materializes summary edges so that million-node graphs can be navigated at any zoom level without running expensive live traversals.

---

## System Architecture

### The Big Picture

```mermaid
flowchart TB
    Browser["Browser<br/>React 19 + Vite<br/>:5173 dev / :3080 prod"]

    Browser -->|HTTP| Viz

    subgraph Web["Web tier"]
        Viz["viz-service :8000<br/>FastAPI + Uvicorn<br/>Auth, Workspaces, Graph<br/>Queries, Ontology, Views"]
    end

    subgraph Aggregation["Aggregation (separate processes)"]
        CP["Control Plane :8091<br/>Job lifecycle, scheduling<br/>Crash recovery, drift"]
        Worker["Worker(s) :8090<br/>headless batch materializer"]
        Redis["Redis 7 :6380<br/>Streams: job dispatch<br/>Pub/Sub: status events"]
    end

    PG[("PostgreSQL :5432<br/>public schema + aggregation schema")]
    Falkor[("FalkorDB :6379<br/>nodes, edges, lineage,<br/>AGGREGATED edges")]

    Viz -->|SQL| PG
    Viz -->|Cypher| Falkor
    Viz -.->|HTTP proxy<br/>aggregation endpoints| CP

    CP -->|XADD| Redis
    Redis -->|XREADGROUP| Worker
    Worker -->|Cypher MERGE batched| Falkor
    Worker -->|checkpoints SQL| PG
    Worker -.->|job status pub/sub| Redis
    Redis -.->|status events| Viz
    CP -->|SQL| PG
```

### Why This Architecture?

The system is split into independent processes because aggregation is the bottleneck. Materializing AGGREGATED edges for a graph with millions of nodes can take hours. If that work runs inside the web server, it starves API requests of CPU and memory. The three-process split ensures:

1. **viz-service** stays responsive for UI requests even when aggregation is saturating FalkorDB
2. **Control Plane** answers "what's the status of my job?" in milliseconds, not competing with MERGE operations for CPU
3. **Workers** can be scaled independently (1 for dev, 10 for production) and crash without affecting any API

### Process Roles

A single codebase boots into different roles, selected by the `SYNODIC_ROLE` environment variable (`backend/app/runtime/role.py`). The role controls which subsystems the FastAPI lifespan starts:

- **`WEB`** — HTTP API, auth, reads, and lightweight writes. Stateless; scale horizontally.
- **`WORKER`** — aggregation execution and heavy provider I/O.
- **`CONTROLPLANE`** — scheduler, outbox relay, and crash recovery. Singleton.
- **`DEV`** — all-in-one for local development (the default). Runs every subsystem in one process.

```mermaid
flowchart LR
    Codebase["Single codebase<br/>SYNODIC_ROLE"] --> WEB
    Codebase --> WORKER
    Codebase --> CONTROLPLANE
    Codebase --> DEV

    WEB["WEB<br/>HTTP API, auth, reads<br/>stateless, scale out"]
    WORKER["WORKER<br/>aggregation + heavy provider I/O"]
    CONTROLPLANE["CONTROLPLANE<br/>scheduler, crash recovery<br/>singleton"]
    DEV["DEV (default)<br/>all subsystems in one process<br/>local development"]
```

The **versioning projection worker** is a separate process (`python -m backend.app.services.versioning`), not a `SYNODIC_ROLE` value — in `DEV` it can instead run in-process via `GRAPHVER_PROJECTION_INPROCESS=1`.

---

## Components in Detail

### Infrastructure (runs in Docker, even for local dev)

#### PostgreSQL 16 (Port 5432)

The management database. Stores everything that isn't graph data: users, workspaces, providers, ontologies, views, feature flags, aggregation job records. Two schemas:

- **`public`** -- owned by viz-service. Tables: `users`, `workspaces`, `workspace_data_sources`, `providers`, `ontologies`, `views`, `context_models`, `announcement_config`, `feature_flags`, etc.
- **`aggregation`** -- owned by the aggregation service. Tables: `aggregation_jobs` (job state, checkpoints, progress), `data_source_state` (per-data-source aggregation status).

The schema split means a column change in `aggregation_jobs` cannot break the viz-service, and vice versa.

#### FalkorDB (Port 6379)

The graph database. Stores nodes, edges, and lineage relationships as a property graph. FalkorDB speaks the Redis protocol but is a dedicated graph engine using Cypher queries internally. Key data:

- **Nodes** -- entities in the data lineage (tables, columns, jobs, systems)
- **Edges** -- relationships between entities (CONTAINS, FLOWS_TO, TRANSFORMS)
- **AGGREGATED edges** -- materialized summary edges created by the aggregation worker. These are pre-computed rollups that let the UI show lineage at any granularity without live graph traversal.

FalkorDB is accessed through the `GraphDataProvider` interface (`backend/common/interfaces/provider.py`), which abstracts over FalkorDB, Neo4j, and DataHub backends. The `ProviderManager` (`backend/app/providers/manager.py`) caches provider instances and wraps each one in a circuit breaker to prevent cascading failures.

#### Redis 7 (Port 6380)

The message broker. Dedicated instance, separate from FalkorDB (which also speaks Redis protocol on port 6379). Uses two Redis features:

- **Redis Streams** (`aggregation.jobs`) -- durable job dispatch from Control Plane to Workers. Consumer groups (`aggregation-workers`) distribute jobs across worker replicas. The Pending Entry List (PEL) provides automatic crash recovery.
- **Redis Pub/Sub** (`aggregation.events`) -- real-time status event propagation. Workers publish `job.completed`, `job.failed`, etc. The viz-service subscribes to sync `workspace_data_sources.aggregation_status`.

### Application Services (run locally from source, or in Docker)

#### viz-service (Port 8000)

The primary backend. Handles everything the UI needs:

- **Authentication** -- Argon2id password hashing, JWT tokens, CSRF protection, session cookies. The auth subsystem (`backend/auth_service/`) is partially extractable into its own service.
- **Workspace management** -- CRUD for workspaces, data sources, provider connections.
- **Graph queries** -- traversal, search, lineage tracing. Delegates to `GraphDataProvider` implementations via `ProviderManager`.
- **Ontology engine** -- defines entity types and relationship types that classify graph edges as containment (structural) vs lineage (functional).
- **View engine** -- saved visualizations scoped to workspaces with isolation.
- **Aggregation proxy** -- in production mode (`AGGREGATION_PROXY_ENABLED=true`), all 13 aggregation API endpoints are forwarded to the Control Plane via `httpx`. In dev mode, aggregation runs in-process.

**Entry point:** `backend/app/main.py` (FastAPI app with lifespan that bootstraps DB, auth, providers, and aggregation).

**Key file:** `backend/app/api/v1/api.py` -- registers all 13 router groups under `/api/v1`.

#### aggregation-controlplane (Port 8091)

The aggregation API. A standalone FastAPI process that owns job lifecycle:

- **Trigger** -- creates a job record, resolves ontology edge types, dispatches to Redis Stream
- **Status queries** -- job listing, readiness checks, KPI summaries (always fast, no FalkorDB MERGE contention)
- **Resume/Cancel/Delete** -- job state management
- **Scheduling** -- periodic drift detection (fingerprints the graph structure and detects changes)
- **Crash recovery** -- on startup, re-dispatches jobs that were interrupted by a previous crash
- **Purge** -- removes all AGGREGATED edges for a data source

Uses SHORT FalkorDB timeouts (5 seconds) so drift checks and readiness queries degrade gracefully rather than blocking the API when the graph is slow.

**Entry point:** `backend/app/services/aggregation/controlplane.py`

#### aggregation-worker (Port 8090 health only)

The batch executor. Headless -- no HTTP API, only a health probe. Consumes jobs from the Redis Stream and runs heavy FalkorDB MERGE operations:

1. Claims a job via `XREADGROUP` (Redis consumer group)
2. Reads frozen edge types from the job record (no cross-service call needed)
3. Iterates lineage edges in cursor-based batches (no SKIP/OFFSET -- O(n) not O(n^2))
4. For each batch: computes ancestor chains, MERGEs AGGREGATED edges
5. Checkpoints progress to Postgres every ~2 seconds (crash-resumable)
6. On completion: publishes status event via Redis pub/sub

Each worker replica joins the same consumer group, so Redis distributes jobs automatically. Per-graph concurrency is limited (`MAX_CONCURRENT_PER_GRAPH`) to prevent FalkorDB write lock contention.

**Entry point:** `backend/app/services/aggregation/__main__.py`

#### versioning projection worker

The graph-versioning executor. Like the aggregation worker, it is a headless background process that owns the heavy provider I/O for the version-control feature: it runs the resumable **enable-version-control bootstrap** (copying an existing data source into a versioned graph), projects published revisions onto FalkorDB, and handles restore/purge/reconcile work. It polls Postgres (`graphver.jobs`) and consumes a Redis stream, mirroring the aggregation worker's dispatch model, and checkpoints so a killed worker resumes rather than restarts.

Must be running for any enable-VC or projection job to make progress — without it, versioning jobs sit in `pending` forever.

**Entry point:** `python -m backend.app.services.versioning` (dev shortcut: set `GRAPHVER_PROJECTION_INPROCESS=1` to run it inside the viz-service process).

#### insights service

Powers pre-registration discovery (per-asset stats and previews shown before a data source is fully onboarded). The web tier's insights endpoints are **cache-only** — they never call a provider inline. A cache miss enqueues a `discovery` job into the insights service (Redis stream) and returns `200` with `meta.status="computing"` so the frontend renders a placeholder plus an ETA chip; the background service computes the payload and writes it to the cache for the next read.

**Entry point:** `backend/app/api/v1/endpoints/insights.py` (API surface); background jobs run on the insights worker.

#### graph-service (Port 8001)

A lightweight, stateless companion service for graph provider discovery and connectivity testing. No database access -- takes connection parameters in the request body, tests connectivity, and returns results. Used by the admin UI when configuring new graph providers.

**Entry point:** `backend/graph/main.py`

#### frontend (Port 5173 dev / 3080 Docker)

React 19 SPA built with Vite. Key libraries:

- **UI:** Radix UI components, Tailwind CSS
- **Graph visualization:** React Flow (XYFlow), Dagre/ELK layout engines, Mermaid diagrams
- **State:** Zustand (global), TanStack React Query (server state)
- **Routing:** React Router 7

The Vite dev server proxies `/api/*` to the viz-service. In Docker, nginx handles this proxy.

---

## Prerequisites

| Tool        | Version | Purpose                         |
|-------------|---------|----------------------------------|
| Python      | 3.13+   | Backend services                 |
| Node.js     | 18+     | Frontend dev server              |
| Docker      | 20+     | Infrastructure (Postgres, FalkorDB, Redis) |
| pip/venv    | bundled | Python dependency management     |

---

## Local Development Setup

### Step 1: Create the Python virtual environment

```bash
cd synodic
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

### Step 2: Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

### Step 3: Start infrastructure

```bash
./dev.sh infra
```

This runs Postgres, FalkorDB, and Redis in Docker containers. Data persists in named volumes across restarts.

Verify infrastructure is healthy:
```bash
docker compose -f docker-compose.dev.yml ps
```

You should see all three containers as `healthy`:
```
synodic-postgres-dev   postgres:16-alpine   healthy   0.0.0.0:5432->5432/tcp
synodic-falkordb-dev   ...                  healthy   0.0.0.0:6379->6379/tcp
synodic-redis-dev      redis:7-alpine       healthy   0.0.0.0:6380->6379/tcp
```

### Step 4: Start application services

You have two options:

#### Option A: Single-process mode (recommended for daily development)

Two terminals. Backend hot-reloads on file changes.

```bash
# Terminal 1: Backend (all-in-one)
./dev.sh viz

# Terminal 2: Frontend
./dev.sh frontend
```

In this mode:
- `SYNODIC_ROLE=dev` -- all subsystems run in one process
- Aggregation runs in-process via `asyncio.create_task()` (no Redis dispatch)
- No separate Control Plane or Worker needed
- Hot-reload via `uvicorn --reload`

#### Option B: Three-process mode (mirrors production)

Four terminals. Use when testing aggregation scaling, failure isolation, or the proxy architecture.

```bash
# Terminal 1: Aggregation Control Plane
./dev.sh controlplane

# Terminal 2: Aggregation Worker
./dev.sh worker

# Terminal 3: Viz-service (proxy mode)
./dev.sh viz-proxy

# Terminal 4: Frontend
./dev.sh frontend
```

In this mode:
- Viz-service sets `AGGREGATION_PROXY_ENABLED=true` and forwards aggregation requests to `localhost:8091`
- Control Plane dispatches jobs via Redis Streams
- Worker consumes from Redis via `XREADGROUP`
- You can kill the Worker mid-job; it resumes from checkpoint on restart

### Step 5: Open the application

| URL | What |
|-----|------|
| http://localhost:5173 | Frontend (Vite dev server) |
| http://localhost:8000/docs | Backend API docs (Swagger) |
| http://localhost:8091/health | Aggregation Control Plane health |
| http://localhost:3000 | FalkorDB browser UI |

### Step 6: Log in

```
Email:    admin@nexuslineage.local
Password: admin123
```

The admin account is created automatically on first boot by the viz-service.

---

## Running with Docker (Full Stack)

When you don't want to manage local Python/Node environments. All services run in containers.

```bash
# Build and start everything
docker compose up --build

# Scale aggregation workers
docker compose up --scale aggregation-worker=3

# View logs for a specific service
docker compose logs -f aggregation-controlplane

# Stop (data preserved)
docker compose down

# Wipe all data and start fresh
docker compose down -v
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3080 |
| Backend API | http://localhost:8000/docs |
| Control Plane | http://localhost:8091/health |
| FalkorDB Browser | http://localhost:3000 |

---

## Environment Variables

All env vars are pre-configured in `.env.dev` (for local dev) and `docker-compose.yml` (for Docker). Source the dev file before running services manually:

```bash
source .env.dev
```

One exception: `JWT_SECRET_KEY` ships **empty**, because `.env.dev` is tracked and a
signing key committed to the repo is one every clone shares. `./dev.sh` generates a
per-machine value on first run. If you start services by hand without ever running it,
the backend will refuse to boot until you fill it in:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGEMENT_DB_URL` | `postgresql+asyncpg://synodic:synodic@localhost:5432/synodic` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6380/0` | Redis broker connection |
| `FALKORDB_HOST` | `localhost` | FalkorDB hostname |
| `FALKORDB_PORT` | `6379` | FalkorDB port |
| `FALKORDB_GRAPH_NAME` | `nexus_lineage` | Default graph name |

### Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET_KEY` | none — required | Secret for JWT signing. Fails fast at startup if unset or under 32 chars |
| `JWT_SECRET_KEY_PREVIOUS` | empty | Retired signing keys (comma-separated), verify-only — set during a rotation |
| `AUTH_ENVIRONMENT_ID` | empty | Names this deployment; scopes cookie names + JWT issuer so environments don't collide in one browser |
| `JWT_ALGORITHM` | `HS256` | JWT algorithm |
| `JWT_EXPIRY_MINUTES` | `60` | Token lifetime |
| `ADMIN_EMAIL` | `admin@nexuslineage.local` | Bootstrap admin email |
| `ADMIN_PASSWORD` | `admin123` | Bootstrap admin password |

### Process Roles

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNODIC_ROLE` | `dev` | Process role. `dev` = all-in-one, `web` = viz-service only, `controlplane` = aggregation API, `worker` = batch executor |
| `AGGREGATION_PROXY_ENABLED` | `false` | When `true`, viz-service proxies aggregation endpoints to Control Plane |
| `AGGREGATION_SERVICE_URL` | `http://localhost:8091` | Control Plane URL (when proxy enabled) |
| `AGGREGATION_DISPATCH_MODE` | `auto` | How jobs are dispatched: `redis`, `postgres`, `inprocess`, `auto` |

### Worker Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY` | `4` | Max parallel jobs per worker replica |
| `MAX_CONCURRENT_PER_GRAPH` | `2` | Max parallel jobs targeting the same FalkorDB graph |
| `FALKORDB_SOCKET_TIMEOUT` | `10` (web) / `60` (worker) | FalkorDB query timeout in seconds |
| `AGGREGATION_JOB_TIMEOUT_SECS` | `7200` | Per-job timeout (2 hours) |

---

## Database

### Two Schemas

| Schema | Owner | Tables |
|--------|-------|--------|
| `public` | viz-service | `users`, `workspaces`, `workspace_data_sources`, `providers`, `ontologies`, `views`, `context_models`, `feature_flags`, `announcement_config`, and more |
| `aggregation` | aggregation service | `aggregation_jobs` (job state + progress), `data_source_state` (per-data-source aggregation status) |

The schema split means the aggregation service can evolve its tables without affecting the viz-service, and vice versa. No foreign keys cross the schema boundary.

### Migrations

Alembic manages the `public` schema (run by the viz-service at startup):

```bash
source .env.dev
cd backend
alembic upgrade head          # Apply all migrations
alembic current               # Show current revision
alembic downgrade -1          # Roll back one step
alembic revision -m "name"    # Create new migration
```

The `aggregation` schema is managed by `init_aggregation_db()` -- no Alembic needed. The Control Plane and Worker create their own tables at startup via SQLAlchemy `create_all(checkfirst=True)`.

### Fresh Database

```bash
./dev.sh reset        # Wipes all Docker volumes (Postgres, FalkorDB, Redis)
./dev.sh infra        # Restart infrastructure
./dev.sh viz          # Viz-service runs Alembic, seeds admin user
```

---

## How Aggregation Works

### The Problem

A graph with 5 million edges is too large to traverse live for every UI request. FalkorDB variable-length path queries (`MATCH path = (a)-[*1..10]->(b)`) explode combinatorially. Aggregation pre-computes summary AGGREGATED edges so the UI can show lineage at any zoom level in constant time.

### The Pipeline

```mermaid
sequenceDiagram
    participant UI as Frontend
    participant Viz as viz-service
    participant CP as Control Plane
    participant Redis
    participant Worker
    participant Falkor as FalkorDB
    participant PG as Postgres

    UI->>Viz: Click "Run Aggregation"
    Viz->>CP: proxy POST /aggregation
    CP->>CP: validate data source,<br/>resolve ontology edge types
    CP->>PG: create job record
    CP->>Redis: XADD job_id (aggregation.jobs)
    Redis->>Worker: XREADGROUP claims job
    Worker->>PG: read frozen edge types
    loop Cursor-based batches (not skip/offset)
        Worker->>Falkor: fetch 1000 lineage edges (cursor > last)
        Worker->>Worker: compute + expand ancestor pairs
        Worker->>Falkor: MERGE AGGREGATED edges (idempotent)
        Worker->>PG: checkpoint progress (~2s)
    end
    Worker->>Redis: publish job.completed
    Redis->>Viz: status event (pub/sub)
    Viz->>PG: set aggregation_status = "ready"
    UI->>Viz: poll readiness (every 5s)
    Viz-->>UI: ready → enable "Create View"
```

### Crash Recovery

If a Worker dies mid-job:
- The job's `last_cursor` is persisted in Postgres (checkpointed every ~2s)
- The Redis Stream message stays in the Pending Entry List (PEL)
- On restart, `XAUTOCLAIM` recovers unacknowledged messages
- Worker resumes from `last_cursor` -- no work is repeated (MERGE is idempotent)

### Scaling

- **Horizontal:** add worker replicas (`--scale aggregation-worker=N`). Redis consumer groups distribute jobs automatically.
- **Per-graph limit:** `MAX_CONCURRENT_PER_GRAPH=2` prevents write lock contention when multiple jobs target the same FalkorDB graph.
- **Pool sizing:** FalkorDB connection pools auto-scale from `WORKER_CONCURRENCY` (graph_pool = concurrency*4+8).

---

## Project Structure

```
synodic/
  backend/
    app/
      api/v1/
        api.py                       # Router registration (13 groups)
        endpoints/
          aggregation.py             # Aggregation (proxy or direct mode)
          graph.py                   # Graph traversal + search
          views.py                   # View CRUD
          workspaces.py              # Workspace management
          providers.py               # Provider CRUD
          ontologies.py              # Ontology CRUD
          auth.py                    # Signup, password reset
          users.py                   # User management
          assets.py                  # Asset rule sets
          features.py                # Feature flags
          catalog.py                 # Data catalog
          context_models.py          # Context model templates
          announcements.py           # System announcements
      db/
        engine.py                    # SQLAlchemy engines (4 connection pools)
        models.py                    # ORM models (public schema)
        repositories/                # Data access layer
      providers/
        falkordb_provider.py         # Compatibility shim over the falkordb/ package (see docs/BACKEND.md §3)
        manager.py                   # Provider cache + circuit breakers
      services/
        aggregation/                 # Self-contained aggregation package
          __init__.py                #   Package exports
          __main__.py                #   Worker entry point
          controlplane.py            #   Control Plane entry point
          service.py                 #   Job orchestration (894 lines)
          worker.py                  #   Batch materializer
          dispatcher.py              #   Redis/Postgres/InProcess dispatch
          scheduler.py               #   Periodic drift detection
          models.py                  #   ORM (aggregation schema)
          schemas.py                 #   Pydantic models
          redis_client.py            #   Redis connection factory
          events.py                  #   Status event publisher
          event_listener.py          #   Event consumer (viz-service)
          reservation.py             #   Postgres advisory lock for concurrency
          fingerprint.py             #   Graph change detection (SHA256)
          db_init.py                 #   Schema + table creation
        context_engine.py            # View execution context
        assignment_engine.py         # Asset assignment computation
      ontology/                      # Ontology resolution + parsing
      runtime/
        role.py                      # Process role enum (web/worker/cp/dev)
      middleware/                     # Request ID, logging, security headers
      main.py                        # FastAPI app + lifespan
    auth_service/                    # Extractable auth module
      api/router.py                  #   Login, logout, refresh, me
      core/password.py               #   Argon2id hashing
      csrf.py                        #   CSRF double-submit
      service.py                     #   Identity service orchestration
    common/
      interfaces/provider.py         # GraphDataProvider protocol
      adapters/                      # Circuit breaker, provider proxy
    graph/
      main.py                        # Graph service (port 8001)
      adapters/                      # Neo4j, DataHub provider implementations
    alembic/
      versions/0001_baseline.py      # Single baseline migration
    scripts/                         # Import, seed, migration utilities
  frontend/
    src/
      services/
        aggregationService.ts        # Aggregation API client (13 methods)
        apiClient.ts                 # Auth-aware fetch wrapper
      components/                    # React components
      pages/                         # Route pages
    vite.config.ts                   # Dev server + API proxy config
    nginx.conf                       # Production reverse proxy
  docker-compose.yml                 # Full-stack (production)
  docker-compose.dev.yml             # Infrastructure only (local dev)
  dev.sh                             # Local development runner
  .env.dev                           # Local environment variables
```

---

## Common Development Tasks

### Adding a new API endpoint

1. Create route handler in `backend/app/api/v1/endpoints/your_module.py`
2. Register the router in `backend/app/api/v1/api.py`:
   ```python
   api_router.include_router(your_module.router, prefix="/your-prefix", tags=["your-tag"])
   ```
3. Add the TypeScript client method in `frontend/src/services/yourService.ts`

### Adding a new database table

1. Define the ORM model in `backend/app/db/models.py`
2. On fresh DB, the baseline migration discovers it automatically
3. For existing databases, create an explicit migration:
   ```bash
   cd backend && alembic revision -m "add_your_table"
   ```

### Adding a graph data provider

Everything the platform knows about a provider type — how to construct it, what
it can do, what its connection form looks like, how it is probed and validated —
lives in one `ProviderDescriptor` under `backend/common/providers/catalog/`.
That descriptor is the **single registration point for behaviour**: both
dispatchers (`ProviderManager` and `ProviderRegistry`), the admin API, the
connectivity probe, payload validation and the onboarding wizard all read it and
need no edit of their own.

Five further additions are **declarative** — an enum member, a DB CHECK literal,
a migration, a frontend visual, a regenerated fixture. They are listed in step 6
along with the test that fails for each one you forget. This is deliberately not
the same promise as "one file"; it is the more useful one, that almost nothing
you forget stays silent.

*Almost.* There are two edits outside that story, and they are the two that
break production rather than a test: if your provider class lives under
`backend/app/`, each dispatcher needs an eager import of your package or it
cannot dispatch your type at all. Step 3 explains why, and step 6 closes with
the complete edit list — including which entries no test names.

#### 1. Executor — how statements reach the engine

Implement the `CypherExecutor` Protocol
(`backend/common/providers/cypher/executor.py`): `run()` and `run_tolerant()`,
each returning a `CypherResult(raw, result_set)`, over Bolt, HTTP or an embedded
driver. `result_set` must be **the driver's own list object**, not a copy — call
sites index rows positionally and rely on that aliasing being free.
`backend/app/providers/falkordb/executor.py` is the working reference.

#### 2. Dialect — the engine's spelling of the same statements

Supply a `CypherDialect` value (`backend/common/providers/cypher/dialect.py`): a
frozen dataclass carrying the introspection statements (labels, relationship
types, property keys, indexes), index and fulltext DDL, the `id()` / `labels()`
expressions, list-parameter support, unknown-label `MATCH` behaviour and
constant-time counts — each with its declared flag.
`backend/app/providers/falkordb/dialect.py` is the reference value; a second
engine is a new value plus an executor, not another adapter class.

Declare each flag honestly in **both** directions. The dialect conformance suite
(step 7) fails a flag that is `True` and does not work, *and* one that is `False`
but actually does — an under-declared dialect silently forfeits a real
capability, which is as much a bug as one that lies.

#### 3. Descriptor — the one registration point

`backend/common/providers/catalog/<type>.py`, holding a `ProviderDescriptor`
(`catalog/descriptor.py`) with:

- `id`, `label`, `description`, `docs_url`, `family` (a label only — nothing
  branches on it);
- `capability` — a `ProviderCapability` whose `features` set of `ProviderFeature`
  members is what endpoints gate on, instead of comparing `provider_type` to a
  string;
- `connection` — a `ConnectionShape` the onboarding wizard renders **without an
  edit** (`kind="generic"` gives host/port/database/auth/TLS; `falkordb` and
  `spanner` select the two bespoke panels);
- `build(spec)` — construct the provider from a normalised `ProviderSpec`;
- `provider_class_path` — `"module:ClassName"`, resolved by the catalog's own
  class-invariant tests;
- optionally `validate` (raise `ProviderRequestError` → HTTP 422
  `provider_config_invalid`), `probe_strategy`, `probe_deadline_s`,
  `admin_visible`.

Then add the module to the self-registration import at the bottom of
`backend/common/providers/catalog/__init__.py`. `catalog/spanner.py` is the
fullest worked example.

**One exception to "register from the kernel."** `backend/common/providers/` is a
dependency-free kernel: `backend/tests/test_falkordb_kernel_purity.py` fails on
any `backend.app` import there, module-level or inside a function body. If your
provider class lives under `backend/app/`, its descriptor therefore cannot be
constructed by any file in the kernel. Register it from its own package instead,
the way FalkorDB does — `backend/app/providers/falkordb/catalog_descriptor.py`
calls `register()` on import, and that package's `__init__.py` imports it for the
side effect. A class under `backend/graph/adapters/` (Neo4j, DataHub, Spanner)
has no such problem and registers from `catalog/<type>.py` in the ordinary way.

**Registering from your own package is only half of it.** A side effect needs
someone to import the module, and nothing does that on your behalf. Add the same
eager import FalkorDB has to **both** dispatchers — `manager.py:60` and
`provider_registry.py:29`, which carry it independently so that neither depends
on the other's imports:

```python
from backend.app.providers.<type> import catalog_descriptor  # noqa: F401
```

Skip either one and the catalog does not know your type in a process that
reached it through that dispatcher: `descriptor_for('<type>')` returns `None`
and the first real dispatch raises `ValueError: Unknown provider_type`. **No
test tells you this.** `test_provider_catalog_classes.py`'s two fresh-process
import tests pin the guarantee for `falkordb` by name, not for whatever type is
newest, so they stay green. The one test that does go red —
`test_provider_catalog_sync.py::test_provider_type_enum_matches_catalog`, when
you add the enum member in step 6 — invites the wrong repair, because the test
file has an import of exactly this shape at its own line 19. Adding yours
alongside it turns the test green and leaves production 500ing. Both dispatchers,
not the test.

#### 4. Overrides — only where the dialect differs or the engine is faster

Subclass the Cypher base (`backend/app/providers/cypher/`, added in PR 3 by
lifting FalkorDB's engine-neutral modules) and override a method **only** when
the dialect genuinely differs or the engine has a native fast path. The canonical
fast path is FalkorDB's constant-time counts: `reduce_count` answers `count()`
over an unfiltered pattern from the label/relation matrix with no scan operator
at all, which is why `get_counts_fast()` costs ~1.3ms on a 500k-node /
850k-edge graph where `get_stats()`'s two queries — which project `labels(n)[0]`
and lose the optimisation — cost ~514ms. That is what an override is for. Copying
a method to change nothing is how the duplication this catalog removed grew in the
first place.

A store that is not Cypher at all skips steps 1, 2 and 4 and implements
`GraphDataProvider` (`backend/common/interfaces/provider.py`) directly. Spanner is
the reference. Everything else in this recipe applies unchanged.

#### 5. Ontology — the step that separates a provider that works from one that looks like it works

This is not optional polish; it is the difference between a correct graph and a
flat one, and it used to fail **silently**.

Until PR 2, a provider participated in ontology by duck-typing: `ContextEngine`
asked `hasattr(provider, 'set_containment_edge_types')` and *skipped* a provider
that lacked it. No error — just a flat graph with no containment structure and no
root types, discovered whenever a user eventually said the canvas looked wrong.

So, for a new provider:

- **The injection setters are contract obligations, not duck-typed extras.**
  `set_containment_edge_types`, `set_entity_type_levels`,
  `set_resolved_edge_metadata`, `set_source_type_aliases`, `set_node_identity`
  and `set_admission_controller` are base-class members of `GraphDataProvider`
  with working defaults. You participate by construction — inherit them, or
  override them if your engine needs to do something with the values. Do not
  reintroduce a `hasattr` guard at a call site.
- **Never cache ontology *classification* under a key that does not encode the
  ontology.** Introspection ("which entity and edge types exist in this graph")
  is a fact about the graph and is safely cacheable under a graph-scoped key.
  Classification (which of those are containment vs lineage, the type hierarchy,
  the root types) is a function of the ontology injected into *this instance*,
  and a provider may legitimately be asked before injection has happened. Two
  rules, and the first alone is **not** enough:
  1. Consult `GraphDataProvider.containment_configured` before writing any
     answer derived from injected state to a shared key. That stops an
     *uninjected* caller publishing its provisional answer — measured on the
     pre-refactor code, one warmed the shared key with `containment=[]`,
     hierarchy 0, roots `[]`, and a correctly-configured reader arriving
     afterwards got that back, with `HAS` presented as a *flow* edge rather
     than a *structural* one.
  2. Fold a digest of the injected ontology into the key. Configured-ness says
     *whether* an ontology was injected, never *which* one, so two correctly
     injected callers still collide: the DB uniqueness constraint is
     (workspace, provider, graph_name), so two data sources in different
     workspaces can address the same physical graph with different ontologies,
     and both writes are legitimate. Without the digest they overwrite each
     other, and editing one data source's ontology changes nothing any reader
     sees until the TTL expires.

  `backend/app/providers/falkordb/stats.py` does both — `_ontology_cache_key`
  is the worked example. Copy its two hashing rules as well as its inputs:
  **sort every collection before hashing, and use `hashlib`, never `hash()`**.
  Both `hash()` and set/frozenset iteration order vary per process with
  `PYTHONHASHSEED`, so a digest built from unsorted iteration fails nothing —
  it silently gives every worker its own key.
- A new provider should implement the **introspection** half and leave
  classification to the ontology layer above it.

#### 6. The five declarative additions, and the test that names each

| Addition | Where | What fails if you skip it |
|---|---|---|
| `ProviderType` enum member | `backend/common/models/management.py` | `test_provider_catalog_sync.py::test_provider_type_enum_matches_catalog` |
| DB CHECK constraint literal | `ProviderORM.__table_args__`, `backend/app/db/models.py` (`ck_providers_provider_type`) | `test_provider_catalog_sync.py::test_db_check_constraint_matches_catalog_plus_legacy` |
| Alembic migration widening that CHECK | `backend/alembic/versions/`, copied from `20260508_spanner_provider.py` | `test_provider_catalog_sync.py::test_newest_migration_new_types_matches_catalog_plus_legacy` and `::test_db_check_constraint_matches_newest_migration` |
| `PROVIDER_TYPE_IDS` + `PROVIDER_VISUALS` entry | `frontend/src/services/providerTypes.ts` | `npx tsc --noEmit` — `PROVIDER_VISUALS` is a `Record<ProviderType, …>`, so an id with no visual is a compile error (`TS2741`), not a half-registered type |
| Regenerated backend fixture | `frontend/src/services/__fixtures__/providerTypes.backend.json` | `test_api_provider_types.py::test_list_provider_types_generates_the_frontend_fixture` |

One honest caveat on that table:

- The migration row also needs a **one-line test edit**.
  `test_provider_catalog_sync.py`'s `_newest_provider_type_migration()` asserts
  there is exactly one migration touching `ck_providers_provider_type`; a second
  one trips that assert with a message telling you to point it at the newest.
  That is the test doing its job, not a defect — but it means the migration is
  two edits, not one.

The fixture row is a **regeneration**, not an edit — the test that names it is
the same test that writes it:

```bash
cd backend && UPDATE_PROVIDER_TYPES_FIXTURE=1 \
    python -m pytest tests/test_api_provider_types.py -k generates_the_frontend_fixture
```

Run without that variable — i.e. in CI, and in every ordinary run — the same
test compares the checked-in file against the live `GET
/admin/providers/types` response and fails with the diff if they have parted.
It is worth knowing what that failure is protecting you from, because the
symptom is otherwise mild enough to ship: the frontend's offline snapshot
(`STATIC_PROVIDER_TYPES`) simply has no row for your type, so
`providerTypeEntry()` falls back to a synthesised generic entry with
`adminVisible: false` and no features — the wizard's type card is missing
until the live query resolves, and any `supportsFeature(id, …)` asked without
a live catalog answers `false`.

##### The complete edit list

The five above are the declarative ones. This is all of it, in the order it is
easiest to do, so you can see what the "one registration" promise does and does
not cover:

| # | Edit | What names it if you forget |
|---|---|---|
| 1 | Descriptor + your package's `__init__` import | — (this *is* the registration) |
| 2 | Eager import in `backend/app/providers/manager.py` | **nothing** — see step 3 |
| 3 | Eager import in `backend/app/registry/provider_registry.py` | **nothing** — see step 3 |
| 4 | `ProviderType` enum member | `test_provider_catalog_sync.py::test_provider_type_enum_matches_catalog` |
| 5 | ORM CHECK constraint literal | `test_provider_catalog_sync.py::test_db_check_constraint_matches_catalog_plus_legacy` |
| 6 | Alembic migration widening that CHECK | `test_provider_catalog_sync.py::test_newest_migration_new_types_matches_catalog_plus_legacy` |
| 7 | Retarget `_newest_provider_type_migration()` | its own assert message |
| 8 | `PROVIDER_TYPE_IDS` + `PROVIDER_VISUALS` | `npx tsc --noEmit` (`TS2741`) |
| 9 | Regenerate the frontend fixture | `test_api_provider_types.py::test_list_provider_types_generates_the_frontend_fixture` |
| 10 | `test_provider_catalog_classes.py`'s registered-id set | itself |
| 11 | `test_api_provider_types.py`'s id set and count | itself |

Rows 10 and 11 are two tests that enumerate today's four types by hand; they
fail with the new id in the diff, which is the test doing its job. Rows 2 and 3
are the only two edits on this list that nothing at all names, and they are the
only two whose omission is a 500 rather than a red run — which is why they get
their own paragraph in step 3 rather than a table row here.

The drift guards are deliberately absent from this list. Both of them
(`test_provider_type_literals.py` and `providerTypes.drift.test.ts`) derive
their provider ids from `ProviderType` / `PROVIDER_TYPE_IDS`, and the backend's
`isinstance` check matches any `…Provider` class by shape, so row 4 and row 8
extend them for you. If you find yourself editing a guard to make your provider
pass, stop — that is the guard reporting a real dispatch you wrote, not a list
that needs your id added to it.

#### 7. Run the provider conformance kit

Four parts, in this order:

1. **The base's fake-executor suite** — per-method tests with pinned Cypher, run
   against a fake executor rather than a live engine.
2. **The live contract snapshot.** `make_contract_test` in
   `backend/tests/regression/_runner.py` does all the work; a new provider's
   contract test is ~15 lines of its own plus a docstring:

   ```python
   from . import _runner

   async def _cleanup(provider) -> None: ...

   test_<type>_provider_contract = _runner.make_contract_test(
       "<type>", env_prefix="<TYPE>_TEST", cleanup=_cleanup,
   )
   ```

   It builds the provider **through the catalog** — the same path production uses,
   so a bad `build` or a wrong capability fails here rather than in a deployment —
   and skips (never fails) unless `<PREFIX>_HOST` is set and `host:port` accepts a
   TCP connection. `test_neo4j_provider_contract.py` is the reference.

   The factory assumes a provider addressed by `host:port`. A provider addressed
   by a resource path instead (Spanner: project/instance/database) keeps its own
   fixture and skip gate, builds a `ProviderSpec` by hand, still constructs via
   `create_provider_instance`, and calls `_runner.seed()` / `_runner.run_all()`
   directly — see `test_spanner_provider_contract.py`. `run_all()` itself carries
   no host:port assumption, so that path is exactly as fully covered.
3. **The dialect conformance suite** —
   `backend/tests/regression/dialect_conformance.py` holds the agreed
   specification of its seven probes (introspection, index DDL, fulltext, id/labels
   expressions, list params, unknown-label MATCH, counts). It is a docstring-only
   stub today; PR 3 fills it in with the Cypher base it tests against.
4. **The drift guards** — `backend/tests/test_provider_type_literals.py` fails CI
   if a `provider_type == "…"` comparison, a `.lower() == "…"` normalised
   comparison, an `isinstance(x, SomeConcreteProvider)` dispatch, or a
   string-keyed capability dict is reintroduced under `backend/app`,
   `backend/common` or `backend/insights_service`. Its frontend counterpart is
   `frontend/src/services/__tests__/providerTypes.drift.test.ts`, which matches
   both quoted literals and unquoted object keys (`falkordb:` in a label map is a
   real site a quoted-literal grep misses). If you need a genuine exemption, add it
   to the allow-list **with a reason**, not a count.

Also worth running, since they are cheap and cover the catalog's own invariants:
`backend/tests/test_provider_catalog_classes.py` (every `provider_class_path`
resolves, no unfilled abstract methods, `preflight` is a coroutine on every
registered class, importing the kernel catalog pulls in no `backend.app` module
and no graph driver) and `backend/tests/test_provider_catalog_sync.py`.

### Testing aggregation

```bash
# Simplest: single-process mode
./dev.sh viz

# In the UI:
# 1. Navigate to Admin > Workspaces
# 2. Create a workspace and add a data source (pointing to a FalkorDB graph)
# 3. Assign an ontology
# 4. Click "Run Aggregation"
# 5. Watch progress in the terminal and UI
```

### Seeding demo data

```bash
# Docker:
docker compose --profile seed up --build

# Local:
source .env.dev
python -m backend.scripts.seed_default_environment
```

---

## Monitoring and Debugging

### Health endpoints

```bash
# viz-service
curl http://localhost:8000/health
curl http://localhost:8000/health/ready          # Includes provider states
curl http://localhost:8000/api/v1/health/providers  # Per-workspace provider health

# Aggregation Control Plane
curl http://localhost:8091/health

# Aggregation Worker (if running standalone)
curl http://localhost:8090/
```

### Aggregation monitoring

```bash
# Job listing
curl http://localhost:8000/api/v1/admin/aggregation-jobs | python -m json.tool

# Job summary (KPIs)
curl http://localhost:8000/api/v1/admin/aggregation-jobs/summary

# Redis Stream state
redis-cli -p 6380 XLEN aggregation.jobs                              # Queue length
redis-cli -p 6380 XPENDING aggregation.jobs aggregation-workers - + 10  # Pending (in-flight)
redis-cli -p 6380 XINFO GROUPS aggregation.jobs                      # Consumer group info
```

### Database inspection

```bash
# Connect to Postgres
psql postgresql://synodic:synodic@localhost:5432/synodic

# Check aggregation jobs
SELECT id, status, progress, data_source_id FROM aggregation.aggregation_jobs ORDER BY created_at DESC LIMIT 10;

# Check aggregation state
SELECT * FROM aggregation.data_source_state;

# Check users
SELECT email, status FROM users;
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| **503 "Aggregation service not available"** | In proxy mode but Control Plane isn't running | Start Control Plane: `./dev.sh controlplane` |
| **503 "Provider unavailable"** | FalkorDB unreachable or circuit breaker open | Check: `redis-cli -p 6379 ping`. Breaker resets in 30s. |
| **Login fails** | Wrong credentials or admin not seeded | Use `admin@nexuslineage.local` / `admin123`. Wipe and restart if needed: `./dev.sh reset` |
| **Alembic error on startup** | Stale migration state | `./dev.sh reset` for clean start |
| **Redis connection refused** | Redis not running | `docker compose -f docker-compose.dev.yml up -d redis` |
| **"relation aggregation.aggregation_jobs does not exist"** | Schema not created | The Control Plane creates it at startup. Make sure it runs before viz-service. |
| **Aggregation job stuck in "running"** | Worker crashed, job never completed | The scheduler watchdog marks stale jobs as failed after 2x the job timeout. Or restart the worker. |
| **Frontend can't reach API** | Vite proxy not configured | Check `frontend/vite.config.ts` proxy target matches your backend port |

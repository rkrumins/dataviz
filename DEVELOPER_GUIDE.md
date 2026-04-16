# Synodic Developer Guide

## What is Synodic?

Synodic is a graph lineage visualization platform. It connects to graph databases (FalkorDB, Neo4j, DataHub), lets teams model data lineage through ontologies, and provides interactive visualization of how data flows through systems. The "aggregation" engine materializes summary edges so that million-node graphs can be navigated at any zoom level without running expensive live traversals.

---

## System Architecture

### The Big Picture

```
                    +------------------+
                    |     Browser      |
                    |  React 19 + Vite |
                    +--------+---------+
                             |
                    HTTP (port 5173 dev / 3080 prod)
                             |
               +-------------v--------------+
               |        viz-service          |    Port 8000
               |     (FastAPI + Uvicorn)     |
               |                             |
               |  Auth, Workspaces, Graph    |
               |  Queries, Ontology, Views   |
               |                             |
               |  Aggregation endpoints are  |
               |  proxied to Control Plane   |---+
               +--+---------------------+---+   |
                  |                     |         |
                  | SQL                 | Cypher   |  HTTP proxy
                  |                     |         |
         +--------v-------+    +-------v----+    |
         |   PostgreSQL    |    |  FalkorDB  |    |
         |   Port 5432     |    |  Port 6379 |    |
         |                 |    |            |    |
         | public schema:  |    | Graph data:|    |
         |  users          |    |  nodes     |    |
         |  workspaces     |    |  edges     |    |
         |  providers      |    |  lineage   |    |
         |  ontologies     |    |  AGGREGATED|    |
         |  views          |    +-------^----+    |
         |                 |            |         |
         | aggregation     |            |         |
         |  schema:        |      Cypher MERGE    |
         |  aggregation_   |       (batched)      |
         |   jobs          |            |         |
         |  data_source_   |    +-------+----+    |
         |   state         |    | Aggregation|    |
         +--------^--------+    |  Worker(s) |    |
                  |             |  (headless)|    |
                  | SQL         |  Port 8090 |    |
                  |             +------^-----+    |
                  |                    |           |
                  |              XREADGROUP        |
                  |                    |           |
                  |             +------+-----+    |
                  |             |   Redis 7   |    |
                  |             |  Port 6380  |    |
                  |             |             |    |
                  |             | Streams:    |    |
                  |             |  job dispatch|   |
                  |             | Pub/Sub:    |    |
                  |             |  status     |    |
                  |             |  events     |    |
                  |             +------^------+    |
                  |                    |           |
                  |               XADD |           |
                  |                    |           |
               +--+--------------------+---+      |
               |  Aggregation Control Plane | <----+
               |       Port 8091            |
               |                            |
               |  Job lifecycle, scheduling |
               |  Crash recovery, drift     |
               +----------------------------+
```

### Why This Architecture?

The system is split into independent processes because aggregation is the bottleneck. Materializing AGGREGATED edges for a graph with millions of nodes can take hours. If that work runs inside the web server, it starves API requests of CPU and memory. The three-process split ensures:

1. **viz-service** stays responsive for UI requests even when aggregation is saturating FalkorDB
2. **Control Plane** answers "what's the status of my job?" in milliseconds, not competing with MERGE operations for CPU
3. **Workers** can be scaled independently (1 for dev, 10 for production) and crash without affecting any API

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
docker compose up --build
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
| `JWT_SECRET_KEY` | auto-generated | Secret for JWT signing (set in production) |
| `JWT_ALGORITHM` | `HS256` | JWT algorithm |
| `JWT_EXPIRY_MINUTES` | `60` | Token lifetime |
| `ADMIN_EMAIL` | `admin@nexuslineage.local` | Bootstrap admin email |
| `ADMIN_PASSWORD` | `changeme` | Bootstrap admin password |

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

```
1. User clicks "Run Aggregation" in the UI
        |
2. viz-service proxies POST to Control Plane
        |
3. Control Plane:
   - Validates data source exists
   - Resolves ontology (which edge types are containment vs lineage)
   - Creates job record in aggregation.aggregation_jobs
   - XADD job_id to Redis Stream "aggregation.jobs"
        |
4. Worker:
   - XREADGROUP claims the job from the stream
   - Reads frozen edge types from the job record
   - Batch loop (cursor-based, NOT skip/offset):
     a. Fetch 1000 lineage edges (WHERE cursor > last_cursor)
     b. Compute ancestor chains for all URNs (cached in Redis)
     c. Expand to ancestor pairs (source_chain x target_chain)
     d. MERGE AGGREGATED edges into FalkorDB (idempotent)
     e. Checkpoint progress to Postgres (every ~2s)
   - On completion: publish job.completed event
        |
5. viz-service event listener:
   - Receives event via Redis pub/sub
   - Updates workspace_data_sources.aggregation_status = "ready"
        |
6. Frontend polls readiness endpoint every 5 seconds
   - Shows progress bar during execution
   - Enables "Create View" button when ready
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
        falkordb_provider.py         # FalkorDB adapter (~2700 lines)
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

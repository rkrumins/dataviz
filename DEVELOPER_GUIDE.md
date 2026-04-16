# Synodic Developer Guide

## Architecture Overview

Synodic is a graph lineage visualization platform with a three-service backend architecture:

```
Browser (React)
    |
    v
viz-service (8000)          -- Web API, auth, graph queries, ontology
    |
    |--- proxy --------->  aggregation-controlplane (8091)   -- Job API, scheduling, drift detection
                                |
                           Redis Streams
                                |
                           aggregation-worker (x N)          -- Batch MERGE execution against FalkorDB
```

**Infrastructure:**

| Service    | Port  | Purpose                                          |
|------------|-------|--------------------------------------------------|
| PostgreSQL | 5432  | Management database (users, workspaces, jobs)     |
| FalkorDB   | 6379  | Graph database (nodes, edges, lineage)            |
| Redis      | 6380  | Message broker (job dispatch, status events)       |

**Application services:**

| Service                  | Port | Purpose                                               |
|--------------------------|------|-------------------------------------------------------|
| viz-service              | 8000 | Web API, auth, graph queries. Proxies aggregation endpoints to Control Plane |
| aggregation-controlplane | 8091 | Aggregation job lifecycle, scheduling, drift detection |
| aggregation-worker       | 8090 | Headless batch executor (heavy FalkorDB I/O)          |
| graph-service            | 8001 | Stateless graph provider discovery                    |
| frontend                 | 5173 | React SPA (Vite dev server)                           |

---

## Prerequisites

- **Python 3.13+**
- **Node.js 18+** (for frontend)
- **Docker** (for infrastructure only)

---

## Quick Start

### 1. Clone and set up Python environment

```bash
cd synodic
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

### 2. Start infrastructure

```bash
./dev.sh infra
```

This starts Postgres, FalkorDB, and Redis in Docker. Data persists across restarts.

### 3. Start the application

**Simplest option — single-process mode (one terminal):**

```bash
./dev.sh viz
```

This runs the entire backend in one process with hot-reload. Aggregation runs in-process (no separate Control Plane or Worker needed).

**In a second terminal, start the frontend:**

```bash
./dev.sh frontend
```

### 4. Open the app

- **Frontend:** http://localhost:5173
- **API docs:** http://localhost:8000/docs
- **FalkorDB browser:** http://localhost:3000

### 5. Log in

```
Email:    admin@nexuslineage.local
Password: admin123
```

---

## Development Modes

### Mode A: Single-Process (Recommended for most development)

Everything runs in one Python process. Simplest setup, fastest iteration.

```bash
# Terminal 1: Backend (hot-reload on file changes)
./dev.sh viz

# Terminal 2: Frontend
./dev.sh frontend
```

- Aggregation jobs run in-process via `asyncio.create_task()`
- No Redis Streams dispatching (jobs execute immediately)
- Best for: UI work, API changes, general feature development

### Mode B: Three-Process (Production-like)

Mirrors the Docker production topology. Use when testing the decoupled aggregation architecture.

```bash
# Terminal 1: Aggregation Control Plane (API on port 8091)
./dev.sh controlplane

# Terminal 2: Aggregation Worker (headless batch executor)
./dev.sh worker

# Terminal 3: Viz-service in proxy mode (forwards aggregation to CP)
./dev.sh viz-proxy

# Terminal 4: Frontend
./dev.sh frontend
```

- Jobs dispatched via Redis Streams
- Worker consumes jobs independently
- Control Plane can be killed/restarted without affecting running jobs
- Best for: testing aggregation scaling, worker isolation, failure scenarios

---

## Running with Docker (Full Stack)

No local Python/Node needed. Everything runs in containers.

```bash
# Build and start everything
docker compose up --build

# Scale aggregation workers
docker compose up --scale aggregation-worker=3

# View logs for a specific service
docker compose logs -f aggregation-controlplane

# Wipe everything and start fresh
docker compose down -v
docker compose up --build
```

**Ports:**

| Service                  | URL                          |
|--------------------------|------------------------------|
| Frontend                 | http://localhost:3080         |
| Viz-service API          | http://localhost:8000/docs    |
| Aggregation Control Plane| http://localhost:8091/health  |
| FalkorDB Browser         | http://localhost:3000         |

---

## Project Structure

```
synodic/
  backend/
    app/
      api/v1/endpoints/       # FastAPI route handlers
        aggregation.py         #   Aggregation endpoints (proxy or direct)
        graph.py               #   Graph query endpoints
        views.py               #   View CRUD
        workspaces.py          #   Workspace management
      db/
        engine.py              # SQLAlchemy engine + connection pools
        models.py              # ORM models (public schema)
      providers/
        falkordb_provider.py   # FalkorDB graph adapter (2700 lines)
        manager.py             # Provider cache + circuit breakers
      services/
        aggregation/           # Self-contained aggregation package
          __main__.py           #   Worker entry point (Redis Streams consumer)
          controlplane.py       #   Control Plane entry point (FastAPI)
          service.py            #   Job orchestration logic
          worker.py             #   Batch materializer
          dispatcher.py         #   Redis/Postgres/InProcess dispatch
          scheduler.py          #   Periodic drift detection
          models.py             #   ORM (aggregation schema)
          schemas.py            #   Pydantic request/response models
          redis_client.py       #   Redis connection factory
          events.py             #   Status event publisher
          event_listener.py     #   Event consumer (for viz-service)
          db_init.py            #   Schema + table creation
      runtime/
        role.py                # Process role (web/worker/controlplane/dev)
      main.py                  # FastAPI app + lifespan
    auth_service/              # Authentication (extractable)
    common/                    # Shared interfaces + circuit breaker
    alembic/                   # Database migrations
  frontend/
    src/
      services/
        aggregationService.ts  # Aggregation API client
      components/              # React components
  docker-compose.yml           # Full-stack production
  docker-compose.dev.yml       # Infrastructure only (for local dev)
  dev.sh                       # Local development runner
  .env.dev                     # Local environment variables
```

---

## Database

### Schemas

Synodic uses two Postgres schemas:

- **`public`** — owned by the viz-service (users, workspaces, providers, ontologies, views)
- **`aggregation`** — owned by the aggregation service (aggregation_jobs, data_source_state)

This separation means the aggregation service can evolve its schema independently.

### Running migrations

Alembic migrations are managed by the viz-service:

```bash
source .env.dev
cd backend
alembic upgrade head      # Apply all migrations
alembic downgrade -1      # Roll back one migration
alembic current           # Show current revision
```

The aggregation Control Plane and Worker do NOT depend on Alembic. They create their own schema and tables at startup via `init_aggregation_db()`.

### Fresh database

```bash
./dev.sh reset            # Wipe Docker volumes
./dev.sh infra            # Restart infrastructure
./dev.sh viz              # Viz-service runs Alembic on first boot
```

---

## Aggregation System

### How aggregation works

1. User triggers aggregation for a data source (via UI or API)
2. **Control Plane** creates a job record, resolves ontology edge types, dispatches to Redis Stream
3. **Worker** picks up the job, iterates lineage edges in cursor-based batches
4. For each batch: compute ancestor chains, MERGE AGGREGATED edges into FalkorDB
5. Progress checkpointed every ~2 seconds (resumable on crash)
6. On completion: status event published via Redis pub/sub
7. **Viz-service** event listener syncs status to `workspace_data_sources`

### Key environment variables

| Variable                    | Default       | Used by       | Purpose                                |
|-----------------------------|---------------|---------------|----------------------------------------|
| `SYNODIC_ROLE`              | `dev`         | All           | Process role (web/worker/controlplane/dev) |
| `AGGREGATION_PROXY_ENABLED` | `false`       | viz-service   | Proxy aggregation to Control Plane     |
| `AGGREGATION_DISPATCH_MODE` | `auto`        | viz-service   | redis / postgres / inprocess / auto    |
| `WORKER_CONCURRENCY`        | `4`           | worker        | Max parallel jobs per replica          |
| `MAX_CONCURRENT_PER_GRAPH`  | `2`           | worker        | Max parallel jobs per FalkorDB graph   |
| `FALKORDB_SOCKET_TIMEOUT`   | `10`          | All           | Graph query timeout (60s for worker)   |
| `AGGREGATION_JOB_TIMEOUT_SECS` | `7200`    | worker        | Per-job timeout (2 hours)              |
| `REDIS_URL`                 | (none)        | All           | Redis broker connection string         |

### Monitoring aggregation

```bash
# Check Control Plane health
curl http://localhost:8091/health

# List all jobs (via viz-service)
curl http://localhost:8000/api/v1/admin/aggregation-jobs

# Check Redis Stream length
redis-cli -p 6380 XLEN aggregation.jobs

# Check pending messages (unprocessed)
redis-cli -p 6380 XPENDING aggregation.jobs aggregation-workers - + 10

# Check worker health (if running standalone)
curl http://localhost:8090/
```

---

## Common Tasks

### Add a new API endpoint

1. Add the route handler in `backend/app/api/v1/endpoints/<module>.py`
2. Register the router in `backend/app/api/v1/api.py`
3. Add the frontend service method in `frontend/src/services/`

### Add a new database table

1. Add the ORM model in `backend/app/db/models.py`
2. The baseline Alembic migration auto-discovers ORM models via `Base.metadata.create_all()`
3. For production: create an explicit Alembic migration:
   ```bash
   cd backend && alembic revision -m "add_my_table"
   ```

### Test aggregation locally

```bash
# Single-process mode (simplest):
./dev.sh viz

# In the UI: create a workspace, add a data source, assign an ontology,
# then click "Run Aggregation". Watch the terminal for progress logs.
```

### Seed demo data

```bash
# With Docker (full stack):
docker compose --profile seed up --build

# Locally:
source .env.dev
python -m backend.scripts.seed_default_environment
```

---

## Troubleshooting

### "Aggregation service is not available" (503)

The viz-service can't reach the Control Plane.

- **Single-process mode:** Make sure `AGGREGATION_PROXY_ENABLED=false` and `SYNODIC_ROLE=dev`
- **Proxy mode:** Make sure the Control Plane is running on port 8091

### "Provider unavailable" (503)

FalkorDB is unreachable or the circuit breaker is open.

- Check FalkorDB is running: `redis-cli -p 6379 ping`
- Check provider health: `curl http://localhost:8000/api/v1/health/providers`
- Circuit breaker resets after 30 seconds

### Login fails

- Default credentials: `admin@nexuslineage.local` / `admin123`
- On fresh DB, the admin is created on first viz-service boot
- If you started with different `ADMIN_EMAIL`, wipe and restart:
  ```bash
  ./dev.sh reset && ./dev.sh infra && ./dev.sh viz
  ```

### Alembic migration errors

```bash
# Check current state
cd backend && alembic current

# Fresh start (wipes all data)
./dev.sh reset
```

### Redis connection refused

Make sure the dev Redis is running on port 6380:
```bash
docker compose -f docker-compose.dev.yml ps
redis-cli -p 6380 ping
```

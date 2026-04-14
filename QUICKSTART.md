# Synodic — Local Setup Guide

Get the full Synodic platform running locally with pre-loaded sample data. No external dependencies beyond Docker.

---

## Prerequisites

| Requirement              | Version |
|--------------------------|---------|
| Docker                   | 24+     |
| Docker Compose (v2)      | 2.20+   |
| Free ports               | 3000, 3080, 6379, 8000, 8001 |

Verify:

```bash
docker --version
docker compose version
```

---

## Option A — Quickstart (Recommended)

Everything is pre-loaded — no database setup, no seeding, no configuration. One command.

### 1. Clone the repository

```bash
git clone <repo-url> synodic
cd synodic
```

### 2. Start the platform

```bash
docker compose -f docker-compose.quickstart.yml up --build
```

Wait until all four services report healthy (roughly 30–60 seconds). You will see output like:

```
synodic-falkordb-1       | Ready to accept connections
synodic-viz-service-1    | [INFO] Application startup complete.
synodic-graph-service-1  | [INFO] Application startup complete.
synodic-frontend-1       | start worker process
```

### 3. Open the application

| Service          | URL                                                  | Notes                     |
|------------------|------------------------------------------------------|---------------------------|
| Frontend (UI)    | [http://localhost:3080](http://localhost:3080)        | Main application          |
| Viz API Docs     | [http://localhost:3080/viz-docs](http://localhost:3080/viz-docs) | Swagger UI via nginx proxy |
| Graph API Docs   | [http://localhost:3080/graph-docs](http://localhost:3080/graph-docs) | Swagger UI via nginx proxy |
| Viz API (direct) | [http://localhost:8000/docs](http://localhost:8000/docs) | Bypasses nginx            |
| Graph API (direct)| [http://localhost:8001/docs](http://localhost:8001/docs) | Bypasses nginx           |
| FalkorDB Browser | [http://localhost:3000](http://localhost:3000)        | Graph database UI         |

### 4. Log in

| Field    | Value                  |
|----------|------------------------|
| Email    | `admin@synodic.local`  |
| Password | `admin123`             |

### 5. What's included

The quickstart ships with pre-populated data baked into the Docker images:

**Management DB** (`nexus_core.db` — SQLite, 1.8 MB):
- Admin user account
- Pre-configured FalkorDB provider
- Default workspace and ontology
- System templates and feature definitions

**Graph Database** (`dump.rdb` — FalkorDB snapshot, 21 MB):

| Graph              | Nodes  | Edges   |
|--------------------|--------|---------|
| `nexus_lineage`    | 1,996  | 6,065   |
| `backup_nexus_graph` | 1,996 | 6,065  |
| `physical_lineage5`| 67,870 | 128,796 |
| `physical_lineage4`| 4,358  | 8,368   |
| `physical_lineage2`| 603    | 1,121   |
| `physical_lineage3`| 603    | 1,121   |
| `physical_lineage` | 405    | 742     |

### 6. Stop the platform

```bash
# Stop (containers removed, no persistent volumes to worry about)
docker compose -f docker-compose.quickstart.yml down
```

---

## Option B — Full Development Setup

Uses PostgreSQL for the management database and seeds data at runtime. Better for active development and production-like environments.

### 1. Clone and configure

```bash
git clone <repo-url> synodic
cd synodic
cp .env.example .env
```

Edit `.env` if you need to change defaults (most values have sensible defaults).

### 2. Start infrastructure + services

```bash
# All services (FalkorDB + PostgreSQL + backends + frontend)
docker compose up --build
```

### 3. (Optional) Seed demo data

In a separate terminal:

```bash
docker compose --profile seed up --build
```

This generates enterprise demo scenarios (finance, ecommerce) and loads them into FalkorDB. The seeder runs once and exits. Control the size with environment variables in `docker-compose.yml`:

| Variable         | Default | Description                      |
|------------------|---------|----------------------------------|
| `SEED_SCENARIOS` | `finance,ecommerce` | Scenarios to generate  |
| `SEED_SCALE`     | `1`     | ~1k nodes per scenario per unit  |
| `SEED_BREADTH`   | `1`     | Parallel system chains           |
| `SEED_DEPTH`     | `1`     | Transformation layers            |
| `SEED_FORCE`     | `false` | Set `true` to re-seed existing data |

### 4. Access

Same URLs as Option A. Login credentials are the same unless you changed them in `.env`.

### 5. Local dev against Docker infrastructure

If you want to run the backends locally (e.g., with hot-reload) but still use the Dockerized databases:

```bash
# Start the management Postgres (v16) — dev-only credentials baked in
docker compose -f docker-compose.dev.yml up -d

# Optionally start FalkorDB if you want a graph backend running locally
docker compose up -d falkordb

# Configure the management DB URL for the local processes
export MANAGEMENT_DB_URL='postgresql+asyncpg://synodic:synodic@localhost:5432/synodic'

# Run viz-service locally (init_db calls `alembic upgrade head` on startup)
cd backend
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --port 8000

# Run graph-service locally (separate terminal)
uvicorn backend.graph.main:app --reload --port 8001

# Run frontend locally (separate terminal)
cd frontend
npm install
npm run dev    # Vite dev server on http://localhost:5173
```

> **Postgres-only.** Synodic dropped SQLite as of the schema-optimization branch. The management DB is Postgres v16+ in every environment — dev, CI, prod. Trying to start with a non-Postgres `MANAGEMENT_DB_URL` fails fast with a clear error.

### 6. Schema migrations (Alembic)

Synodic uses Alembic to own all schema lifecycle. The application's `init_db()` invokes `alembic upgrade head` automatically on startup, so a regular `uvicorn` boot is enough to migrate the dev DB. For manual control:

```bash
cd backend

# Apply all pending migrations (idempotent — safe to re-run)
alembic upgrade head

# Show current revision
alembic current

# Show history
alembic history

# Roll back one revision
alembic downgrade -1
```

**Stopping vs wiping the dev Postgres:**

The named volume in `docker-compose.dev.yml` survives `down` so your dev data persists across normal restarts:

```bash
# Stop, keep data (default — your workspaces, ontologies, etc. are preserved)
docker compose -f docker-compose.dev.yml down

# Bring it back up exactly as you left it
docker compose -f docker-compose.dev.yml up -d
```

**Iterating on schema during P1 / P1.5:**

While the baseline migration is `Base.metadata.create_all`, additive ORM changes (new tables, indexes that don't already exist) are picked up by re-running `alembic upgrade head` against the existing DB. Column **additions** to existing tables are *not* — `create_all` only touches missing tables.

For changes that require a clean baseline (renamed columns, dropped constraints, anything that mutates an existing table), wipe the volume explicitly:

```bash
# DESTROYS dev data — opt-in only
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
cd backend && alembic upgrade head
```

Constraints (`CHECK`, `FOREIGN KEY`, `UNIQUE`), soft-delete columns (`deleted_at`, `deleted_by`), and indexes all live on the ORM model declarations and land in the baseline on a fresh DB.

**For real schema evolution (post-baseline):** add a new revision file under `backend/alembic/versions/` with explicit `op.add_column` / `op.create_index` / etc. Production data-preserving migrations are out of scope until the first real production deployment exists.

### 7. Stop and clean up

```bash
# Stop (keep data volumes)
docker compose down

# Stop and delete all data (fresh start)
docker compose down -v
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Nginx + React SPA)        :3080          │
│  ┌──────────────────────────────────────────────┐   │
│  │  /api/*    → viz-service:8000                │   │
│  │  /graph/*  → graph-service:8001              │   │
│  │  /viz-docs → viz-service:8000/docs           │   │
│  │  /graph-docs → graph-service:8001/docs       │   │
│  │  /*        → React SPA (client-side routing) │   │
│  └──────────────────────────────────────────────┘   │
└────────────────┬────────────────┬────────────────────┘
                 │                │
     ┌───────────▼──┐    ┌───────▼─────────┐
     │ Viz Service   │    │ Graph Service   │
     │ :8000         │    │ :8001           │
     │               │    │                 │
     │ Auth, CRUD,   │    │ Stateless       │
     │ Workspaces,   │    │ provider        │
     │ Ontology,     │    │ discovery &     │
     │ Graph queries │    │ connectivity    │
     └──┬─────────┬──┘    └───────┬─────────┘
        │         │               │
  ┌─────▼───┐ ┌───▼───────────────▼──┐
  │ SQLite / │ │    FalkorDB          │
  │ Postgres │ │    :6379 (Redis)     │
  │ Mgmt DB  │ │    :3000 (Browser)   │
  └──────────┘ └──────────────────────┘
```

---

## Port Reference

| Port | Service                | Protocol |
|------|------------------------|----------|
| 3000 | FalkorDB Browser UI    | HTTP     |
| 3080 | Frontend (Nginx)       | HTTP     |
| 5173 | Vite dev server (local)| HTTP     |
| 5432 | PostgreSQL (full mode) | TCP      |
| 6379 | FalkorDB (Redis)       | TCP      |
| 8000 | Viz Service API        | HTTP     |
| 8001 | Graph Service API      | HTTP     |

---

## Troubleshooting

**Port already in use**
```bash
# Find what's using a port
lsof -i :8000
```

**Frontend shows "Backend Unavailable" banner**
The viz-service hasn't finished starting yet. Wait for the healthcheck to pass (~15 seconds after container start). Check with:
```bash
curl http://localhost:8000/health
```

**FalkorDB connection refused**
```bash
# Verify FalkorDB is healthy
docker compose ps falkordb
redis-cli -h localhost -p 6379 ping
```

**Rebuild from scratch**
```bash
docker compose -f docker-compose.quickstart.yml down
docker compose -f docker-compose.quickstart.yml up --build --force-recreate
```

**View service logs**
```bash
# All services
docker compose -f docker-compose.quickstart.yml logs -f

# Single service
docker compose -f docker-compose.quickstart.yml logs -f viz-service
```

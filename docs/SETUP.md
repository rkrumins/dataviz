# Developer Setup Guide

> Step-by-step instructions for getting Synodic running locally, whether you prefer a one-command Docker setup or a hot-reload development workflow.

---

## Prerequisites

| Tool | Minimum Version | Check |
|------|----------------|-------|
| **Docker** | 24+ (with Compose V2) | `docker compose version` |
| **Node.js** | 20+ | `node --version` |
| **Python** | 3.12+ | `python3 --version` |
| **npm** | 9+ | `npm --version` |
| **Git** | 2.30+ | `git --version` |

Node and Python are only required for **Option B** (local dev). Docker-only users need just Docker.

---

## Option A — Docker Compose (Recommended for First-Time Setup)

The fastest way to get the full platform running. One command builds and starts all services.

### 1. Clone and enter the repo

```bash
git clone https://github.com/rkrumins/synodic.git
cd synodic
```

### 2. Start the platform

```bash
docker compose up --build
```

This builds and starts **5 services**:

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | http://localhost:3080 | React SPA + nginx reverse proxy |
| Visualization Service | http://localhost:8000 | Auth, workspaces, graph queries, ontology |
| Graph Service | http://localhost:8001 | Provider discovery & connectivity testing |
| FalkorDB | http://localhost:6379 | Graph database (Redis protocol) |
| FalkorDB Browser | http://localhost:3000 | Graph database UI |
| PostgreSQL | http://localhost:5432 | Management database |

### 3. What happens on first boot

1. **PostgreSQL** and **FalkorDB** start and pass health checks
2. **viz-service** starts and runs `init_db()` — creates all management tables in PostgreSQL
3. Seeds context model templates, feature registry, and system default ontology
4. Creates an admin user (see credentials below)
5. Bootstraps a default FalkorDB provider, workspace, and data source from environment variables
6. **Frontend** becomes available once all backend services are healthy

### 4. Log in

Open http://localhost:3080 and sign in with the default admin account:

| Field | Value |
|-------|-------|
| Email | `admin@synodic.local` |
| Password | `admin123` |

> Change these credentials after first login. They can be customised via `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `docker-compose.yml`.

### 5. Next Steps After Login

You're logged in. Here's what to do next:

1. **If this is a fresh platform** (no providers registered): the **FirstRunHero** onboarding screen will guide you through initial setup automatically — register a provider, discover schemas, catalog assets, and create your first workspace.

2. **To set up manually**: Navigate to **Admin → Unified Registry**:
   - **Connections tab** — register a graph database provider (FalkorDB, Neo4j, or DataHub)
   - **Assets tab** — discover and register catalog items from your provider
   - **Workspaces tab** — create workspaces and bind catalog items with ontologies

3. **To explore with demo data**: seed the graph database first (see next section), then open the **Explorer** to trace lineage.

> For a full walkthrough of the admin setup journey, see [OVERVIEW.md — For Platform Admins](OVERVIEW.md).

### 6. Seed demo graph data (optional)

By default the graph database starts empty. To populate it with realistic enterprise data:

```bash
docker compose --profile seed up --build
```

This starts all services **plus** a one-shot `seed` container that:

1. Waits for FalkorDB to become healthy (up to 90 seconds)
2. Checks if graph data already exists — skips if so (use `SEED_FORCE=true` to re-seed)
3. Generates enterprise demo scenarios (finance + ecommerce by default)
4. Creates a containment hierarchy: **Domain > Platform > Container > Dataset > SchemaField**
5. Adds **TRANSFORMS** lineage edges and a consumption layer (Dashboards, Charts)
6. Batch-pushes all nodes and edges to FalkorDB
7. Exits with code 0 on success

The seed container appears in logs as `seed-1`. After completion, verify data in the FalkorDB Browser at http://localhost:3000.

#### Seed configuration

Customise seeding via environment variables in `docker-compose.yml` under the `seed` service:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEED_SCENARIOS` | `finance,ecommerce` | Comma-separated list: `finance`, `hr`, `marketing`, `ecommerce`, or `all` |
| `SEED_SCALE` | `1` | Scale multiplier (1 = ~1k nodes per scenario) |
| `SEED_BREADTH` | `1` | Parallel system chain multiplier |
| `SEED_DEPTH` | `2` | Transformation layer depth (higher = richer lineage) |
| `SEED_FORCE` | *(unset)* | Set to `true` to re-seed even if data exists |

### 7. Common Docker commands

```bash
# Start in background (detached)
docker compose up --build -d

# View logs for a specific service
docker compose logs -f viz-service

# View logs for the seed container
docker compose logs -f seed

# Restart a single service
docker compose restart viz-service

# Stop all services (preserves data volumes)
docker compose down

# Stop and delete all data (PostgreSQL + FalkorDB volumes)
docker compose down -v

# Rebuild without Docker cache (use after Dockerfile changes)
docker compose build --no-cache
docker compose up
```

---

## Option B — Local Development (Hot-Reload)

For active development with hot-reload on both frontend and backend.

### 1. Start infrastructure

Synodic requires two databases running locally: **FalkorDB** (graph data) and **PostgreSQL** (management data — users, workspaces, providers, ontology configs).

#### Using Docker Compose (recommended)

The simplest approach — starts both databases with health checks and persistent volumes:

```bash
docker compose up -d falkordb postgres
```

Wait for both to become healthy:

```bash
docker compose ps
```

Expected output:

```
NAME         IMAGE                      STATUS                  PORTS
falkordb     falkordb/falkordb:latest    Up (healthy)            0.0.0.0:6379->6379/tcp, 0.0.0.0:3000->3000/tcp
postgres     postgres:16-alpine         Up (healthy)            0.0.0.0:5432->5432/tcp
```

To stop infrastructure without losing data:

```bash
docker compose stop falkordb postgres
```

To start it again later:

```bash
docker compose start falkordb postgres
```

#### Without Docker Compose (manual setup)

If you prefer to run the databases natively or already have instances running:

**FalkorDB:**

```bash
# Via Docker (standalone)
docker run -d --name falkordb \
  -p 6379:6379 \
  -p 3000:3000 \
  -v falkordb_data:/data \
  falkordb/falkordb:latest

# Verify
redis-cli -p 6379 PING   # Should return PONG
```

Or install natively — see [FalkorDB docs](https://docs.falkordb.com).

**PostgreSQL:**

```bash
# Via Docker (standalone)
docker run -d --name postgres \
  -e POSTGRES_USER=synodic \
  -e POSTGRES_PASSWORD=synodic \
  -e POSTGRES_DB=synodic \
  -p 5432:5432 \
  -v postgres_data:/var/lib/postgresql/data \
  postgres:16-alpine

# Verify
psql -h localhost -U synodic -d synodic -c "SELECT 1;"
```

Or use a local PostgreSQL installation. Create a database and user:

```sql
CREATE USER synodic WITH PASSWORD 'synodic';
CREATE DATABASE synodic OWNER synodic;
```

> **Note:** PostgreSQL is optional for local dev. Without `MANAGEMENT_DB_URL` set, the viz-service falls back to **SQLite** (`nexus_core.db` in the project root). SQLite is fine for single-developer use but does not match the Docker/production setup.

**Using an existing FalkorDB or PostgreSQL instance:**

If you already have these services running on non-default ports or remote hosts, set the connection details via environment variables (see step 3 below).

### 2. Set up the backend

```bash
# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r backend/requirements.txt
```

### 3. Configure environment (optional)

Copy the example env file and adjust as needed:

```bash
cp .env.example .env
```

Key variables for local development:

```bash
GRAPH_PROVIDER=falkordb           # Default graph provider
FALKORDB_HOST=localhost           # Docker-exposed FalkorDB
FALKORDB_PORT=6379
FALKORDB_GRAPH_NAME=nexus_lineage

# Uncomment to use PostgreSQL instead of SQLite for the management DB:
# MANAGEMENT_DB_URL=postgresql+asyncpg://synodic:synodic@localhost:5432/synodic

# Auth — auto-generated in dev if omitted
# JWT_SECRET_KEY=dev-secret-key
```

Without a `.env` file, the backend uses sensible defaults: SQLite (`nexus_core.db`), auto-generated JWT key, and `admin@nexuslineage.local` / `changeme` as the admin account.

### 4. Start the Visualization Service (port 8000)

```bash
GRAPH_PROVIDER=falkordb uvicorn backend.app.main:app --port 8000 --reload
```

On first start, this creates the management database, seeds defaults, and bootstraps the admin user. You should see log lines confirming each step.

### 5. Start the Graph Service (port 8001)

In a separate terminal:

```bash
source .venv/bin/activate
uvicorn backend.graph.main:app --port 8001 --reload
```

### 6. Seed graph data (optional)

To populate FalkorDB with demo data locally:

```bash
source .venv/bin/activate
python backend/scripts/seed_falkordb.py --scenarios finance,ecommerce --scale 1 --depth 2
```

Or use the Docker-aware seeder (same script the Docker seed container runs):

```bash
python backend/scripts/docker_seed.py --scenarios all --scale 1
```

### 7. Start the frontend

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server starts at http://localhost:5173 with HMR. It proxies API requests to the backend services automatically (configured in `vite.config.ts`).

### 8. Verify everything is running

| Service | URL | Expected |
|---------|-----|----------|
| Frontend | http://localhost:5173 | Login page |
| Viz Service | http://localhost:8000/health | `{"status": "ok"}` |
| Graph Service | http://localhost:8001/health | `{"status": "ok"}` |
| FalkorDB Browser | http://localhost:3000 | FalkorDB UI |

---

## Environment Variables Reference

All environment variables with their defaults. Set these in `.env`, `docker-compose.yml`, or your shell.

### Graph Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `GRAPH_PROVIDER` | `falkordb` | Default provider type (`falkordb`, `neo4j`, `mock`) |
| `FALKORDB_HOST` | `localhost` | FalkorDB host |
| `FALKORDB_PORT` | `6379` | FalkorDB port |
| `FALKORDB_GRAPH_NAME` | `nexus_lineage` | Default graph name |

### Management Database

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGEMENT_DB_URL` | `sqlite+aiosqlite:///nexus_core.db` | SQLAlchemy async connection string |
| `DB_ECHO` | `false` | Log all SQL statements |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET_KEY` | *(auto-generated)* | HMAC signing key for JWTs |
| `JWT_ALGORITHM` | `HS256` | JWT signing algorithm |
| `JWT_EXPIRY_MINUTES` | `60` | Token lifetime |
| `ADMIN_EMAIL` | `admin@nexuslineage.local` | Bootstrap admin email |
| `ADMIN_PASSWORD` | `changeme` | Bootstrap admin password |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `CREDENTIAL_ENCRYPTION_KEY` | *(none)* | Fernet key for encrypting provider credentials at rest. **Required in production.** |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated allowed CORS origins |

---

## Production Environment Checklist

Before deploying to production, ensure these **mandatory** settings are configured:

| Requirement | Why | How |
|-------------|-----|-----|
| **PostgreSQL database** | SQLite cannot handle concurrent writes or multi-worker deployments | Set `MANAGEMENT_DB_URL=postgresql+asyncpg://user:pass@host:5432/synodic` |
| **Credential encryption key** | Without it, provider credentials (passwords, API tokens) are stored in **plaintext** | Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` → set as `CREDENTIAL_ENCRYPTION_KEY` |
| **Change admin password** | Default bootstrap password is `changeme` / `admin123` | Set `ADMIN_PASSWORD` env var to a strong password, or change via the admin UI after first login |
| **Specific CORS origins** | Default includes `*` on Graph Service, allowing any origin | Set `CORS_ALLOWED_ORIGINS` to your actual frontend domain(s) |
| **JWT secret key** | Auto-generated key changes on restart, invalidating all tokens | Set a stable `JWT_SECRET_KEY` value |

> See [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) for a full security risk assessment.

---

## Troubleshooting

### `docker compose up` fails with port conflicts

Another process is using port 6379, 5432, 8000, 8001, or 3080. Either stop the conflicting process or change the port mapping in `docker-compose.yml` (e.g., `"6380:6379"`).

### Viz-service exits or restarts repeatedly

Check logs with `docker compose logs viz-service`. Common causes:
- **PostgreSQL not ready yet** — the health check dependency should handle this, but on slow machines increase the health check retries in `docker-compose.yml`
- **Migration error** — if you see "current transaction is aborted", run `docker compose down -v` to wipe stale data and start fresh

### Seed container shows "already has N nodes — skipping"

The graph already contains data from a previous run. Either:
- Accept the existing data (no action needed)
- Force re-seed: set `SEED_FORCE: "true"` under the `seed` service in `docker-compose.yml`

### Frontend shows a blank page or API errors

- Ensure both backend services are running and healthy
- In Docker mode, check that `frontend/nginx.conf` proxy targets match the service names (`viz-service`, `graph-service`)
- In local dev, check that `vite.config.ts` proxy targets point to `localhost:8000` and `localhost:8001`

### "No data source for workspace" error

This means the workspace was created without a data source binding. Run `docker compose down -v` to clear stale PostgreSQL data, then `docker compose up --build` for a clean bootstrap.

### Python import errors when running seed scripts locally

Make sure you run from the **project root** directory (not `backend/` or `backend/scripts/`):

```bash
# Correct — run from project root
python backend/scripts/seed_falkordb.py

# Wrong — will fail with import errors
cd backend/scripts && python seed_falkordb.py
```

---

## Project Structure (Key Files)

```
synodic/
├── docker-compose.yml              # Full-stack orchestration
├── .dockerignore                   # Docker build exclusions
├── .env.example                    # Environment variable reference
├── backend/
│   ├── Dockerfile.viz              # Visualization Service image
│   ├── Dockerfile.graph            # Graph Service image
│   ├── Dockerfile.seed             # Demo data seeder image
│   ├── requirements.txt            # Python dependencies
│   ├── app/                        # Visualization Service (port 8000)
│   │   └── main.py                 # FastAPI app + lifespan bootstrap
│   ├── graph/                      # Graph Service (port 8001)
│   │   └── main.py                 # Stateless FastAPI app
│   ├── common/                     # Shared models & interfaces
│   └── scripts/
│       ├── seed_falkordb.py        # Enterprise data generator
│       └── docker_seed.py          # Docker-aware seed entrypoint
├── frontend/
│   ├── Dockerfile                  # Multi-stage Node build + Nginx
│   ├── nginx.conf                  # Reverse proxy + SPA routing
│   └── src/                        # React 19 + TypeScript source
└── docs/                           # Documentation
```

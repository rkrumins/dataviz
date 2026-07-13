# Developer Setup Guide

> Step-by-step instructions for getting {brand} running locally, whether
> you're actively iterating on source code or just want the platform up.

For self-hosting on a VM, see [DEPLOYMENT.md](DEPLOYMENT.md) instead.

> **Working on the auth / SSO surface?** Read
> [`SSO_INTEGRATION.md`](SSO_INTEGRATION.md) for the developer
> Day-1 walkthrough, architecture + sequence diagrams, backend and
> frontend cookbooks, runbooks, and reference tables. The operator
> view is in [`SSO.md`](SSO.md).

---

## Mental model — two workflows, never both

```
┌───────────────────────────┬────────────────────────────┐
│ dev.sh     (source iter)  │ deploy.sh  (VM self-host)  │
├───────────────────────────┼────────────────────────────┤
│ docker-compose.dev.yml    │ docker-compose.yml         │
│ compose project: synodic-dev   compose project: synodic│
│ infra only in Docker      │ everything in Docker       │
│ apps run from .venv + npm │ apps built as images       │
│ volumes: synodic-*-dev-data    volumes: synodic_*_data │
│ env file: .env.dev        │ env file: .env             │
└───────────────────────────┴────────────────────────────┘
```

The two stacks use **different compose project names** and **different volume names**, so they can coexist without data collisions. Mixing them (running `deploy.sh` while `dev.sh infra` is up, or vice versa) causes port conflicts — pick one.

### Three capabilities you care about

| Capability | Dev workflow (`dev.sh`) | Self-host workflow (`deploy.sh`) |
|---|---|---|
| **Rebuild images** | Only `falkordb` has a build context; `./dev.sh infra` rebuilds it when source under `data/quickstart/` changes. Apps run from source — no image build needed. | `./deploy.sh up --build` (rebuild + start) or `./deploy.sh update` (git pull + rebuild + start) |
| **Start stopped containers** | `./dev.sh infra` — `docker compose up -d` resumes existing containers without recreating them | `./deploy.sh up` — same semantics |
| **Persistent data** | Named volumes `synodic-postgres-dev-data`, `synodic-falkordb-dev-data`, `synodic-redis-dev-data` survive `stop` / `restart` / host reboot. Only wiped by `./dev.sh reset`. | Named volumes `synodic_postgres_data`, `synodic_falkordb_data`, `synodic_redis_data`. Backed up via `./deploy.sh backup`, wiped by `./deploy.sh restore` or `docker compose down -v`. |

## Prerequisites

| Tool | Minimum Version |
|------|----------------|
| **Docker** | 20+ (with Compose V2) |
| **Python** | 3.13+ |
| **Node.js** | 18+ |
| **Git** | 2.30+ |

On macOS:

```bash
brew install docker docker-compose python@3.13 node
```

## First-time setup

```bash
git clone <repo-url> && cd synodic
cp .env.example .env.dev
./dev.sh               # starts infra, prints next steps
```

`./dev.sh` (with no arguments) brings up PostgreSQL + FalkorDB + Redis, verifies the role/db, prints a credentials banner, and tells you how to launch the service processes in separate terminals.

## Daily workflow

Three terminals:

```bash
# Terminal 1: infrastructure (persistent)
./dev.sh infra

# Terminal 2: backend (hot-reload)
./dev.sh viz

# Terminal 3: frontend (hot-reload)
./dev.sh frontend
```

Access:

| | URL |
|---|---|
| Frontend (Vite dev server) | http://localhost:5173 |
| Backend API docs | http://localhost:8000/docs |
| FalkorDB browser UI | http://localhost:3000 |

Default admin: `admin@nexuslineage.local` / `admin123` (change after first login).

### Seed demo graph data (optional)

By default the graph database starts empty. To populate it with realistic enterprise demo data:

```bash
source .venv/bin/activate
python backend/scripts/seed_falkordb.py --scenarios finance,ecommerce --scale 1 --depth 2
```

| Flag | Default | Description |
|------|---------|-------------|
| `--scenarios` | `finance,ecommerce` | Comma-separated: `finance`, `hr`, `marketing`, `ecommerce`, or `all` |
| `--scale` | `1` | Scale multiplier (1 = ~1k nodes per scenario) |
| `--depth` | `2` | Transformation layer depth (higher = richer lineage) |

### Next steps after login

1. **If this is a fresh platform** (no providers registered): the onboarding flow guides you through registering a provider, discovering schemas, cataloging assets, and creating your first workspace.
2. **To set up manually**: navigate to **Admin → Unified Registry** — the **Connections** tab registers a graph database provider (FalkorDB, Neo4j, or DataHub), **Assets** discovers and registers catalog items, **Workspaces** creates workspaces and binds catalog items with ontologies.
3. **To explore with demo data**: seed the graph database first (above), then open the **Explorer** to trace lineage.

> For a full walkthrough of the admin setup journey, see [OVERVIEW.md — For Platform Admins](OVERVIEW.md).

## Subcommand reference

### Infrastructure

| Command | What it does |
|---|---|
| `./dev.sh infra` | Start PostgreSQL + FalkorDB + Redis |
| `./dev.sh stop` | Stop infra, preserve data |
| `./dev.sh restart` | Stop + start |
| `./dev.sh reset` | **Wipe all data** (interactive confirm) |
| `./dev.sh repair` | Self-heal stale volumes / orphans |
| `./dev.sh backup [name]` | Tar volumes to `./backups/<ts>-<name>/` |
| `./dev.sh restore <dir>` | Restore volumes from a backup directory |

### Diagnostics

| Command | What it does |
|---|---|
| `./dev.sh doctor` | Run all preflight checks, no side effects |
| `./dev.sh status` | Containers + ports + backend health |
| `./dev.sh logs [svc]` | Tail container logs |
| `./dev.sh clean-orphans` | Remove orphan containers from the prod compose |

### Services (pick one mode)

**Single-process dev mode (simplest):**

```bash
./dev.sh viz        # backend on :8000, aggregation runs in-process
./dev.sh frontend   # frontend on :5173
```

**Three-process production-like mode:**

```bash
./dev.sh controlplane   # aggregation API on :8091
./dev.sh worker         # aggregation worker (headless)
./dev.sh viz-proxy      # viz on :8000, proxies aggregation to CP
./dev.sh frontend       # frontend on :5173
```

## Fresh start vs repair

- **`./dev.sh repair`** — fixes a broken environment (stale role, orphan containers) by wiping *only* what's broken. Prompts before destructive action. Use this when things were working before.
- **`./dev.sh reset`** — wipes all volumes (PostgreSQL + FalkorDB + Redis). Use when you want a clean slate.

## How persistence works

Named Docker volumes live under `/var/lib/docker/volumes/` on the host. They survive:

- `./dev.sh stop`
- `./dev.sh restart`
- `docker compose down` (without `-v`)
- Host reboot (Docker daemon starts them back up because of `restart: unless-stopped`)

They do **not** survive:

- `./dev.sh reset` / `./dev.sh restore` / explicit `docker compose down -v`
- `docker volume rm <name>`

Back up before any potentially destructive operation: `./dev.sh backup pre-change`.

---

## Environment Variables Reference

All environment variables with their defaults. Set these in `.env.dev` (dev workflow), `.env` (self-host workflow), or your shell.

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
| `MANAGEMENT_DB_URL` | `sqlite+aiosqlite:///nexus_core.db` | SQLAlchemy async connection string. `dev.sh` provisions a dockerized PostgreSQL and sets this for you; SQLite is only a fallback for ad hoc manual runs. |
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
| **Specific CORS origins** | The dev default only allows `http://localhost:5173`; a production deployment must allow-list its real frontend domain(s), not `*` | Set `CORS_ALLOWED_ORIGINS` to your actual frontend domain(s) |
| **JWT secret key** | Auto-generated key changes on restart, invalidating all tokens | Set a stable `JWT_SECRET_KEY` value |

> See [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) for a full security risk assessment.

---

## Troubleshooting

| Error you see | What it means | Fix |
|---|---|---|
| `WARN Found orphan containers` | Prev `docker compose up` left containers behind | `./dev.sh clean-orphans` |
| `FATAL: role "synodic" does not exist` | Postgres volume is stale (init ran with different creds) | `./dev.sh repair` |
| `Port 8000 already in use by PID X` | Previous uvicorn didn't shut down | `kill -9 X` (preflight prints the command) |
| `Postgres.app running on port 5432` | Local Postgres intercepts Docker | Stop Postgres.app via menubar / `brew services stop postgresql` |
| `password authentication failed` | `.env.dev` password doesn't match volume | `./dev.sh reset` (wipes data) or edit `.env.dev` to match |
| Backend starts in degraded mode | DB unreachable at lifespan start — app stays up but DB endpoints 503 | `./dev.sh doctor` → follow hints; `/api/v1/health` reports `"status": "degraded"` |
| Alembic "Can't locate revision" | Old migration chain | Handled automatically by `_reset_stale_alembic_version` |
| Frontend shows a blank page or API errors | Backend isn't running/healthy, or a proxy target is misconfigured | Ensure `viz-service` is running and healthy. In Docker mode, check that `frontend/nginx.conf` proxies to `viz-service`. In local dev, check that `vite.config.ts` proxies to `localhost:8000`. |
| Docker Compose fails with port conflicts | Another process is using one of the required ports (6379, 5432, 8000, 3080) | Stop the conflicting process or change the port mapping in `docker-compose.yml` |
| "No data source for workspace" error | The workspace was created without a data source binding | `docker compose down -v` to clear stale data, then rebuild for a clean bootstrap |

If `./dev.sh doctor` doesn't explain your problem, run `./dev.sh logs postgres` (or the relevant service) for raw output.

---

## Project Structure (Key Files)

```
synodic/
├── docker-compose.yml              # Self-host orchestration (deploy.sh)
├── docker-compose.dev.yml          # Dev infra orchestration (dev.sh)
├── .dockerignore                   # Docker build exclusions
├── .env.example                    # Environment variable reference
├── backend/
│   ├── Dockerfile.viz              # Visualization Service image
│   ├── Dockerfile.seed             # Demo data seeder image
│   ├── requirements.txt            # Python dependencies
│   ├── alembic/                    # Schema migrations (source of truth for the DB schema)
│   ├── app/                        # Visualization Service (port 8000) — auth, workspaces,
│   │   │                           # graph queries, ontology, provider connectivity
│   │   └── main.py                 # FastAPI app + lifespan bootstrap
│   ├── graph/adapters/              # Provider adapters (Neo4j/DataHub/Spanner), imported
│   │                                # in-process by the Visualization Service
│   ├── app/services/aggregation/    # Control-plane + worker for lineage rollup/materialization
│   ├── app/services/versioning/     # Draft branches, review/merge, revert/rollback
│   ├── insights_service/            # Cached stats & top-level materialization
│   ├── common/                     # Shared models & interfaces
│   └── scripts/
│       └── seed_falkordb.py        # Enterprise data generator
├── frontend/
│   ├── Dockerfile                  # Multi-stage Node build + Nginx
│   ├── nginx.conf                  # Reverse proxy + SPA routing
│   └── src/                        # React 19 + TypeScript source
└── docs/                           # Documentation
```

## Further reading

- [DEPLOYMENT.md](DEPLOYMENT.md) — VM / self-host guide
- [ARCHITECTURE.md](ARCHITECTURE.md) — system overview
- [superpowers/specs/2026-04-18-resilient-dev-environments-design.md](superpowers/specs/2026-04-18-resilient-dev-environments-design.md) — design rationale for the current dev-env resilience model

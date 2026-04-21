# Development Guide

Local-dev reference for contributors iterating on Synodic source code.

For self-hosting on a VM, see [DEPLOYMENT.md](DEPLOYMENT.md) instead.

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

- Docker Engine 20+ / Docker Desktop (for the infrastructure containers)
- Python 3.13+ (for the backend services)
- Node 18+ (for the frontend dev server)

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

`./dev.sh` (with no arguments) brings up Postgres + FalkorDB + Redis, verifies the role/db, prints a credentials banner, and tells you how to launch the service processes in separate terminals.

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

## Subcommand reference

### Infrastructure

| Command | What it does |
|---|---|
| `./dev.sh infra` | Start Postgres + FalkorDB + Redis |
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

If `./dev.sh doctor` doesn't explain your problem, run `./dev.sh logs postgres` (or the relevant service) for raw output.

## Fresh start vs repair

- **`./dev.sh repair`** — fixes a broken environment (stale role, orphan containers) by wiping *only* what's broken. Prompts before destructive action. Use this when things were working before.
- **`./dev.sh reset`** — wipes all volumes (Postgres + FalkorDB + Redis). Use when you want a clean slate.

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

## Further reading

- [DEPLOYMENT.md](DEPLOYMENT.md) — VM / self-host guide
- [ARCHITECTURE.md](ARCHITECTURE.md) — system overview
- [superpowers/specs/2026-04-18-resilient-dev-environments-design.md](superpowers/specs/2026-04-18-resilient-dev-environments-design.md) — design rationale for the current dev-env resilience model

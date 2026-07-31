# Data Lineage & Context Platform

> A graph metadata and lineage platform: connect a graph database, model data lineage with ontologies, and explore how data flows through your systems on an interactive canvas — at any scale.

**What this is:** the platform's monorepo — a Python (FastAPI) backend, a React frontend, and a FalkorDB graph store, plus the aggregation and versioning services that make million-node graphs navigable. **Who it's for:** contributors editing the source, operators self-hosting it, and anyone who wants a zero-config demo.

Pick the path that matches what you're doing:

| I want to… | Path | Command |
|------------|------|---------|
| Edit source with hot-reload | [Contributor](#1-contributor--edit-source-locally) | `./dev.sh` |
| Run it on a VM | [Self-host](#2-self-host--run-on-a-vm) | `./deploy.sh up` |
| Take a quick look | [Quickstart](#3-quickstart--zero-config-demo) | `docker compose -f docker-compose.quickstart.yml up` |

## Three paths to get running

### 1. Contributor — edit source locally

Backend/frontend from source with hot-reload; infra in Docker.

```bash
cp .env.example .env.dev
./dev.sh              # generates a signing key, starts infra, prints next steps
```

Full guide: [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).

### 2. Self-host — run on a VM

Everything in containers; persistent volumes; auto-restart on VM reboot.

```bash
cp .env.prod.example .env
$EDITOR .env          # replace REPLACE_ME values
./deploy.sh up
```

Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### 3. Quickstart — zero-config demo

Pre-seeded SQLite + FalkorDB for a quick look:

```bash
docker compose -f docker-compose.quickstart.yml up --build
```

Access:
- Frontend: http://localhost:3080
- API docs: http://localhost:8000/docs
- Login: `admin@nexuslineage.local` / `admin123`

> [!NOTE]
> The quickstart ships pre-seeded SQLite and FalkorDB baked into the images — no `.env`, no seeding. It is for evaluation only; the Contributor and Self-host paths use PostgreSQL.

## Diagnostics

Both runners ship with `doctor`, `status`, and `repair` subcommands — they check environment, ports, role/db state, and orphan containers. If something feels off:

```bash
./dev.sh doctor       # local dev
./deploy.sh doctor    # self-host
```

## Documentation map

Start here, then follow the trail for whatever you're doing.

| Document | What it covers |
|----------|----------------|
| [QUICKSTART.md](QUICKSTART.md) | Get running locally with sample data |
| [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) | Contributor guide — architecture, roles, aggregation internals |
| [SPEC.md](SPEC.md) | Technical specification — data models, rule engine, API contract |
| [PLAN.md](PLAN.md) | What's built today and what's next |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [docs/SETUP.md](docs/SETUP.md) | Environment setup reference |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Self-host operator guide |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview |
| [docs/BACKEND.md](docs/BACKEND.md) | Backend internals |
| [docs/FRONTEND.md](docs/FRONTEND.md) | Frontend internals |

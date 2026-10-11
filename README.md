# Data Lineage & Context Platform

> A graph metadata and lineage platform: connect a graph database, model data lineage with ontologies, and explore how data flows through your systems on an interactive canvas — at any scale.

**What this is:** the platform's monorepo — a Python (FastAPI) backend, a React frontend, and a FalkorDB graph store, plus the aggregation and versioning services that make million-node graphs navigable. **Who it's for:** contributors editing the source, operators self-hosting it, and anyone who wants a zero-config demo.

Pick the path that matches what you're doing:

| I want to… | Path | Command |
|------------|------|---------|
| Edit source with hot-reload | [Contributor](#1-contributor--edit-source-locally) | `./dev.sh` |
| Run it on a VM | [Self-host](#2-self-host--run-on-a-vm) | `./deploy.sh up` |
| Take a quick look | [Quickstart](#3-quickstart--zero-config-demo) (does not boot today) | `docker compose -f docker-compose.quickstart.yml up` |

## Three paths to get running

### 1. Contributor — edit source locally

Everything in containers, with the backend and frontend source bind-mounted for hot-reload. `./dev.sh infra` starts only Postgres, Redis and FalkorDB, for running the apps on the host.

```bash
cp .env.example .env.dev
./dev.sh              # generates a signing key, starts the stack, prints the URLs
```

Full guide: [docs/SETUP.md](docs/SETUP.md). Before your first pull request, read [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): where things live, the conventions, and what CI checks.

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

> [!WARNING]
> **The quickstart does not boot today.** It points the API at a baked-in SQLite database, and the backend has accepted only PostgreSQL for some time; its published signing key is also refused at startup. Use the Contributor or Self-host path until it is fixed — see [docs/TECHNICAL_DEBT.md](docs/TECHNICAL_DEBT.md) §2.1.

## Diagnostics

Both runners ship with a `doctor` subcommand that checks environment, ports, role/db state, and orphan containers; `./deploy.sh status` and `./dev.sh ps` show what is running. If something feels off:

```bash
./dev.sh doctor       # local dev
./deploy.sh doctor    # self-host
```

## Documentation map

Start here, then follow the trail for whatever you're doing.

| Document | What it covers |
|----------|----------------|
| [QUICKSTART.md](QUICKSTART.md) | Get running locally with sample data |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Contributor guide — where things live, the change workflow, conventions, common tasks |
| [SPEC.md](SPEC.md) | The original design specification — historical; much of it was never built as written |
| [PLAN.md](PLAN.md) | What's built today and what's next |
| [docs/TECHNICAL_DEBT.md](docs/TECHNICAL_DEBT.md) | Known risks, with evidence, and the order to fix them |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [docs/SETUP.md](docs/SETUP.md) | Environment setup reference |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Self-host operator guide |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview |
| [docs/MIGRATIONS.md](docs/MIGRATIONS.md) | How the schema is built, and the rules for a new migration |
| [docs/BACKEND.md](docs/BACKEND.md) | Backend internals |
| [docs/FRONTEND.md](docs/FRONTEND.md) | Frontend internals |

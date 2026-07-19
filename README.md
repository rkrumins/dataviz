# Context Visualization Platform

Context Visualization Platform (CVP) — a graph metadata + lineage platform. Backend in Python (FastAPI), frontend in React, graph store in FalkorDB.

## Three paths to get running

### 1. Contributor — edit source locally

Backend/frontend from source with hot-reload; infra in Docker.

```bash
cp .env.example .env.dev
./dev.sh              # starts infra + prints next steps
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

## Diagnostics

Both runners ship with `doctor`, `status`, and `repair` subcommands — they check environment, ports, role/db state, and orphan containers. If something feels off:

```bash
./dev.sh doctor       # local dev
./deploy.sh doctor    # self-host
```

## Documentation

- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — contributor guide
- [docs/SETUP.md](docs/SETUP.md) — environment setup reference
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — self-host operator guide
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system overview
- [docs/BACKEND.md](docs/BACKEND.md) — backend internals
- [docs/FRONTEND.md](docs/FRONTEND.md) — frontend internals

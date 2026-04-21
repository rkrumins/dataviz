# Self-Host Deployment Guide

Deploy Synodic on a VM or bare-metal server using Docker Compose. Everything runs in containers — no local Python/Node needed.

For local development (editing source code), see [DEVELOPMENT.md](DEVELOPMENT.md).

## Prerequisites

- Docker Engine 20+ and Docker Compose v2
- 2 GB RAM minimum (4 GB recommended)
- 10 GB disk for images + data (grows with your graph data)
- Outbound network access (to pull images; first run only)

Tested on Ubuntu 22.04, Debian 12, macOS with Docker Desktop.

## One-command install

```bash
git clone <repo-url> && cd synodic
cp .env.prod.example .env
$EDITOR .env                     # replace all REPLACE_ME values
./deploy.sh up
```

`./deploy.sh up` runs preflight (refuses to start if any `REPLACE_ME` value remains), then `docker compose up -d`. First run builds images (~3 min) and initializes volumes.

**Secrets you must set in `.env`:**

- `POSTGRES_PASSWORD` — Postgres password. Any strong string.
- `JWT_SECRET_KEY` — generate with `openssl rand -hex 48`.
- `ADMIN_PASSWORD` — initial admin login. Change in the UI after first login.

Optional:

- `CREDENTIAL_ENCRYPTION_KEY` — encrypts stored provider credentials. Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Leave blank for plaintext (not recommended).

## Accessing

| | URL |
|---|---|
| Frontend | http://`<vm-ip>`:3080 |
| Backend API docs | http://`<vm-ip>`:8000/docs |
| FalkorDB browser | http://`<vm-ip>`:3000 |

Login with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.

For public-facing deployments, put a reverse proxy (Caddy, Nginx, Traefik) with TLS termination in front and firewall the direct ports. See the hardening section below.

## Subcommand reference

| Command | What it does |
|---|---|
| `./deploy.sh up` | Start all services (preflight + `docker compose up -d`) |
| `./deploy.sh up --build` | Rebuild images first (after code change) |
| `./deploy.sh down` | Stop all services, preserve data |
| `./deploy.sh restart` | `docker compose restart` (picks up env changes on next `up`) |
| `./deploy.sh status` | Container status + live health probes |
| `./deploy.sh logs [svc]` | Tail logs (default: all services, last 100 lines) |
| `./deploy.sh doctor` | Preflight checks only, no side effects |
| `./deploy.sh update` | `git pull` + rebuild + `up -d` |
| `./deploy.sh backup [name]` | Tar named volumes to `./backups/<ts>-<name>/` |
| `./deploy.sh restore <dir>` | Restore volumes from a backup directory (stops services) |

## VM reboot behavior

Every service is configured with `restart: unless-stopped`. When the VM reboots:

1. Docker daemon starts automatically (on Ubuntu/Debian, it's enabled by default; if not: `sudo systemctl enable --now docker`).
2. Docker daemon starts all containers with `restart: unless-stopped`.
3. Services come up in dependency order (controlled by `depends_on: condition: service_healthy` in `docker-compose.yml`).
4. Data survives because named Docker volumes live in `/var/lib/docker/volumes/`.

**No manual intervention needed after a reboot.** `./deploy.sh status` confirms all services are up.

## Backup & restore

### Backup

```bash
./deploy.sh backup pre-upgrade
# → backups/20260421-120000-pre-upgrade/
#     synodic_postgres_data.tgz
#     synodic_falkordb_data.tgz
#     synodic_redis_data.tgz
```

Back up before: upgrading, running migrations, changing `.env`, or any destructive operation.

**Off-site storage** — copy the backup directory off the VM:

```bash
rsync -av backups/20260421-120000-pre-upgrade/ user@backup-host:/backups/synodic/
# or upload to S3 / B2 / etc.
```

A cron job is a good idea for production:

```
# /etc/cron.d/synodic-backup
0 3 * * * cd /opt/synodic && ./deploy.sh backup nightly >> /var/log/synodic-backup.log 2>&1
```

### Restore

```bash
./deploy.sh restore backups/20260421-120000-pre-upgrade/
# Prompts for 'yes' before wiping + restoring. Stops services, wipes
# volumes, extracts tarballs, restarts.
```

## Upgrading

```bash
./deploy.sh backup pre-upgrade     # always back up first
./deploy.sh update                 # git pull + rebuild + up -d
./deploy.sh status                 # verify health
```

If the upgrade includes schema changes, Alembic migrations run automatically on viz-service start. If they fail (e.g., database was manually modified), the service enters degraded mode and `./deploy.sh status` shows `{"status": "degraded", "reason": ...}`.

## Resetting all data

```bash
./deploy.sh down
docker compose -f docker-compose.yml down -v   # explicit: wipes volumes
```

Then `./deploy.sh up` rebuilds from an empty state.

## Hardening for public-facing VMs

Beyond the defaults, for a production deployment:

1. **TLS termination** — put Caddy/Nginx/Traefik in front. Synodic binds to 0.0.0.0 — close it off via a firewall except for the reverse proxy.
2. **Firewall** — only expose the frontend port (3080) externally; keep Postgres (5432), FalkorDB (6379), Redis (6380) bound to localhost or the Docker network only. Edit `docker-compose.yml` to change `"5432:5432"` → `"127.0.0.1:5432:5432"` etc.
3. **Strong secrets** — `JWT_SECRET_KEY` should be at least 256 bits. `openssl rand -hex 48` is good.
4. **CREDENTIAL_ENCRYPTION_KEY** — don't skip in production. Provider credentials are stored in the management DB and protected by this Fernet key.
5. **CORS** — set `CORS_ALLOWED_ORIGINS` to only your actual domain(s), not `localhost`.
6. **Rotate the admin password** immediately after first login.
7. **Disable FalkorDB browser UI in production** — it's authentication-free. Remove the port mapping `"3000:3000"` from `docker-compose.yml` for public deployments.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `POSTGRES_PASSWORD must be set in .env` | `.env` missing or `REPLACE_ME` not set | Edit `.env`, rerun `./deploy.sh up` |
| `FATAL: role "synodic" does not exist` | Data volume was initialized with different creds | Either match the old password in `.env`, or `docker compose down -v` to reset (destroys data) |
| viz-service unhealthy | DB migrations failed | `./deploy.sh logs viz-service` → likely an Alembic issue |
| Containers restart in a loop | Misconfigured env | `./deploy.sh logs <service>` and `./deploy.sh doctor` |
| High Postgres memory | Default `shared_buffers` not tuned | Edit `docker-compose.yml` postgres `command:` section |

If stuck, the logs almost always have the answer: `./deploy.sh logs <service-name>`.

## Uninstall

```bash
./deploy.sh down
docker compose -f docker-compose.yml down -v --rmi all
# Optional: remove the checkout
cd .. && rm -rf synodic
```

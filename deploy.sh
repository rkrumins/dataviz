#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# Synodic — Self-Host Deployment Runner
# ══════════════════════════════════════════════════════════════════════
#
# For VM / bare-metal self-hosting with Docker Compose. Runs everything
# in containers (viz, controlplane, worker, graph, frontend, infra).
#
# First-time setup:
#   cp .env.prod.example .env
#   $EDITOR .env                     # set REPLACE_ME values
#   ./deploy.sh up
#
# Usage:
#   ./deploy.sh up          Preflight + docker compose up -d
#   ./deploy.sh up --build  Same, but rebuild images first
#   ./deploy.sh down        Stop (data preserved)
#   ./deploy.sh restart     docker compose restart (live reconfig)
#   ./deploy.sh status      docker compose ps + health probes
#   ./deploy.sh logs [svc]  Tail logs
#   ./deploy.sh doctor      Preflight checks only (no side effects)
#   ./deploy.sh update      git pull + rebuild + up -d
#   ./deploy.sh backup [n]  Tar volumes into ./backups/<ts>-<n>/
#   ./deploy.sh restore <d> Restore volumes from a backup directory
#
# For local development (source-code iteration), use ./dev.sh instead.
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

# shellcheck source=scripts/preflight.sh
source "$ROOT_DIR/scripts/preflight.sh"

COMPOSE_PROD="docker compose -f docker-compose.yml"
POSTGRES_CONTAINER="synodic-postgres-1"   # derived from name:synodic + service postgres

# ── Preflight for prod ─────────────────────────────────────────────
preflight_prod() {
    local exit_code=0

    if [ ! -f .env ]; then
        err ".env not found."
        echo -e "  Create one with: ${CYAN}cp .env.prod.example .env${NC}" >&2
        echo -e "  Then edit .env to replace REPLACE_ME values." >&2
        return 1
    fi

    if ! check_env_secrets .env; then
        exit_code=1
    fi

    if ! docker info >/dev/null 2>&1; then
        err "Docker daemon is not reachable. Is Docker running?"
        exit_code=1
    fi

    return $exit_code
}

# ── up / down / restart ────────────────────────────────────────────
cmd_up() {
    preflight_prod || return 1

    log "Starting Synodic full stack..."
    if [ "$#" -gt 0 ]; then
        $COMPOSE_PROD up -d "$@"
    else
        $COMPOSE_PROD up -d
    fi

    log "Waiting for services to become healthy..."
    local deadline=$(( $(date +%s) + 120 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        local unhealthy
        unhealthy=$($COMPOSE_PROD ps --format '{{.Name}} {{.State}} {{.Health}}' 2>/dev/null \
            | awk '$2=="running" && $3!="" && $3!="healthy"' | wc -l | tr -d ' ')
        if [ "$unhealthy" = "0" ]; then
            log "All services healthy."
            break
        fi
        sleep 2
    done

    echo ""
    log "Synodic is up:"
    # shellcheck disable=SC1091
    set -a; source .env; set +a
    echo -e "  ${CYAN}Frontend${NC}   http://localhost:${FRONTEND_PORT:-3080}"
    echo -e "  ${CYAN}API${NC}        http://localhost:${VIZ_PORT:-8000}/docs"
    echo -e "  ${CYAN}Login${NC}      ${ADMIN_EMAIL:-admin@synodic.local} / (from .env)"
    echo ""
    echo -e "  Seed demo data:  ${CYAN}$COMPOSE_PROD --profile seed up seed${NC}"
    echo -e "  Tail logs:       ${CYAN}./deploy.sh logs${NC}"
    echo -e "  Status:          ${CYAN}./deploy.sh status${NC}"
}

cmd_down() {
    log "Stopping Synodic (data preserved)..."
    $COMPOSE_PROD down
    log "Stopped. './deploy.sh up' resumes with data intact."
}

cmd_restart() {
    log "Restarting all services (keeping containers)..."
    $COMPOSE_PROD restart
    log "Restart complete."
}

cmd_status() {
    log "Container status:"
    $COMPOSE_PROD ps
    echo ""

    # shellcheck disable=SC1091
    [ -f .env ] && { set -a; source .env; set +a; }

    log "Health probes:"
    for url_info in \
        "http://localhost:${VIZ_PORT:-8000}/api/v1/health:viz-service" \
        "http://localhost:${CONTROLPLANE_PORT:-8091}/health:controlplane" \
        "http://localhost:${GRAPH_PORT:-8001}/health:graph-service" \
        "http://localhost:${FRONTEND_PORT:-3080}:frontend"; do
        local url="${url_info%:*}"
        local name="${url_info##*:}"
        if curl -sf -o /dev/null -m 3 "$url" 2>/dev/null; then
            echo -e "  ${name}: ${GREEN}healthy${NC}"
        else
            echo -e "  ${name}: ${RED}unreachable${NC}"
        fi
    done
}

cmd_logs() {
    local svc="${1:-}"
    if [ -n "$svc" ]; then
        $COMPOSE_PROD logs -f "$svc"
    else
        $COMPOSE_PROD logs -f --tail=100
    fi
}

cmd_doctor() {
    log "Running preflight checks..."
    preflight_prod || true

    echo ""
    log "Container status:"
    $COMPOSE_PROD ps 2>/dev/null || warn "No containers running."

    echo ""
    log "Postgres role + db (if container running):"
    if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
        # shellcheck disable=SC1091
        [ -f .env ] && { set -a; source .env; set +a; }
        check_postgres_role "$POSTGRES_CONTAINER" "${POSTGRES_USER:-synodic}" || true
        check_postgres_db "$POSTGRES_CONTAINER" "${POSTGRES_DB:-synodic}" || true
    else
        warn "Postgres container not running — skipping role/db check."
    fi
}

cmd_update() {
    log "Pulling latest code..."
    git pull --ff-only || {
        err "git pull failed. Resolve manually and retry."
        return 1
    }
    log "Rebuilding images..."
    $COMPOSE_PROD build
    log "Restarting services with new images..."
    $COMPOSE_PROD up -d
    log "Update complete. Run './deploy.sh status' to verify."
}

# ── Backup / restore (volumes) ─────────────────────────────────────
cmd_backup() {
    local name="${1:-manual}"
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    local dir="$ROOT_DIR/backups/${ts}-${name}"
    mkdir -p "$dir"

    log "Backing up named volumes to ${dir}/ ..."
    for vol in synodic_postgres_data synodic_falkordb_data synodic_redis_data; do
        if ! docker volume ls --format '{{.Name}}' | grep -q "^${vol}$"; then
            warn "Volume ${vol} does not exist — skipping."
            continue
        fi
        docker run --rm \
            -v "$vol":/source:ro \
            -v "$dir":/backup \
            alpine:3.19 \
            tar -czf "/backup/${vol}.tgz" -C /source .
        log "  ${vol}.tgz"
    done
    log "Backup complete: ${dir}"
}

cmd_restore() {
    local archive="${1:-}"
    if [ -z "$archive" ] || [ ! -d "$archive" ]; then
        err "Usage: ./deploy.sh restore <backup-directory>"
        return 1
    fi

    warn "Restore will STOP services and OVERWRITE volumes:"
    warn "  synodic_postgres_data, synodic_falkordb_data, synodic_redis_data"
    read -rp "Type 'yes' to confirm: " answer
    [ "$answer" = "yes" ] || { log "Aborted."; return 0; }

    log "Stopping services..."
    $COMPOSE_PROD down

    for vol in synodic_postgres_data synodic_falkordb_data synodic_redis_data; do
        local tarball="${archive}/${vol}.tgz"
        if [ ! -f "$tarball" ]; then
            warn "Missing ${tarball} — skipping ${vol}."
            continue
        fi
        log "Restoring ${vol} from $(basename "$tarball") ..."
        docker volume rm -f "$vol" >/dev/null 2>&1 || true
        docker volume create "$vol" >/dev/null
        docker run --rm \
            -v "$vol":/target \
            -v "$archive":/backup:ro \
            alpine:3.19 \
            sh -c "cd /target && tar -xzf /backup/${vol}.tgz"
    done

    log "Restore complete. Starting services..."
    cmd_up
}

usage() {
    cat <<'EOF'
Usage: ./deploy.sh <command> [args]

Lifecycle:
  up [--build]       Start all services (preflight + docker compose up -d)
  down               Stop all services (data preserved)
  restart            docker compose restart
  update             git pull + rebuild + up -d

Diagnostics:
  status             Container status + health probes
  logs [service]     Tail logs (default: all services)
  doctor             Preflight checks only, no side effects

Data:
  backup [name]      Tar named volumes into ./backups/<timestamp>-<name>/
  restore <dir>      Restore volumes from a backup directory

First-time setup:
  cp .env.prod.example .env
  $EDITOR .env              # replace all REPLACE_ME values
  ./deploy.sh up

Docs: docs/DEPLOYMENT.md
EOF
}

case "${1:-}" in
    up)
        shift
        cmd_up "$@"
        ;;
    down)
        cmd_down
        ;;
    restart)
        cmd_restart
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs "${2:-}"
        ;;
    doctor)
        cmd_doctor
        ;;
    update)
        cmd_update
        ;;
    backup)
        cmd_backup "${2:-manual}"
        ;;
    restore)
        cmd_restore "${2:-}"
        ;;
    help|-h|--help|"")
        usage
        ;;
    *)
        err "Unknown command: $1"
        echo ""
        usage
        exit 1
        ;;
esac

#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# Synodic — Local Development Runner
# ══════════════════════════════════════════════════════════════════════
#
# Runs all services locally from source with hot-reload.
# Infrastructure (Postgres, FalkorDB, Redis) runs in Docker.
#
# Usage:
#   ./dev.sh                 Start infra + show service instructions
#   ./dev.sh infra           Start infrastructure only
#   ./dev.sh stop            Stop infrastructure (data preserved)
#   ./dev.sh restart         Stop + start infra
#   ./dev.sh reset           Wipe all data (interactive confirm)
#   ./dev.sh repair          Self-heal stale volumes / orphans
#   ./dev.sh doctor          Diagnose environment, no side effects
#   ./dev.sh status          Container + port + health summary
#   ./dev.sh logs [svc]      Tail logs (default: all)
#   ./dev.sh clean-orphans   Remove full-stack compose orphans
#   ./dev.sh backup [name]   Tar named volumes into ./backups/
#   ./dev.sh restore <file>  Restore volumes from a backup tarball
#   ./dev.sh viz             Start viz-service (single-process dev)
#   ./dev.sh viz-proxy       Start viz-service (proxy mode)
#   ./dev.sh controlplane    Start aggregation control plane
#   ./dev.sh worker          Start aggregation worker (headless)
#   ./dev.sh frontend        Start frontend Vite dev server
#
# Prerequisites:
#   - Python 3.13+ with venv at .venv/
#   - Node.js 18+ (for frontend)
#   - Docker (for infrastructure)
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
err()  { echo -e "${RED}[dev]${NC} $*" >&2; }

# ── Preflight library ───────────────────────────────────────────────
# shellcheck source=scripts/preflight.sh
source "$ROOT_DIR/scripts/preflight.sh"

# ── Compose invocation (centralized) ───────────────────────────────
COMPOSE_DEV="docker compose --env-file .env.dev -f docker-compose.dev.yml"
POSTGRES_CONTAINER="synodic-postgres-dev"

# ── Background process tracking (for `start` / `stop`) ─────────────
LOG_DIR="$ROOT_DIR/logs"
PID_DIR="$ROOT_DIR/.pids"

# ── Environment ─────────────────────────────────────────────────────
# .env.dev uses KEY=VALUE format (no `export`). `set -a` auto-exports.
load_env() {
    if [ ! -f .env.dev ]; then
        if [ -f .env.example ]; then
            warn ".env.dev not found — creating from .env.example"
            cp .env.example .env.dev
        else
            err ".env.dev not found and .env.example missing — cannot bootstrap"
            exit 1
        fi
    fi
    set -a
    # shellcheck disable=SC1091
    source .env.dev
    set +a
}

# ── Venv check ──────────────────────────────────────────────────────
check_venv() {
    if [ ! -d ".venv" ]; then
        warn "No .venv found. Creating..."
        python3 -m venv .venv
        .venv/bin/pip install -r backend/requirements.txt
        log "Virtual environment created and dependencies installed."
    fi
    # shellcheck disable=SC1091
    source .venv/bin/activate
}

# ── Infrastructure lifecycle ───────────────────────────────────────
start_infra() {
    check_orphan_containers 2>/dev/null || \
        warn "Orphans detected — run './dev.sh clean-orphans' to clean up."

    # Check ports before starting (avoid silent failures when, e.g., a
    # local Postgres already holds 5432).
    local port_ok=1
    check_port "${POSTGRES_PORT:-5432}" "postgres" 2>/dev/null || port_ok=0
    check_port "${REDIS_PORT:-6380}" "redis" 2>/dev/null || port_ok=0
    check_port "${FALKORDB_PORT:-6379}" "falkordb" 2>/dev/null || port_ok=0
    check_port "${FALKORDB_UI_PORT:-3000}" "falkordb-ui" 2>/dev/null || port_ok=0
    if [ "$port_ok" -eq 0 ]; then
        err "Port conflicts detected. Run './dev.sh doctor' for details."
        return 1
    fi

    log "Starting infrastructure (Postgres, FalkorDB, Redis)..."
    $COMPOSE_DEV up -d

    log "Waiting for services to become healthy..."
    wait_for_service localhost "${POSTGRES_PORT:-5432}" "Postgres" 30
    wait_for_service localhost "${REDIS_PORT:-6380}" "Redis" 15
    wait_for_service localhost "${FALKORDB_PORT:-6379}" "FalkorDB" 15

    # Verify role+db made it through init (catches stale-volume bug)
    if ! check_postgres_role "$POSTGRES_CONTAINER" "${POSTGRES_USER:-synodic}" 2>/dev/null; then
        err "Postgres is up but role '${POSTGRES_USER:-synodic}' is missing."
        err "Your data volume is likely stale. Run: ./dev.sh repair"
        return 1
    fi

    log "Infrastructure ready."
    echo ""
    echo -e "  ${CYAN}Postgres${NC}   localhost:${POSTGRES_PORT:-5432}  (${POSTGRES_USER:-synodic}/${POSTGRES_PASSWORD:-synodic})"
    echo -e "  ${CYAN}FalkorDB${NC}   localhost:${FALKORDB_PORT:-6379}  (browser: http://localhost:${FALKORDB_UI_PORT:-3000})"
    echo -e "  ${CYAN}Redis${NC}      localhost:${REDIS_PORT:-6380}"
    echo ""
}

stop_infra() {
    log "Stopping infrastructure (data preserved)..."
    $COMPOSE_DEV down
    log "Infrastructure stopped. Volumes retained — './dev.sh infra' resumes."
}

# ── Background process helpers ─────────────────────────────────────
# Stores PIDs under .pids/<name>.pid and streams stdout/stderr to
# logs/<name>.log. Designed so the user can forget they exist: `start`
# launches them, `stop` kills them, `logs <name>` tails them.

_pid_alive() {
    local pidfile="$1"
    [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

_start_bg() {
    # _start_bg <name> <working-dir> <cmd...>
    local name="$1"; shift
    local workdir="$1"; shift
    local pidfile="$PID_DIR/${name}.pid"
    local logfile="$LOG_DIR/${name}.log"

    mkdir -p "$LOG_DIR" "$PID_DIR"

    if _pid_alive "$pidfile"; then
        warn "${name} already running (PID $(cat "$pidfile")) — skip."
        return 0
    fi
    rm -f "$pidfile"

    # nohup detaches from the terminal so the process keeps running
    # after dev.sh exits. `&` backgrounds it. `$!` is the child PID.
    (
        cd "$workdir"
        nohup "$@" > "$logfile" 2>&1 &
        echo $! > "$pidfile"
    )
    sleep 0.2
    if _pid_alive "$pidfile"; then
        log "  ${BLUE}${name}${NC} started (PID $(cat "$pidfile"), log: logs/${name}.log)"
        return 0
    else
        err "  ${name} failed to start — see logs/${name}.log"
        return 1
    fi
}

_stop_bg() {
    # _stop_bg <name>
    local name="$1"
    local pidfile="$PID_DIR/${name}.pid"

    if ! [ -f "$pidfile" ]; then
        return 0
    fi
    local pid
    pid=$(cat "$pidfile")

    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pidfile"
        return 0
    fi

    log "  Stopping ${name} (PID ${pid})..."
    # SIGTERM first; children (uvicorn workers, vite) propagate
    kill -TERM "$pid" 2>/dev/null || true
    # Also kill direct children (vite spawns esbuild; uvicorn reload spawns workers)
    local children
    children=$(pgrep -P "$pid" 2>/dev/null || true)
    if [ -n "$children" ]; then
        echo "$children" | xargs -r kill -TERM 2>/dev/null || true
    fi

    # Wait up to 5s for graceful shutdown
    local deadline=$(( $(date +%s) + 5 ))
    while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
        sleep 0.2
    done

    # Force if still alive
    if kill -0 "$pid" 2>/dev/null; then
        warn "  ${name} did not exit gracefully — SIGKILL."
        kill -KILL "$pid" 2>/dev/null || true
        [ -n "$children" ] && echo "$children" | xargs -r kill -KILL 2>/dev/null || true
    fi

    rm -f "$pidfile"
}

# ── Start: one-command bring-up (infra + viz + frontend) ───────────
start_all() {
    start_infra || return 1

    echo ""
    log "Starting application processes in the background..."

    # Activate venv for the Python processes we're about to launch. We
    # only need the path to `python`/`uvicorn` — the child inherits the
    # venv via activated PATH.
    check_venv

    # Viz (single-process dev mode, hot-reload)
    local viz_port="${VIZ_PORT:-8000}"
    if lsof -iTCP:"$viz_port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        warn "Port ${viz_port} busy — skipping viz start. Check './dev.sh status'."
    else
        SYNODIC_ROLE="dev" \
        AGGREGATION_PROXY_ENABLED="false" \
        AGGREGATION_DISPATCH_MODE="inprocess" \
        _start_bg viz "$ROOT_DIR" \
            python -m uvicorn backend.app.main:app \
                --reload \
                --host 0.0.0.0 \
                --port "$viz_port" \
                --reload-dir backend \
                --log-level "$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
    fi

    # Frontend (Vite)
    local fe_port="${FRONTEND_PORT:-5173}"
    if lsof -iTCP:"$fe_port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        warn "Port ${fe_port} busy — skipping frontend start."
    else
        if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
            log "Installing frontend dependencies (first run)..."
            (cd "$ROOT_DIR/frontend" && npm install)
        fi
        _start_bg frontend "$ROOT_DIR/frontend" \
            npm run dev -- --port "$fe_port"
    fi

    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    log "Synodic is running."
    echo -e "  ${CYAN}Frontend${NC}     http://localhost:${fe_port}"
    echo -e "  ${CYAN}Backend API${NC}  http://localhost:${viz_port}/docs"
    echo -e "  ${CYAN}Login${NC}        ${ADMIN_EMAIL:-admin@nexuslineage.local} / ${ADMIN_PASSWORD:-admin123}"
    echo ""
    echo -e "  Tail logs:   ${CYAN}./dev.sh logs-app [viz|frontend]${NC}"
    echo -e "  Status:      ${CYAN}./dev.sh status${NC}"
    echo -e "  Stop all:    ${CYAN}./dev.sh stop${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
}

# ── Stop: bring everything down ────────────────────────────────────
stop_all() {
    log "Stopping application processes..."
    _stop_bg frontend
    _stop_bg viz
    _stop_bg controlplane 2>/dev/null || true
    _stop_bg worker 2>/dev/null || true

    echo ""
    stop_infra
}

# ── logs-app: tail a backgrounded process's log ────────────────────
logs_app() {
    local name="${1:-viz}"
    local logfile="$LOG_DIR/${name}.log"
    if [ ! -f "$logfile" ]; then
        err "No log file at $logfile — is '${name}' running? Try './dev.sh start'."
        return 1
    fi
    log "Tailing logs/${name}.log (Ctrl-C to exit) ..."
    exec tail -f "$logfile"
}

reset_infra() {
    warn "This WIPES all data volumes (postgres + falkordb + redis)."
    read -rp "Type 'yes' to confirm: " answer
    if [ "$answer" != "yes" ]; then
        log "Aborted."
        return 0
    fi
    $COMPOSE_DEV down -v
    log "All data wiped. Run './dev.sh infra' to start fresh."
}

# ── Repair: self-heal stale volumes / orphans ──────────────────────
repair() {
    log "Diagnosing environment..."
    run_doctor || true   # informational; we act on specific findings below

    echo ""

    # 1. Orphan cleanup
    local orphans
    orphans=$(docker ps -a --format '{{.Names}}' 2>/dev/null \
        | grep -E '^synodic-(frontend|viz-service|aggregation-(worker|controlplane)|graph-service)-[0-9]+$' || true)
    if [ -n "$orphans" ]; then
        warn "Orphan containers found:"
        echo "$orphans" | sed 's/^/    /'
        read -rp "Remove them? [y/N] " answer
        if [ "${answer:-n}" = "y" ] || [ "${answer:-n}" = "Y" ]; then
            echo "$orphans" | xargs -r docker rm -f
            log "Orphans removed."
        fi
    fi

    # 2. Stale-volume detection
    local role_missing=0
    if docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
        check_postgres_role "$POSTGRES_CONTAINER" "${POSTGRES_USER:-synodic}" 2>/dev/null || role_missing=1
    else
        warn "Postgres container is not running — skipping volume check."
        log "Run './dev.sh infra' to start."
        return 0
    fi

    if [ "$role_missing" -eq 1 ]; then
        echo ""
        warn "Stale Postgres volume detected."
        warn "The data directory was initialized with different credentials "
        warn "(or a failed init). Repair requires wiping the volume."
        read -rp "Wipe 'synodic-postgres-dev-data' and re-init? [y/N] " answer
        if [ "${answer:-n}" = "y" ] || [ "${answer:-n}" = "Y" ]; then
            log "Stopping and wiping Postgres volume..."
            $COMPOSE_DEV down -v
            log "Restarting infrastructure with fresh init..."
            start_infra
            log "Verifying role..."
            if check_postgres_role "$POSTGRES_CONTAINER" "${POSTGRES_USER:-synodic}"; then
                log "Repair complete."
            else
                err "Repair failed — role still missing after re-init."
                return 1
            fi
        else
            log "Aborted. Nothing changed."
        fi
    else
        log "No stale volume detected."
    fi
}

# ── Status: compose ps + port summary + health probe ───────────────
status() {
    log "Container status:"
    $COMPOSE_DEV ps 2>/dev/null || warn "No infrastructure containers."
    echo ""

    log "Port status:"
    for entry in "${POSTGRES_PORT:-5432}:postgres" \
                 "${REDIS_PORT:-6380}:redis" \
                 "${FALKORDB_PORT:-6379}:falkordb" \
                 "${FALKORDB_UI_PORT:-3000}:falkordb-ui" \
                 "${VIZ_PORT:-8000}:viz" \
                 "${AGGREGATION_API_PORT:-8091}:controlplane" \
                 "${FRONTEND_PORT:-5173}:frontend-dev"; do
        local port="${entry%%:*}"
        local name="${entry##*:}"
        if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "  ${CYAN}${port}${NC} (${name}): occupied"
        else
            echo "  ${port} (${name}): free"
        fi
    done
    echo ""

    log "Backend health:"
    local health
    health=$(curl -sf "http://localhost:${VIZ_PORT:-8000}/api/v1/health" 2>/dev/null || true)
    if [ -n "$health" ]; then
        echo "$health" | python3 -m json.tool 2>/dev/null || echo "  $health"
    else
        echo "  viz-service: unreachable"
    fi
}

# ── Clean orphans ──────────────────────────────────────────────────
clean_orphans() {
    local orphans
    orphans=$(docker ps -a --format '{{.Names}}' 2>/dev/null \
        | grep -E '^synodic-(frontend|viz-service|aggregation-(worker|controlplane)|graph-service)-[0-9]+$' || true)
    if [ -z "$orphans" ]; then
        log "No orphan containers."
        return 0
    fi
    warn "Will remove:"
    echo "$orphans" | sed 's/^/    /'
    read -rp "Proceed? [y/N] " answer
    [ "${answer:-n}" = "y" ] || [ "${answer:-n}" = "Y" ] || { log "Aborted."; return 0; }
    echo "$orphans" | xargs -r docker rm -f
    log "Orphans removed."
}

# ── Backup / restore ───────────────────────────────────────────────
backup() {
    local name="${1:-manual}"
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    local dir="$ROOT_DIR/backups/${ts}-${name}"
    mkdir -p "$dir"

    log "Backing up named volumes to ${dir}/ ..."
    for vol in synodic-postgres-dev-data synodic-falkordb-dev-data synodic-redis-dev-data; do
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

restore() {
    local archive="${1:-}"
    if [ -z "$archive" ]; then
        err "Usage: ./dev.sh restore <backup-dir-or-tarball>"
        return 1
    fi
    if [ ! -e "$archive" ]; then
        err "Backup not found: $archive"
        return 1
    fi

    warn "Restore will OVERWRITE current data volumes."
    read -rp "Type 'yes' to confirm: " answer
    [ "$answer" = "yes" ] || { log "Aborted."; return 0; }

    log "Stopping infrastructure..."
    $COMPOSE_DEV down

    # Accept either a directory containing per-volume tarballs or a single tarball.
    local src_dir
    if [ -d "$archive" ]; then
        src_dir="$archive"
    else
        err "Single-archive restore not yet supported — pass a backup directory."
        return 1
    fi

    for vol in synodic-postgres-dev-data synodic-falkordb-dev-data synodic-redis-dev-data; do
        local tarball="${src_dir}/${vol}.tgz"
        if [ ! -f "$tarball" ]; then
            warn "Missing ${tarball} — skipping ${vol}."
            continue
        fi
        log "Restoring ${vol} from $(basename "$tarball") ..."
        docker volume rm -f "$vol" >/dev/null 2>&1 || true
        docker volume create "$vol" >/dev/null
        docker run --rm \
            -v "$vol":/target \
            -v "$src_dir":/backup:ro \
            alpine:3.19 \
            sh -c "cd /target && tar -xzf /backup/${vol}.tgz"
    done

    log "Restore complete. Starting infrastructure..."
    start_infra
}

# ── Logs ───────────────────────────────────────────────────────────
logs() {
    local svc="${1:-}"
    if [ -n "$svc" ]; then
        $COMPOSE_DEV logs -f "$svc"
    else
        $COMPOSE_DEV logs -f
    fi
}

# ── Service runners ─────────────────────────────────────────────────

run_viz() {
    local port="${VIZ_PORT:-8000}"
    check_port "$port" "viz-service" || return 1
    wait_for_service localhost "${POSTGRES_PORT:-5432}" "Postgres" 15 || {
        err "Postgres not reachable. Run './dev.sh infra' first."
        return 1
    }

    log "Starting ${BLUE}viz-service${NC} on port ${port} (hot-reload)..."
    echo -e "  Mode: ${YELLOW}single-process dev${NC} (aggregation runs in-process)"
    echo ""

    # Dev mode: no proxy, aggregation runs in-process
    export SYNODIC_ROLE="dev"
    export AGGREGATION_PROXY_ENABLED="false"
    export AGGREGATION_DISPATCH_MODE="inprocess"

    cd "$ROOT_DIR"
    exec python -m uvicorn backend.app.main:app \
        --reload \
        --host 0.0.0.0 \
        --port "$port" \
        --reload-dir backend \
        --log-level "$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
}

run_viz_proxy() {
    local port="${VIZ_PORT:-8000}"
    local cp_port="${AGGREGATION_API_PORT:-8091}"
    check_port "$port" "viz-service" || return 1
    wait_for_service localhost "${POSTGRES_PORT:-5432}" "Postgres" 15 || return 1
    wait_for_service localhost "$cp_port" "controlplane" 5 || {
        warn "Control plane not reachable on ${cp_port} — starting anyway, "
        warn "but aggregation endpoints will fail until './dev.sh controlplane' runs."
    }

    log "Starting ${BLUE}viz-service${NC} on port ${port} (proxy mode, hot-reload)..."
    echo -e "  Mode: ${YELLOW}proxy${NC} (aggregation -> controlplane:${cp_port})"
    echo ""

    export SYNODIC_ROLE="web"
    export AGGREGATION_PROXY_ENABLED="true"
    export AGGREGATION_SERVICE_URL="${AGGREGATION_SERVICE_URL:-http://localhost:${cp_port}}"

    cd "$ROOT_DIR"
    exec python -m uvicorn backend.app.main:app \
        --reload \
        --host 0.0.0.0 \
        --port "$port" \
        --reload-dir backend \
        --log-level "$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
}

run_controlplane() {
    local port="${AGGREGATION_API_PORT:-8091}"
    check_port "$port" "controlplane" || return 1
    wait_for_service localhost "${POSTGRES_PORT:-5432}" "Postgres" 15 || return 1
    wait_for_service localhost "${REDIS_PORT:-6380}" "Redis" 10 || return 1

    log "Starting ${BLUE}aggregation-controlplane${NC} on port ${port}..."
    echo ""

    export SYNODIC_ROLE="controlplane"
    export AGGREGATION_DISPATCH_MODE="redis"
    export AGGREGATION_API_PORT="$port"
    export FALKORDB_SOCKET_TIMEOUT="5"

    cd "$ROOT_DIR"
    exec python -m backend.app.services.aggregation.controlplane
}

run_worker() {
    wait_for_service localhost "${POSTGRES_PORT:-5432}" "Postgres" 15 || return 1
    wait_for_service localhost "${REDIS_PORT:-6380}" "Redis" 10 || return 1

    log "Starting ${BLUE}aggregation-worker${NC} (headless)..."
    echo ""

    export SYNODIC_ROLE="worker"
    export FALKORDB_SOCKET_TIMEOUT="60"
    export WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-4}"
    export MAX_CONCURRENT_PER_GRAPH="${MAX_CONCURRENT_PER_GRAPH:-2}"

    cd "$ROOT_DIR"
    exec python -m backend.app.services.aggregation
}

run_frontend() {
    local port="${FRONTEND_PORT:-5173}"
    check_port "$port" "frontend" || return 1

    log "Starting ${BLUE}frontend${NC} dev server on port ${port}..."
    echo ""

    cd "$ROOT_DIR/frontend"
    if [ ! -d "node_modules" ]; then
        warn "Installing frontend dependencies..."
        npm install
    fi
    exec npm run dev -- --port "$port"
}

# ── Usage ───────────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
Usage: ./dev.sh <command> [args]

One-command (recommended):
  start             Start infra + backend + frontend (backgrounded)  ← default
  stop              Stop everything (app processes + infra)
  status            Container + port + health summary
  logs-app [name]   Tail a backgrounded process log (viz | frontend)

Infrastructure-only:
  infra             Start Postgres + FalkorDB + Redis
  stop-infra        Stop only the infra containers (leave apps alone)
  restart           Stop + start infra
  reset             Wipe all data (interactive confirm)
  repair            Self-heal stale volumes / orphans
  backup [name]     Tar named volumes into ./backups/<timestamp>-<name>/
  restore <dir>     Restore named volumes from a backup directory

Diagnostics:
  doctor            Run all preflight checks (no side effects)
  logs [svc]        Tail Docker infra logs (compose)
  clean-orphans     Remove orphan containers from full-stack compose

Foreground services (run in separate terminals — old workflow):
  viz               viz-service (single-process dev mode, hot-reload)
  viz-proxy         viz-service (proxy mode → controlplane)
  controlplane      aggregation control plane (port 8091)
  worker            aggregation worker (headless)
  frontend          frontend Vite dev server (port 5173)

Default (no args): `start`.

Docs: docs/DEVELOPMENT.md  (self-host: docs/DEPLOYMENT.md)
EOF
}

# ── Main ────────────────────────────────────────────────────────────

case "${1:-start}" in
    start)
        load_env
        start_all
        ;;
    infra)
        load_env
        start_infra
        ;;
    stop)
        load_env
        stop_all
        ;;
    stop-infra)
        load_env
        stop_infra
        ;;
    logs-app)
        logs_app "${2:-viz}"
        ;;
    restart)
        load_env
        stop_infra
        start_infra
        ;;
    reset)
        load_env
        reset_infra
        ;;
    repair)
        load_env
        repair
        ;;
    doctor)
        load_env 2>/dev/null || true
        run_doctor
        ;;
    status)
        load_env 2>/dev/null || true
        status
        ;;
    logs)
        load_env 2>/dev/null || true
        logs "${2:-}"
        ;;
    clean-orphans)
        clean_orphans
        ;;
    backup)
        backup "${2:-manual}"
        ;;
    restore)
        restore "${2:-}"
        ;;
    viz)
        load_env
        check_venv
        run_viz
        ;;
    viz-proxy)
        load_env
        check_venv
        run_viz_proxy
        ;;
    controlplane|cp)
        load_env
        check_venv
        run_controlplane
        ;;
    worker)
        load_env
        check_venv
        run_worker
        ;;
    frontend|fe)
        load_env
        run_frontend
        ;;
    all)
        load_env
        check_venv
        start_infra

        echo ""
        echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}  Infrastructure is running. Start services in separate terminals:${NC}"
        echo ""
        echo -e "  ${CYAN}Option A — Single-process dev mode (simplest):${NC}"
        echo -e "    ./dev.sh viz              # All-in-one on port ${VIZ_PORT:-8000}"
        echo ""
        echo -e "  ${CYAN}Option B — Three-process production-like mode:${NC}"
        echo -e "    ./dev.sh controlplane     # Aggregation API on port 8091"
        echo -e "    ./dev.sh worker           # Aggregation worker (headless)"
        echo -e "    ./dev.sh viz-proxy        # Web tier on port 8000"
        echo ""
        echo -e "  ${CYAN}Frontend (either mode):${NC}"
        echo -e "    ./dev.sh frontend         # Vite dev server on port ${FRONTEND_PORT:-5173}"
        echo ""
        echo -e "  ${CYAN}Diagnostics:${NC}"
        echo -e "    ./dev.sh doctor           # health of environment"
        echo -e "    ./dev.sh status           # containers + ports + backend health"
        echo -e "    ./dev.sh repair           # fix stale volumes / orphans"
        echo ""
        echo -e "  ${CYAN}Credentials:${NC}"
        echo -e "    Email:    ${ADMIN_EMAIL:-admin@synodic.local}"
        echo -e "    Password: ${ADMIN_PASSWORD:-admin123}  (change after first login)"
        echo ""
        echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
        ;;
    help|-h|--help)
        usage
        ;;
    *)
        err "Unknown command: $1"
        echo ""
        usage
        exit 1
        ;;
esac

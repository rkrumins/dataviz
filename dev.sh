#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# Synodic — Local Development Runner
# ══════════════════════════════════════════════════════════════════════
#
# Runs all services locally from source with hot-reload.
# Infrastructure (Postgres, FalkorDB, Redis) runs in Docker.
#
# Usage:
#   ./dev.sh              Start everything (infra + all services)
#   ./dev.sh infra        Start infrastructure only
#   ./dev.sh viz          Start viz-service only
#   ./dev.sh controlplane Start aggregation control plane only
#   ./dev.sh worker       Start aggregation worker only
#   ./dev.sh frontend     Start frontend dev server only
#   ./dev.sh stop         Stop infrastructure
#   ./dev.sh reset        Wipe all data and start fresh
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

# ── Environment ─────────────────────────────────────────────────────
load_env() {
    if [ -f .env.dev ]; then
        source .env.dev
    else
        err ".env.dev not found — run from project root"
        exit 1
    fi
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

# ── Infrastructure ──────────────────────────────────────────────────
start_infra() {
    log "Starting infrastructure (Postgres, FalkorDB, Redis)..."
    docker compose -f docker-compose.dev.yml up -d
    log "Waiting for services to be healthy..."
    docker compose -f docker-compose.dev.yml exec postgres pg_isready -U synodic -q 2>/dev/null || sleep 3
    docker compose -f docker-compose.dev.yml exec redis redis-cli ping > /dev/null 2>&1 || sleep 3
    docker compose -f docker-compose.dev.yml exec falkordb redis-cli ping > /dev/null 2>&1 || sleep 3
    log "Infrastructure ready."
    echo ""
    echo -e "  ${CYAN}Postgres${NC}   localhost:5432  (synodic/synodic)"
    echo -e "  ${CYAN}FalkorDB${NC}   localhost:6379  (browser: http://localhost:3000)"
    echo -e "  ${CYAN}Redis${NC}      localhost:6380"
    echo ""
}

stop_infra() {
    log "Stopping infrastructure..."
    docker compose -f docker-compose.dev.yml down
    log "Infrastructure stopped."
}

reset_infra() {
    warn "Wiping all data volumes..."
    docker compose -f docker-compose.dev.yml down -v
    log "All data wiped. Run './dev.sh' to start fresh."
}

# ── Service runners ─────────────────────────────────────────────────

run_viz() {
    local port="${VIZ_PORT:-8000}"
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
    log "Starting ${BLUE}viz-service${NC} on port 8000 (proxy mode, hot-reload)..."
    echo -e "  Mode: ${YELLOW}proxy${NC} (aggregation -> controlplane:8091)"
    echo ""

    # Production-like mode: proxy to control plane
    export SYNODIC_ROLE="web"
    export AGGREGATION_PROXY_ENABLED="true"
    export AGGREGATION_SERVICE_URL="http://localhost:8091"

    cd "$ROOT_DIR"
    exec python -m uvicorn backend.app.main:app \
        --reload \
        --host 0.0.0.0 \
        --port 8000 \
        --reload-dir backend \
        --log-level "$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
}

run_controlplane() {
    log "Starting ${BLUE}aggregation-controlplane${NC} on port 8091..."
    echo ""

    export SYNODIC_ROLE="controlplane"
    export AGGREGATION_DISPATCH_MODE="redis"
    export AGGREGATION_API_PORT="8091"
    export FALKORDB_SOCKET_TIMEOUT="5"

    cd "$ROOT_DIR"
    exec python -m backend.app.services.aggregation.controlplane
}

run_worker() {
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
    log "Starting ${BLUE}frontend${NC} dev server on port 5173..."
    echo ""

    cd "$ROOT_DIR/frontend"
    if [ ! -d "node_modules" ]; then
        warn "Installing frontend dependencies..."
        npm install
    fi
    exec npm run dev
}

# ── Main ────────────────────────────────────────────────────────────

case "${1:-all}" in
    infra)
        start_infra
        ;;
    stop)
        stop_infra
        ;;
    reset)
        reset_infra
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
        run_frontend
        ;;
    all)
        load_env
        check_venv
        start_infra

        echo ""
        echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}  Infrastructure is running. Now start services in separate terminals:${NC}"
        echo ""
        echo -e "  ${CYAN}Option A — Single-process dev mode (simplest):${NC}"
        echo -e "    ./dev.sh viz              # All-in-one on port 8000"
        echo ""
        echo -e "  ${CYAN}Option B — Three-process production-like mode:${NC}"
        echo -e "    ./dev.sh controlplane     # Aggregation API on port 8091"
        echo -e "    ./dev.sh worker           # Aggregation worker (headless)"
        echo -e "    ./dev.sh viz-proxy        # Web tier on port 8000 (proxies to CP)"
        echo ""
        echo -e "  ${CYAN}Frontend (either mode):${NC}"
        echo -e "    ./dev.sh frontend         # Vite dev server on port 5173"
        echo ""
        echo -e "  ${CYAN}Credentials:${NC}"
        echo -e "    Email:    admin@nexuslineage.local"
        echo -e "    Password: admin123"
        echo ""
        echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
        ;;
    *)
        echo "Usage: ./dev.sh [infra|stop|reset|viz|viz-proxy|controlplane|worker|frontend|all]"
        echo ""
        echo "  infra         Start infrastructure (Postgres, FalkorDB, Redis)"
        echo "  stop          Stop infrastructure"
        echo "  reset         Wipe all data and stop"
        echo "  viz           Start viz-service (single-process dev mode)"
        echo "  viz-proxy     Start viz-service (proxy mode -> controlplane)"
        echo "  controlplane  Start aggregation control plane (port 8091)"
        echo "  worker        Start aggregation worker (headless)"
        echo "  frontend      Start frontend Vite dev server"
        echo "  all           Start infra + show instructions (default)"
        exit 1
        ;;
esac

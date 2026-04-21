#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# Synodic — Preflight Validation Library
# ══════════════════════════════════════════════════════════════════════
#
# Source this from dev.sh before starting any service. Provides:
#   check_port       — fail fast if a port is already occupied
#   wait_for_service — block until a TCP service is reachable
#   check_env        — validate .env.dev has required variables
#
# Usage:
#   source scripts/preflight.sh
#   check_port 8000 "viz-service"
#   wait_for_service localhost 5432 "Postgres" 30
# ══════════════════════════════════════════════════════════════════════

# Colors (inherit from dev.sh if already defined)
_PF_RED='\033[0;31m'
_PF_GREEN='\033[0;32m'
_PF_YELLOW='\033[1;33m'
_PF_CYAN='\033[0;36m'
_PF_NC='\033[0m'

_pf_log()  { echo -e "${_PF_GREEN}[preflight]${_PF_NC} $*"; }
_pf_warn() { echo -e "${_PF_YELLOW}[preflight]${_PF_NC} $*"; }
_pf_err()  { echo -e "${_PF_RED}[preflight]${_PF_NC} $*" >&2; }

# ── check_port <port> <service_name> ──────────────────────────────────
# Checks if a port is already in use. If occupied, prints the offending
# process and exits with code 1.
check_port() {
    local port="$1"
    local service_name="$2"

    if [ -z "$port" ] || [ -z "$service_name" ]; then
        _pf_err "Usage: check_port <port> <service_name>"
        return 1
    fi

    # lsof is available on macOS and most Linux distros
    local pid_info
    pid_info=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)

    if [ -n "$pid_info" ]; then
        local pid="$pid_info"
        local cmd elapsed
        if [[ "$OSTYPE" == darwin* ]]; then
            cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            elapsed=$(ps -p "$pid" -o etime= 2>/dev/null || echo "unknown")
        else
            cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            elapsed=$(ps -p "$pid" -o etime= 2>/dev/null || echo "unknown")
        fi
        _pf_err "Port ${port} is already in use by:"
        echo -e "  PID ${pid} — ${cmd} — running for ${elapsed}" >&2
        echo -e "  Kill it with: ${_PF_CYAN}kill -9 ${pid}${_PF_NC}" >&2
        echo "" >&2
        _pf_err "Cannot start ${service_name} on port ${port}."
        return 1
    fi

    return 0
}

# ── wait_for_container_healthy <container> [timeout_secs] ────────────
# Blocks until the container's compose healthcheck reports `healthy`.
# Returns 0 on success, 1 on timeout, 2 if container has no healthcheck.
wait_for_container_healthy() {
    local container="$1"
    local timeout="${2:-60}"

    if [ -z "$container" ]; then
        _pf_err "Usage: wait_for_container_healthy <container> [timeout_secs]"
        return 1
    fi

    local start elapsed status
    start=$(date +%s)
    printf "${_PF_GREEN}[preflight]${_PF_NC} Waiting for %s to be healthy..." "$container"

    while true; do
        status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
                    "$container" 2>/dev/null || echo "missing")

        case "$status" in
            healthy)
                elapsed=$(( $(date +%s) - start ))
                echo -e " ${_PF_GREEN}OK${_PF_NC} (${elapsed}s)"
                return 0
                ;;
            none)
                echo -e " ${_PF_YELLOW}no healthcheck${_PF_NC}"
                return 2
                ;;
            missing)
                echo -e " ${_PF_RED}FAILED${_PF_NC}"
                _pf_err "Container ${container} not found"
                return 1
                ;;
        esac

        elapsed=$(( $(date +%s) - start ))
        if [ "$elapsed" -ge "$timeout" ]; then
            echo -e " ${_PF_RED}FAILED${_PF_NC} (status: ${status})"
            _pf_err "${container} did not become healthy within ${timeout}s"
            echo -e "  Inspect: ${_PF_CYAN}docker logs ${container}${_PF_NC}" >&2
            return 1
        fi
        sleep 1
    done
}

# ── wait_for_service <host> <port> <service_name> [timeout_secs] ─────
# Attempts TCP connection with retries up to timeout_secs (default 30).
# Returns 0 on success, 1 on timeout.
wait_for_service() {
    local host="$1"
    local port="$2"
    local service_name="$3"
    local timeout="${4:-30}"

    if [ -z "$host" ] || [ -z "$port" ] || [ -z "$service_name" ]; then
        _pf_err "Usage: wait_for_service <host> <port> <service_name> [timeout_secs]"
        return 1
    fi

    local start elapsed
    start=$(date +%s)

    printf "${_PF_GREEN}[preflight]${_PF_NC} Waiting for %s on %s:%s..." "$service_name" "$host" "$port"

    while true; do
        # Try TCP connection (works on both macOS and Linux)
        if (echo > /dev/tcp/"$host"/"$port") 2>/dev/null; then
            elapsed=$(( $(date +%s) - start ))
            echo -e " ${_PF_GREEN}OK${_PF_NC} (${elapsed}s)"
            return 0
        fi

        elapsed=$(( $(date +%s) - start ))
        if [ "$elapsed" -ge "$timeout" ]; then
            echo -e " ${_PF_RED}FAILED${_PF_NC}"
            _pf_err "${service_name} not reachable on ${host}:${port} after ${timeout}s"
            echo -e "  Is Docker infrastructure running? Try: ${_PF_CYAN}./dev.sh infra${_PF_NC}" >&2
            return 1
        fi

        sleep 1
    done
}

# ── check_env ─────────────────────────────────────────────────────────
# Validates .env.dev exists and contains required variables.
check_env() {
    local env_file="${1:-.env.dev}"
    local required_vars=("MANAGEMENT_DB_URL" "REDIS_URL" "FALKORDB_HOST")
    local missing=()

    if [ ! -f "$env_file" ]; then
        _pf_err "${env_file} not found — run from project root"
        return 1
    fi

    # .env.dev uses KEY=VALUE (load_env does `set -a`); .env-style files
    # with `export` prefixes are also accepted.
    for var in "${required_vars[@]}"; do
        if ! grep -qE "^(export[[:space:]]+)?${var}=" "$env_file" 2>/dev/null; then
            missing+=("$var")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        _pf_err "Missing required variables in ${env_file}:"
        for var in "${missing[@]}"; do
            echo "  - ${var}" >&2
        done
        return 1
    fi

    # Warn if MANAGEMENT_DB_URL points to Docker port (5433) in local dev mode
    local db_url
    db_url=$(grep -E "^(export[[:space:]]+)?MANAGEMENT_DB_URL=" "$env_file" 2>/dev/null \
        | sed -E 's/^(export[[:space:]]+)?MANAGEMENT_DB_URL=//' | tr -d '"')
    if echo "$db_url" | grep -q ":5433/" 2>/dev/null; then
        _pf_warn "MANAGEMENT_DB_URL points to port 5433 (Docker external port)."
        _pf_warn "For local dev, it should point to port 5432 (local Postgres)."
    fi

    _pf_log "Environment check (${env_file}): ${_PF_GREEN}OK${_PF_NC}"
    return 0
}

# ── check_postgres_role <container_name> [user] ──────────────────────
# Verifies the app role exists inside the given Postgres container.
# Returns 0 if role exists, 1 if missing, 2 if container not running.
#
# Connects as the app user itself: when POSTGRES_USER != postgres, the
# default superuser role is not created, so `-U postgres` would fail
# on a healthy DB.
check_postgres_role() {
    local container="${1:-synodic-postgres-dev}"
    local user="${2:-${POSTGRES_USER:-synodic}}"

    if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        _pf_warn "Postgres container '${container}' is not running — skipping role check"
        return 2
    fi

    local exists
    exists=$(docker exec "$container" psql -U "$user" -d postgres -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname='${user}'" 2>/dev/null | tr -d '[:space:]')

    if [ "$exists" != "1" ]; then
        _pf_err "Postgres role '${user}' does not exist in ${container} (stale volume?)."
        echo -e "  Fix with: ${_PF_CYAN}./dev.sh repair${_PF_NC}" >&2
        return 1
    fi
    return 0
}

# ── check_postgres_db <container_name> [db_name] ─────────────────────
# Verifies the app database exists inside the given Postgres container.
check_postgres_db() {
    local container="${1:-synodic-postgres-dev}"
    local db="${2:-${POSTGRES_DB:-synodic}}"
    local user="${POSTGRES_USER:-synodic}"

    if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        return 2
    fi

    local exists
    exists=$(docker exec "$container" psql -U "$user" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='${db}'" 2>/dev/null | tr -d '[:space:]')

    if [ "$exists" != "1" ]; then
        _pf_err "Postgres database '${db}' does not exist in ${container}."
        echo -e "  Fix with: ${_PF_CYAN}./dev.sh repair${_PF_NC}" >&2
        return 1
    fi
    return 0
}

# ── list_orphan_containers ───────────────────────────────────────────
# Emits (on stdout) the names of all orphan containers the dev env
# should remove. Two categories:
#
#   app-tier   containers from a previous `docker compose -f
#              docker-compose.yml up` (project `synodic`) — patterns
#              like `synodic-frontend-1`, `synodic-viz-service-1`.
#   infra     containers holding one of the dev-infra hardcoded names
#              (`synodic-postgres-dev`, `synodic-falkordb-dev`,
#              `synodic-redis-dev`) under a compose project label that
#              is NOT `synodic-dev` — i.e. left over from before the
#              compose project was renamed.
#
# Empty output means clean.
list_orphan_containers() {
    docker ps -a --format '{{.Names}}' 2>/dev/null \
        | grep -E '^synodic-(frontend|viz-service|aggregation-(worker|controlplane)|graph-service)-[0-9]+$' \
        || true

    local n proj
    for n in synodic-postgres-dev synodic-falkordb-dev synodic-redis-dev; do
        if docker inspect "$n" >/dev/null 2>&1; then
            proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$n" 2>/dev/null)
            if [ "$proj" != "synodic-dev" ]; then
                echo "$n"
            fi
        fi
    done
}

# ── check_orphan_containers ──────────────────────────────────────────
# Detects orphan containers. Returns 0 if clean, 1 if orphans found.
check_orphan_containers() {
    local orphans
    orphans=$(list_orphan_containers)
    if [ -n "$orphans" ]; then
        _pf_warn "Orphan containers detected:"
        echo "$orphans" | sed 's/^/    /' >&2
        echo -e "  Remove with: ${_PF_CYAN}./dev.sh clean-orphans${_PF_NC}" >&2
        return 1
    fi
    return 0
}

# ── check_env_secrets <env_file> ─────────────────────────────────────
# Scans an env file for REPLACE_ME placeholders. Returns 0 if all set,
# 1 if any placeholder remains. Used by deploy.sh for prod preflight.
check_env_secrets() {
    local env_file="${1:-.env}"
    if [ ! -f "$env_file" ]; then
        _pf_err "${env_file} not found — run 'cp .env.prod.example .env' first"
        return 1
    fi

    local missing
    missing=$(grep -E '^[A-Z_]+=REPLACE_ME' "$env_file" 2>/dev/null | cut -d= -f1 || true)
    if [ -n "$missing" ]; then
        _pf_err "Secrets still unset in ${env_file} (value REPLACE_ME):"
        echo "$missing" | sed 's/^/    /' >&2
        echo -e "  Edit ${env_file} and replace these values before deploying." >&2
        return 1
    fi
    _pf_log "Env secrets check (${env_file}): ${_PF_GREEN}OK${_PF_NC}"
    return 0
}

# ── run_doctor ────────────────────────────────────────────────────────
# Runs all checks without starting anything. Designed to be called from
# dev.sh as `./dev.sh doctor`.
run_doctor() {
    local exit_code=0

    echo -e "${_PF_GREEN}[doctor]${_PF_NC} Checking ports..."
    for port_info in "8000:viz-service" "5173:frontend" "8091:controlplane"; do
        local port="${port_info%%:*}"
        local name="${port_info##*:}"
        if check_port "$port" "$name" 2>/dev/null; then
            echo -e "  ${port}: ${_PF_GREEN}free${_PF_NC}"
        else
            echo -e "  ${port}: ${_PF_RED}occupied${_PF_NC}"
            # Show the occupying process
            local pid
            pid=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
            if [ -n "$pid" ]; then
                local cmd
                cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
                echo -e "    PID ${pid} — ${cmd}"
            fi
            exit_code=1
        fi
    done

    echo ""
    echo -e "${_PF_GREEN}[doctor]${_PF_NC} Checking infrastructure..."
    for svc_info in "localhost:5432:Postgres" "localhost:6380:Redis" "localhost:6379:FalkorDB"; do
        local host="${svc_info%%:*}"
        local rest="${svc_info#*:}"
        local port="${rest%%:*}"
        local name="${rest##*:}"
        if (echo > /dev/tcp/"$host"/"$port") 2>/dev/null; then
            echo -e "  ${name} (${port}): ${_PF_GREEN}healthy${_PF_NC}"
        else
            echo -e "  ${name} (${port}): ${_PF_RED}unreachable${_PF_NC}"
            exit_code=1
        fi
    done

    echo ""
    echo -e "${_PF_GREEN}[doctor]${_PF_NC} Checking .env.dev..."
    if check_env .env.dev; then
        : # already printed OK
    else
        exit_code=1
    fi

    # Check for local Postgres.app conflict
    echo ""
    echo -e "${_PF_GREEN}[doctor]${_PF_NC} Checking local Postgres conflict..."
    local pg_pid
    pg_pid=$(lsof -iTCP:5432 -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -n "$pg_pid" ]; then
        local pg_cmd
        pg_cmd=$(ps -p "$pg_pid" -o comm= 2>/dev/null || echo "unknown")
        if echo "$pg_cmd" | grep -iq "postgres"; then
            # Check if it's the Docker-published port (healthy) or a real
            # local Postgres (conflict). Docker-published ports show up
            # under the docker daemon PID; local ones run as the postgres user.
            local parent_comm
            parent_comm=$(ps -p "$pg_pid" -o ppid= 2>/dev/null | tr -d ' ' || echo "")
            if [ -n "$parent_comm" ] && docker ps --format '{{.Names}}' | grep -q "synodic-postgres-dev"; then
                echo -e "  Port 5432 is bound by Docker Postgres: ${_PF_GREEN}OK${_PF_NC}"
            else
                _pf_warn "Postgres process running on port 5432 (PID ${pg_pid})"
                echo -e "  This may intercept connections meant for Docker."
                echo -e "  Stop it via Postgres.app menu bar or: ${_PF_CYAN}brew services stop postgresql${_PF_NC}"
            fi
        fi
    else
        echo -e "  No local Postgres detected on port 5432: ${_PF_GREEN}OK${_PF_NC}"
    fi

    # Orphan container check
    echo ""
    echo -e "${_PF_GREEN}[doctor]${_PF_NC} Checking orphan containers..."
    if check_orphan_containers 2>/dev/null; then
        echo -e "  No orphan containers: ${_PF_GREEN}OK${_PF_NC}"
    else
        check_orphan_containers   # re-run so output goes to stderr
        exit_code=1
    fi

    # Postgres role + db verification (only if container is up)
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^synodic-postgres-dev$'; then
        echo ""
        echo -e "${_PF_GREEN}[doctor]${_PF_NC} Checking Postgres role + database..."
        if check_postgres_role synodic-postgres-dev "${POSTGRES_USER:-synodic}" 2>/dev/null; then
            echo -e "  Role '${POSTGRES_USER:-synodic}': ${_PF_GREEN}OK${_PF_NC}"
        else
            check_postgres_role synodic-postgres-dev "${POSTGRES_USER:-synodic}"
            exit_code=1
        fi
        if check_postgres_db synodic-postgres-dev "${POSTGRES_DB:-synodic}" 2>/dev/null; then
            echo -e "  Database '${POSTGRES_DB:-synodic}': ${_PF_GREEN}OK${_PF_NC}"
        else
            check_postgres_db synodic-postgres-dev "${POSTGRES_DB:-synodic}"
            exit_code=1
        fi
    fi

    echo ""
    if [ $exit_code -eq 0 ]; then
        echo -e "${_PF_GREEN}[doctor]${_PF_NC} All checks passed"
    else
        _pf_err "Some checks failed — see above"
    fi
    return $exit_code
}

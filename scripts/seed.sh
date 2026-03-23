#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# seed.sh — Quick-start helper for populating Synodic graph databases
# ══════════════════════════════════════════════════════════════════════
#
# Usage:
#   ./backend/scripts/seed.sh                    # defaults: finance + ecommerce, scale=1
#   ./backend/scripts/seed.sh --all              # all scenarios
#   ./backend/scripts/seed.sh --large            # large lineage seeder (100k nodes)
#   ./backend/scripts/seed.sh --neo4j            # seed Neo4j instead of FalkorDB
#   ./backend/scripts/seed.sh --docker           # run via docker-compose seed service
#   ./backend/scripts/seed.sh --wipe             # wipe graph before seeding
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ────────────────────────────────────────────────────────
SCENARIOS="finance,ecommerce"
SCALE=1
BREADTH=1
DEPTH=2
BACKEND="falkordb"        # falkordb | large | neo4j
USE_DOCKER=false
WIPE=false
DRY_RUN=false
PUSH=true

# ── Parse Arguments ─────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)         SCENARIOS="all"; shift ;;
    --scenarios)   SCENARIOS="$2"; shift 2 ;;
    --scale)       SCALE="$2"; shift 2 ;;
    --breadth)     BREADTH="$2"; shift 2 ;;
    --depth)       DEPTH="$2"; shift 2 ;;
    --large)       BACKEND="large"; shift ;;
    --neo4j)       BACKEND="neo4j"; shift ;;
    --docker)      USE_DOCKER=true; shift ;;
    --wipe)        WIPE=true; shift ;;
    --dry-run)     DRY_RUN=true; PUSH=false; shift ;;
    -h|--help)
      head -12 "$0" | tail -9
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ── Docker Mode ─────────────────────────────────────────────────────
if $USE_DOCKER; then
  echo "▸ Running seed via docker-compose..."
  EXTRA_ENV=""
  if $WIPE; then
    EXTRA_ENV="SEED_FORCE=true"
  fi
  cd "$PROJECT_ROOT"
  SEED_SCENARIOS="$SCENARIOS" \
  SEED_SCALE="$SCALE" \
  SEED_BREADTH="$BREADTH" \
  SEED_DEPTH="$DEPTH" \
  $EXTRA_ENV \
  docker compose --profile seed up --build seed
  echo "✓ Docker seed complete."
  exit 0
fi

# ── Local Mode ──────────────────────────────────────────────────────
cd "$PROJECT_ROOT"

# Ensure virtual env / dependencies
if [[ -d ".venv" ]]; then
  source .venv/bin/activate
elif [[ -d "venv" ]]; then
  source venv/bin/activate
fi

echo "▸ Backend: $BACKEND | Scenarios: $SCENARIOS | Scale: $SCALE | Breadth: $BREADTH | Depth: $DEPTH"

case "$BACKEND" in
  falkordb)
    CMD="python backend/scripts/seed_falkordb.py --scenarios $SCENARIOS --scale $SCALE --breadth $BREADTH --depth $DEPTH"
    echo "▸ Running: $CMD"
    eval "$CMD"
    ;;

  large)
    ARGS="--scale $SCALE"
    if $PUSH; then
      ARGS="$ARGS --push-falkordb"
    fi
    if $DRY_RUN; then
      ARGS="$ARGS --dry-run"
    fi
    CMD="python backend/scripts/seed_large_lineage.py $ARGS"
    echo "▸ Running: $CMD"
    eval "$CMD"
    ;;

  neo4j)
    ARGS="--scenarios $SCENARIOS --scale $SCALE --breadth $BREADTH --depth $DEPTH"
    if $WIPE; then
      ARGS="$ARGS --wipe"
    fi
    CMD="python backend/scripts/seed_neo4j.py $ARGS"
    echo "▸ Running: $CMD"
    eval "$CMD"
    ;;

  *)
    echo "Unknown backend: $BACKEND" >&2
    exit 1
    ;;
esac

echo "✓ Seeding complete."

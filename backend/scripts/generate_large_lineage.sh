#!/usr/bin/env bash
#
# ============================================================================
#  Generate a VERY LARGE Solidatus graph with FULL end-to-end column lineage
# ============================================================================
#
# Uses the generator's --realistic mode: data CONCEPTS flow through every layer,
# so every source column traces source->sink across all layers (real end-to-end
# lineage), not the default adjacent-layer random fill. e2e-fraction=1.0 carries
# EVERY concept the whole way, so 100% of columns are end-to-end traceable.
#
# DEFAULT SIZE  (16 layers): ~2.1M nodes, ~5M edges (~7M total elements).
#   Each layer adds ~130k nodes, so node count scales linearly with LAYERS:
#     LAYERS=16 -> ~2.1M nodes   |   LAYERS=24 -> ~3.1M   |   LAYERS=38 -> ~5M
#   Widen instead of deepen by raising ATTRS (columns/concept pool) or OBJECTS.
#
# TIMING / RESOURCES (measured on the dev container):
#   generate:  ~70s for ~2M nodes (held in memory as JSON — a few GB RAM).
#   push:      FalkorDB load is ~24k elements/s, so ~7M elements ~= 5 minutes.
#              The graph occupies real RAM in FalkorDB — use a throwaway name and
#              GRAPH.DELETE it when done. Pushing multi-million graphs into the
#              SHARED dev FalkorDB competes with the running app; consider a
#              dedicated instance for the biggest runs.
#
# USAGE (run inside the dev container so push has FalkorDB + deps):
#   docker exec -w /app synodic-dev-viz-service-1 \
#     bash backend/scripts/generate_large_lineage.sh [GRAPH_NAME]
#
#   - No GRAPH_NAME  -> generate the JSON only (to $OUT), skip the push.
#   - With GRAPH_NAME-> generate, then push into that FalkorDB graph.
#   Tunables (env): LAYERS OBJECTS ATTRS E2E FAN_IN SEED SCHEMA OUT
#     e.g.  LAYERS=38 bash .../generate_large_lineage.sh huge_lineage   # ~5M nodes
# ============================================================================

set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/../.."   # repo root, so `python backend/scripts/...` resolves

LAYERS=${LAYERS:-16}
OBJECTS=${OBJECTS:-200}          # tables per layer
ATTRS=${ATTRS:-650}              # concept pool per layer (columns), NOT capped at 50 in realistic mode
E2E=${E2E:-1.0}                  # fraction of concepts carried source->sink (1.0 = full end-to-end)
FAN_IN=${FAN_IN:-1-2}            # join width on carry targets (adds cross-column lineage)
SEED=${SEED:-1}
SCHEMA=${SCHEMA:-roots_node}     # Roots (layers) + Node (tables/columns), HAS/FLOWS_TO
OUT=${OUT:-/tmp/large_lineage.json}
GRAPH="${1:-}"                   # optional FalkorDB graph name to push into

GEN="python backend/scripts/generate_solidatus_model.py"
IMP="python backend/scripts/import_solidatus.py"

echo "==> Generating: --realistic layers=$LAYERS objects=$OBJECTS attrs=$ATTRS e2e=$E2E fan-in=$FAN_IN"
t0=$(date +%s)
$GEN --realistic \
  --layers "$LAYERS" \
  --min-objects "$OBJECTS" --max-objects "$OBJECTS" \
  --min-attrs "$ATTRS" --max-attrs "$ATTRS" \
  --e2e-fraction "$E2E" --fan-in "$FAN_IN" \
  --seed "$SEED" --stats -o "$OUT"
echo "==> Generated in $(( $(date +%s) - t0 ))s -> $OUT"

if [ -z "$GRAPH" ]; then
  echo "==> No graph name given; skipping push. Convert/inspect with:"
  echo "    $IMP --file $OUT --dry-run --schema $SCHEMA"
  exit 0
fi

echo "==> Pushing into FalkorDB graph '$GRAPH' (schema=$SCHEMA, batch=10000)..."
t1=$(date +%s)
FALKORDB_SAVE_BATCH_SIZE=10000 $IMP --file "$OUT" --schema "$SCHEMA" --graph "$GRAPH"
echo "==> Pushed in $(( $(date +%s) - t1 ))s. Delete when done:  GRAPH.DELETE $GRAPH"

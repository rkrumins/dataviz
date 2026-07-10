#!/usr/bin/env bash
#
# ============================================================================
#  Synthetic data generation — guide & runnable cookbook
# ============================================================================
#
# A guided tour of the Solidatus synthetic-data toolchain: generate a lineage
# graph, optionally convert it to a CUSTOM ontology, and load it into FalkorDB
# — at any size from ~1k to ~5m elements.
#
# THE PIPELINE
#   generate_solidatus_model.py   emits Solidatus JSON {entities, layers, transitions}
#        |
#   import_solidatus.py           (optionally --schema) → GraphNodes/GraphEdges → FalkorDB
#
# THREE MODES (import_solidatus.py)
#   dry-run   --dry-run --schema <s>            parse + print type counts, write nothing
#   push      --schema <s> --graph <name>       convert + push straight to FalkorDB (fast)
#   versioned --schema <s> --versioned ...       register+publish ontology, strict graph, project
#   (omit --schema entirely for the original layer/object/group/attribute + HAS/FLOWS_TO output)
#
# SIZING  (attrs-per-object saturates at 50 — scale with --layers x --max-objects;
#          total elements ~= 2.7 x nodes. Use --depth 3 for a clean L->O->A shape.)
#   ~1k    --layers 2  --max-objects 5      ~10k   --layers 4  --max-objects 25
#   ~100k  --layers 10 --max-objects 100    ~1m    --layers 20 --max-objects 350
#   ~5m    --layers 50 --max-objects 720
#   (each also: --min-objects = --max-objects, --min-attrs 50 --max-attrs 50 --depth 3)
#   Load times after the edge-index fix: 100k ~4s, 1m ~40s. For big loads export
#   FALKORDB_SAVE_BATCH_SIZE=10000.
#
# PRESETS (backend/scripts/schemas/, pass the bare name to --schema)
#   solidatus_default   identity — layer/object/group/attribute + HAS/FLOWS_TO (== legacy)
#   roots_node          Layer->Roots, everything else->Node, Has/Flows_To (emits lowercase 'has')
#   multi_containment   Zone/Asset/Field, two containment types (Groups/Holds) alternated by depth
#   ...or pass a path to your own JSON (see the `custom-schema` example below).
#
# STRUCTURAL EDGE CASES (generator knobs)
#   --depth 2      flat (Layer->Attribute)      --depth 6   deep nesting (extra Group tiers)
#   --orphans K    K uncontained, non-root nodes (top-level/orphan query case)
#
# REALISTIC LINEAGE (--realistic) — coherent, column-level, end-to-end flows.
#   Data CONCEPTS flow through every layer, so columns trace source->sink with semantic
#   correspondence (email->email->...), unlike the default adjacent-layer random fill.
#     --realistic              enable it
#     --e2e-fraction F         fraction of concepts carried source->sink (backbones, default 0.5)
#     --fan-in MIN-MAX         join width on carry targets (e.g. 1-3)
#     --fan-out MIN-MAX        split width on carry sources (e.g. 1-2)
#     --table-lineage          also emit object->object (table-level) edges
#     --transition-density     probability transient (non-backbone) columns get a derived edge
#
# WHERE TO RUN
#   Generation needs only Python stdlib (runs anywhere). Push/versioned modes need
#   the app deps + a live FalkorDB, i.e. the dev container:
#     docker exec -w /app synodic-dev-viz-service-1 bash backend/scripts/synthetic_data_examples.sh <example> [push]
#
# USAGE
#   synthetic_data_examples.sh                 # this guide + the example catalog
#   synthetic_data_examples.sh <example>       # run an example (dry-run: shows counts, writes nothing)
#   synthetic_data_examples.sh <example> push  # actually load into FalkorDB (graph: demo_<example>)
# ============================================================================

set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # absolute path to this script
cd "$(dirname "$SELF")/../.." || exit 1                  # repo root, so `python backend/scripts/...` resolves

GEN="python backend/scripts/generate_solidatus_model.py"
IMP="python backend/scripts/import_solidatus.py"
MODE="${2:-dryrun}"                    # "push" to load into FalkorDB, else dry-run

if [ -t 1 ]; then BOLD=$'\033[1m'; CYAN=$'\033[1;36m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else BOLD=""; CYAN=""; DIM=""; OFF=""; fi

# Echo a command, then run it (pipelines welcome — this is a trusted cookbook).
run() { printf '%s$ %s%s\n' "$CYAN" "$*" "$OFF"; eval "$*"; }
note() { printf '%s# %s%s\n' "$DIM" "$*" "$OFF"; }

# generate|import at a given size. dry-run prints counts; push loads demo_<label>.
size_example() {
  local label=$1 layers=$2 objects=$3 schema=$4
  local gen="$GEN --layers $layers --min-objects $objects --max-objects $objects --min-attrs 50 --max-attrs 50 --depth 3 --seed 1"
  if [ "$MODE" = push ]; then
    note "loading into FalkorDB graph 'demo_$label' (larger batch for throughput)"
    run "FALKORDB_SAVE_BATCH_SIZE=10000 $gen | $IMP --schema $schema --graph demo_$label"
  else
    note "dry-run: shows the converted node/edge counts, writes nothing (add 'push' to load)"
    run "$gen | $IMP --dry-run --schema $schema"
  fi
}

# generate realistic lineage with the given generator flags, then dry-run or push.
realistic_example() {
  local label=$1; shift
  local gen="$GEN --realistic $* --seed 7"
  if [ "$MODE" = push ]; then
    run "FALKORDB_SAVE_BATCH_SIZE=10000 $gen | $IMP --schema roots_node --graph demo_$label"
  else
    run "$gen | $IMP --dry-run --schema roots_node"
  fi
}

catalog() {
  cat <<EOF
${BOLD}Synthetic data generation — examples${OFF}
  run one with:  bash backend/scripts/synthetic_data_examples.sh ${BOLD}<example>${OFF} [push]

${BOLD}Sizes${OFF}         (roots_node ontology; dry-run shows counts, 'push' loads demo_<example>)
  size-1k        ~1,200 elements       size-10k       ~13,000 elements
  size-100k      ~138,000 elements     size-1m        ~980,000 elements
  size-5m        ~5,080,000 elements

${BOLD}Ontologies${OFF}    (~10k each, so they're quick)
  onto-default          layer/object/group/attribute + HAS/FLOWS_TO (identity)
  onto-roots-node       Layer->Roots, else->Node, Has/Flows_To
  onto-multi            Zone/Asset/Field, two containment types (Groups/Holds)

${BOLD}Shapes${OFF}        (structural edge cases)
  shape-flat            --depth 2  (Layer directly contains attributes)
  shape-deep            --depth 6  (extra nested Group tiers)
  shape-orphans         --orphans 5  (uncontained, non-root nodes)

${BOLD}Realistic${OFF}     (coherent end-to-end column lineage; prints an actual source->sink trace)
  realistic-10hop       10 layers, 60% backbone concepts carried source->sink
  realistic-joins       fan-in 1-3, fan-out 1-2 (joins & splits around the backbone)
  realistic-tables      adds object/table-level lineage alongside the column edges

${BOLD}Modes${OFF}
  mode-emit-ontology    write the derived OntologyCreateRequest JSON to stdout
  mode-custom-schema    author a schema on the fly and convert with it
  mode-versioned        (prints the command) full versioned ingest w/ strict enforcement + projection
  mode-legacy           no --schema: the original untouched output
EOF
}

case "${1:-}" in
  ""|list|help|-h|--help)
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$SELF"; echo; catalog ;;

  # ── Sizes ────────────────────────────────────────────────────────────────
  size-1k)    size_example size-1k    2  5   roots_node ;;
  size-10k)   size_example size-10k   4  25  roots_node ;;
  size-100k)  size_example size-100k  10 100 roots_node ;;
  size-1m)    size_example size-1m    20 350 roots_node ;;
  size-5m)    size_example size-5m    50 720 roots_node ;;

  # ── Ontologies (dry-run shows how the same data maps to each vocabulary) ──
  onto-default) note "identity mapping — same as the legacy importer"
                run "$GEN --layers 4 --seed 1 | $IMP --dry-run --schema solidatus_default" ;;
  onto-roots-node) note "Layer->Roots, everything else->Node; note the lowercase 'has' payload"
                run "$GEN --layers 4 --seed 1 | $IMP --dry-run --schema roots_node" ;;
  onto-multi) note "Zone/Asset/Field with two containment types alternated by depth"
                run "$GEN --layers 4 --groups-chance 1.0 --seed 1 | $IMP --dry-run --schema multi_containment" ;;

  # ── Shapes ───────────────────────────────────────────────────────────────
  shape-flat) note "depth 2: layers directly contain attributes (no objects/groups)"
                run "$GEN --layers 3 --max-objects 6 --depth 2 --seed 1 | $IMP --dry-run --schema roots_node" ;;
  shape-deep) note "depth 6: 3 extra nested Group tiers between object and attributes"
                run "$GEN --layers 2 --max-objects 4 --depth 6 --seed 1 | $IMP --dry-run --schema roots_node" ;;
  shape-orphans) note "5 uncontained, non-root nodes (the top-level/orphan query edge case)"
                run "$GEN --layers 3 --orphans 5 --seed 1 | $IMP --dry-run --schema roots_node" ;;

  # ── Realistic lineage (coherent end-to-end column flows) ─────────────────
  realistic-10hop) note "10 layers; 60% of concepts are carried source->sink (real end-to-end traces)"
                realistic_example realistic-10hop --layers 10 --e2e-fraction 0.6 ;;
  realistic-joins) note "joins (fan-in 1-3) and splits (fan-out 1-2) around the backbone"
                realistic_example realistic-joins --layers 8 --fan-in 1-3 --fan-out 1-2 ;;
  realistic-tables) note "column-level lineage PLUS object/table-level rollup edges"
                realistic_example realistic-tables --layers 8 --fan-in 1-2 --table-lineage ;;

  # ── Modes ────────────────────────────────────────────────────────────────
  mode-emit-ontology) note "derive the ontology (entity/relationship defs) from the schema + data"
                run "$GEN --layers 3 --seed 1 | $IMP --dry-run --schema roots_node --emit-ontology /dev/stdout" ;;

  mode-custom-schema)
    note "author your own schema, then convert with it"
    tmp="$(mktemp /tmp/my_schema.XXXX.json)"
    cat > "$tmp" <<'JSON'
{
  "name": "my-vocab",
  "entityTypes": { "layer": "System", "object": "Dataset", "group": "Dataset", "attribute": "Column" },
  "edgeTypes":   { "containment": ["CONTAINS"], "lineage": ["DERIVES_FROM"] },
  "emit":        {}
}
JSON
    note "wrote schema to $tmp:"; sed 's/^/    /' "$tmp"
    run "$GEN --layers 3 --seed 1 | $IMP --dry-run --schema $tmp"
    rm -f "$tmp" ;;

  mode-versioned)
    note "full versioned ingest — registers+publishes the derived ontology, provisions a"
    note "strict graph, canonicalizes, bulk-ingests, and projects. Needs a workspace + FalkorDB"
    note "provider id (find them in the app / DB). Shown here, not auto-run:"
    printf '%s$ %s%s\n' "$CYAN" \
      "$GEN --layers 3 --seed 1 | $IMP --schema roots_node --versioned --graph my_versioned --workspace-id <WS> --provider-id <PROVIDER>" "$OFF" ;;

  mode-legacy) note "no --schema: the original layer/object/group/attribute + HAS/FLOWS_TO output"
                run "$GEN --layers 4 --seed 1 | $IMP --dry-run" ;;

  *) printf 'Unknown example: %s\n\n' "$1"; catalog; exit 1 ;;
esac

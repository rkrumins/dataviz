# Property storage: the bag leaves the schema

**Status:** decided 2026-09-14; phase 1 in progress on `claude/falkordb-resilience-eval-itgtwx`.
**Supersedes:** the native property budget (`FALKORDB_NATIVE_PROPERTY_BUDGET`) and the
attribute pre-flight's role as the line of defence. Both stay until phase 1 lands and
phase 5 retires them.

## The problem, stated exactly

FalkorDB numbers every distinct property name in a graph with a 16-bit id
(`typedef uint16_t AttributeID`; two values reserved; ids 0..65,533 usable).
`GraphContext_FindOrAddAttribute` refuses the 65,535th name with *"Max number of
attributes exceeded, graph does not support more than N unique attribute names"*.
Ids are never freed: `GraphContext_RemoveAttribute` runs only from undo-log rollback,
deleting entities or rollup edges touches nothing, and only `GRAPH.DELETE` discards
the map (`graphcontext.c`; upstream #336 open since 2023, the Rust engine keeps the
same cap). Property names are **schema** in FalkorDB's design.

Our writers made property names **data**. Since commit `3793106b` (2026-05-17,
"store node properties as native fields instead of JSON blob") every distinct key in a
node's user `properties` dict became a native attribute (`SET n += item.nativeProps` in
`save_custom_graph`, `create_node` and the versioning projector). Our ingest manufactures
no keys: it passes the source's keys through verbatim (no flattening, prefixing or casing
variants anywhere in the tree). A 241k-node source whose records carry ~65,000 distinct
keys therefore registered ~65,000 names, and its rollups could no longer be written or
indexed. Sources of a million nodes are coming.

So the limit is FalkorDB's, the exposure to it is ours, and the key population is the
source's. A budget on how many keys become schema fences the problem; it does not remove
it, and it makes which keys are searchable an accident of ingestion order.

The one diagnostic that shows what spent a graph's ids, on the shard that owns it:

```
GRAPH.RO_QUERY <graph> "CALL db.propertyKeys() YIELD propertyKey
  RETURN count(*) AS names,
    sum(CASE WHEN propertyKey =~ '.*[0-9]{4,}.*' THEN 1 ELSE 0 END) AS digitRun4,
    sum(CASE WHEN propertyKey =~ '.*[0-9a-f]{8}-[0-9a-f]{4}-.*' THEN 1 ELSE 0 END) AS uuidLike,
    sum(CASE WHEN propertyKey =~ '.*(19|20)[0-9]{2}[-_/.]?[0-9]{2}[-_/.]?[0-9]{2}.*' THEN 1 ELSE 0 END) AS dateLike,
    sum(CASE WHEN propertyKey CONTAINS '.' THEN 1 ELSE 0 END) AS dotted,
    sum(CASE WHEN propertyKey CONTAINS '/' THEN 1 ELSE 0 END) AS slashed,
    sum(CASE WHEN propertyKey CONTAINS '=' OR propertyKey CONTAINS ':' THEN 1 ELSE 0 END) AS tagValue,
    sum(CASE WHEN propertyKey CONTAINS ' ' THEN 1 ELSE 0 END) AS hasSpace,
    sum(CASE WHEN propertyKey <> toLower(propertyKey) THEN 1 ELSE 0 END) AS mixedCase"
```

## What must survive, for any key on any source size

1. The Properties panel shows it.
2. Advanced-search predicates on it: equals, contains, starts/ends with, exists, numeric
   and string ranges, IN, between, negation, under AND/OR/NOT.
3. Sort and projection by it.
4. Distinct values and key discovery (Property Manager, omnibox).
5. Display rules and saved searches on it (both replay predicates through the same search).
6. Hot keys can be indexed for seek speed.
7. Aggregation, profiling, tracing, canvas views and the projector never count or traverse
   anything the design adds.
8. Existing graphs, including one at the ceiling, have a migration path.
9. Direct-load (external) and versioned graphs behave the same.

## The architectures weighed

A grounded panel (three mappers over readers, writers and the FalkorDB source; four
architects; three judges; one synthesis) weighed four designs against those nine
requirements at 1M nodes × 200 properties × 100k distinct keys:

| | Removes the ceiling | Keeps every capability | Cost at 1M nodes | Migration of a graph at the ceiling |
|---|---|---|---|---|
| **D** Declared fields + a flat key/value array carrier | for data, yes; declared set is human-bounded | yes, but every long-tail predicate is an O(N×K) array scan, 3-10 s at 1M | 20-27 GB FalkorDB | none: the carrier itself needs a fresh name |
| **E** Postgres side index (JSONB + GIN), predicates → URN sets → per-label seeks | yes: ~25 names regardless of data | yes; single-plan composition for long-tail keys is lost | 8-10 GB FalkorDB, 8-13 GB Postgres | in place, zero graph writes |
| **F** EAV tier in the graph: `(n)-[:_HAS {v}]->(:_Key)` | yes: labels and types have their own id spaces | mostly; non-equality ops under OR/NOT rest on an unverified pattern shape | 30-50 GB FalkorDB, 5-8× slower loads, 15+ exclusion sites | recreate only |
| **H** One map property, `n.bag[$k]` | — | — | — | not buildable: `SI_VALID_PROPERTY_VALUE` excludes maps (`value.h`), CREATE/SET reject them, the RDB encoder asserts, PR #658 closed unmerged |

Two judges chose E; the third chose an E/D hybrid whose two ideas (an optional declared
native tier as an accelerator, and a zero-write migration) are folded in. The result is
**E+**.

## E+ in one paragraph

The graph keeps topology and a **constant** set of attribute names: the platform's
reserved node keys, the source's identity and name properties plus the `name`/`title`/
`label` fallbacks the read path checks natively, the rollup and run-meta names, and the
edge trio. The **complete** user bag of every node is written to Postgres
(`propidx.node_props`, one LIST partition per physical graph, an expression GIN over a
case-folded copy) and, unchanged in shape, to `n.propertiesRaw` as the display copy the
read path already merges. Every predicate, sort, distinct, aggregation-by-property and key
discovery on any key is answered in Postgres and enters FalkorDB as a per-label URN index
seek. No cap, budget, pre-flight or declaration decides what is stored or searchable.
The invariant, pinned by a test that loads a million nodes carrying 100k distinct keys:
`CALL db.propertyKeys()` grows by exactly zero beyond the reserve.

## Storage layout

**FalkorDB, per user node** (carriers unchanged, contents re-partitioned):

- native attributes = platform ∪ reserve (∪ declared-and-backfilled, phase 3);
- `n.propertiesRaw` = JSON of the full sanitised user bag (reserved-key collisions dropped
  with today's warning, `None` dropped, nested values kept);
- `n.searchableText` computed from the full bag, not from native values only, under the
  existing 8,192-byte cap;
- edges unchanged: `r.properties` stays one JSON string and registers nothing;
- **marker**: one node `(:_PropIdx)` with a label and no properties. Labels live in their
  own id space, so it costs no attribute id, lands on a graph at the ceiling, and is wiped
  by `GRAPH.DELETE` exactly when the physical layout is gone. `_PropIdx` joins
  `DERIVED_LABELS` — the only exclusion-list change in the design.

**Postgres schema `propidx`** (alembic revision, guarded like its siblings):

```sql
CREATE SCHEMA IF NOT EXISTS propidx;
CREATE FUNCTION propidx.ci(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v)='string'
                                           THEN to_jsonb(lower(v #>> '{}')) ELSE v END), '{}'::jsonb)
  FROM jsonb_each(p) AS e(k, v) $$;
CREATE TABLE propidx.node_props (
  graph_key    text NOT NULL,   -- physical graph: host:port:graph_name, the provider's _cache_ns identity
  urn          text NOT NULL,
  entity_type  text NOT NULL,   -- sanitised physical label, as written: per-label anchor buckets come free
  props        jsonb NOT NULL,  -- the complete user bag
  tags         jsonb NOT NULL DEFAULT '[]',
  content_hash text NOT NULL,   -- canonical-JSON digest: a re-upsert of the same bag is a no-op
  load_epoch   bigint NOT NULL, -- writer epoch: rows older than the graph's epoch are stale after a full seed
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_key, urn)
) PARTITION BY LIST (graph_key);
CREATE INDEX ix_np_ci_gin ON propidx.node_props USING gin ((propidx.ci(props)) jsonb_ops);
CREATE INDEX ix_np_type  ON propidx.node_props (graph_key, lower(entity_type));
CREATE INDEX ix_np_epoch ON propidx.node_props (graph_key, load_epoch);
CREATE TABLE propidx.prop_keys (graph_key text, entity_type text, key text, node_count bigint DEFAULT 0,
  kinds text[] DEFAULT '{}', samples jsonb DEFAULT '[]', refreshed_at timestamptz,
  PRIMARY KEY (graph_key, entity_type, key));
CREATE INDEX ix_pk_prefix ON propidx.prop_keys (graph_key, key text_pattern_ops);
CREATE TABLE propidx.graph_state (
  graph_key text PRIMARY KEY,
  storage_version smallint NOT NULL CHECK (storage_version IN (1, 2)),  -- 1 legacy, 2 side index
  status text NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  load_epoch bigint NOT NULL DEFAULT 0,
  declared_ready jsonb NOT NULL DEFAULT '[]',
  row_count bigint, progress jsonb, last_built_at timestamptz, last_verified_at timestamptz,
  last_error text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE propidx.hot_indexes (graph_key text, key text, kind text CHECK (kind IN ('text','numeric','trgm')),
  index_name text NOT NULL, status text NOT NULL, created_at timestamptz DEFAULT now(),
  PRIMARY KEY (graph_key, key, kind));
```

Partitions are created lazily per physical graph by the writers, as the versioning schema
creates its hash partitions programmatically. Hot-key promotion is a Postgres expression
index on the partition (`text_pattern_ops` for equality and prefix, a numeric partial for
ranges, `pg_trgm` for contains), created `CONCURRENTLY`, droppable, spending no attribute
id.

Why not a GIN over `node_versions.payload`: it is append-only history across 64 hash
partitions, every predicate would join three ways through `entity_heads`, and direct
loads have no row there at all. The projector already materialises heads; it materialises
this table too, and a direct load gets the identical row shape. That is requirement 9 by
construction.

## Write path

`_split_user_properties(props, native_keys)` returns the reserve-only native dict and the
full-bag JSON. One `PostgresPropertyIndex(graph_key, session_factory)` serves both writers:
`ensure_partition`, `upsert_rows(rows, epoch)` (an `unnest` upsert that skips rows whose
`content_hash` and epoch are unchanged), `upsert_keys`, `delete_urns`, `sweep_epoch`,
`wipe`, `get_state`/`set_state`, `begin_load`/`end_load`, and the read helpers below.
Every statement runs under `SET LOCAL statement_timeout` set to the caller's remaining
budget; request-path reads use the `GRAPH_READ` pool role, jobs and the projector `JOBS`.

**Ordering contract: Postgres first, graph second.** A FalkorDB failure raises as today and
leaves Postgres ahead, which is harmless (an anchor URN with no node seeks nothing; the
next load overwrites). Postgres must never be behind on an upsert. A v2 writer that cannot
reach Postgres refuses the write rather than produce a search-blind graph. Upsert semantics
become replace-on-upsert on both sides: the bag written is the bag stored.

- `save_custom_graph`: `MERGE (m:_PropIdx)` once per provider instance on an empty or
  already-marked graph (a non-empty unmarked graph is legacy and refused until migrated);
  `ensure_partition` once; rows upserted in the save batch size; then the existing per-label
  `UNWIND … MERGE (n:{label} {urn}) SET … n.propertiesRaw … n.searchableText … n += item.nativeProps`
  unchanged in text; edges as today.
- `create_node`: the same split, one-row upsert, then the existing `SET n += $p`.
- Versioning projector: `_apply` upserts rows per label chunk before the MERGE loop and
  deletes URNs after the node-delete batches. A full seed picks `epoch = to_seq` **before**
  `client.delete()`, calls `begin_load(epoch)`, and sweeps `load_epoch < epoch` **before**
  `_verify_and_heal`, so the side table equals committed main exactly when the watermark
  publishes. `_verify_and_heal` gains a third, advisory count that re-upserts missing heads
  and never pins the watermark. The projector's reserve becomes the provider's, including
  the source's identity and name property.
- Direct-load scripts: `GRAPH.DELETE` becomes `provider.recreate_graph()` (delete, wipe the
  partition, next epoch, status building) and the post-load signal calls
  `provider.end_load()` (sweep, refresh keys, ready) before `signal_data_changed`.
- A fresh graph with no state row is stamped `(2, 'ready')` by its first successful writer.

## Routing

Routing truth is `propidx.graph_state`; physical truth is the `(:_PropIdx)` node. The
provider reports v2 iff the row says `(2, 'ready')` **and** `MATCH (m:_PropIdx) RETURN 1
LIMIT 1` finds the marker, cached for 60 s and invalidated by the hooks that already
invalidate per-graph state. Row 2 with no marker means the graph was dropped and rebuilt
out of band: readers fall back to v1 compilation, warn, and the drift sweep flags it;
writers on an empty unmarked graph create the marker and stamp v2. Version 1 or status
`building` means the compiler and writers behave byte-for-byte as today.

## Read path, per capability

1. **Properties panel** — unchanged. `_node_from_props` merges non-reserved native keys
   with `propertiesRaw`, which now holds the full bag; the 22 call sites behind it are
   untouched.
2. **Predicates on any key** — a planner pre-pass runs after `compile()` in both
   `execute_deep_search` and `explain_deep_search` (which becomes async). It partitions the
   predicate tree into P-nodes (property, has-property and text-on-property leaves on keys
   not declared-ready, with maximal all-P subtrees collapsed) and G-leaves (everything
   else, compiled exactly as today). Each P-node compiles to null-propagating SQL so that
   SQL's three-valued logic reproduces Cypher's (a missing key is NULL and excluded; `NOT
   NULL` stays NULL): case-insensitive equality on the case-folded copy, exact and
   non-string equality on the raw value, ranges with a `jsonb_typeof` guard for numbers and
   `COLLATE "C"` for strings (FalkorDB's byte order), contains/starts/ends as escaped
   `ILIKE`, IN as `= ANY`, has-property as `props ? key`, plus `nec(P)`, the GIN-servable
   condition each node implies by polarity. Scope pushes down (`entity_type`, the visible
   URN set). The **anchor** is the smallest positive-polarity top-level-AND P-node with at
   most `DEEP_SEARCH_PG_ANCHOR_MAX` rows (50,000; a plan threshold, never an answer
   threshold); its URNs replace the bare `MATCH (n)` with the shape the provider already
   trusts:

   ```
   CALL { MATCH (n:dataset) WHERE n.urn IN $p3_dataset RETURN n
          UNION MATCH (n:column) WHERE n.urn IN $p3_column RETURN n }
   WITH n WHERE <G-fragment> <scope continuation> <withinHops continuation>
   ```

   (an unlabelled `n.urn IN $list` is a full scan; per label it is an index seek). Every
   other P-node is a post-filter: the scan projects one boolean per G-leaf that shares an
   OR/NOT with it, candidate URNs go to Postgres in 10k chunks, Python evaluates the
   original tree per row. Counts are exact in anchor mode and when the whole tree is pure
   property under a data-source-wide scope; otherwise today's capped "N+".
3. **Sort and projection** — `fetch_values(candidate_urns, keys)` fills the candidate rows
   by primary-key lookup; ranking and hydration are unchanged.
4. **Distinct and discovery** — `SELECT DISTINCT props->>$k` parameterised (the
   `[A-Za-z0-9_]` sanitiser that silently queried `n.AssetOwner` for "Asset Owner" goes);
   discovery reads `prop_keys` exactly, with samples, a `storage` field and a typeahead
   endpoint so a 100k-key source is browsable.
5. **Display rules and saved searches** — unchanged; they replay through the same search.
6. **Hot keys** — a Postgres expression index per (graph, key); phase 3 adds the FalkorDB
   native accelerator for ontology-declared fields under a label-anchored scan.
7. **Aggregation, profiling, tracing, canvas, projector** — nothing new exists in the graph
   but the property-less marker. Aggregations by property run over post-filter survivors
   in Postgres, exact and uncapped on a data-source-wide scope.
8. **"Search everything"** — `searchableText` now carries the long tail within its cap;
   phase 2 adds a per-label FULLTEXT index and a hoisted `match='fulltext'` leaf.

## Exclusion hooks

`_PropIdx` → `DERIVED_LABELS`, which covers every `is_derived_label` and
`not_derived_clause` consumer. Two sites that miss derived labels today (`_AggMeta`
included) are fixed with it: `get_distinct_values('entityType')` and discovery's
`CALL db.labels()` loop. The marker has no `urn`, so identity-keyed scans skip it by
construction. No relationship type and no attribute name is added, so every literal
`AGGREGATED` filter and every untyped traversal stays as it is. Off graph: the purge
worker and the data-source delete path drop the graph's partition and state row; the
projector's full seed wipes and sweeps; the phase-3 drift sweep treats `propidx` as a
cache of the graph, never a source of truth.

## Migration of existing graphs (phase 4)

Per physical graph, idempotent and restart-safe, with a cursor per label:

- **Mode A — zero-write flip.** The default, and the only mode for a graph at the ceiling.
  Read every node per label by URN keyset, `_node_from_props` (native ∪ blob, exactly what
  the panel shows), upsert with the current epoch, build the GIN after the rows, verify the
  count and 2,000 random URNs field by field, `MERGE (m:_PropIdx)` (a label needs no id),
  flip to `(2, 'ready')`. Rollback is `set_state(1, 'ready')`, which never touches FalkorDB.
  Residue: stale native user columns remain, inert; `searchableText` stays native-only.
- **Mode B — full backfill** of `propertiesRaw` and `searchableText`, names every current
  graph already has, so it works at the ceiling too.
- **Mode C — recreate.** The only thing that frees ids: `GRAPH.DELETE`. Versioned sources
  through the projection rebuild; direct loads through `recreate_graph()` and the loader.

Fleet order: fresh graphs need nothing; then Mode A smallest-first, one graph per FalkorDB
instance at a time; the 241k-node source gets Mode A immediately (every one of its 65k keys
searchable within the hour), then Mode C at a maintenance window so its rollups and the
`_AggMeta` stamp land again with ~65k room.

## Cost model at 1M nodes × 200 properties × 100k distinct keys

Derived from the verified engine layouts, not measured. FalkorDB: ~25 attribute names;
~255 B per node of attribute set; `propertiesRaw` ~8 KB per node; net 8-10 GB, the same
order as 200 native attributes, no sparse-matrix growth (F: 30-50 GB; D: 20-27 GB).
Postgres per source: heap ~10 GB raw, 5-7 GB after TOAST/lz4; GIN 2-4 GB; 2-4 GB of cache
for good latency. Writes: 5-15k rows/s per connection, the same order as the UNWIND MERGE,
so a 1M-node load gains 2-4 min. Queries, warm: selective equality 1-30 ms in the GIN plus
0.3-0.8 s of per-label seeks for a 50k set; a has-property on a 900k-node key 0.3-1 s as a
post-filter; contains on a common unindexed key 1-3 s (10-100 ms with a trigram hot index);
distinct ms to 1 s; discovery tens of ms.

## What is honestly lost

- Single-plan composition for undeclared keys: a long-tail predicate enters the graph as an
  anchor set or a post-filter, not as a WHERE conjunct beside `degree`/`withinHops`/
  `descendantOf` (those still compose against the anchor). Declared-ready keys keep it.
- Broad predicates (past the anchor threshold, or under OR/NOT) under a containment scope
  degrade to a post-filter over the capped superset and read "N+". Remedies: raise the
  candidate cap, declare the key, or the phase-2 union of anchors.
- Postgres becomes a hard dependency for undeclared-key predicates and for every v2 write.
  Structural and declared-key queries, hydration and the Properties panel never touch it.
- Replace-on-upsert replaces merge-on-upsert for user keys; direct provider callers that
  send partial bags must be audited before phase 1 ships.
- Two copies of the bag (three for versioned sources), with an ordering contract, an
  advisory verify count and a mandatory drift sweep.
- Mode-A graphs keep inert stale columns and no long-tail "search everything" until Mode B
  or a recreate; their ids are reclaimed only by Mode C.
- `searchableText` stays capped at 8,192 bytes.
- The declared accelerator tier is still bounded by the name table and pre-flighted; a
  schema declaring tens of thousands of native fields is a schema-authoring error the UI
  reports.
- `explain_deep_search` becomes async and truncates URN arrays.

## Phases

1. **Remove the ceiling for new ingests on both writers.** Schema and revision;
   `PostgresPropertyIndex`; the budget deleted; both writers and the projector on the
   ordering contract with the marker; loader scripts on `recreate_graph()`/`end_load()`;
   `_PropIdx` in `DERIVED_LABELS`; the planner pre-pass, compiler routing, anchor and
   post-filter execution, sort fetch, async explain, Postgres distinct and discovery.
   Exit: the propertyKeys invariant on a live 1M-node load; the three-valued-logic parity
   table per operator on live FalkorDB (v1) and Postgres (v2); identical hit sets on every
   existing advanced-search test on a v2 graph; provider/projector parity for the same
   payloads.
2. **Product surfaces and the search grafts**: key typeahead, hot-key indexing, exact
   data-source-wide insights, union of anchors, the label-union candidate scan so platform
   indexes serve deep search, full-text "mentions X", dotted-path leaves, per-type edge
   counts replacing the literal `AGGREGATED` scans.
3. **Consistency operations and the declared accelerator**: drift sweep, partition drop on
   purge and delete, metrics, GIN runbook; `FieldSchema.native/indexed`, the backfill job,
   `declared_ready` routing, native indexes for declared fields.
4. **Fleet migration** with Modes A, B and C and a control-plane job kind.
5. **Retire v1**: delete the native-column compile branch for undeclared keys, the sampling
   discovery, the storage-version switch and the legacy-writer refusal.

## What the operator should stop believing, and do now

- Purge, `DETACH DELETE`, `REMOVE n.<key>`, the blob migration script or a lower budget give
  no ids back. Only `GRAPH.DELETE` does.
- The budget is a knob, not a fix: every key past it is invisible to predicates, sort,
  distinct, discovery and "search everything" while the panel still shows it. Leave it at
  its default (50,000) until phase 1 deletes it. It no longer protects the PLATFORM:
  both writers now register every platform-owned property name on a graph before their
  first data write, by stamping them onto one `(:_PropReserve)` node and deleting it
  again (`reserve_platform_property_names`). Names are never freed, so that reservation
  is permanent; its only remaining job is to keep a graph off the ceiling, where the
  store refuses every further new name — no rollup write, no index — and the graph can
  only be recreated. A registered name that appears on few nodes costs almost nothing
  — an entity's attribute set is sized by the attributes PRESENT on it — so what a
  demoted key costs is searchability, not memory, and a generous budget is the safer one.
- FalkorDB indexes on user keys were never serving deep search: the candidate scan is a
  bare `MATCH (n)` the planner never rewrites to an index scan.
- The graph at the ceiling does not have to be dropped for search to come back: Mode A
  restores all of its keys with zero graph writes. The recreate is only for rollups.
- No engine change is coming: maps cannot be stored, and the cap is the same in the Rust
  engine.

The budget is fleet-wide through `FALKORDB_NATIVE_PROPERTY_BUDGET` and can be
raised for one graph store by putting `nativePropertyBudget` on the PROVIDER's
config. It is deliberately not settable per data source: every name the budget
admits is permanent, so a budget set too low leaves that graph's keys
unsearchable for good, which makes it a graph-store capacity decision at the
privilege level that owns the store. Both merge paths drop a data source's
attempt to set it, exactly as they drop `cacheConnection`.

Before phase 1 ships: leave the 241k-node graph as it is; do not reload it under today's
writer and do not run the blob migration script on it. Prepare 8-13 GB of Postgres disk
and 2-4 GB of cache per 1M-node source, `pg_trgm`, and `maintenance_work_mem` of at least
1 GB for the migration's GIN builds.

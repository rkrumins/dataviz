# PR 1 of 3 — FalkorDB provider decoupling: package split + executor/dialect seams

Read-only analysis of `backend/app/providers/falkordb_provider.py` at HEAD `feature/connections-panel` (providers dir identical to `main`; 20 commits ahead elsewhere). Every number below was measured with an AST pass or grep on 2026-08-30; line numbers refer to the current file.

**Scope of PR 1 (what the user asked for, verbatim goal):** "build it strategically … refactored provider (FalkorDB one) and decouple it where it makes sense." PR 1 = (a) split the 11,333-line module into a package by functional area, (b) introduce the `CypherExecutor` + `CypherDialect` seams inside the FalkorDB provider so its dialect-neutral algorithms can become the shared `CypherGraphProvider` base in PR 3 (FalkorDB client #1, ArcadeDB client #2, Neo4j Bolt later), (c) move genuinely provider-agnostic helpers into `backend/common/providers/`, (d) preserve behaviour byte-for-byte, gated by the contract snapshot + the unit suite + a new Cypher-text golden.

**Not in PR 1:** repointing the 9 outside importers of private names (PR 2), moving `CursorMismatchError` into `backend/common/interfaces/provider.py` (PR 2), lifting any algorithm into a shared base (PR 3), touching `falkordb_deep_search.py` / `falkordb_materialize.py` / `falkordb_connection.py` bodies (only 3 import lines — see §5 step 10), Neo4j's duplicate helpers (follow-up).

---

## 0. Measured facts (corrections to the brief where they differ)

| Fact | Measured | Where |
|---|---|---|
| File / class | 11,333 lines; `class FalkorDBProvider(GraphDataProvider)` L804–11333; **163 methods** (matches brief) | AST |
| `__init__` | L811–1065 (255 lines) assigns **44** instance attributes | AST |
| Late-assigned attributes | **19** attributes are assigned *only* outside `__init__` (brief said 21): `_redis` (1404, 11331), `_reconcile_started` (1554), `_reconcile_task` (1571), `_indexed_entity_type_ids` (2236), `_resolved_containment_types`/`_set` (2340/2341), `_entity_type_levels` (2360), `_resolved_edge_metadata`/`_resolved_lineage_types`/`_resolved_edge_metadata_set` (2572–2574), `_source_rel_aliases`/`_source_entity_aliases` (2591/2593), `_node_identity_property`/`_name_property` (2617/2620), `_agg_meta_cached` (2877, 5639, 5774), `_regime_probe_cached` (2949), `_observed_rel_types` (10481), `_casing_maps_cache` (10834), `_save_indices_ensured` (10976) | AST |
| Class-level constants | `_TRANSIENT_REDIS_EXC`/`_LOADING_REDIS_EXC` are **module**-level (L301/313, inside try blocks); class-level: `_READ_TIMEOUT`/`_WRITE_TIMEOUT`/`_EDGES_BETWEEN_TIMEOUT` (L1584–1586, computed in the class body from `from ..config import resilience as _resilience` + `del _resilience` L1583/1587), `TRACE_DEGREE_CAP` (2390, annotated), `_MERGE_SUB_BATCH_*` (4627–4632), `_BULK_CREATE_BATCH_SIZE`/`_BULK_WIPE_BATCH_SIZE` (4641/4642), `_SCHEMA_CACHE_TTL` (10123), `_TYPE_CASING_TTL_S` (10806) | grep |
| Query chokepoints | in-class call sites: `_ro_query` 57, `_ro_query_tolerant` 5, `_query` 7, `_proj_ro_query` 8, `_proj_query` 10 = **87**; satellites: `falkordb_materialize.py` 19, `falkordb_deep_search.py` 13 → **119 total** (brief said 102) | grep |
| Direct driver-handle bypasses (must be folded into the executor eventually, untouched in PR 1) | `self._graph.ro_query` L1518 (seed count); `self._graph.query` L2261 (ensure_indices DDL), L2421 (`_check_levels_backfilled`); `self._proj.ro_query` L4235 (`CALL db.indexes()`), 4939, 4993, 5026 (label warmup); `self._proj.query` L4905 (per-label index); `self._db.execute_command` L1899 (`EXISTS`), L11268 (`GRAPH.LIST`) | grep |
| Lazy imports inside the file | **55** in-function import sites (brief said 43): 13 → `falkordb_connection`, 11 → `..config.resilience` (relative!), 5 → `backend.common.adapters`, 3 → `.falkordb_deep_search` (relative), 1 → `falkordb_materialize`, 2 → `index_policy`, 1 → `.manager` (L460, relative), 1 → `backend.app.services.deep_search` (L513, inside `_compute_searchable_text`), 2 → `services.ontology_levels`, 1 → `services.node_identity`, 2 → `services.aggregation.cancel`, 1 → `common.providers.pair_rules` (L5263), 1 → `fastapi` (L5881), rest stdlib | AST |
| Module-level imports that are *relative* | L33 `from ..models.graph import …` (a re-export of `backend.common.models.graph`), L45 `from .base import GraphDataProvider` | read |
| Module mutable state | `_UNLABELED_URN_UNSUPPORTED` L54, `_INDEX_HEALTH_LOGGED` L55 (read/written only at 4197–4212), `_BULK_CREATE_KNOBS_CACHE` L80 (tests call `fp._BULK_CREATE_KNOBS_CACHE.clear()` — `test_falkordb_empty_graph.py:280,293,297,305`), `_logged_legacy_blob` L562 (`global` at 684), `_RESERVED_NODE_KEYS` L537 (frozenset; imported by `falkordb_deep_search.py:66`) | grep |
| Kernel usage today | FalkorDB uses only `backend.common.providers.pair_rules` (L5263); `falkordb_materialize.py:88-91` uses `identity` + `pair_rules`; Spanner uses ancestor_cache/config/deadlines/schema_introspection/trace_orchestrator; Neo4j none, and re-implements `_sanitize_label`/`_node_from_props`/`_edge_from_row` at `neo4j_provider.py:50–90` | grep |
| Contract snapshot | `backend/tests/regression/snapshots/falkordb/*.json` — **15 files, last written 2026-05-10 (commit 4275eefc)**; `_runner.py` last changed 2026-05-09. The provider has since changed searchable text, identity, `childCount` counting, trace… → the stored baseline is almost certainly stale. Step 0 must re-baseline on HEAD **before** any move. | git log |
| A pre-existing failing assertion | `test_trace_v2_invalidation.py:595-596` reads `FalkorDBProvider._ANCESTOR_CACHE_TTL_S`, which does not exist (the TTL is the method `_ancestor_cache_ttl()` L4517, env `FALKORDB_ANCESTOR_CACHE_TTL_S`) — record it in the step-0 failure ledger, do not "fix" it in this PR | grep |
| Unmerged provider commits elsewhere | only `origin/claude/contextviewcanvas-search-upgrade-nxrhct` (654c888d "find-in-view returned zero…", 979e2e26 "Names chip"); `feature/uplift-of-search` has no provider-dir delta vs `main`; the `backup/native-canvas-trace-*` branches are backups of landed work | git |

---

## 1. Verified section map (file:line provenance for the package split)

Pre-class module (L1–801): `AggRunMeta` 17–31 · `_UNLABELED_URN_UNSUPPORTED`/`_INDEX_HEALTH_LOGGED` 54–55 · `AggregationBatchAbort` 58–64 · `_completed` 67–70 · bulk-create knobs 73–133 (`_resolve_bulk_create_knobs` 83, `_BULK_CREATE_KNOBS_CACHE` 80) · `_sanitize_label` 136–138 · `_CURSOR_PREFIX` 158 · `CLOSURE_*` constants 166–179 · keyset cursors 182–255 (`CursorMismatchError` 182, `_validate_sort_direction` 188, `_encode_keyset_cursor` 195, `_decode_keyset_cursor` 205, `_keyset_sort_key` 233, `_keyset_sort` 239) · error classifiers 262–410 (`_CLUSTER_REDIRECT_EXC_NAMES` 262, `_is_cluster_redirect` 268, `_CLUSTER_ROUTING_EXC_NAMES` 283, `_TRANSIENT_RETRY_BACKOFFS` 290, optional-import try blocks 296–315, `_is_cluster_routing_error` 318, `_is_transient_connection_error` 331 (lazy-imports `is_auth_error` from `falkordb_connection` at 345), `_is_null_handle_error` 359, `_is_missing_graph_error` 371, `_is_loading_error` 393) · `_EmptyResult` 413–416 · host resolution 419–463 (`_normalize_falkordb_host` 419, `resolve_falkordb_target` 448, lazy `.manager` import at 460) · row↔model 466–760 (`_compute_searchable_text` 466 [lazy app import at 513], `_RESERVED_NODE_KEYS` 537, `_logged_legacy_blob` 562, `_split_user_properties` 565, `_sanitize_node_properties` 612, `_node_from_props` 633, `_edge_from_row` 750) · `_ClosureWalk` 763–801.

Class areas (method line ranges from the AST): B connection L811–2077 · C seeding/indices/identity 2079–2313 · D ontology injection 2316–2767 · E cache namespace + agg meta 2772–2992 · F node/edge reads 2994–3328 + G deep-search shims 3330–3356 + `get_edges` 3358–3460 · H browse 3462–4038 · I simple lineage 4040–4158 · J projections 4165–4344 + ancestor cache 4346–4611 · K aggregation 4627–6593 · L trace 6595–8619 · M closure engine 8639–9370 · N drill/set helpers 9372–10036 · O `get_nodes_batch` 10038–10117 · P stats/schema 10123–10673 · Q navigation 10675–10801 · R casing + writes 10806–11233 · S `list_graphs` 11239, `close` 11273.

All brief citations checked out except the counts corrected in §0.

---

## 2. Target package layout and composition mechanism

### 2.1 Layout

```
backend/app/providers/falkordb/
  __init__.py        assembles + exports FalkorDBProvider and the public names (no satellite imports at module level)
  provider.py        class FalkorDBProvider(<15 mixins>, GraphDataProvider) — bases tuple + nothing else after step 9
  _state.py          _FalkorState Protocol (§2.3) + class constants that several mixins read
  _log.py            logger = logging.getLogger("backend.app.providers.falkordb_provider")   (see risk R9)
  errors.py          L262–416: exception-name tuples, optional-import try blocks, 6 classifiers, _TRANSIENT_RETRY_BACKOFFS, _EmptyResult
  hosts.py           L419–463: _normalize_falkordb_host, resolve_falkordb_target (keeps the lazy .manager import)
  cursors.py         re-exports backend/common/providers/cursors.py (L158–255) under the old private names
  rowmap.py          L466–760: re-exports the kernel rowmap under the old private names + _compute_searchable_text stays HERE (app-layer dependency, see §4)
  knobs.py           L73–133: _resolve_bulk_create_knobs + _BULK_CREATE_KNOBS_CACHE + the two _DEFAULT constants
  connection.py      ConnectionMixin  = B (811–2077) + S (11239–11333): __init__, preflight, pools, failover, _run_guarded, _guarded_timed, the 5 chokepoints, quiesce gate, list_graphs, close
  schema.py          SchemaMixin      = C (2079–2313) + J1 (4165–4344): _seed_from_file, stamp_identity_urns, ensure_indices, ensure_projections, _log_aggregation_index_health; OWNS _UNLABELED_URN_UNSUPPORTED / _INDEX_HEALTH_LOGGED
  ontology.py        OntologyMixin    = D (2316–2767)
  caches.py          CacheMixin       = E (2772–2992): _cache_ns, physical_graph_id, key builders, _aggregation_run_meta/_legacy_regime_meta/_probe_nonconforming_cells/_aggregation_storage_regime, URN→label cache
  ancestors.py       AncestorMixin    = J2 (4346–4611)
  reads.py           ReadMixin        = F+G (2994–3460)
  browse.py          BrowseMixin      = H (3462–4038)
  lineage_simple.py  SimpleLineageMixin = I (4040–4158)
  aggregation.py     AggregationMixin = K (4627–6593) + pre-class AggRunMeta (17–31), AggregationBatchAbort (58–64), _completed (67–70)
  trace.py           TraceMixin       = L (6595–8619)
  closure.py         ClosureMixin     = M (8639–9370) + _ClosureWalk (763–801) + CLOSURE_* constants (166–179)
  drill.py           DrillMixin       = N+O (9372–10117)
  stats.py           StatsMixin       = P (10123–10673)
  navigation.py      NavigationMixin  = Q (10675–10801)
  writes.py          WriteMixin       = R (10806–11233)
  executor.py        FalkorDBExecutor (new seam, §3.1)
  dialect.py         FalkorDBDialect  (new seam, §3.2)
backend/app/providers/falkordb_provider.py     compatibility shim (§2.4)
backend/common/providers/cypher/__init__.py
backend/common/providers/cypher/executor.py    CypherResult, CypherExecutor Protocol
backend/common/providers/cypher/dialect.py     CypherDialect base dataclass
backend/common/providers/rowmap.py             sanitize_label, split_user_properties, sanitize_node_properties, node_from_props, edge_from_row, RESERVED_NODE_KEYS (public names)
backend/common/providers/cursors.py            CursorMismatchError, validate_sort_direction, encode/decode_keyset_cursor, keyset_sort_key, keyset_sort
```

Largest resulting module is `aggregation.py` (~2,000 lines) — still 5× smaller than today; every other module is < 1,500 lines.

### 2.2 Composition: recommendation = **hybrid (iii)**, weighted heavily toward mixins in PR 1

**Mixins for every class area (all 163 methods stay methods on `FalkorDBProvider`); collaborator objects only for the two NEW seams (executor, dialect).** Reasons, from the evidence:

1. **The 19 late-assigned attributes and the 44 `__init__` attributes are read across areas** (e.g. `_redis` is read by caches/ancestors/aggregation/stats/lifecycle; `_level_digest`/`_levels_backfilled` by connection(`__init__`)/ontology/aggregation; `_graph_name` by 10 areas). A collaborator-object design (`FalkorDBSession`, `FalkorDBCaches`) would have to *rename or proxy* every one of those reads — that is not a pure move and it is exactly where a behaviour drift would hide. Mixins keep every `self._x` read byte-identical.
2. **Tests reach into the instance by attribute name**: 56 assignments in 26 test files set `p._graph` / `p._redis` / `p._db` / `p._proj_graph` directly (52 `_graph` refs, 37 `_redis`, e.g. `test_falkordb_slow_query_log.py:51`, `test_ensure_indices_onboarding.py:111`, `test_falkordb_empty_graph.py:193/249`), stub `_ensure_connected` 62×, `_ro_query` 35×, `_proj_ro_query` 22×, `_run_guarded` 14×. Three tests construct the class **without running `__init__`** (`test_ensure_indices_onboarding.py:110` `object.__new__`, `test_falkordb_ancestors_cache_reset.py:16` and `test_falkordb_pool_resilience.py:218` `FalkorDBProvider.__new__`) and then hand-set 1–3 attributes. Any object created in `__init__` (a session, a caches object) would be absent on those instances → AttributeError; a mixin method is still there.
3. **The satellites are already duck-typed on the provider's private surface** (`falkordb_materialize.py`: `p._ro_query` 11, `p._proj_ro_query` 8, `p._proj_query` 5, `p._redis` 3, `p._graph_name` 30, `p._aggregation_sub_batch_*`, `p._MERGE_SUB_BATCH_*`, `p._bulk_create_*`, `p._ensure_label_urn_indexes`, `p._agg_regime_key`, `p._agg_last_materialized_key`; `falkordb_deep_search.py`: `provider._ro_query`, `_get_containment_edge_types`, `_get_lineage_edge_types`, `_get_ancestor_chain`, `_extract_node_from_result`). Mixins keep that surface as is.
4. **The 119 chokepoint call sites**: with mixins the 5 chokepoints stay methods (`ConnectionMixin`), the executor is layered *on top of them* (§3.1), so zero call sites change in PR 1 and the swap to `self.executor.run(...)` happens per module as PR 3 lifts it — each swap then lands with its own contract-snapshot run.
5. **MRO safety**: no two areas define the same method name (single class today), so the bases tuple is order-insensitive for correctness; keep file order for readability. Mixins define no `__init__` (only `ConnectionMixin` carries the original one) and no `__slots__`. Abstract methods of `GraphDataProvider` are satisfied through the MRO at class creation exactly as today.
6. **Indentation is preserved**: a method body under `class FalkorDBProvider:` and under `class BrowseMixin:` is indented identically, so each carve is a byte-identical block move that `git diff --color-moved=dimmed-zebra` renders as pure movement — the review property the brief asks for.

Where objects *do* pay for themselves in PR 1: `FalkorDBExecutor` and `FalkorDBDialect` (new, stateless-or-derived, created lazily via properties so `__new__`-built instances still work), and the pure module-level helpers (functions, not objects). `FalkorDBCaches` as an object is deferred to PR 2/3 (it would break the 37 `p._redis` test sites today).

### 2.3 `_FalkorState` Protocol (what each mixin needs) — measured per area

Documented in `falkordb/_state.py` as a `typing.Protocol` (never used as a base — documentation + the AST guard test in §5 step 10 read it). Per-mixin "requires", from the AST:

| Mixin | `__init__`-assigned attrs read | Late-assigned attrs read (all guarded by `getattr(self, …, default)` or by the raising `_get_containment_edge_types` contract) | Class constants read | Module-level names it must import |
|---|---|---|---|---|
| ConnectionMixin (B+S) | all 44 (it owns `__init__`) | `_redis`, `_reconcile_started`, `_reconcile_task` | `_MERGE_SUB_BATCH_SIZE` (read in `__init__` L973 — defined on AggregationMixin), `_READ_TIMEOUT`, `_WRITE_TIMEOUT` | `_EmptyResult`, the 6 classifiers, `_TRANSIENT_RETRY_BACKOFFS`, `_normalize_falkordb_host`, `_resolve_bulk_create_knobs`, `deque`, `logger` |
| SchemaMixin (C+J1) | `_graph`, `_graph_name`, `_seed_file`, `_host`, `_port` | `_indexed_entity_type_ids`, `_node_identity_property`, `_name_property`, `_projection_mode` | — | `GraphNode`, `GraphEdge`, `json`, `os`, `asyncio`, `logger`, `_UNLABELED_URN_UNSUPPORTED`, `_INDEX_HEALTH_LOGGED` (owned here) |
| OntologyMixin (D) | `_admission_controller`, `_conn_cfg`, `_db`, `_graph`, `_graph_name`, `_level_digest`, `_levels_backfilled`, `_levels_warning_for_digest`, `_proj_db`, `_proj_graph`, `_proj_pool`, `_projection_mode` | `_entity_type_levels`, `_name_property`, `_node_identity_property`, `_resolved_containment_types(_set)`, `_resolved_edge_metadata(_set)`, `_resolved_lineage_types`, `_source_entity_aliases`, `_source_rel_aliases`, `_observed_rel_types` | `TRACE_DEGREE_CAP` (defined at 2390 inside this area) | `ProviderConfigurationError`, `_node_from_props`, `_sanitize_label`, `logger` |
| CacheMixin (E) | `_graph_name`, `_host`, `_port` | `_agg_meta_cached`, `_redis`, `_regime_probe_cached` | — | `AggRunMeta`, `os`, `time`, `logger` |
| AncestorMixin (J2) | — | `_redis` | — | `_sanitize_label`, `json`, `os`, `asyncio`, `logger` |
| ReadMixin (F+G) | — | — | `_EDGES_BETWEEN_TIMEOUT` | models, `_edge_from_row`, `_sanitize_label`, `json`, `logger` |
| BrowseMixin (H) | `_graph_name` | — | — | models, keyset cursor functions, `_edge_from_row`, `_sanitize_label`, `logger` |
| SimpleLineageMixin (I) | — | — | — | models only |
| AggregationMixin (K) | `_graph_name`, `_level_digest` | `_agg_meta_cached`, `_redis`, `_entity_type_levels` | `_BULK_WIPE_BATCH_SIZE`, owns `_MERGE_SUB_BATCH_*`, `_BULK_CREATE_BATCH_SIZE` | `AggRunMeta`, `AggregatedEdgeInfo/Result`, `_sanitize_label`, `deque`, `json`, `os`, `time`, `logger` |
| TraceMixin (L) | — | — | `TRACE_DEGREE_CAP` | `CLOSURE_*` (3), `_ClosureWalk`, `_completed`, `_edge_from_row`, `_sanitize_label`, trace models, `defaultdict`, `time`, `logger` |
| ClosureMixin (M) | — | — | — | `CLOSURE_QUERY_CAP_SECS`, `CLOSURE_WALK_SLICE`, `_sanitize_label`, `time`, `logger` |
| DrillMixin (N+O) | — | — | — | models, `_sanitize_label`, `logger` |
| StatsMixin (P) | `_graph_name` | `_observed_rel_types`, `_redis`, `_resolved_edge_metadata`, `_resolved_lineage_types` | `_SCHEMA_CACHE_TTL` (owned) | schema models, `ProviderConfigurationError`, `_sanitize_label`, `json`, `os`, `logger` |
| NavigationMixin (Q) | — | `_indexed_entity_type_ids` | — | keyset cursor functions, `_sanitize_label`, `json` |
| WriteMixin (R) | `_graph_name` | `_casing_maps_cache`, `_save_indices_ensured` | `_TYPE_CASING_TTL_S` (owned) | `_compute_searchable_text`, `_split_user_properties`, `_edge_from_row`, `_sanitize_label`, `_is_loading_error`, `_is_transient_connection_error`, `defaultdict`, `json`, `os`, `time`, `logger` |

Cross-mixin method calls (e.g. `TraceMixin` → `self._get_ancestor_chain` on `AncestorMixin`) need no imports; only the module-level names in the last column do.

### 2.4 The compatibility shim `backend/app/providers/falkordb_provider.py`

Keeps working for every importer listed in §4. Contents: a deprecation docstring ("moved to `backend.app.providers.falkordb`; private names re-exported until PR 2 repoints consumers") and explicit re-exports — **no `import *`, no runtime `DeprecationWarning` in PR 1** (40+ test files import it; a warning would just be noise until PR 2). It must also `import asyncio` (two tests patch `backend.app.providers.falkordb_provider.asyncio.sleep` — that resolves to `asyncio.sleep` itself, so it keeps working as long as the shim has the `asyncio` attribute).

Names the shim must export (every name imported from it today, in app code, scripts, or tests):

- Public: `FalkorDBProvider`, `AggRunMeta`, `AggregationBatchAbort`, `CursorMismatchError`, `resolve_falkordb_target`, `CLOSURE_FRONTIER_PROBE_CAP`, `CLOSURE_WALK_SLICE`, `CLOSURE_QUERY_CAP_SECS`, `CLOSURE_WALK_RESERVE_FRACTION`.
- Private helpers: `_sanitize_label`, `_compute_searchable_text`, `_split_user_properties`, `_sanitize_node_properties`, `_node_from_props`, `_edge_from_row`, `_RESERVED_NODE_KEYS`, `_normalize_falkordb_host`, `_is_cluster_redirect`, `_is_cluster_routing_error`, `_is_transient_connection_error`, `_is_null_handle_error`, `_is_missing_graph_error`, `_is_loading_error`, `_EmptyResult`, `_validate_sort_direction`, `_encode_keyset_cursor`, `_decode_keyset_cursor`, `_keyset_sort_key`, `_keyset_sort`, `_CURSOR_PREFIX`, `_resolve_bulk_create_knobs`, `_BULK_CREATE_BATCH_DEFAULT`, `_BULK_CREATE_TIMEOUT_DEFAULT`, `_TRANSIENT_RETRY_BACKOFFS`, `_ClosureWalk`, `_completed`.
- Module state re-exported **as the same objects** (never rebound): `_UNLABELED_URN_UNSUPPORTED`, `_INDEX_HEALTH_LOGGED` (from `falkordb.schema`), `_BULK_CREATE_KNOBS_CACHE` (from `falkordb.knobs`). `_logged_legacy_blob` is an immutable bool mutated via `global` — a re-export would be a stale copy; nothing outside reads it (grep), so **do not re-export it** (document in the shim).
- Also `logger` (name `backend.app.providers.falkordb_provider`, see R9) so `caplog.at_level(..., logger="backend.app.providers.falkordb_provider")` keeps capturing.

---

## 3. The executor + dialect seams (the strategic part)

### 3.1 `CypherExecutor` (kernel) and `FalkorDBExecutor`

```python
# backend/common/providers/cypher/executor.py
@dataclass
class CypherResult:
    raw: Any                              # driver-native object (falkordb QueryResult / _EmptyResult; later neo4j Result, ArcadeDB JSON)
    columns: tuple[str, ...]              # FalkorDB: tuple(h[1] for h in raw.header)
    result_set: list[list[Any]]           # THE SAME list object as raw.result_set — every one of today's ~120 call sites reads .result_set; no copy, no per-row cost
    @property
    def rows(self) -> list[dict[str, Any]]: ...   # lazy zip(columns, row) — for PR-3 code only

class CypherExecutor(Protocol):
    target: Literal["source", "projection"]
    async def run(self, cypher: str, params: Mapping[str, Any] | None = None, *,
                  readonly: bool = True, timeout_s: float | None = None, op: str | None = None) -> CypherResult: ...
    async def run_tolerant(self, cypher: str, params=None, *, timeout_s=None, op=None) -> CypherResult: ...
    # missing/never-created graph → empty CypherResult (FalkorDB: "Invalid graph operation on empty key" + cluster EXISTS verification)
```

```python
# backend/app/providers/falkordb/executor.py
class FalkorDBExecutor:
    """Adapter over the provider's 5 chokepoints. Retries/failover/loading/quiesce/semaphores/slow-query
    telemetry stay inside ConnectionMixin._run_guarded/_guarded_timed/_proj_query — untouched in PR 1."""
    def __init__(self, owner: "_FalkorState", target: str): ...
    async def run(self, cypher, params=None, *, readonly=True, timeout_s=None, op=None):
        if self.target == "source":
            fn = owner._ro_query if readonly else owner._query
            raw = await fn(cypher, params=params, timeout=timeout_s, op=op)
        else:
            raw = await (owner._proj_ro_query(cypher, params=params, timeout=timeout_s, op=op) if readonly
                         else owner._proj_query(cypher, params=params, timeout=timeout_s, op=op))   # _proj_query gains op=None (additive)
        return _wrap(raw)
    async def run_tolerant(...):            # source: owner._ro_query_tolerant; projection: _proj_ro_query + owner._is_verified_missing_graph
```

Wiring: two lazily-created cached properties on `ConnectionMixin` — `executor` (source) and `projection_executor` — implemented as `self.__dict__.setdefault("_executor", FalkorDBExecutor(self, "source"))` so instances built with `__new__` get one on first use. The executor looks the chokepoint up on the owner **at call time**, so tests that stub `p._ro_query = spy` (35 sites) keep intercepting even when PR-3 code calls `self.executor.run(...)`.

Why "source vs projection = two instances" and not a `target=` arg: `_proj_query` carries the quiesce gate + write semaphore (L2045–2077) and `_proj` resolves to `_graph` in `in_source` mode (L1067–1077) — the two targets differ in *policy*, not only in handle; separate instances keep that policy visible at the call site (`self.projection_executor.run(..., readonly=False)`).

Per-query cost: one extra Python call + one small dataclass per query, zero per row (`result_set` is aliased). Guard test asserts `res.result_set is raw.result_set`.

### 3.2 `CypherDialect` (kernel) and `FalkorDBDialect`

```python
# backend/common/providers/cypher/dialect.py
@dataclass(frozen=True)
class CypherDialect:
    name: str
    identifier_case_sensitive: bool           # FalkorDB True (the whole _type_casing_maps / _floor_case_fold machinery exists for this)
    label_scoped_indexes_only: bool           # True → readers must anchor on a label (drives label_union())
    supports_unlabeled_property_index: bool | None   # None = probe once per server (FalkorDB memo _UNLABELED_URN_UNSUPPORTED)
    supports_call_subquery: bool              # CALL { … }
    supports_union_in_subquery: bool
    supports_exists_subquery: bool            # EXISTS { MATCH … }
    supports_pattern_predicate_negation: bool # NOT (n)<-[:T]-()
    supports_list_params: bool                # IN $list / UNWIND $list
    supports_o1_counts: bool                  # FalkorDB reduce_count; Neo4j count store
    timeout_mode: Literal["server_param_ms", "driver_tx_timeout", "client_only"]
    unknown_label_match: Literal["empty", "error"]
    aggregated_edge_type: str = "AGGREGATED"
    agg_meta_label: str = "_AggMeta"
    projection_label: str = "_Projection"
    # statements
    def labels_statement(self) -> str
    def relationship_types_statement(self) -> str
    def property_keys_statement(self) -> str | None
    def indexes_statement(self) -> str | None
    def parse_index_rows(self, rows) -> list[IndexInfo]         # FalkorDB row = label, properties, types, language, stopwords, entitytype, info
    def create_node_index(self, label: str, props: Sequence[str]) -> str
    def create_edge_index(self, rel_type: str, props: Sequence[str]) -> str
    def create_unlabeled_index(self, prop: str) -> str | None
    def is_index_exists_error(self, exc: BaseException) -> bool  # FalkorDB: "already indexed" in str(exc).lower()
    def fulltext_create(self, label, props) -> str | None; def fulltext_query(self, label, prop, text) -> str | None
    # expressions
    def first_label_expr(self, var) -> str        # labels(n)[0]
    def node_id_expr(self, var) -> str            # ID(n)
    def edge_id_expr(self, var) -> str            # id(r)
    def edge_type_expr(self, var) -> str          # type(r)
    def label_union(self, branches: Sequence[str], tail: str) -> str   # "CALL { a UNION b } tail"
    def no_incoming_pattern(self, var, rel_alt) -> str   # "NOT (n)<-[:A|B]-()"
    def edge_id_cursor_page(self, var) -> tuple[str, str]  # ("WHERE id(r) >= $after", "ORDER BY id(r)")
```

`FalkorDBDialect` (in `falkordb/dialect.py`) instantiates the above with today's literal strings; `ConnectionMixin.dialect` is a cached property. **PR-1 rule: every builder returns the byte-identical string the provider emits today** — enforced by the Cypher-text golden (§6 step 0).

#### 3.2.1 Dialect points found in the file, with the three-column matrix

| # | Dialect point (where it is used today) | FalkorDB (Cypher/openCypher, redis protocol) | Neo4j Cypher 5 (Bolt) | ArcadeDB (HTTP API `language: "opencypher"`, SQL DDL) |
|---|---|---|---|---|
| 1 | Label catalogue — L4820, 4939, 10244, 10825 | `CALL db.labels() YIELD label RETURN label` | same | no `db.labels()` in ArcadeDB's Cypher → SQL `SELECT name FROM schema:types WHERE type = 'vertex'` (verify on a live server) |
| 2 | Relationship-type catalogue — L10247, 10464, 10821 | `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType` | same | `SELECT name FROM schema:types WHERE type = 'edge'` |
| 3 | Property keys (unused today) | `CALL db.propertyKeys()` | same | `SELECT FROM schema:types` (properties per type) |
| 4 | Index catalogue — L4235 (`_log_aggregation_index_health`, parses positional columns 0/1/5) | `CALL db.indexes()` — column order varies by version | `SHOW INDEXES YIELD name, type, labelsOrTypes, properties` | `SELECT FROM schema:indexes` |
| 5 | Node property index DDL — L2275, 4185, 4906 | `CREATE INDEX FOR (n:L) ON (n.p)`; re-issue → error text "already indexed" (L2267) treated as success | `CREATE INDEX name IF NOT EXISTS FOR (n:L) ON (n.p)` | SQL `CREATE INDEX IF NOT EXISTS ON L (p) NOTUNIQUE`; **type L must exist** (`CREATE VERTEX TYPE L IF NOT EXISTS` first) |
| 6 | Edge property index DDL — L2291–2300 (incl. composite) | `CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceLevel, r.targetLevel)` (v4.16+) | same syntax | `CREATE INDEX ON AGGREGATED (sourceLevel, targetLevel) NOTUNIQUE` (edge types are types) |
| 7 | Label-less property index — probed once per server L4189–4207, memo `_UNLABELED_URN_UNSUPPORTED` | unsupported on every build (`CREATE INDEX FOR (n) ON (n.urn)` throws) | no label-less range index (only token-lookup) → same "label-scoped only" regime | indexes are type-scoped but polymorphic: an index on the root `V` type would cover all vertex types (verify) |
| 8 | Full-text (unused; deep search uses `CONTAINS` on `searchableText`) | `CALL db.idx.fulltext.createNodeIndex(...)` / `db.idx.fulltext.queryNodes` | `CREATE FULLTEXT INDEX n FOR (n:L) ON EACH [n.p]` / `CALL db.index.fulltext.queryNodes('n', q)` | `CREATE INDEX ON L (p) FULL_TEXT` / `CALL db.index.fulltext.queryNodes('L[p]', q)` |
| 9 | Edge identity as a page cursor — L9294–9329 (`WHERE id(r) >= $after … ORDER BY id(r)`), also 8468, 9025, 9829, 9840, 9964, 10003 | `id(r)` int (ids are reused after delete; numeric order) | `elementId(r)` string; `id()` deprecated — lexical order ≠ numeric → cursor must be remodelled | `id(r)` = RID string `#bucket:pos` — not numerically ordered across buckets (verify) |
| 10 | Node identity for range batching — L2143 `max(ID(n))` (`stamp_identity_urns`) | `ID(n)` int | deprecated `id(n)` | RIDs — batch per bucket |
| 11 | First label of a node — 49 sites (`labels(x)[0]`), incl. `toLower(labels(n)[0]) IN $…` L3071 | supported | supported | `labels(n)` supported (one type per vertex) (verify) |
| 12 | `type(r)` — 49 sites | supported | supported | supported |
| 13 | Timeout injection — `timeout=self._db_timeout_ms(t)` at L1872, 1961, 1974, 2065, 2262; clamp L1599–1605 to `FALKORDB_SERVER_TIMEOUT_MAX_MS` | protocol arg `GRAPH.QUERY … TIMEOUT ms` (server rejects > TIMEOUT_MAX) | driver `tx.timeout` / `db.transaction.timeout` | no per-command timeout in the HTTP body → client-side HTTP timeout + server `command.timeout` setting (verify) |
| 14 | Identifier case sensitivity — `_type_casing_maps` L10808, `_consistent_casing` 10838, `_floor_case_fold` 2661, alias maps 2576–2694 | labels/types case-sensitive | case-sensitive | type names case-insensitive (brief) → the whole casing machinery collapses to identity |
| 15 | Label-scoped index ⇒ per-label union readers — `CALL { MATCH (n:L1)… RETURN n UNION MATCH (n:L2)… }` at L3187–3206 (`get_nodes`), 3906/4003 (`get_top_level_or_orphan_nodes`), 10786–10790 (`get_nodes_by_layer`); bare `UNION` in drill 9514–9553, 9631–9681, 9763 | `CALL {}` + `UNION` (v4) | `CALL { … UNION … }` valid (no outer variables referenced, so no importing `WITH` needed) | no `CALL {}` subquery; top-level `UNION` only (verify) → dialect `label_union()` must fall back to N sequential per-label queries merged client-side |
| 16 | Unknown label in `MATCH (n:L)` | empty result | empty result | `MATCH` on an undeclared type → error (verify) → `unknown_label_match="error"` ⇒ intersect requested labels with the catalogue first |
| 17 | List parameters — 95 `IN $…` sites, 25 `UNWIND` | supported | supported | supported via JSON params (verify UNWIND of a list param) |
| 18 | Subqueries — `CALL {}` used (6 sites); `EXISTS { MATCH }` explicitly avoided (L3863–3867: "NOT supported by FalkorDB … silently throws") | `CALL {}` yes, `EXISTS {}` no | `CALL {}`, `EXISTS {}`, `COUNT {}`, `CALL {} IN TRANSACTIONS` | neither (verify) |
| 19 | Pattern-negation predicate — L3870 `NOT (n)<-[:T]-()` | supported (openCypher 1.0 form) | still supported | pattern predicates in WHERE supported by cypher-for-gremlin (verify) |
| 20 | O(1) counts — `get_counts_fast` L10205–10306 relies on `reduce_count` (no projection alongside `count()`) | yes (matrix counters) | count store makes `MATCH (n:L) RETURN count(n)` / `MATCH ()-[r:T]->() RETURN count(r)` O(1) too | per-bucket record counts make `count(*)` on a type cheap (verify) → `supports_o1_counts` |
| 21 | Reserved graph objects — `AGGREGATED` rel type, `_AggMeta {id:'singleton'}` L2844, `_Projection` label L4185 | created implicitly on first write | implicit | **must be declared** (`CREATE EDGE TYPE AGGREGATED IF NOT EXISTS`, `CREATE VERTEX TYPE _AggMeta …`) before insert; underscore-prefixed names to verify |
| 22 | Projection graph — `{graph}_proj` as a separate Redis key with its own cluster owner (L2527–2547, 1656–1665) | second graph key on the same instance/cluster | second database (Enterprise) or same DB | second database (`/api/v1/command/{db}_proj`) → `projection_executor` bound to another DB |
| 23 | Upsert shapes — `MERGE (n:L {urn: item.urn}) SET n += item.nativeProps … REMOVE n.properties` L10991–11000; `UNWIND $batch AS item` | supported | supported | `SET n += map` support to verify; types must pre-exist (#21) |
| 24 | Chunked delete — `MATCH ()-[r:AGGREGATED]->() WITH r LIMIT n DELETE r RETURN count(r)` L4683–4685 | supported | supported | verify |
| 25 | Graph/database listing — L11268 `GRAPH.LIST` (+ cluster fan-out via `list_graph_keys_for_config`) | redis command | `SHOW DATABASES` | `GET /api/v1/databases` |
| 26 | Missing-graph read — error text "Invalid graph operation on empty key" (L371–390), masked only after the cluster `EXISTS` verification (1878–1938) | error string match | `DatabaseNotFound` error | HTTP 400/404 "Database not found" |
| 27 | Warm-up / loading state — L393–410 (`LOADING …`) → `ProviderLoading` with `retry_after_seconds=5` (1729–1735) | `BusyLoadingError` / "loading" text | `Neo.TransientError.General.DatabaseUnavailable` | HTTP 503 |
| 28 | Transient/redirect classification — L262–356 (`MovedError`, `AskError`, `ClusterDownError`, reset-by-peer) | redis-cluster specific | `ServiceUnavailable`/`SessionExpired` | connection errors only |
| 29 | Variable-length alternation — 31 `*1..`/`*0..` sites, `[:A|B*1..k]` | supported | supported | supported (verify depth syntax) |
| 30 | Tag storage as JSON string — `n.tags CONTAINS $tagVal` L3084 (storage convention, not syntax) | string | string (or native list) | string |

Rows marked "(verify)" are the ArcadeDB items to confirm on a live server in PR 3; PR 1 only encodes the FalkorDB column.

### 3.3 Per-method classification

Legend — **G**: dialect-neutral algorithm on `executor` + `dialect` + injected ontology state (candidate to lift unchanged into the PR-3 base). **F**: FalkorDB-specific (Redis-backed URN→label cache / agg ledger, projection-graph plumbing, cluster/failover, `reduce_count`, quiesce/admission, redis-protocol commands, driver handles). **GF**: generic algorithm with a FalkorDB-specific fast path or fragment that becomes a dialect call or an override. "cache" in the notes = uses Redis only through a swappable cache facade (ancestor chains / stats / ontology) — Spanner already does the same through the kernel's `AncestorChainCache`, so that dependency is not what makes a method F.

**B — connection (`connection.py`)**

| Method (line) | Class | Notes |
|---|---|---|
| `__init__` (811) | F | pools, semaphores, quiesce knobs, cluster config; PR 3 base gets its own `__init__` and FalkorDB's calls `super()` |
| `_proj` (1068) | F | projection handle resolution |
| `inflight_ops` (1079) | F | manager recovery contract (`manager.py` ×3) |
| `preflight` (1084) | F | RESP AUTH/PING, sentinel/cluster |
| `_build_pool_kwargs` (1226), `_build_and_verify` (1255), `_ensure_connected` (1300), `_schedule_reconcile_once` (1543) | F | driver/pool lifecycle; cache client construction |
| `_db_timeout_ms` (1599), `_graph_socket_timeout` (1607) | F | dialect point #13 (`timeout_mode`) |
| `_rebuild_graph_client_for_failover` (1629) | F | cluster |
| `_run_guarded` (1682), `_guarded_timed` (1817) | F | executor internals (retry/loading/telemetry) |
| `_ro_query` (1865), `_query` (1954), `_proj_ro_query` (1967), `_proj_query` (2045), `_ro_query_tolerant` (1940) | F | the executor's implementation |
| `_empty_key_is_genuine` (1878), `_is_verified_missing_graph` (1932) | F | dialect point #26 + cluster EXISTS probe |
| `_quiesce_p95` (1980), `_check_quiesce_gate` (1988), `_record_write_latency` (2020) | F | write flow control |
| `list_graphs` (11239), `close` (11273) | F | `GRAPH.LIST`, pool teardown |

**C + J1 — schema (`schema.py`)**

| Method | Class | Notes |
|---|---|---|
| `_seed_from_file` (2079) | G | reads a JSON file, calls `save_custom_graph` |
| `stamp_identity_urns` (2101) | GF | algorithm generic; `ID(n)` range batching = dialect #10; in-source-only guard reads `_projection_mode` |
| `ensure_indices` (2220) | GF | policy generic (`index_policy`); DDL strings + "already indexed" = dialect #5/#6; direct `self._graph.query` bypass L2261 → executor in PR 3 |
| `ensure_projections` (4165) | GF | `_Projection` index + unlabeled probe (#7) via dialect; per-server memo sets stay here |
| `_log_aggregation_index_health` (4215) | F | parses FalkorDB `db.indexes()` row layout (#4) → becomes `dialect.parse_index_rows`; direct `_proj.ro_query` bypass |

**D — ontology (`ontology.py`)**

| Method | Class | Notes |
|---|---|---|
| `name` (2316) | G | |
| `set_containment_edge_types` (2319), `set_entity_type_levels` (2344), `_get_node_level` (2375), `_types_at_level` (2503), `set_resolved_edge_metadata` (2562), `set_source_type_aliases` (2576), `set_node_identity` (2596), `_alias_types` (2624), `_containment_hop_bound` (2644), `_alias_rel_types` (2685), `_alias_entity_types` (2693), `_get_containment_edge_types` (2696), `_get_lineage_edge_types` (2724) | G | pure injected-state management (this is the "ontology-injection state" the brief lists for the kernel — see §4) |
| `_check_levels_backfilled` (2392) | GF | generic stamp probe on `AGGREGATED`; direct `self._graph.query` bypass L2421 → executor |
| `_resolve_root_anchor` (2444) | G | containment climb; ancestor cache |
| `set_projection_mode` (2514) | F | builds the `_proj` client (cluster-aware) |
| `set_admission_controller` (2556) | F | |
| `_floor_case_fold` (2661) | GF | exists only because `identifier_case_sensitive=True` (#14); identity on ArcadeDB |
| `_extract_node_from_result` (2753) | GF | depends on the driver's Node object shape (`.properties`, `.labels`) → executor row mapping |

**E — caches (`caches.py`)**

| Method | Class | Notes |
|---|---|---|
| `_cache_ns` (2772), `physical_graph_id` (2794) | GF | "physical graph identity" is generic; composed from FalkorDB host:port:graph |
| `_urn_label_key` (2803), `_agg_members_prefix` (2812), `_agg_in_flight_key` (2954), `_urn_label_ttl` (2957), `_cache_urn_label` (2960), `_cache_urn_labels_bulk` (2973), `_get_cached_label` (2987) | F | Redis-hash URN→label cache — exists because of label-scoped indexes (#15); Neo4j would want it too, so PR 3 may promote it to a "label-scoped-index engines" facade |
| `_agg_last_materialized_key` (2806), `_agg_regime_key` (2809), `_legacy_regime_meta` (2880) | F | legacy Redis regime markers |
| `_aggregation_run_meta` (2818), `_probe_nonconforming_cells` (2912), `_aggregation_storage_regime` (2927) | G | reads `_AggMeta` through the projection executor |

**J2 — ancestors (`ancestors.py`)**

| Method | Class | Notes |
|---|---|---|
| `_ancestors_cache_key` (4346), `_get_ancestor_chain` (4374), `_compute_ancestor_chain` (4402), `_compute_and_store_ancestors_bulk` (4417), `_ancestor_cache_ttl` (4517), `_compute_ancestor_chains_bulk_cypher` (4520) | G (cache) | variable-length containment walk in plain openCypher; Redis pipeline HGET/HSET = the same contract as kernel `AncestorChainCache` (PR 3 candidate to swap in) |

**F + G — reads (`reads.py`)**

| Method | Class | Notes |
|---|---|---|
| `get_node` (2994) | GF | label-cache seek + unlabeled fallback |
| `get_nodes` (3046) | GF | label-union shape (#15), `toLower(labels(n)[0])` (#11), URN bucketing by cached label |
| `_match_property_filters` (3265), `_match_operator` (3274), `_match_tag_filters` (3302), `_match_text_filter` (3313), `search_nodes` (3326) | G | pure Python |
| `deep_search` (3330), `deep_search_explain` (3343), `deep_search_discover` (3350) | F | delegates to `falkordb_deep_search.py` (3,604 lines of FalkorDB-shaped Cypher; PR 3 decides) |
| `get_edges` (3358) | G | type alternation; `_EDGES_BETWEEN_TIMEOUT` |

**H — browse (`browse.py`)**

| Method | Class | Notes |
|---|---|---|
| `get_children` (3462), `get_parent` (3764) | G | keyset cursors (kernel) |
| `get_children_with_edges` (3558) | GF | label cache for lineage-edge endpoints |
| `get_top_level_or_orphan_nodes` (3787) | GF | `CALL {} UNION` builder (#15) + negation predicate (#19) via dialect |

**I — simple lineage (`lineage_simple.py`)**: `_traverse_lineage` (4040) GF (`labels(neighbor)[0]` #11), `get_upstream` (4092), `get_downstream` (4114), `get_full_lineage` (4136) — G.

**K — aggregation (`aggregation.py`)**

| Method | Class | Notes |
|---|---|---|
| `_wipe_aggregated_edges` (4644) | G | chunked delete (#24) on projection executor |
| `_purge_aggregated_idempotency_namespace` (4700) | F | Redis `SCAN` over the agg ledger |
| `_label_buckets` (4743), `_resolve_chain_levels` (5137), `_derive_lineage_types_from_cache` (5114) | GF | label cache |
| `_resolve_urn_labels_bulk` (4767) | GF | `CALL db.labels()` (#1) + per-label seeks; Redis label cache |
| `_ensure_label_urn_indexes` (4892) | GF | DDL via dialect (#5); direct `_proj.query` bypass |
| `_warmup_urn_label_cache_for_aggregation` (4913) | F | FalkorDB-shaped warmup (`CALL db.labels`, direct `_proj.ro_query` ×3, per-label caps) |
| `_estimate_lineage_edge_count` (5083) | G | |
| `_get_ancestor_dag_pair` (5194), `_hook_pairs` (5247) | G | kernel `pair_rules` |
| `on_lineage_edge_written` (5282), `on_lineage_edge_deleted` (5474) | GF | pair algebra generic; Redis idempotency ledger (`SADD`) = F → kernel `IdempotencyBackend` protocol already exists in `common/providers/aggregation.py:37` |
| `on_containment_changed` (5568) | G (cache) | |
| `clear_content_caches` (5610) | F | Redis key wipe (facade in PR 3) |
| `count_aggregated_edges` (5641) | G | |
| `purge_aggregated_edges` (5651) | GF | Redis regime keys + chunked delete |
| `materialize_lineage_for_edge` (5807) | G | |
| `materialize_aggregated_edges_batch` (5822) | F | delegates to `falkordb_materialize.py` (2,552 lines; PR 3 decides) |
| `get_aggregated_edges_between` (5865), `_synthesize_ondemand_lineage_pairs` (6104), `_mixed_depth_pairs` (6386), `_synthesize_raw_lineage_pairs` (6488), `_rows_to_aggregated_result` (6555) | G | projection executor reads; `fastapi.HTTPException` import at 5881 is an app-layer leak to note for PR 3 |

**L — trace (`trace.py`)**

| Method | Class | Notes |
|---|---|---|
| `get_trace_lineage` (6595) | G | |
| `trace_at_level` (6830) | G | 465 lines; note: the kernel already has `TraceOrchestrator` (Spanner uses it) — PR 3 must decide adopt-vs-keep, PR 1 keeps FalkorDB's own byte-for-byte |
| `trace_closure` (7296), `trace_closure_coarse` (7785) | G | label cache reads; `labels(p)[0]` (#11) |
| `expand_aggregated` (7964) | GF | `UNION` builder (#15) |
| `_resolve_anchor_at_level` (8129), `_has_aggregated_at_level` (8234), `_find_ancestor_with_lineage` (8283) | GF | label cache + `labels(x)[0] IN $types` |
| `_expand_aggregated_set` (8353) | GF | level-stamp fast path is generic; `id(r)` (#9), `labels(other)[0]`, `COALESCE` |

**M — closure (`closure.py`)**

| Method | Class | Notes |
|---|---|---|
| `_lineage_degrees` (8639), `_walk_anchors` (8700), `_walk_estimate` (8794), `_file_cut` (8798), `_expand_prefix` (8818), `_commit_rows` (8870), `_hub_page` (8902), `_collect_lineage_seed` (9072), `_descendant_lineage_seed` (9186) | G | degree-exact walk; `labels(f)[0]` (#11) |
| `_expand_raw_lineage_set` (8961), `_page_raw_lineage_single` (9279) | GF | numeric `id(r)` cursor (#9) — the one place where Neo4j/ArcadeDB need a different cursor model |

**N + O — drill (`drill.py`)**

| Method | Class | Notes |
|---|---|---|
| `_collect_ancestor_urns` (9372), `_collect_children_pair` (9483), `_collect_descendants_pair_at_level` (9582), `_collect_level_and_subtree` (9719), `_edges_between_sets` (9780), `get_nodes_batch` (10038) | G | bare `UNION` branches (#15) via dialect |
| `_edge_depth_stamps` (9420), `_frontier_depths_from_stamps` (9442) | G | projection executor |
| `_edges_between_sets_once` (9809), `_fetch_containment_edges` (9875) | GF | `id(r)`, `properties(r)` |

**P — stats (`stats.py`)**

| Method | Class | Notes |
|---|---|---|
| `get_stats` (10125) | G (cache) | grouped counts; `labels(n)[0]` (#11) |
| `get_counts_fast` (10205) | GF → override | needs `supports_o1_counts` (#20) and `CALL db.*` (#1/#2); returns `None` to defer — the base can return `None` when the dialect lacks O(1) counts |
| `prime_stats_cache` (10308) | G (cache) | |
| `get_schema_stats` (10328) | G | |
| `get_ontology_metadata` (10414) | GF | `CALL db.relationshipTypes()` (#2) with a generic edge-scan fallback already written (L10471) |
| `get_node_degrees` (10593), `get_distinct_values` (10649) | G | |

**Q — navigation (`navigation.py`)**: `get_ancestors` (10675), `get_descendants` (10687), `get_nodes_by_tag` (10727) — G; `get_nodes_by_layer` (10741) — GF (label-union over `indexed_labels` #15).

**R — writes (`writes.py`)**

| Method | Class | Notes |
|---|---|---|
| `_type_casing_maps` (10808), `_consistent_casing` (10838) | GF | `CALL db.*` (#1/#2); no-op when `identifier_case_sensitive=False` |
| `_bulk_write_batch` (10851) | GF | wait-out-a-restart loop; generic given the executor's `ProviderLoading`/transient classification |
| `save_custom_graph` (10907) | GF | `UNWIND`/`MERGE`/`SET +=` generic (#23); `ensure_indices`; label-cache writes |
| `create_node` (11105) | GF | label cache write |
| `create_edge` (11173), `update_edge` (11202), `delete_edge` (11220) | G | |

Tally: **G 80 · GF 38 · F 45** (of 163; per area — B 25F · C 1G/3GF/1F · D 15G/3GF/2F · E 3G/2GF/10F · J2 6G · F+G 6G/2GF/3F · H 2G/2GF · I 3G/1GF · K 12G/8GF/4F · L 4G/5GF · M 9G/2GF · N+O 8G/2GF · P 5G/2GF · Q 3G/1GF · R 3G/5GF). The F set is exactly area B+S (25), the Redis label-cache/ledger/regime methods (14), the two satellite delegations, `set_projection_mode`/`set_admission_controller`, and the two FalkorDB-only probes — i.e. the PR-3 base can take ~118 methods with the dialect/executor substitutions above, and FalkorDB overrides ~45.

---

## 4. Shared-kernel extraction in PR 1

Move now (pure functions, no app-layer imports — verified against the lazy-import map):

| Kernel module | Functions (from) | Public name | Re-exported as (old private name) |
|---|---|---|---|
| `backend/common/providers/rowmap.py` | `_sanitize_label` (136), `_RESERVED_NODE_KEYS` (537), `_logged_legacy_blob` (562, `global` state moves with `node_from_props`), `_split_user_properties` (565), `_sanitize_node_properties` (612), `_node_from_props` (633), `_edge_from_row` (750) | `sanitize_label`, `RESERVED_NODE_KEYS`, `split_user_properties`, `sanitize_node_properties`, `node_from_props`, `edge_from_row` | `falkordb/rowmap.py`: `_sanitize_label = sanitize_label` … (same objects) |
| `backend/common/providers/cursors.py` | `_CURSOR_PREFIX` (158), `CursorMismatchError` (182), `_validate_sort_direction` (188), `_encode_keyset_cursor` (195), `_decode_keyset_cursor` (205), `_keyset_sort_key` (233), `_keyset_sort` (239) | `CursorMismatchError`, `validate_sort_direction`, `encode_keyset_cursor`, `decode_keyset_cursor`, `keyset_sort_key`, `keyset_sort` | `falkordb/cursors.py` under the old names; the shim re-exports `CursorMismatchError` (imported by `api/v1/endpoints/graph.py:27`, caught at 5 sites). PR 2 adds `from backend.common.providers.cursors import CursorMismatchError` to `backend/common/interfaces/provider.py` (or moves the class there and reverses the import) — both paths keep resolving to the one class object |

**Stays in the FalkorDB package (not kernel) in PR 1:** `_compute_searchable_text` (466) — it lazily imports `backend.app.services.deep_search.get_deep_search_settings` at L513; moving it under `backend/common/` would create a common→app dependency (the kernel has none today). Leave it in `falkordb/rowmap.py`; PR 2/3 can inject the settings if the ArcadeDB provider needs it.

**Ontology-injection state** (D, 13 pure methods): keep as `OntologyMixin` in PR 1 (it reads `self._*` and is exercised by the `set_*` lifecycle from `context_engine.py` and `aggregation/worker.py`); it is G and lifts unchanged in PR 3 — creating a kernel copy now would duplicate it for one PR.

**Neo4j duplicates** (`neo4j_provider.py:50–90`: its own `_sanitize_label`, `_node_from_props`, `_edge_from_row`, subtly different — e.g. no `searchableText`, no reserved-key split): leave untouched; the Neo4j follow-up repoints them to the kernel with its own contract snapshot (`test_neo4j_provider_contract.py` exists).

**Kernel dependency direction check**: `backend/common/providers/rowmap.py` needs only `json`, `logging`, `backend.common.models.graph` (`GraphNode`, `GraphEdge`) — same layer as the kernel today (`schema_introspection.py` already imports `backend.graph.adapters.schema_mapping`, so the layering is already loose; rowmap adds nothing new).

---

## 5. Consumers that must keep working (inventory)

### 5.1 Non-test importers (app + scripts) — unchanged by PR 1 (the shim serves them)

`api/v1/endpoints/graph.py:27` (`CursorMismatchError`, module-level) · `api/v1/endpoints/versioning.py:2143` (`_edge_from_row`, `_node_from_props`, lazy) · `providers/falkor_graph_registry.py:97` (`resolve_falkordb_target`, lazy) · `providers/falkordb_connection.py:1380` (3 classifiers, lazy — the back-import) · `providers/falkordb_deep_search.py:66` (`_RESERVED_NODE_KEYS`, **module-level**) · `providers/falkordb_materialize.py:1176,1590,2036` (`_sanitize_label`, lazy) · `providers/manager.py:1168` and `registry/provider_registry.py:305` (`FalkorDBProvider`, `resolve_falkordb_target`, lazy) · `providers/versioned_branch_provider.py:401,423` (`_sanitize_label`, lazy) · `services/lineage_aggregator.py:3` (`FalkorDBProvider`, module-level, `isinstance` at :37) · `services/versioning/projection.py:45` (`_compute_searchable_text`, `_sanitize_label`, `_split_user_properties`, module-level) · `services/versioning/reconcile.py:67` (`_sanitize_label`, module-level) · `services/versioning/service.py:63` (`_sanitize_node_properties`, module-level) · `services/versioning/entity_serde.py:40` (`_sanitize_node_properties`, lazy) · `services/versioning/bootstrap_worker.py:935,979,1037` (`_node_from_props`, `_edge_from_row`, lazy) · `scripts/migrate_native_properties.py:57` (`_compute_searchable_text`, `_split_user_properties`, `_sanitize_label`, `_RESERVED_NODE_KEYS`) · scripts constructing `FalkorDBProvider` and calling `provider._ensure_connected()` / `provider._graph.query(...)`: `optimize_falkordb.py:16,28,50,61`, `check_trace_query_plans.py:103,114`, `docker_seed.py:62-65`, `import_layered_lineage.py:272-279`, `generate_analytics_data.py:22,351`, `add_column_lineage.py:311-319`, `resync_identity_repro.py:84`, `backfill_aggregation.py:66` (isinstance), `seed_falkordb.py:1037-1068`, `seed_data_lake.py:2183-2189`, `seed_large_lineage.py:35`, `seed_platform_lineage.py:1455-1459`.

Lifecycle protocol used by app code that the mixins must keep as public methods: `set_containment_edge_types`, `set_entity_type_levels`, `set_resolved_edge_metadata`, `set_source_type_aliases`, `set_node_identity`, `ensure_indices` (`services/context_engine.py`, `services/aggregation/worker.py`), `set_projection_mode`, `set_admission_controller`, `stamp_identity_urns` (worker, `falkordb_materialize.py`), `clear_content_caches` (`services/aggregation/service.py`), `inflight_ops`, `close` (`manager.py`, `provider_registry.py`), `preflight`, `_ensure_connected` (`api/v1/endpoints/providers.py`), `physical_graph_id` (`services/graph_cache.py`), `get_counts_fast`/`prime_stats_cache` (insights collector).

### 5.2 Tests — every file that imports from the four modules (65 files; the ones that couple to *module internals* are flagged)

Importing `falkordb_provider` (class or names): `test_source_alignment.py:168,180,192,205` · `test_falkordb_run_guarded.py:17` **+ string patch `backend.app.providers.falkordb_provider.asyncio.sleep` :33** · `test_falkordb_slow_query_log.py:18` (`p._graph = _FakeGraph`) · `test_falkordb_edge_labeling.py:11` · `test_ensure_indices_onboarding.py:108` **(`object.__new__` :110; caplog logger name `backend.app.providers.falkordb_provider` :118,129)** · `test_falkordb_cluster_rotation.py:27` **+ `asyncio.sleep` string patch :43** · `test_falkordb_clear_content_caches.py:16` · `test_provider_cache_namespacing.py:8` · `test_falkordb_auth_gating.py:15` · `test_falkordb_native_properties.py:22` (`_RESERVED_NODE_KEYS`, `_compute_searchable_text`, `_node_from_props`, `_split_user_properties`) · `test_top_level_provider_kwargs.py:12,114` (`_decode_keyset_cursor`) · `test_node_property_hygiene.py:13` (`_RESERVED_NODE_KEYS`, `_node_from_props`, `_sanitize_node_properties`) · `verify_scenarios.py:9`, `verify_aggregation.py:9`, `debug_aggregation.py:9` (stale `app.providers…` path — already broken, ignore) · `test_trace_waves.py:13` · `test_falkordb_ancestors_cache_reset.py:10` **(`__new__` :16)** · `test_falkordb_write_casing.py:21` · `test_keyset_cursor.py:15` (`_decode_keyset_cursor`, `_encode_keyset_cursor`, `_keyset_sort_key`) · `test_falkordb_mode_mismatch.py:146` · `test_falkordb_empty_graph.py:14-15` **(`import … as fp`: `fp._normalize_falkordb_host` :53-73, `fp._BULK_CREATE_KNOBS_CACHE.clear()` :280-305, `fp._BULK_CREATE_BATCH_DEFAULT`/`_TIMEOUT_DEFAULT` :307-308, `_is_missing_graph_error`)** · `test_falkordb_loading_state.py:18` (`_is_loading_error`) · `test_falkordb_auth_matrix.py:96,378` (`_is_transient_connection_error`) · `test_purge_epoch.py:13` · `test_falkordb_cluster_preflight.py:21` · `test_provider_registry.py:35,55` · `test_falkordb_trace_structural.py:21` · `test_falkordb_materialize.py:24` · `test_falkordb_ondemand_pairs.py:33,660,1143,1188,1235,1288,1355` (`AggRunMeta`) · `test_falkordb_counts_fast.py:25` · `test_falkordb_host_resolution.py:26` (`_normalize_falkordb_host`, `resolve_falkordb_target`; `inspect.getsource` of manager/registry functions :114-131) · `test_node_identity_read_path.py:13` (`_node_from_props`) · `test_falkordb_delete_hook_canonical.py:20,94` (`AggRunMeta`) · `test_falkordb_edge_attributes.py:19` · `test_falkordb_provider.py:40` (live) · `test_provider_cache_decoupling.py:24` · `test_trace_closure_completeness.py:425,487` **(`fp.CLOSURE_QUERY_CAP_SECS` :444 — read only, fine)** · `test_worker_warmup_and_falkor_probe.py:212,223` **(`inspect.getsource(FalkorDBProvider.list_graphs / .set_projection_mode)` :214,225 — resolves through the MRO, fine)** · `test_falkordb_failloud.py:18` · `test_trace_v2_falkordb.py:22` · `benchmark_stats.py:9` · `test_keyset_cursor_direction.py:7` (`CursorMismatchError`, `_decode/_encode_keyset_cursor`, `_keyset_sort`, `_validate_sort_direction`) · `test_cypher_shapes.py:16` (recording `_ro_query`) · `test_trace_v2_invalidation.py:26` (pre-existing `_ANCESTOR_CACHE_TTL_S` failure :595) · `test_falkordb_pool_resilience.py:216` **(`__new__` :218)** · integration: `test_layered_lineage_schema_ingest.py:46`, `test_node_sort_desc_live.py:68`, `test_trace_closure_live.py:32`, `test_aggregation_pipeline_live.py:36`, `test_source_alignment_live.py:23`, `test_versioning_roundtrip_fidelity.py:21` (`_sanitize_label`, `_split_user_properties`), `test_topologies.py:122,148,203,293` · regression: `test_falkordb_provider_contract.py:52` (fixture uses `p._ensure_connected()` and `p._graph.delete()` — keep the `_graph` attribute name).

**Source-text test that goes vacuous on the split:** `test_falkordb_no_unlabeled_unwind_match.py:44` scans `app/providers/falkordb_provider.py` — after step 1 that file is the shim with no Cypher, so the guard silently passes. Update `SCANNED_PATHS` in the same commit to `sorted((_APP_DIR / "providers" / "falkordb").glob("*.py"))` + `projection.py` (parametrised ids stay stable).

Importing `falkordb_connection` / `falkor_graph_registry` / `falkordb_deep_search` / `falkordb_materialize` (all untouched modules in PR 1, so their string-path patches keep resolving): `test_falkordb_connection.py` (+ patch `…falkordb_connection.resolve_cluster_node_for_key` :767), `test_provider_cache_reaping.py` (patch `…falkor_graph_registry.invalidate_provider` :134,157), `test_provider_invalidation_bus.py` (patches :74,98,132), `test_falkordb_cluster_rotation.py` (:165,204,236,292), `test_falkordb_topology_routing.py` (:306; `monkeypatch.setattr(fc, "verify_not_cluster_node")` :480), `test_worker_warmup_and_falkor_probe.py` (`setattr(falkordb_connection, "cluster_primary_nodes")` :313,337,357,376), `test_falkordb_cluster_preflight.py` (`setattr(fc_mod, …)` :85,146,171,191), `test_falkordb_auth_matrix.py` (:241), `test_falkordb_materialize.py` (`setattr(mat, …)` :979,1022,1028,1338), `test_aggregation_case_fold.py`, `test_aggregation_scan_shrink.py`, `test_aggregation_settings.py`, `test_advanced_search.py` (80+ lazy imports of `falkordb_deep_search` names), `test_deep_search_settings.py:127-150` (PEP 562 `__getattr__` on `falkordb_deep_search`), `test_cache_client_endpoint.py`, `test_discovery_partial_coverage.py`, `test_falkordb_cluster_coverage.py`, `test_redis_tls.py`, `test_provider_secret_handling.py`, `test_falkordb_host_resolution.py:24`, `integration/test_versioning_projection_provider_routing.py`.

`importlib.reload` / `sys.modules[...]` manipulation targeting these modules: **none**. `monkeypatch.setattr(falkordb_provider, …)` on the provider module object: **none** (only the two `fp.` reads and the `_BULK_CREATE_KNOBS_CACHE.clear()` calls above, which the same-object re-export satisfies).

---

## 6. Ordered migration steps (one commit each; suite green after every step)

Conventions for every step: commit **by explicit pathspec**; never `--amend`/`stash`/`reset` (memory: parallel lanes have lost commits that way); verify `git log -1 --format=%s` after each commit; reformat nothing; rename nothing; edit no docstrings except the shim's. Review with `git diff --color-moved=dimmed-zebra <sha>^ <sha>`. `REPO="/Volumes/ASMT ASM246X Media/dataviz"`, `PY="$REPO/.venv/bin/python"` (spell the interpreter absolutely — bare `python` in `backend/` is NOT the venv), `SCRATCH=/private/tmp/claude-501/-Volumes-ASMT-ASM246X-Media-dataviz/41b94c9c-458e-4a07-82c6-90cc94bd82f3/scratchpad`. Run everything from a fresh branch off `main` (`feature/falkordb-provider-package`), not off `feature/connections-panel`.

| # | Commit | Files touched | Verify | Rollback |
|---|---|---|---|---|
| 0 | **Baseline** (no production code). (a) Unit-suite failure ledger: run V1+V2 (§7), save `failures-0.txt`. (b) Contract snapshot: run V3-plain first to *see* whether the 2026-05-10 snapshots still match HEAD; then V3-update to refresh; commit the refreshed `snapshots/falkordb/*.json` with a message that names the pre-refactor HEAD sha (the diff is the drift since May, not a regression). (c) Add `backend/tests/test_falkordb_cypher_golden.py`: a recording fake (same pattern as `test_cypher_shapes.py:_make_provider`) drives a fixed script of ~25 calls (get_node, get_nodes×3 shapes, get_edges, get_children(+cursor), get_children_with_edges, get_top_level_or_orphan_nodes(+entity_types, +cursor), get_nodes_by_layer, get_descendants, get_stats, get_counts_fast, get_ontology_metadata, ensure_indices, ensure_projections, trace_at_level, trace_closure, trace_closure_coarse, expand_aggregated, get_aggregated_edges_between, save_custom_graph, create_node, create_edge, `_type_casing_maps`) and pins every emitted Cypher string (+ params keys) to `backend/tests/golden/falkordb_cypher.json`. Capture with `UPDATE_CYPHER_GOLDEN=1`. This is the gate for steps 11–13. | `backend/tests/regression/snapshots/falkordb/*.json`, `backend/tests/test_falkordb_cypher_golden.py`, `backend/tests/golden/falkordb_cypher.json` | V1, V2, V3-plain, V4 | `git revert` |
| 1 | **Move the file**: `git mv backend/app/providers/falkordb_provider.py backend/app/providers/falkordb/provider.py`; add `falkordb/__init__.py` (imports `provider` and the export list); rewrite the shim `falkordb_provider.py` as re-exports (§2.4); fix the relative imports that break one directory deeper: L33 → `from backend.app.models.graph import …`, L45 → `from backend.common.interfaces.provider import GraphDataProvider` (what `.base` re-exports), L460 `.manager` → `backend.app.providers.manager`, L1583 + the 11 `..config` sites → `backend.app.config`, L3339/3346/3352 `.falkordb_deep_search` → `backend.app.providers.falkordb_deep_search`; update `test_falkordb_no_unlabeled_unwind_match.SCANNED_PATHS`. | 4 files + 1 test | V1, V2, V3-plain, V4, V5 (import smoke of the full export list against BOTH module paths), `git diff -M --stat` shows the rename | `git revert` (rename reverts cleanly) |
| 2 | **Dissolve the pre-class helpers** (L17–801) into `errors.py`, `hosts.py`, `knobs.py`, `cursors.py`, `rowmap.py` (+ kernel `backend/common/providers/rowmap.py`, `cursors.py`), `aggregation.py` gets `AggRunMeta`/`AggregationBatchAbort`/`_completed`, `closure.py` gets `_ClosureWalk` + `CLOSURE_*`; `provider.py` imports every name back so the class body is untouched. The two memo sets go to `schema.py` **now** (a module that exists from this step on, even if the mixin arrives in step 4) and `provider.py`/shim import the objects. | *(as landed: 10 new files — 8 in `falkordb/` + `backend/common/providers/{rowmap,cursors}.py` — plus `__init__.py` and `provider.py`; the shim itself needed no edit, since it re-exports from the package regardless of which submodule supplies a name)* | V1–V5 + memo-identity check (`falkordb_provider._UNLABELED_URN_UNSUPPORTED is falkordb.schema._UNLABELED_URN_UNSUPPORTED`, same for `_INDEX_HEALTH_LOGGED`, `_BULK_CREATE_KNOBS_CACHE`) | revert |
| 3 | **`ConnectionMixin`** → `connection.py` (L811–2077 + 11239–11333, byte-identical bodies; the class-body `from backend.app.config import resilience as _resilience` / `del _resilience` block moves into the mixin's class body). `provider.py` becomes `class FalkorDBProvider(ConnectionMixin, GraphDataProvider):` + the remaining areas. | `connection.py`, `provider.py` | V1–V5; `test_falkordb_run_guarded`, `test_falkordb_slow_query_log`, `test_falkordb_cluster_rotation`, `test_falkordb_pool_resilience`, `test_falkordb_empty_graph` individually first (they pin `_run_guarded`/chokepoint behaviour) | revert (LIFO if later carves exist) |
| 4 | `SchemaMixin` (C+J1) → `schema.py`; `OntologyMixin` (D) → `ontology.py` | *(as landed: 1 new — `ontology.py`; `schema.py` already existed from step 2, so this step only adds the mixin's methods to it)*, `schema.py`, `provider.py` | V1–V5; `test_ensure_indices_onboarding` (caplog logger name!) | revert |
| 5 | `CacheMixin` (E) → `caches.py`; `AncestorMixin` (J2) → `ancestors.py` | 2 new + `provider.py` | V1–V5; `test_provider_cache_namespacing`, `test_falkordb_ancestors_cache_reset`, `test_trace_v2_invalidation` (ledger-known failure only) | revert |
| 6 | `ReadMixin` (F+G) → `reads.py`; `BrowseMixin` (H) → `browse.py`; `SimpleLineageMixin` (I) → `lineage_simple.py` | 3 new + `provider.py` | V1–V5; `test_cypher_shapes`, `test_top_level_provider_kwargs`, `test_keyset_cursor*` | revert |
| 7 | `AggregationMixin` (K) → `aggregation.py` | *(as landed: 0 new — `aggregation.py` already existed from step 2; this step adds the mixin's methods to it)*, `provider.py` | V1–V5; `test_falkordb_ondemand_pairs`, `test_falkordb_delete_hook_canonical`, `test_purge_epoch`, `test_falkordb_materialize` | revert |
| 8 | `TraceMixin` (L) → `trace.py`; `ClosureMixin` (M) → `closure.py` | *(as landed: 1 new — `trace.py`; `closure.py` already existed from step 2, so this step adds the mixin's methods to it)*, `provider.py` | V1–V5; `test_trace_closure_completeness`, `test_trace_waves`, `test_falkordb_trace_structural`, `test_trace_v2_falkordb` | revert |
| 9 | `DrillMixin` (N+O) → `drill.py`; `StatsMixin` (P) → `stats.py`; `NavigationMixin` (Q) → `navigation.py`; `WriteMixin` (R) → `writes.py`. `provider.py` is now the bases tuple + docstring only. | 4 + `provider.py` | V1–V5; `test_falkordb_counts_fast`, `test_falkordb_write_casing`, `test_falkordb_edge_labeling`, `test_falkordb_native_properties` | revert |
| 10 | **Guards + in-family repoints**: add `falkordb/_state.py` (`_FalkorState` Protocol, §2.3) and `backend/tests/test_falkordb_package_guards.py` (§6.1). Repoint the three in-family satellites so the shim is external-facing only: `falkordb_connection.py:1380` → `backend.app.providers.falkordb.errors` (stays lazy), `falkordb_deep_search.py:66` → `backend.app.providers.falkordb.rowmap`, `falkordb_materialize.py:1176/1590/2036` → `backend.app.providers.falkordb.rowmap`. | `_state.py`, 1 test, 3 one-line import edits | V1–V5 + the new guard test; import-order smoke both ways (`import falkordb_connection` first, then the package; and the reverse) | revert |
| 11 | **Executor seam**: `backend/common/providers/cypher/{__init__,executor}.py`, `falkordb/executor.py`, `executor`/`projection_executor` cached properties on `ConnectionMixin`, `_proj_query(..., op=None)` additive kwarg; `backend/tests/test_falkordb_executor.py` (fake graph → `result_set` identity, readonly/write routing, tolerant path, stubbed `_ro_query` still intercepts). **No call sites change.** | *(as landed: 3 new — `cypher/__init__.py`, `cypher/executor.py`, `falkordb/executor.py`)*, `connection.py`, `_state.py`, 2 tests (`test_falkordb_executor.py` + `test_falkordb_kernel_purity.py`, the latter added mid-task) | V1–V5, V4 golden unchanged | revert |
| 12 | **Dialect seam**: `backend/common/providers/cypher/dialect.py`, `falkordb/dialect.py`, `dialect` cached property; route the *statement-level* fragments through it: labels (4820, 4939, 10244, 10825), rel types (10247, 10464, 10821), indexes (4235), node index DDL (2275, 4185, 4906), unlabeled probe (4199), edge index DDL (2291–2300), "already indexed" predicate (2267), `label_union` builder (3187–3206, 3906, 4003, 10786–10790), negation predicate (3870). ~20 sites, each replaced by a call that returns the identical string. | *(as landed: 2 new)*, `schema.py`, `reads.py`, `browse.py`, `navigation.py`, `stats.py`, `aggregation.py`, `connection.py` (the `dialect` cached property — not `writes.py`, which the task found no routable site in and left bare, with a comment explaining why), 1 test | **V4 golden must be byte-identical**, V1–V3, V5 | revert |
| 13 | *(optional pilot, recommended)* `stats.py` end-to-end on the seams: its 9 chokepoint calls → `self.executor.run(...)`/`run_tolerant`, `.result_set` reads unchanged (aliased). Proves the PR-3 lift pattern on a module the contract snapshot covers (`get_stats`, `discover_schema_subset`). | `stats.py` | V1–V5 + golden | revert |
| 14 | *(optional; recommend deferring to PR 3)* expression-level routing (`labels(x)[0]` 49 sites, `id(r)` 13, `type(r)` 49) — mechanical, golden-gated, but 110 edits in 9 modules is the least reviewable commit of the set and PR 3 touches every one of those sites anyway when it lifts the module. | — | — | — |
| 15 | **Finish**: shim's export list grouped + documented (no `DeprecationWarning` — 40+ test files still import it directly); `falkordb/__init__.py` gets a narrowed `__all__` (10 genuinely-public names of the 40, by the leading-underscore convention) plus both modules' docstrings rewritten to state the export contract inline instead of citing the (git-ignored, session-only) planning directory; `docs/BACKEND.md` §3 gains the package layout, the two seams, and a query-plan-profiling howto; four more factually-wrong doc lines fixed (`DEVELOPER_GUIDE.md`, `docs/BACKEND.md` ×2, `docs/versioning/04-projection-and-cache.md` ×2); the same git-ignored-citation defect swept and fixed across 15 more package modules and 4 test files (found by grep, not by trusting this table); `_is_cluster_redirect` + `_CLUSTER_REDIRECT_EXC_NAMES` deleted as dead code (own commit); this table's own step 2/4/7/8/11/12 file counts corrected against `git diff-tree`, and this V5 script repointed at guard 6. *(as landed — considerably more than the original 3-line estimate; every task in this plan found more than its brief named, and the finishing task was no exception.)* | shim, `__init__.py`, `errors.py`, 15 mixin modules + `dialect.py` (citations only), 4 test files (citations only), `DEVELOPER_GUIDE.md`, `docs/BACKEND.md`, `docs/versioning/04-projection-and-cache.md`, this plan doc | V1–V5, V6 live probes (§7) | revert |

14 required commits (0–12, 15) + the optional pilot (13) = 15 — at the budget; step 14 is deferred to PR 3.

### 6.1 Guard tests to add (`backend/tests/test_falkordb_package_guards.py`, AST/grep-based, no conftest dependency like `test_falkordb_no_unlabeled_unwind_match.py`)

1. **No private imports from the shim in non-test app code** — parse every `.py` under `backend/app` and `backend/common`; fail on `from backend.app.providers.falkordb_provider import _x` / `import … as` of a private name, **except** the allow-list of today's 9 outside consumers (§5.1) which PR 2 removes; the allow-list is the PR-2 to-do.
2. **Every `self._x` read in every mixin resolves** — for each module in `falkordb/`, collect attribute reads on `self`; each must be (a) assigned in `ConnectionMixin.__init__`, (b) in the late-assigned allow-list from `_state.py` *and* read through `getattr(self, name, …)` or inside a documented raising accessor (`_get_containment_edge_types`), (c) a method/property somewhere in the MRO of `FalkorDBProvider`, or (d) a class constant on some mixin. Also assert the composed class defines each `_FalkorState` member.
3. **Module memo sets are single-instance** — identity assertions listed in step 2; plus a grep that `_UNLABELED_URN_UNSUPPORTED: set = set()` / `_INDEX_HEALTH_LOGGED` / `_BULK_CREATE_KNOBS_CACHE` are *defined* in exactly one module of the package.
4. **No module-level import of the satellites from the package** (`falkordb_deep_search`, `falkordb_materialize`, `falkordb_connection`, `manager` must appear only inside function bodies in `falkordb/*.py`) — the cycle guard.
5. **No relative `..config` / `..models` imports** in `falkordb/*.py` (they would silently resolve to the wrong package one level deeper).
6. **Export-list smoke** — for every name in §2.4, `getattr(falkordb_provider, name)` is `getattr(falkordb, name)` (same object).
7. **Executor identity** — `FalkorDBExecutor.run` returns a `CypherResult` whose `result_set is raw.result_set`.

---

## 7. Verification protocol (exact commands)

Facts: `backend/pytest.ini` → `testpaths = tests`, `asyncio_mode = auto`, marker `integration`; `backend/tests/conftest.py` inserts the repo root on `sys.path` and sets `JWT_SECRET_KEY`/`AUTH_COOKIE_SECURE` (run from `backend/` or with `backend/tests/...` paths — both pick up the ini). CI (`.github/workflows/backend-tests.yml`) runs two jobs from `backend/`: the **required** `python -m pytest tests/ -q -m "not integration" -k "falkordb or preflight or warmup or circuit or redis or bus or provider or probes or manager or aggregation or insights"` and the informational full `python -m pytest tests/ -q -m "not integration"` (continue-on-error). `alembic-guards.yml` is unrelated. No `Makefile`/`scripts/*.sh` pytest gate exists. Host venv has `falkordb`, `redis 7.2.0`, pytest; the viz-service container currently has **no** pytest (memory 2026-08-21) — unit tests run on the host.

```bash
REPO="/Volumes/ASMT ASM246X Media/dataviz"; PY="$REPO/.venv/bin/python"
SCRATCH="/private/tmp/claude-501/-Volumes-ASMT-ASM246X-Media-dataviz/41b94c9c-458e-4a07-82c6-90cc94bd82f3/scratchpad"
K='falkordb or preflight or warmup or circuit or redis or bus or provider or probes or manager or aggregation or insights'

# V1 — CI-required subset (must be identical to baseline, expected green)
cd "$REPO/backend" && "$PY" -m pytest tests -q -m "not integration" -k "$K" -p no:cacheprovider -rfE 2>&1 | tee "$SCRATCH/v1-step-N.txt"
# V2 — full unit suite; compare the FAILED/ERROR set, not the count
cd "$REPO/backend" && "$PY" -m pytest tests -q -m "not integration" -p no:cacheprovider -rfE 2>&1 | tee "$SCRATCH/v2-step-N.txt"
grep -E '^(FAILED|ERROR) ' "$SCRATCH/v2-step-N.txt" | sed 's/ - .*//' | sort > "$SCRATCH/failures-N.txt"; diff "$SCRATCH/failures-0.txt" "$SCRATCH/failures-N.txt"   # must be empty
# V3 — live contract snapshot (dev FalkorDB is up: synodic-falkordb-dev, localhost:6379; the fixture creates+deletes graph test_regression_<pid>)
cd "$REPO" && FALKORDB_HOST=localhost FALKORDB_PORT=6379 "$PY" -m pytest backend/tests/regression/test_falkordb_provider_contract.py -v -p no:cacheprovider            # plain (after every step)
cd "$REPO" && UPDATE_PROVIDER_SNAPSHOTS=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 "$PY" -m pytest backend/tests/regression/test_falkordb_provider_contract.py -v   # step 0 ONLY; then `git diff --stat backend/tests/regression/snapshots`
# V4 — Cypher-text golden (added in step 0; UPDATE_CYPHER_GOLDEN=1 only in step 0)
cd "$REPO" && "$PY" -m pytest backend/tests/test_falkordb_cypher_golden.py backend/tests/test_falkordb_no_unlabeled_unwind_match.py backend/tests/test_falkordb_package_guards.py -q
# V5 — import-time smoke, both paths, both import orders. NAMES is the
# measured 40-name export surface — imported from
# backend/tests/test_falkordb_package_guards.py's guard 6 (`_EXPORT_SURFACE`)
# rather than retyped here, so this script cannot drift from that test; a
# name added to (or dropped from) the real surface changes NAMES the next
# time this runs instead of silently going stale. (An earlier version of
# this list included `_is_cluster_redirect`, which was never re-exported by
# either module and is now deleted as dead code — running the old literal
# list raised AttributeError.)
cd "$REPO" && "$PY" - <<'EOF'
import importlib
import sys
sys.path.insert(0, "backend/tests")
from test_falkordb_package_guards import _EXPORT_SURFACE as NAMES
import backend.app.providers.falkordb_connection            # the back-import direction first
shim = importlib.import_module("backend.app.providers.falkordb_provider")
pkg  = importlib.import_module("backend.app.providers.falkordb")
for n in NAMES:
    a = getattr(shim, n); b = getattr(pkg, n, a); assert a is b, n
print("ok", len(NAMES))
EOF
```

**V6 — live probes against the running dev stack (steps 1, 9, 12, 15).** The container bind-mounts `backend/` but gunicorn `--reload` does not reload; after each checkout: `docker exec -i synodic-dev-viz-service-1 python -c "import os, signal; os.kill(1, signal.SIGHUP)"` and prove the worker pids changed (memory `viz-service-no-hot-reload`). Login is cookie-based (`POST /api/v1/auth/login` with `.env.dev` admin creds, then `-b jar -H "X-CSRF-Token: $(awk '$6=="nx_csrf"{print $7}' jar)"`), and **every graph route needs `?dataSourceId=<ds>`** (memory `graph-routes-need-datasourceid`; else it silently hits the workspace primary). Capture each response to `$SCRATCH/probe-before/*.json` on `main` and `$SCRATCH/probe-after/*.json` after step 15; `diff -r` must be empty (strip timing fields such as `elapsedMs`, `lastMaterializedAt`):

- roots: `GET /api/v1/{ws}/graph/nodes?…` top-level listing (route at `graph.py:1141`) and `GET …/nodes/{urn}/children` (1315), `…/children-with-edges` (1338), `…/nodes/{urn}/parent` (1301), `…/nodes/by-layer/{layer}` (1833)
- trace: `POST …/trace/closure` (858) with the Lens's one-hop body — or simply `scripts/trace_live_probe.py page WS DS URN --depth 1` before/after; `POST …/trace/v2` (815), `…/trace/expand` (964)
- aggregated: `POST …/edges/aggregated` (2367), `POST …/edges/between` (1879)
- search: `POST …/search` (1398), `…/search/explain` (1550), `GET …/search/discover` (1600)
- schema/stats: `GET …/metadata/schema` (2165), `GET …/introspection` (2051)
- planner: `"$PY" backend/scripts/check_trace_query_plans.py --workspace dev` (PROFILE, fails on any `AllNodeScan`) before/after — the index-seek shapes are exactly what the dialect routing must not alter.

Integration files (`backend/tests/integration/test_trace_closure_live.py`, `test_aggregation_pipeline_live.py`, `test_source_alignment_live.py`, `test_topologies.py`, `test_versioning_roundtrip_fidelity.py`) run **per file** (cross-file event-loop pollution — memory) on the host: `cd "$REPO" && GRAPHVER_E2E=1 FALKORDB_HOST=localhost "$PY" -m pytest backend/tests/integration/<file> -q` — run at steps 9 and 15 (they need the dev Postgres/FalkorDB; `gvt_*` graph names are swept).

---

## 8. Risk register

| # | Risk | Evidence | Mitigation in this plan |
|---|---|---|---|
| R1 | **Import cycle** through the shim: `falkordb_deep_search.py:66` imports the shim at module level; the package's `deep_search` shims import `falkordb_deep_search` lazily (3339–3352); `falkordb_connection.py:1380` imports classifiers lazily while `connection.py` imports `falkordb_connection` lazily 13× | AST map | keep every satellite import lazy (guard #4); step 10 repoints the three in-family imports to leaf modules (`errors.py`, `rowmap.py`) so no satellite imports the shim; V5 imports in both orders |
| R2 | **Relative imports silently resolve elsewhere** one directory deeper (`..config` → would mean `backend.app.providers.config`, `.base`, `.manager`, `.falkordb_deep_search`) | 16 sites (§0) | rewritten to absolute in step 1; guard #5 |
| R3 | **Late-assigned attributes** read from a mixin before the lifecycle `set_*` ran, or on `__new__`-built test instances | 19 attrs; 3 `__new__` tests | mixins keep the exact `getattr(self, …, default)` reads; `_state.py` lists the 19 with their default; guard #2 |
| R4 | `_proj` property + "call must reference `self._graph`/`self._proj` lazily" contract of `_run_guarded` (L1703) | docstring | executor keeps the per-call closure pattern; the chokepoints themselves do not move out of `ConnectionMixin` in PR 1 |
| R5 | **Module memo sets duplicated** by the split (a second `set()` in the shim = per-server facts re-probed and re-logged per graph) | L54–55, L80 | defined once in `schema.py`/`knobs.py`; shim re-exports the objects; guard #3 + memo-identity check in step 2 |
| R6 | Tests that patch by string path / read module globals | `asyncio.sleep` ×2 (works if the shim imports `asyncio`), `fp._BULK_CREATE_KNOBS_CACHE.clear()` ×4 (same-object re-export), `fp.CLOSURE_QUERY_CAP_SECS` (read-only re-export), `fp._normalize_falkordb_host` | §2.4 export list; V5 |
| R7 | Source-text lint goes vacuous | `test_falkordb_no_unlabeled_unwind_match.py:44` | glob the package in step 1 |
| R8 | **Stale contract baseline** — snapshots from 2026-05-10; the first plain run on HEAD may already fail | git log | step 0 refreshes on HEAD *before* any move and commits the refresh separately; the plan is invalid if the refresh is skipped |
| R9 | **Logger name changes** — `logging.getLogger(__name__)` per module would rename records from `backend.app.providers.falkordb_provider` to `backend.app.providers.falkordb.<area>`; `test_ensure_indices_onboarding.py:118,129` filter on the old name; ops dashboards may too | grep | `falkordb/_log.py` keeps the historic name for every module in PR 1 (`getLogger("backend.app.providers.falkordb_provider")`); renaming (and updating the two caplog sites) is a deliberate PR-2 change, not a side effect |
| R10 | `FalkorDBProvider.__module__` changes (`repr`, exception tracebacks, `inspect.getsource` paths) | — | `isinstance` and identity are unaffected (one class object); `inspect.getsource(FalkorDBProvider.list_graphs)` (`test_worker_warmup_and_falkor_probe.py:214,225`) resolves through the MRO to `connection.py` |
| R11 | **Performance** — mixins add no per-call cost (MRO lookups are cached); the executor adds one call + one dataclass per *query*, never per row | design | `result_set` aliased (guard #7); no swap of the 119 call sites in PR 1, so the hot paths are literally unchanged |
| R12 | Class constants split across mixins (`__init__` at L973 reads `_MERGE_SUB_BATCH_SIZE`, defined in the aggregation area; satellites read `p._MERGE_SUB_BATCH_*`; `test_trace_v2_invalidation` reads a constant that does not exist) | AST | constants stay on the mixin that owns the area; resolution via the composed class is identical; guard #2 checks the composed class has them |
| R13 | Reviewability | 11,333 lines moving | each carve is a contiguous byte-identical block (same indentation); commit messages name the source line range; `--color-moved=dimmed-zebra` review; ±0 net lines per carve |
| R14 | Merge conflicts with in-flight provider work | only `origin/claude/contextviewcanvas-search-upgrade-nxrhct` (2 commits) touches the provider off `main` | land PR 1 from `main` after that branch merges, or rebase it onto the package (conflicts are mechanical: the same method bodies in new files) |
| R15 | The contract runner pins only 14 behaviours (no top-level listing, no `trace_closure`, no aggregated-between-after-materialize, no deep search, no `get_counts_fast`) | `_runner.py:46–131` | the step-0 Cypher golden covers the *shape* of the rest; **recommendation (scope addition for the lead to approve)**: extend `_runner.py` in step 0 with `get_top_level_or_orphan_nodes`, `get_nodes_batch`, `get_descendants`, `get_nodes_by_layer`, `get_ontology_metadata`, `get_counts_fast`, `get_node_degrees`, `trace_closure`, `trace_closure_coarse`, `expand_aggregated`, and `get_aggregated_edges_between` after `materialize_aggregated_edges_batch` — the snapshot test then gates PR 3 as well |
| R16 | Dev-stack caveats: workers don't hot-reload (SIGHUP via Python, no `kill`/`ps` in the image); FalkorDB OOM refuses writes (`save_custom_graph` in the contract fixture would fail — check `INFO memory` first); the external volume can unmount mid-session | memories | V6 recipe; run V3 early in each session |

---

## 9. Decisions for the lead (answer before step 0)

1. Approve the **snapshot refresh on HEAD** as commit 0 (R8) — required.
2. Approve extending `_runner.py` (R15) — recommended, no production code.
3. Pilot module on the seams (step 13, `stats.py`) — recommended.
4. Repoint the three in-family satellite imports in PR 1 (step 10) — recommended; otherwise the shim stays on the runtime path of the package itself.
5. Logger-name policy (R9) — plan keeps the old name.
6. Expression-level dialect routing (step 14) — plan defers to PR 3.

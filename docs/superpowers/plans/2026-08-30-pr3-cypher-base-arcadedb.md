# PR 3 — `CypherGraphProvider` (lifted from FalkorDB) + ArcadeDB provider (full-parity tier)

Read-only design plan, revision 2 (folds in the three course corrections: base = the FalkorDB package's dialect-neutral modules lifted; seam = provider methods with positional rows; declarative dialect + conformance kit for future Cypher engines). Every code fact is cited `file:line` against `feature/connections-panel` (`69115b5f`). No repo file has been edited.

## 0. Framing

**Architecture in one paragraph.** PR 1 splits `backend/app/providers/falkordb_provider.py` (11,333 lines) into a package and puts an executor/dialect seam behind its five query chokepoints `_ro_query` / `_ro_query_tolerant` / `_query` / `_proj_ro_query` / `_proj_query` (`falkordb_provider.py:1865-2077`), classifying every method G (generic algorithm) / F (FalkorDB-specific) / GF (generic with a FalkorDB fast path). PR 3 **lifts the G modules into `backend/graph/adapters/cypher/`** as `CypherGraphProvider`, whose every contract method is written in standard openCypher — byte-identical Cypher to today's FalkorDB text, only the call target changes (`self._ro_query(` → `self._run_read(`). `FalkorDBProvider(CypherGraphProvider)` becomes client #1 (keeps its F modules and overrides only where it has a native fast path); `ArcadeDBProvider(CypherGraphProvider)` is client #2 (executor over HTTP + a dialect + a descriptor); Neo4j is the documented follow-up (§11). A future engine (Memgraph, Kùzu, Apache AGE) needs an executor + a dialect + a descriptor and, in the common case, zero method overrides (§6).

**Feature tier = FalkorDB parity.** The app consumes these optional provider features via `hasattr`/`getattr` (grep over `backend/app`): `set_containment_edge_types`, `set_entity_type_levels`, `set_resolved_edge_metadata`, `set_source_type_aliases`, `set_node_identity`, `set_ontology_rules` (versioned write-through only), `ensure_indices`, `stamp_identity_urns` (`worker.py:370`), `set_admission_controller` (`worker.py:384`), `materialize_aggregated_edges_batch` (`worker.py:1374`, `context_engine.py:856`), `trace_closure` / `trace_closure_coarse` (`context_engine.py:1391-1421`), `get_node_degrees` (`context_engine.py:832`), `get_counts_fast` (`reconcile_sweeper.py:628`), `physical_graph_id` (`graph.py:611`), `inflight_ops` (`manager.py:937`), `clear_content_caches` (`aggregation/service.py:1824`), and the private `TraceResult` extras `_mega_nodes` / `_fallback_level` (`context_engine.py:1484-1485`). The base implements all of them; each is a capability flag on the PR-2 descriptor.

**Harness constraints that shape the design** (from the test explorer, verified by grep over `backend/tests`): fakes are ASSIGNED onto provider instances — `._ensure_connected =` (37 sites), `._redis =` (28), `._ro_query =` (26), `._proj_ro_query =` (23), `._query =` (9), `._label_buckets =` (8), `._aggregation_run_meta =` (5), `._proj_query =` (4), `._compute_and_store_ancestors_bulk =` (4), `._get_cached_label =` (2), `._resolve_urn_labels_bulk =` (1) — returning objects with a positional `.result_set` list-of-lists (`test_falkordb_ondemand_pairs.py:36-38`) and dispatching by regex on the Cypher text. Therefore: (1) the seam is **provider methods**, resolved at call time; (2) the base's lifted helpers **keep their FalkorDB names** (`_label_buckets`, `_aggregation_run_meta`, `_compute_and_store_ancestors_bulk`, `_get_cached_label`, `_resolve_urn_labels_bulk`, `_redis`, `_ensure_connected`) — no renaming into helper classes; (3) rows are positional; (4) Cypher text is byte-identical after lifting. The CI lane runs `-k "falkordb or preflight or warmup or circuit or redis or bus or provider or probes or manager or aggregation or insights"` (`.github/workflows/backend-tests.yml:50`), so new test files are named `test_cypher_provider_base_*.py` / `test_arcadedb_provider_*.py` / `test_provider_dialect_conformance.py`. `backend/app/providers/` is a namespace package (no `__init__.py`) — leave it so.

**Placement.** `backend/graph/adapters/cypher/` (the lead's default). FalkorDB *can* depend on it: `backend/app/providers` already imports `backend.graph.adapters.*` (`manager.py:1213`, `:1240`) and `backend/graph/adapters` already imports app modules lazily (`neo4j_provider.py:98`), so no new dependency direction is introduced. The one rule that makes this safe for every process that imports FalkorDB (viz-service, workers, control plane, stats-service — memory `worker-boot-jwt-secret-isolation`): **no module-level `backend.app` import anywhere under `cypher/`**, enforced by a source-text test (§10.1). The lifted code's function-level `backend.app.*` imports (list in §1.3) stay lazy; PR 1 should move the pure ones to `backend/common/`. `backend/common/providers/cypher/` would be equally valid (it is a kernel like `trace_orchestrator.py`, and `common` already imports `graph.adapters` at `schema_introspection.py:20`); the only argument for it is symmetry with the other kernels — not strong enough to deviate from the lead's default.

**Non-goals.** Bolt executor implementation (seam only); `dedicated` projection on ArcadeDB (capability off; `set_projection_mode("dedicated")` raises `ProviderConfigurationError`); FalkorDB cluster/sentinel analogues; SchemaMapping Mode B (Neo4j follow-up seam).

**Size.** ~9-11k lines of behaviour move (the G share of `falkordb_provider.py` + `falkordb_deep_search.py` 3,604 + a generic materialiser). §12 orders five independently mergeable milestones behind capability flags.

---

## 1. The lifted base — module set, seam, placement

### 1.1 `backend/graph/adapters/cypher/` — one mixin per lifted module, method names preserved

```
cypher/
  __init__.py
  result.py        CypherResult (falkordb.QueryResult duck), CypherNode (falkordb.Node duck), CypherRel (falkordb.Edge duck),
                   EmptyResult; ErrorKind enum; CypherError hierarchy
  dialect.py       CypherDialect frozen dataclass + Stmt templates (§3); FALKORDB_DIALECT lives here too (PR 1 may own it)
  timeouts.py      CypherTimeouts (the ..config.resilience constants the lifted code reads, as a value object)
  base.py          CypherGraphProvider(_ReadsMixin, _ContainmentMixin, _LineageMixin, _LabelsMixin, _AncestorsMixin,
                   _AggregationMixin, _TraceMixin, _ClosureMixin, _WritesMixin, _IntrospectionMixin, _DeepSearchMixin,
                   GraphDataProvider) — constructor, injection setters, the abstract seam (§2), capability properties
  reads.py         _ReadsMixin: get_node, get_nodes, search_nodes, get_edges, get_nodes_batch, get_node_degrees,
                   get_distinct_values, get_nodes_by_tag, get_nodes_by_layer, filters   (falkordb_provider.py:2994-3460, 10038-10117, 10593-10801)
  containment.py   _ContainmentMixin: get_children, get_children_with_edges, get_parent, get_top_level_or_orphan_nodes,
                   get_ancestors, get_descendants                                           (:3462-4038, 10675-10725)
  lineage.py       _LineageMixin: _traverse_lineage, get_upstream/downstream/full_lineage, get_trace_lineage (:4040-4158, 6595-6813)
  labels.py        _LabelsMixin: _cache_ns/physical_graph_id, _urn_label_key, _cache_urn_label(s_bulk), _get_cached_label,
                   _label_buckets, _resolve_urn_labels_bulk, _type_casing_maps, _consistent_casing (:2772-2993, 4743-4890, 10808-10849)
  ancestors.py     _AncestorsMixin: _ancestors_cache_key, _get_ancestor_chain, _compute_ancestor_chain,
                   _compute_and_store_ancestors_bulk, _compute_ancestor_chains_bulk_cypher, _ancestor_cache_ttl,
                   _containment_hop_bound, _get_ancestor_dag_pair, _resolve_chain_levels, _collect_ancestor_urns (:4346-4611, 5137-5245, 9372-9418)
  aggregation.py   _AggregationMixin: _aggregation_run_meta + AggMeta helpers, _hook_pairs, on_lineage_edge_written/deleted,
                   on_containment_changed, count/purge_aggregated_edges, get_aggregated_edges_between + _synthesize_*,
                   _rows_to_aggregated_result, idempotency backend seam                    (:2818-2953, 5194-5865, 6104-6593)
  materialize.py   generic keyset-scan v3 pipeline behind materialize_aggregated_edges_batch (§7.4)
  trace.py         _TraceMixin: _check_levels_backfilled, _resolve_root_anchor, _types_at_level, trace_at_level,
                   expand_aggregated, _resolve_anchor_at_level, _has_aggregated_at_level, _find_ancestor_with_lineage,
                   _expand_aggregated_set, _edge_depth_stamps, _frontier_depths_from_stamps, _collect_children_pair,
                   _collect_descendants_pair_at_level, _collect_level_and_subtree, _edges_between_sets(_once),
                   _fetch_containment_edges                                                 (:2392-2513, 6830-7294, 7964-8619, 9420-10036)
  closure.py       _ClosureMixin: _ClosureWalk, trace_closure, trace_closure_coarse, _lineage_degrees, _walk_anchors,
                   _walk_estimate, _file_cut, _expand_prefix, _commit_rows, _hub_page, _expand_raw_lineage_set,
                   _collect_lineage_seed, _descendant_lineage_seed, _page_raw_lineage_single  (:763-801, 7296-7962, 8639-9370)
  writes.py        _WritesMixin: ensure_indices, ensure_projections, stamp_identity_urns, _bulk_write_batch, save_custom_graph,
                   create_node, create_edge, update_edge, delete_edge                      (:2101-2313, 4165-4213, 10851-11233)
  introspection.py _IntrospectionMixin: get_stats, get_counts_fast, prime_stats_cache, get_schema_stats,
                   get_ontology_metadata, discover_schema (via SchemaIntrospector), clear_content_caches (:5610-5639, 10125-10591)
  deep_search.py   falkordb_deep_search.py lifted (3,604 lines) — transport + 4 dialect touches (§8);
                   _DeepSearchMixin: deep_search / deep_search_explain / deep_search_discover (:3330-3356)
  rowmap.py        ONLY if PR 1 did not move _node_from_props/_edge_from_row/_split_user_properties/_compute_searchable_text/
                   _RESERVED_NODE_KEYS (:466-760) and the keyset cursor codec (:141-255) into backend/common/providers/
```

Mixins are the lifting unit: each is the FalkorDB module's G methods with `self._ro_query(` → `self._run_read(` (and the four siblings, §2) as the *only* edit, plus the dialect-fragment substitutions listed in §4. Method names, argument names, docstrings and Cypher text are otherwise preserved so the 62 instance-patched test sites and every regex fake keep working on `FalkorDBProvider` after it inherits from the base.

### 1.2 What `CypherGraphProvider.__init__` takes

```python
class CypherGraphProvider(...mixins..., GraphDataProvider):
    def __init__(self, *, dialect: CypherDialect, graph_name: str, provider_name: str,
                 timeouts: CypherTimeouts, cache_redis: Optional[Any] = None,
                 codec: Optional[NodeCodec] = None, provider_id: Optional[str] = None) -> None:
        self._dialect = dialect
        self._graph_name = graph_name            # name preserved: lifted code logs/keys on it (:2792, :6039, …)
        self._timeouts = timeouts
        self._redis = cache_redis                # name preserved: 28 patch sites; None = no cache Redis
        self._inflight = 0
        # injection state, verbatim from :976-998 and the setters (:2319-2622)
        self._resolved_containment_types: Set[str] = set(); self._resolved_containment_types_set = False
        self._entity_type_levels: Dict[str, int] = {}; self._level_digest = None; self._levels_backfilled = None
        self._resolved_edge_metadata = {}; self._resolved_lineage_types = set(); self._resolved_edge_metadata_set = False
        self._source_rel_aliases = {}; self._source_entity_aliases = {}; self._observed_rel_types = set()
        self._node_identity_property = "urn"; self._name_property = "name"
        self._projection_mode = "in_source"; self._admission_controller = None
        self._urn_label_lru = _URNLabelCache(50_000)   # neo4j_provider.py:134-165 — the L1 in front of the Redis hash;
                                                        # consulted ONLY when self._redis is None (FalkorDB behaviour unchanged)
```

`FalkorDBProvider.__init__` keeps its own signature and calls `super().__init__(dialect=FALKORDB_DIALECT, graph_name=graph_name, provider_name="FalkorDBProvider", timeouts=CypherTimeouts.from_resilience(), cache_redis=None)` and assigns `self._redis` later in `_ensure_connected` exactly as today (`build_cache_client`). `_READ_TIMEOUT`/`_WRITE_TIMEOUT` (`:1583`) stay FalkorDB attributes read by its chokepoints.

### 1.3 App-level values the lifted code reads (function-level imports today) and where they go

| Import in lifted code | Sites | Disposition |
|---|---|---|
| `from ..config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS` (`:3538`, `:3647`, `:10050`), `FALKORDB_TOP_LEVEL_{QUERY,COUNT}_TIMEOUT_SECS` (`:3818`), `AGGREGATED_EDGE_PAGE_SIZE` / `AGGREGATED_EDGE_RESULT_CAP` / `AGGREGATED_SOURCE_URN_BATCH_SIZE` (`:5882`, `:6172`, `:6505`, `:6567`), `FALKORDB_EDGES_BETWEEN_TIMEOUT` (`_EDGES_BETWEEN_TIMEOUT`, `:3383`), `FALKORDB_SLOW_QUERY_MS` (`:1835`), `FALKORDB_SERVER_TIMEOUT_MAX_MS` (`:1600`) | 11 | `CypherTimeouts` value object (`cypher/timeouts.py`): fields `children_query_s, top_level_query_s, top_level_count_s, edges_between_s, stats_query_s, agg_page_size, agg_result_cap, agg_source_batch, slow_query_ms`; `CypherTimeouts.from_resilience()` (FalkorDB — identical values) and `.from_env("ARCADEDB")` with the same defaults. Call sites become `self._timeouts.children_query_s` — Cypher unchanged |
| `backend.app.providers.index_policy` (`:2230`, `:10758`) | 2 | pure module — PR 1 moves it to `backend/common/providers/index_policy.py`; else lazy absolute import |
| `backend.app.services.ontology_levels` (`compute_level_digest` `:2358`, `UNKNOWN_LEVEL` `:5393`) | 2 | pure — move to common (PR 1) or lazy |
| `backend.app.services.node_identity` defaults (`:2614`) | 1 | constants — `common/providers/identity.py:26-27` already defines `DEFAULT_IDENTITY_PROPERTY`/`DEFAULT_DISPLAY_NAME_PROPERTY`; use those (note the name default is `"name"` in the app module vs `"displayName"` in common — keep the app semantics: source property default `name`) |
| `backend.app.services.aggregation.cancel.JobCancelled` (`:4676`, `:5702`) | 2 | exception class — move to `backend/common/` (PR 1) or lazy |
| `backend.app.services.deep_search` (`get_deep_search_settings` `:513`; `CompileError` + settings in `falkordb_deep_search.py:67`) | 2 | settings are env-driven pydantic — move to common (PR 1) or lazy; `deep_search/contracts.py:19-21` already says each provider re-exports `CompileError` |
| `backend.common.adapters` (`ProviderLoading`, `ProviderBusy`) | — | already common |
| `falkordb_connection`, `.manager`, `falkordb_materialize` | — | F code; stays in the FalkorDB package |

---

## 2. The executor seam — Protocol signatures, `CypherResult`, error classification

The seam is a set of **methods on the provider instance**; a detached executor object would bypass instance-patched fakes. `CypherExecutor` is a `typing.Protocol` that the provider class itself satisfies; `CypherGraphProvider` declares them abstract.

```python
class CypherExecutor(Protocol):
    # --- the five chokepoints (mirror falkordb_provider.py:1865-2077 one-to-one) ---
    async def _run_read(self, cypher: str, params: Optional[dict] = None, *,
                        timeout: Optional[float] = None, op: Optional[str] = None,
                        columns: Optional[Sequence[str]] = None,
                        language: Optional[str] = None) -> CypherResult: ...
    async def _run_read_tolerant(self, cypher, params=None, *, timeout=None, op=None,
                                 columns=None, language=None) -> CypherResult: ...   # missing graph / unknown type -> EmptyResult
    async def _run_write(self, cypher, params=None, *, timeout=None, op=None,
                         columns=None, language=None) -> CypherResult: ...
    async def _run_read_proj(self, cypher, params=None, *, timeout=None, op=None,
                             columns=None, language=None) -> CypherResult: ...      # projection target; default = _run_read
    async def _run_write_proj(self, cypher, params=None, *, timeout=None, op=None,
                              columns=None, language=None) -> CypherResult: ...     # default = _run_write
    # --- lifecycle / classification (names preserved from FalkorDB) ---
    async def _ensure_connected(self) -> None: ...
    async def _is_verified_missing_graph(self, exc: BaseException) -> bool: ...     # :1932 — the ONLY masking predicate
    def _classify_error(self, exc: BaseException) -> ErrorKind: ...                # transient | loading | auth | missing_graph | unknown_type | syntax | timeout | other
    def inflight_ops(self) -> int: ...
    def physical_graph_id(self) -> str: ...
```

Deviations from the lead's sketch, on purpose: the kwarg is `timeout=` (seconds) not `timeout_s=` — the lifted call sites pass `timeout=t` at ~200 places (`:3539`, `:3648`, `:3933`, `:5972`, …) and keeping the name keeps the diff mechanical; `op=` is preserved; `columns=` and `language=` are additive and ignored by FalkorDB.

**FalkorDB implements the seam by delegation at call time** (so `p._ro_query = fake` is honoured):

```python
async def _run_read(self, cypher, params=None, *, timeout=None, op=None, columns=None, language=None):
    return await self._ro_query(cypher, params, timeout=timeout, op=op)
async def _run_read_tolerant(...):  return await self._ro_query_tolerant(cypher, params, timeout=timeout, op=op)
async def _run_write(...):          return await self._query(cypher, params, timeout=timeout, op=op)
async def _run_read_proj(...):      return await self._proj_ro_query(cypher, params, timeout=timeout, op=op)
async def _run_write_proj(...):     return await self._proj_query(cypher, params, timeout=timeout)   # :2045 has no op kwarg
```

Everything FalkorDB-specific stays inside its existing chokepoints: server-side `timeout=` ms via `_db_timeout_ms` (`:1599-1605`), the query semaphore + slow-query telemetry (`_guarded_timed` `:1817-1863`), transient/cluster-failover retries (`_run_guarded` `:1682-1815`), `ProviderLoading` translation, the write semaphore + quiesce gate (`:2045-2077`), the projection-graph target (`_proj` `:1068-1077`).

**ArcadeDB implements the seam over an `ArcadeDBClient`** (§5.2): `_run_read` → `POST /query/{db}` with `{"language": language or "opencypher", "command": cypher, "params": params or {}, "serializer": "record"}`; `_run_write*` → `POST /command/{db}`; both under `DeadlineGuard.run(..., timeout_s=timeout or self._timeouts.*)` with an `asyncio.Semaphore(ARCADEDB_QUERY_CONCURRENCY=20)`, readonly-only transient retry `(0.25, 0.5)` (mirrors `_TRANSIENT_RETRY_BACKOFFS` `:290`), and the same slow-query WARNING line shape as `:1855-1861` (`arcadedb slow ro: graph=… op=… query_ms=… budget_s=… rows=… cypher=…`). `_run_read_proj`/`_run_write_proj` = the source graph.

**`CypherResult` — a `falkordb.QueryResult` duck.** Verified attribute set of the real class: `cached_execution, header, indices_created, indices_deleted, labels_added, labels_removed, nodes_created, nodes_deleted, properties_removed, properties_set, relationships_created, relationships_deleted, result_set, run_time_ms`. Lifted code reads `.result_set` everywhere and `getattr(r, "properties_set", 0)` (`:2205`); nothing reads `.header` (grep). So:

```python
@dataclass
class CypherResult:
    result_set: List[List[Any]]            # POSITIONAL rows, projection order
    header: List[str] = field(default_factory=list)   # column names (falkordb's is [[type, name], ...]; unused by lifted code)
    nodes_created: int = 0; nodes_deleted: int = 0; relationships_created: int = 0; relationships_deleted: int = 0
    properties_set: int = 0; properties_removed: int = 0; labels_added: int = 0; labels_removed: int = 0
    indices_created: int = 0; indices_deleted: int = 0; run_time_ms: float = 0.0; cached_execution: bool = False

class EmptyResult:                          # == _EmptyResult (:413-416)
    result_set: list = []

@dataclass(frozen=True)
class CypherNode:                           # duck-typed to falkordb.Node — lifted code does hasattr(cell, "properties") / cell.labels (:2760-2763)
    id: Any; labels: List[str]; properties: Dict[str, Any]

@dataclass(frozen=True)
class CypherRel:                            # duck-typed to falkordb.Edge — lifted code reads .relation / .type / .properties (:6701-6702)
    id: Any; relation: str; properties: Dict[str, Any]; src_node: Any; dest_node: Any
    @property
    def type(self) -> str: return self.relation
```

The ArcadeDB executor builds positional rows from the HTTP JSON row objects. **Day-0 #4/#14 (§10.4) checks whether ArcadeDB preserves projection order in the JSON object keys**; if it does, `list(row.values())` is the row. If it does not, the executor orders by `columns=` — the base generates every Cypher, so lifting adds `columns=[…]` only at call sites whose RETURN has two or more *unaliased* columns (e.g. `RETURN a.urn, b.urn, type(lr), properties(lr)` `:3714`; `RETURN n.urn, count(ch)` `:6228`; `RETURN cu, a.urn, coalesce(max(length(q)), 0)` `:5232`) — a kwarg addition, never a Cypher text change (test regexes such as `test_falkordb_ondemand_pairs.py:41-47` pin the unaliased text). Vertex cells (`@cat:"v"`) become `CypherNode(id=@rid, labels=[@type], properties={non-@ keys})`, edge cells (`@cat:"e"`) become `CypherRel(id=@rid, relation=@type, src_node=@out, dest_node=@in, properties=…)`; exact keys confirmed by the spike.

**`_run_read_tolerant` semantics per engine:** FalkorDB masks "Invalid graph operation on empty key" after the cluster EXISTS verification (`:1878-1952`); ArcadeDB masks `unknown_type` (a `MATCH (n:NeverCreated)` error, if Day-0 #2 says it errors) and a missing database is NOT masked (that is a configuration error → `graph_not_found`).

**`_classify_error`** feeds `_bulk_write_batch` (`:10883-10891` — today `ProviderUnavailable | _is_loading_error | _is_transient_connection_error`) and `_is_verified_missing_graph`. FalkorDB implements it with its existing classifiers (`:258-410`); ArcadeDB with the HTTP status table in §5.2.

---

## 3. `CypherDialect` — declarative data + three small hooks; three-column matrix

### 3.1 Shape

```python
@dataclass(frozen=True)
class Stmt:                       # a statement template; {label}/{prop}/{props}/{rel} placeholders, rendered with dialect.sanitize
    text: str
    language: Optional[str] = None      # None = the dialect's Cypher language; "sql" for ArcadeDB DDL/introspection
    idempotent_error_markers: Tuple[str, ...] = ()   # substrings meaning "already exists" — treated as success

@dataclass(frozen=True)
class CypherDialect:
    name: str
    statement_language: str                       # "cypher" | "opencypher"
    # --- introspection ---
    labels_stmt: Stmt; rel_types_stmt: Stmt; property_keys_stmt: Optional[Stmt]; indexes_stmt: Optional[Stmt]
    # --- DDL (templates; empty tuple = unsupported) ---
    ensure_vertex_type_stmts: Tuple[Stmt, ...]     # ArcadeDB: CREATE VERTEX TYPE ... IF NOT EXISTS; others: ()
    ensure_edge_type_stmts: Tuple[Stmt, ...]
    node_index_stmts: Tuple[Stmt, ...]             # per (label, prop)
    node_unique_index_stmts: Tuple[Stmt, ...]
    edge_index_stmts: Tuple[Stmt, ...]             # per (rel, props)
    fulltext_index_stmts: Tuple[Stmt, ...]; fulltext_query_stmt: Optional[Stmt]   # {index}, $q
    # --- functions / fragments ---
    id_fn: str                                     # "id" | "elementId"
    id_kind: str                                   # "int" | "str"
    edge_page_order: str                           # "engine_id_int" | "keyset_urn_id"
    exists_property_tpl: str                       # "EXISTS({col})" | "{col} IS NOT NULL"
    remove_property_tpl: str                       # "REMOVE {var}.{prop}" | "SET {var}.{prop} = null"
    aggregated_rel: str = "AGGREGATED"
    # --- capability flags (asserted live by the conformance suite, §10.3) ---
    identifiers_case_insensitive: bool
    label_scoped_indexes_only: bool                # bare MATCH (n) cannot use an index -> keep per-label CALL {} UNION / bucket shapes
    unknown_label_match: str                       # "empty" | "error"
    types_must_be_declared: bool
    supports_list_params: bool
    supports_call_subquery: bool                   # CALL { ... UNION ... }
    supports_call_in_transactions: bool
    supports_exists_subquery: bool                 # EXISTS { MATCH ... }
    count_is_constant_time: bool                   # MATCH (n:L) RETURN count(n) without projection
    variable_length_zero_hop_ok: bool              # informational: base always emits *1..N + explicit self branch (:9653-9657)
    timeout_injection: str                         # "server_ms_param" | "tx_timeout" | "client_only"
    # --- hooks (the only code) ---
    def sanitize(self, name: str) -> str            # _sanitize_label (:136-138)
    def quote(self, name: str) -> str               # backticks (common/providers/identity.py:30)
    def render(self, stmt: Stmt, **fields) -> Tuple[str, Optional[str]]   # (text, language)
```

Three hooks only (`sanitize`, `quote`, `render`); everything else is data. A dialect for a new engine is ~60 lines of literals.

**Byte-identity rule for FalkorDB:** every fragment the base substitutes must render today's text under `FALKORDB_DIALECT`: `labels_stmt` → `CALL db.labels() YIELD label RETURN label` (`:10244`, `:4820`, `falkordb_deep_search.py:1755`), `rel_types_stmt` → `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType` (`:10246`, `:10464`); the two bare variants `CALL db.relationshipTypes()` / `CALL db.labels()` at `:10821`/`:10825` are normalised to the YIELD form during lifting (same first column; no test regex pins the bare text); `node_index_stmts` → `CREATE INDEX FOR (n:{label}) ON (n.{prop})` (`:2275`, marker `already indexed` `:2267`); `edge_index_stmts` → `CREATE INDEX FOR ()-[r:{rel}]-() ON ({props})` (`:2291-2300`); `remove_property_tpl` → `REMOVE n.properties` (`:11022`, `:11144`); `exists_property_tpl` → `EXISTS(n.`k`)` (`falkordb_deep_search.py:459`, `:735`); `id_fn` → `id` (`:9025`, `:9327`, `:8468`, `:9829`). The golden-Cypher test in §10.1 is the gate.

### 3.2 Three-column matrix

| Dialect point | FalkorDB (Cypher, v4.18) | Neo4j 5 (Cypher 5) | ArcadeDB 26.8 (openCypher) |
|---|---|---|---|
| `statement_language` | n/a (RESP `GRAPH.RO_QUERY`/`GRAPH.QUERY`) | n/a (Bolt) | `"opencypher"` — never the deprecated `"cypher"` |
| labels | `CALL db.labels() YIELD label RETURN label` | same | Cypher `MATCH (n) RETURN DISTINCT labels(n)[0] AS label` is a scan; prefer SQL `SELECT name AS label FROM schema:types WHERE type = 'vertex'` (`language="sql"`); Day-0 #16 checks whether `CALL db.labels()` exists in the apoc-compatible namespace |
| rel types | `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType` | same | SQL `SELECT name AS relationshipType FROM schema:types WHERE type = 'edge'` |
| property keys | `CALL db.propertyKeys()` (unused today; discover samples nodes) | `CALL db.propertyKeys()` | sample `MATCH (n:L) WITH n LIMIT 50 RETURN keys(n)`; SQL `SELECT properties FROM schema:types` for declared ones |
| index introspection | `CALL db.indexes()` (row shape varies, `:4252-4260`) | `SHOW INDEXES` | SQL `SELECT FROM schema:indexes` |
| node index DDL | `CREATE INDEX FOR (n:L) ON (n.p)` (error `already indexed` = ok) | `CREATE INDEX idx_L_p IF NOT EXISTS FOR (n:L) ON (n.p)` | SQL `CREATE PROPERTY L.p IF NOT EXISTS STRING` then `CREATE INDEX IF NOT EXISTS ON L (p) NOTUNIQUE` |
| unique index | none | `CREATE CONSTRAINT … FOR (n:L) REQUIRE n.urn IS UNIQUE` | SQL `CREATE INDEX IF NOT EXISTS ON L (urn) UNIQUE` (fallback NOTUNIQUE on duplicates) |
| edge index DDL | `CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth, r.targetDepth)` | `CREATE INDEX … FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth, r.targetDepth)` | SQL `CREATE INDEX IF NOT EXISTS ON AGGREGATED (sourceDepth, targetDepth) NOTUNIQUE` (+ `(aggKey) UNIQUE`) |
| fulltext DDL / query | `CALL db.idx.fulltext.createNodeIndex('L', 'searchableText')` / `CALL db.idx.fulltext.queryNodes('L', $q) YIELD node, score` | `CREATE FULLTEXT INDEX ft_L IF NOT EXISTS FOR (n:L) ON EACH [n.searchableText]` / `CALL db.index.fulltext.queryNodes('ft_L', $q) YIELD node, score` | SQL `CREATE INDEX IF NOT EXISTS ON L (searchableText) FULL_TEXT` / `CALL db.index.fulltext.queryNodes('L[searchableText]', $q) YIELD node, score` |
| types must be declared | no | no | **yes** (Day-0 #1 confirms whether Cypher CREATE auto-declares) |
| ensure type DDL | () | () | SQL `CREATE VERTEX TYPE `L` IF NOT EXISTS` / `CREATE EDGE TYPE `T` IF NOT EXISTS` |
| `id()` / `elementId()` / RID | `id(x)` → int | `elementId(x)` → str (`id()` deprecated) | `id(x)` → RID string `#b:p` (Day-0 #6) |
| `edge_page_order` (hub paging cursor) | `engine_id_int`: `WHERE id(r) >= $after ORDER BY id(r)` (`:9324-9331`) | `keyset_urn_id` | `keyset_urn_id`: `ORDER BY o.urn, coalesce(r.id,'')` (§7.5) |
| timeout injection | `server_ms_param`: `timeout=` ms on the query (`:1872`, `_db_timeout_ms` `:1599`) | `tx_timeout`: `session.execute_read(fn, timeout=)` / `CALL {} IN TRANSACTIONS` n/a | `client_only` (Day-0 #9; server `command.timeout` is global) |
| identifier case sensitivity | case-sensitive (`:2584-2586`) | case-sensitive | **case-insensitive** (`:T2` = `:t2`) |
| `label_scoped_indexes_only` | yes — no label-less URN index (`:4747-4750`), hence `CALL {} UNION` per label (`:3193`, `:3906`, `:10790`) and urn→label buckets | yes (indexes are label-scoped; bare `MATCH (n)` cannot seek) | yes (indexes are per type; bare `MATCH (n)` scans every vertex type) |
| unknown-label MATCH | empty (never-created graph key raises `empty key` → tolerant path) | empty | Day-0 #2: empty or error (`unknown_label_match`) |
| list params (`IN $list`, `UNWIND $batch`) | yes | yes | Day-0 #5 |
| `CALL {}` subquery / union | yes (`:3193`) | yes | documented yes (Day-0 #11) |
| `CALL {} IN TRANSACTIONS` | no | yes (4.4+) | no (HTTP sessions instead) |
| `EXISTS {}` subquery | **no** (`:3863-3867`) — base uses pattern predicates everywhere | yes | Cypher-25 grammar → likely yes; unverified; base does not need it |
| O(1) counts | yes — `reduce_count` when `count()` has no projection (`:10206-10217`) | yes — count store for `MATCH (n:L) RETURN count(n)` / `MATCH ()-[r:T]->() RETURN count(r)` | Day-0 #3: SQL `SELECT count(*) FROM L` may be O(1) (bucket counts); Cypher count is a scan |
| `exists_property_tpl` | `EXISTS({col})` | `{col} IS NOT NULL` (function form removed in 5) | `{col} IS NOT NULL` (Day-0 #11) |
| `remove_property_tpl` | `REMOVE {var}.{prop}` | `REMOVE {var}.{prop}` | `SET {var}.{prop} = null` (no `REMOVE` documented) |
| variable-length `*0..N` | planner trips in filtered forms (`:9653-9657`) — base emits `*1..N` + self branch | fine | Day-0 #11 |
| AGGREGATED rel label | `AGGREGATED` | `AGGREGATED` | `AGGREGATED` (declared edge type; case-insensitive → reject a user type whose casefold is `aggregated` at injection) |
| list-graphs | RESP `GRAPH.LIST` (F, `:11239`) | `SHOW DATABASES` on `system` (F) | HTTP `GET /databases` (F) |

---

## 4. Per-method classification of the FalkorDB provider (G / F / GF)

"Neutral once the seam exists" = the method's Cypher is plain openCypher and its Python touches nothing FalkorDB-specific except the chokepoints (and `self._redis`, which the base holds as optional). "ArcadeDB needs" lists what is required on top of the seam.

| FalkorDB method (line) | Class | Neutral once the seam exists? / ArcadeDB needs |
|---|---|---|
| module helpers `:136-255` (`_sanitize_label`, keyset cursor codec, `_keyset_sort`), `:466-760` (`_compute_searchable_text`, `_RESERVED_NODE_KEYS`, `_split_user_properties`, `_node_from_props`, `_edge_from_row`), `_ClosureWalk` `:763-801` | G | pure; PR-1 target `backend/common/providers/` |
| `_normalize_falkordb_host`, `resolve_falkordb_target` `:419-463`, redis/cluster exception classifiers `:258-410`, `_EmptyResult` `:413` | F | classifiers become FalkorDB's `_classify_error`; `EmptyResult` duck in the base |
| `__init__` `:811-1065`, `_proj` `:1068`, `preflight` `:1084`, connection/pool/failover `:1226-1681`, `_run_guarded`/`_guarded_timed`/5 chokepoints `:1682-2077`, `_seed_from_file` `:2079`, `list_graphs` `:11239`, `close` `:11273` | F | the executor implementation; ArcadeDB writes its own (§5) |
| `stamp_identity_urns` `:2101-2218` | GF | algorithm (fill / re-point with `urnSource`/`nameSource` provenance) G; batching by `ID(n)` ranges F → base uses per-label keyset on the identity property (`MATCH (n:L) WHERE n.`<ident>` > $after … WITH n ORDER BY n.`<ident>` LIMIT $w SET … RETURN max(n.`<ident>`)`); FalkorDB keeps its ID-range version as an override |
| `ensure_indices` `:2220-2313` | GF | policy G (`index_policy`); DDL text → `node_index_stmts`/`edge_index_stmts`; "already indexed" → `idempotent_error_markers`; ArcadeDB adds `ensure_vertex_type_stmts` + `CREATE PROPERTY` + UNIQUE on `urn` (all templates) |
| `set_containment_edge_types` … `set_node_identity` `:2319-2622`, `_alias_*`/`_floor_case_fold`/`_containment_hop_bound`/`_get_containment_edge_types`/`_get_lineage_edge_types` `:2624-2751` | G | ArcadeDB adds the casefold-collision rejection when `identifiers_case_insensitive` |
| `_check_levels_backfilled` `:2392`, `_resolve_root_anchor` `:2444`, `_types_at_level` `:2503` | G | plain Cypher |
| `set_projection_mode` `:2514`, `set_admission_controller` `:2556` | F / G | base: `in_source` only; `_run_*_proj` default to the source graph |
| `_extract_node_from_result` `:2753` | G | reads `cell.properties` / `cell.labels` — works on `CypherNode` by duck typing |
| `_cache_ns`/`physical_graph_id`/keys `:2772-2816` | G | `host:port:graph` — ArcadeDB `host:port:database` |
| `_aggregation_run_meta` + legacy probes `:2818-2953` | G | `_AggMeta` read is Cypher; Redis marker paths guard on `self._redis` |
| urn→label cache `:2957-2993`, `_label_buckets` `:4743`, `_resolve_urn_labels_bulk` `:4767` | G | Redis hash when `self._redis`, else the in-process LRU (one added branch); `CALL db.labels()` → `labels_stmt` |
| `get_node` `:2994`, `get_nodes` `:3046`, filters `:3265-3325`, `search_nodes` `:3326` | G | `CALL {} UNION` gated on `supports_call_subquery` (FalkorDB True → identical text); else per-label queries merged in Python (the shape the urn path already uses `:3134-3177`) |
| `deep_search*` `:3330-3356` | G | lifted module (§8) |
| `get_edges` `:3358`, `get_children` `:3462`, `get_children_with_edges` `:3558`, `get_parent` `:3764` | G | timeouts via `CypherTimeouts` |
| `get_top_level_or_orphan_nodes` `:3787-4038` | G | pattern negation `NOT (n)<-[:C]-()` is portable (never `EXISTS {}`); `CALL {} UNION` flag; timeouts |
| `_traverse_lineage`, `get_upstream/downstream/full_lineage` `:4040-4158` | G | `ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes)` — Day-0 #11; fallback = typed lineage alternation |
| `ensure_projections` `:4165`, `_log_aggregation_index_health` `:4215` | F | unlabeled-index attempt + `CALL db.indexes()` parsing are FalkorDB's; base's `ensure_projections` = AGGREGATED indexes + `_AggMeta`/AGGREGATED type via templates |
| ancestors `:4346-4611` (`_ancestors_cache_key`, `_get_ancestor_chain`, `_compute_ancestor_chain(s_bulk_cypher)`, `_compute_and_store_ancestors_bulk`) | G | Redis pipeline paths already guard/try (`:4442-4458`, `:4502`); the chain Cypher (`OPTIONAL MATCH path=… [n IN nodes(path)[1..] \| n.urn] … collect … coalesce(candidates[0], [])` `:4566-4576`) is Day-0 #11 |
| `_wipe_aggregated_edges` `:4644`, `_purge_aggregated_idempotency_namespace` `:4700`, `_ensure_label_urn_indexes` `:4892`, `_warmup_urn_label_cache_for_aggregation` `:4913`, `_estimate_lineage_edge_count` `:5083`, `_derive_lineage_types_from_cache` `:5114` | GF | Redis-namespace purge moves behind the idempotency backend; warm-up uses per-label scans (keyset in the base) |
| `_resolve_chain_levels` `:5137`, `_get_ancestor_dag_pair` `:5194`, `_hook_pairs` `:5247` | G | plain Cypher (`max(length(p))`) + `pair_rules` |
| `on_lineage_edge_written` `:5282`, `on_lineage_edge_deleted` `:5474`, `on_containment_changed` `:5568` | GF | algorithm G; the Redis `SADD` idempotency (`:5369-5381`) becomes an `IdempotencyBackend` (§7.2); the MERGE `:5425-5471` is plain Cypher (Day-0 #7) |
| `clear_content_caches` `:5610`, `count_aggregated_edges` `:5641`, `purge_aggregated_edges` `:5651`, `materialize_lineage_for_edge` `:5807` | G | Redis scan of `agg_members:*` `:5742-5751` → backend `purge_namespace` |
| `materialize_aggregated_edges_batch` `:5822` → `falkordb_materialize.py` | F (override) | ID-range scans; base gets the generic keyset pipeline (§7.4) |
| `get_aggregated_edges_between` `:5865`, `_synthesize_ondemand_lineage_pairs` `:6104`, `_mixed_depth_pairs` `:6386`, `_synthesize_raw_lineage_pairs` `:6488`, `_rows_to_aggregated_result` `:6555` | G | `_proj_ro_query` → `_run_read_proj`; label buckets; plain Cypher |
| `get_trace_lineage` `:6595` | G | rows carry node + rel cells (`RETURN src, r, tgt`) → `CypherNode`/`CypherRel` ducks |
| `trace_at_level` `:6830-7294` (root anchor, retry, `_mega_nodes`, `_fallback_level`) | G | self-contained; the base lifts it as-is (the kernel `TraceOrchestrator` stays for Spanner; convergence is a later refactor, not PR 3) |
| `trace_closure` `:7296`, `trace_closure_coarse` `:7785`, walk engine `:8639-9370` | G | `id(r)` cursor paging → `edge_page_order` (§7.5); FalkorDB stays `engine_id_int` so text is identical |
| `expand_aggregated` `:7964`, helpers `:8129-8619`, `:9420-10036` | G | plain Cypher; `UNION` of `RETURN 's' AS side, collect(urn) AS urns` branches (`:9547-9558`) — Day-0 #11 |
| `get_nodes_batch` `:10038`, `get_stats` `:10125`, `prime_stats_cache` `:10308`, `get_schema_stats` `:10328`, `get_ontology_metadata` `:10414`, `get_node_degrees` `:10593`, `get_distinct_values` `:10649`, `get_ancestors` `:10675`, `get_descendants` `:10687`, `get_nodes_by_tag` `:10727` | G | catalogue statements via dialect; Redis memo guarded |
| `get_counts_fast` `:10205` | GF | Cypher is plain; the O(1) property is the engine's → base returns `None` unless `count_is_constant_time` (FalkorDB True → identical behaviour, no override) |
| `get_nodes_by_layer` `:10741` | G | `CALL {} UNION` flag; `indexed_labels` from the moved `index_policy` |
| `_type_casing_maps` `:10808`, `_consistent_casing` `:10838` | G | catalogue via dialect; mandatory on a case-insensitive engine |
| `_bulk_write_batch` `:10851` | GF | retry-on-loading semantics G; recoverability via `_classify_error` |
| `save_custom_graph` `:10907`, `create_node` `:11105`, `create_edge` `:11173`, `update_edge` `:11202`, `delete_edge` `:11220` | G | `REMOVE n.properties` → `remove_property_tpl`; ArcadeDB adds `ensure_vertex_type_stmts`/`ensure_edge_type_stmts` before the first batch per label/type (memoised per instance) and byte-aware chunking (100 MB body cap) |
| `falkordb_deep_search.py` (whole) | G | transport + 4 dialect touches (§8) |

---

## 5. Contract-method inheritance table and the ArcadeDB package

### 5.1 Base (openCypher) → overrides

| Contract / optional method | Base implementation (openCypher, lifted) | FalkorDB override? | ArcadeDB override? | Neo4j (follow-up) |
|---|---|---|---|---|
| `preflight` | abstract | yes (`:1084`, RESP AUTH+PING) | yes (`/ready` → `/exists/{db}`) | yes (TCP Bolt) |
| `_ensure_connected` / `close` / `list_graphs` | abstract / abstract / `[]` | yes / yes / yes (`GRAPH.LIST`) | yes / yes / yes (`GET /databases`) | yes / yes / yes (`SHOW DATABASES`) |
| `get_node`, `get_nodes`, `search_nodes`, `get_edges`, `get_nodes_batch`, `get_node_degrees`, `get_distinct_values`, `get_nodes_by_tag` | lifted | no | no | no |
| `get_nodes_by_layer` | lifted; `supports_call_subquery` picks union vs per-label merge | no (flag True) | no (flag from Day-0) | no |
| `get_children`, `get_children_with_edges`, `get_parent`, `get_top_level_or_orphan_nodes`, `get_ancestors`, `get_descendants` | lifted | no | no | no |
| `get_upstream/downstream/full_lineage`, `get_trace_lineage` | lifted | no | no | no |
| `trace_at_level`, `expand_aggregated` | lifted (FalkorDB's richer version incl. root anchor / retry / mega nodes) | no | no | no |
| `trace_closure`, `trace_closure_coarse` | lifted; `edge_page_order` picks the hub cursor shape | no (`engine_id_int`) | no (`keyset_urn_id`) | no (`keyset_urn_id`) |
| `get_aggregated_edges_between` | lifted (+ on-demand synthesis) | no | no | no |
| `on_lineage_edge_written/deleted`, `on_containment_changed`, `count_aggregated_edges`, `purge_aggregated_edges` | lifted over an `IdempotencyBackend` (Redis set when `_redis`, edge-list otherwise) | no (Redis backend auto-selected) | no | no |
| `materialize_aggregated_edges_batch` | generic keyset pipeline (`cypher/materialize.py`) | **yes** (`falkordb_materialize.py`, ID-range fast path) | no | no |
| `get_stats`, `get_schema_stats`, `get_ontology_metadata`, `discover_schema`, `prime_stats_cache`, `clear_content_caches` | lifted | no | no | no |
| `get_counts_fast` | lifted, returns `None` unless `count_is_constant_time` | no (flag True) | no (flag from Day-0) | no (flag True) |
| `save_custom_graph`, `create_node`, `create_edge`, `update_edge`, `delete_edge` | lifted; `remove_property_tpl`; `ensure_*_type_stmts` before writes | no | no (templates) | no (gains `update_edge`/`delete_edge`, which raise today `neo4j_provider.py:2344-2350`) |
| `ensure_indices` | lifted policy + DDL templates + `idempotent_error_markers` | no | no (templates incl. `CREATE PROPERTY`, UNIQUE) | no |
| `ensure_projections` | AGGREGATED indexes + `_AggMeta`/AGGREGATED type templates | **yes** (unlabeled-index attempt + health log `:4165-4344`) | no | no |
| `stamp_identity_urns` | keyset on the identity property | **yes** (ID-range batching `:2191-2211`) | no | no |
| `set_projection_mode` | `in_source` only, else `ProviderConfigurationError` | **yes** (dedicated `{graph}_proj` `:2514-2554`) + `_run_*_proj` | no | no |
| `set_*` injection setters, `set_admission_controller`, `inflight_ops`, `physical_graph_id` | lifted / base | no | no | no |
| `deep_search`, `deep_search_explain`, `deep_search_discover` | lifted module | no | no (optional later: `match='fulltext'` via `fulltext_query_stmt`) | no |
| `search_nodes` fulltext fast path | not in v1 (deep search defers `fulltext`, `falkordb_deep_search.py:294-298`) | — | optional override later (Lucene) | optional |

Override count: FalkorDB 8 (all F-class or fast paths), ArcadeDB 4 (all lifecycle), Neo4j 4 (lifecycle). Everything else is dialect data.

### 5.2 `backend/graph/adapters/arcadedb/`

```
arcadedb/
  client.py     ArcadeDBClient(httpx.AsyncClient): base http(s)://host:port/api/v1, basic auth (or POST /login bearer);
                query(db, language, command, params, serializer, timeout) -> dict      POST /query/{db}
                command(db, ...)                                                       POST /command/{db}
                ready() / health() / databases() / exists(db) / server(cmd)             GET /ready | /health | /databases | /exists/{db}; POST /server
                begin(db) -> session_id / commit / rollback                             arcadedb-session-id header (30 s idle expiry)
                batch(db, ndjson_lines, batch_size) -> idMapping                        POST /batch/{db}?batchSize=
                map_error(response) -> CypherError subclass + ErrorKind
  dialect.py    ARCADEDB_DIALECT (column 3 of §3.2, spike-corrected)
  schema.py     ArcadeSchema: ensure_database, ensure_types, ensure_indices(labels, props), ensure_aggregated_types,
                ensure_fulltext (optional), introspect_types (SELECT FROM schema:types)   — renders dialect templates
  provider.py   ArcadeDBProvider(CypherGraphProvider): __init__(host, port, database, username, password, tls, extra_config,
                provider_id, credentials); the five _run_* methods over ArcadeDBClient; _ensure_connected (db exists once);
                _is_verified_missing_graph / _classify_error; preflight; list_graphs; close; name="arcadedb";
                physical_graph_id = f"{host}:{port}:{database}"
  descriptor.py ARCADEDB_DESCRIPTOR + build(row)
```

Error table (`map_error`): 400 → `CypherSyntaxError` (`syntax`; includes the "unknown type" message pattern → `unknown_type`, masked only by `_run_read_tolerant`); 401 → `CypherAuthError` (`auth_required` without creds / `auth_failed` with); 403 → `auth_failed`; 404 on the db path → `CypherNotFoundError` (`missing_graph`); 503 → `CypherTransientError` (`loading`, mapped to `ProviderLoading` like `:1729-1735`); 500 → `CypherError` (`other`); `httpx.ConnectError`/`RemoteProtocolError` → `transient`; `httpx.ReadTimeout` → `asyncio.TimeoutError` (`timeout`, never retried).

`preflight(deadline_s=1.5)` → `PreflightResult` (`preflight.py:30`): `GET /ready` (204) then `GET /exists/{db}` with credentials; reasons `connect_timeout`/`dns_unresolvable`/`tcp_refused` from `_classify` (`preflight.py:45`), `auth_required`/`auth_failed` (already in `AUTH_REACHABLE_REASONS` `preflight.py:138` → reachable-but-misconfigured, not an outage), `graph_not_found: <db>` (Spanner's wording `spanner_provider.py:332`), `http_<status>`. Not `http_head_preflight` (`preflight.py:335`) — it counts 401 as healthy.

**Descriptor (name it):** `ARCADEDB_DESCRIPTOR = ProviderDescriptor(type_id="arcadedb", display_name="ArcadeDB", dialect=ARCADEDB_DIALECT, capability=ProviderCapability(writable=True, full_crud=True, is_external=False, supports_copy=False, aggregated_rollups=True, trace_v2=True, lens_walk=True, deep_search=True, batch_materialize=True, counts_fast=<Day-0>, dedicated_projection=False, list_graphs=True, schema_discovery=True), connection=ConnectionShape(host, port=2480, tls_enabled→https, graph_name→database, credentials={username: "root", password}, extra_config.arcadedb={queryTimeoutS, writeTimeoutS, serializer:"record", verifyTls, caCert, batchSize}), conformance=Conformance(test_url_env="ARCADEDB_TEST_URL", snapshot_label="arcadedb"), build=build_arcadedb_provider)`. `build(row)` maps the `ProviderORM` columns (`db/models.py:389-408`) to the constructor; the cache Redis resolves through `build_cache_client` like Neo4j (`neo4j_provider.py:92-106`), never from the graph credentials. PR-2 coordination: the `dialect` and `conformance` fields are what the dialect-conformance suite (§10.3) enumerates.

---

## 6. Extensibility for the next Cypher engines

**Fully dialect-driven (zero overrides for a hypothetical Memgraph / Kùzu / AGE):** every read (`get_node`…`get_nodes_by_layer`), containment, lineage, trace v2, Lens walk, rollup reads and hooks, stats/ontology/discover, writes, `ensure_indices`, `stamp_identity_urns` (keyset), `get_counts_fast` (flag), deep search. These consume only: the five `_run_*` methods, `labels_stmt`/`rel_types_stmt`, index/type templates, `id_fn`/`edge_page_order`, `exists_property_tpl`/`remove_property_tpl`, and the boolean flags.

**Always provider code (4 methods):** `preflight`, `_ensure_connected`, `close`, `list_graphs` — plus the five `_run_*` methods and `_classify_error` (the executor). That is the entire mandatory surface.

**Where a hypothetical engine would still need an override:**
- *Memgraph* (Bolt-compatible, openCypher): none expected. Flags: `id_fn="id"` (int), `edge_page_order="engine_id_int"`, index DDL `CREATE INDEX ON :L(p)` (no `IF NOT EXISTS` — use `idempotent_error_markers`), fulltext via `CALL text_search.search(...)` (module) or `None`, `supports_exists_subquery=False` (pattern predicates only — the base already avoids `EXISTS {}`), `count_is_constant_time=False`, case-sensitive, labels via `SHOW NODE_LABELS INFO` → `labels_stmt` (a `Stmt`, rendered as-is), rel types `SHOW EDGE_TYPES INFO`.
- *Kùzu* (embedded, schema-first): `types_must_be_declared=True` with `CREATE NODE TABLE L(urn STRING PRIMARY KEY, …)` needing the *property list* — the template hook must receive the write map's keys → `ensure_vertex_type_stmts` rendered per (label, props); `MERGE`/`SET +=` support is partial → `save_custom_graph` override likely; bulk load via `COPY FROM` → optional override.
- *Apache AGE* (Postgres): the executor wraps every statement in `SELECT * FROM cypher('graph', $$ … $$, $1) AS (…)` and decodes `agtype` — all inside `_run_*`; `supports_call_subquery=False` (per-label merge path), `id_fn="id"` (graphid int), list params via the `$1` agtype map; `count_is_constant_time=False`; no fulltext procedure.

**Worked example — adding Memgraph (checklist of files):**
1. `backend/graph/adapters/memgraph/dialect.py` — `MEMGRAPH_DIALECT = CypherDialect(name="memgraph", statement_language="cypher", labels_stmt=Stmt("SHOW NODE_LABELS INFO"), rel_types_stmt=Stmt("SHOW EDGE_TYPES INFO"), node_index_stmts=(Stmt("CREATE INDEX ON :{label}({prop})", idempotent_error_markers=("already exists",)),), edge_index_stmts=(Stmt("CREATE EDGE INDEX ON :{rel}({prop})"),), fulltext_index_stmts=(), fulltext_query_stmt=None, id_fn="id", id_kind="int", edge_page_order="engine_id_int", exists_property_tpl="{col} IS NOT NULL", remove_property_tpl="REMOVE {var}.{prop}", identifiers_case_insensitive=False, label_scoped_indexes_only=True, unknown_label_match="empty", types_must_be_declared=False, supports_list_params=True, supports_call_subquery=True, supports_call_in_transactions=False, supports_exists_subquery=False, count_is_constant_time=False, timeout_injection="tx_timeout")` (~50 lines).
2. `backend/graph/adapters/memgraph/provider.py` — `MemgraphProvider(CypherGraphProvider)` with the five `_run_*` methods over the neo4j Bolt driver (a shared `BoltExecutorMixin` from §11 makes this ~40 lines), `preflight` (`tcp_preflight`), `_ensure_connected`, `close`, `list_graphs=[]`, `_classify_error` (driver exception names).
3. `backend/graph/adapters/memgraph/descriptor.py` — `MEMGRAPH_DESCRIPTOR` (port 7687, conformance `MEMGRAPH_TEST_URL`).
4. `backend/tests/test_memgraph_provider_client.py` — fake-driver unit tests for the executor + `_classify_error`.
5. `backend/tests/regression/test_memgraph_provider_contract.py` — the 40-line template (§10.2).
6. Run `MEMGRAPH_TEST_URL=bolt://localhost:7687 pytest backend/tests/regression/test_provider_dialect_conformance.py -k memgraph` (§10.3) — every declared flag is asserted against the live engine.
7. `docker-compose.yml` profile `memgraph`, `.env.example` block; add `backend/graph/adapters/memgraph/dialect.py` to the unlabeled-UNWIND gate's `SCANNED_PATHS` (§10.1).
No base method is touched.

---

## 7. Aggregation, trace and Lens design on the lifted base

### 7.1 Facts the design rests on
- Readers dispatch on `_aggregation_run_meta()` (`:2818-2880`): the in-graph `_AggMeta {id:'singleton'}` node (`regime`, `stampVersion`, `pairRuleVersion`, `levelDigest`, `maxDepth`, `edgeCount`, `runStartMs`, `lastMaterializedAt` — written at `falkordb_materialize.py:2488-2500`) outranks the Redis marker. `boundary` = canonical depth-diagonal pairs stored, readers derive the rest; `cube` = every pair stored, derivation off.
- Edge shape `:AGGREGATED {aggKey, weight, sourceEdgeTypes, sourceLevel, targetLevel, sourceDepth, targetDepth, levelDigest, latestUpdate}` (`:5425-5439`); `aggKey` is the identity shared by batch and hook (`:5399-5403`).
- `pair_rules.py` (`ancestor_closure`, `cube_pairs`, `boundary_pairs`) is the single semantic mirror (`falkordb_materialize.py:48-52`, `falkordb_provider.py:5263`).

### 7.2 Incremental hooks — one lifted algorithm, two idempotency backends
`on_lineage_edge_written` (`:5282-5472`) is lifted verbatim except the Redis pipeline at `:5369-5381`, which becomes `new_pairs = await self._agg_idempotency.add_batch(pairs_to_check, edge_id)`:
- `RedisSetIdempotency` (selected when `self._redis is not None`): `SADD {agg_members}:{s}:{t} {edge_id}` pipeline — byte-identical to today; `purge_namespace` = the `SCAN agg_members:*` + `DELETE` at `:5742-5751`.
- `EdgeListIdempotency` (no Redis — the Neo4j model `neo4j_provider.py:2394-2417`): `add_batch` = one `UNWIND $batch AS item MATCH (s:Ls {urn:item.s})-[r:AGGREGATED {aggKey:item.k}]->(t:Lt {urn:item.t}) RETURN item.k AS k, $eid IN coalesce(r.sourceEdgeIds, []) AS present` → the MERGE for new pairs appends `r.sourceEdgeIds = coalesce(r.sourceEdgeIds, []) + $eid` in the same `_SET_CLAUSE` (`:5425-5439` + one clause); `remove` = the Neo4j decrement (`:2442-2451`); `purge_namespace` = no-op. Weight semantics unchanged (increment-by-one per new membership `:5427`).
`on_lineage_edge_deleted` (`:5474-5566`) mirrors it. `AggregatedEdgeMaterializer` (`common/providers/aggregation.py`) is NOT wired in: the lifted hook already owns regime-dispatched pair selection and level/depth stamps that the kernel's `_cross_pairs` (cube, leaf mirrors included) does not; reconciling the two is a kernel follow-up, not PR 3.

### 7.3 Reads without materialisation — `get_aggregated_edges_between`
Lifted as-is (`:5865-6098` + `:6104-6593`): keyset-paged cell reads, regime dispatch (`cube` → raw mirror; `unknown` → raw mirror + `stale_reason="unmaterialized"`; `boundary`+`stampVersion>=2` → Q1/Q2/Q3 structural derivation over the ancestor cache). A never-aggregated ArcadeDB source therefore answers with the exact raw-lineage mirror and `stale=True, staleReason="unmaterialized"` — the signal that triggers the app's backfill (`graph.py:663-669`), i.e. the same first-day behaviour as a fresh FalkorDB source. `backend/tests/test_falkordb_ondemand_pairs.py` (its `_FakeGraph` answers exactly these shapes) is re-run against the base through a fake provider (§10.1).

### 7.4 Batch materialiser — generic keyset pipeline (`cypher/materialize.py`)
Worker contract: `materialize_aggregated_edges_batch(containment_edge_types, lineage_edge_types, batch_size, tuning, job_id, last_cursor, progress_callback, intra_batch_callback, should_cancel, resume_processed, resume_created)` (`worker.py:1374-1387`) returning `{"processed", "aggregated_edges_affected", "last_cursor", "errors", …}` (`falkordb_materialize.py:787-791`). Port the v3 design (`falkordb_materialize.py:1-88`: EXTRACT → COMPUTE → RECONCILE → APPLY; cursor `v3:{run_start_ms}:{phase}:{pos}`; `latestUpdate >= runStartMs` guards concurrently written edges from the reconcile delete) with one substitution — FalkorDB scans by internal `ID(n)` ranges; the generic pipeline scans by **keyset on an indexed property**: containment per label `MATCH (p:L)-[:C]->(c) WHERE p.urn > $after WITH p.urn AS pu, c.urn AS cu ORDER BY pu LIMIT $page RETURN pu, cu`; lineage per label `MATCH (s:L)-[r:LT]->(t) WHERE s.urn > $after RETURN s.urn, t.urn, type(r) ORDER BY s.urn LIMIT $page`; reconcile `MATCH ()-[r:AGGREGATED]->() WHERE r.aggKey > $after RETURN r.aggKey, r.weight, r.sourceEdgeTypes, r.sourceDepth, r.targetDepth, r.latestUpdate ORDER BY r.aggKey LIMIT $page` (needs the `aggKey` index from `ensure_projections`); apply `UNWIND … MATCH (s:Ls {urn}) MATCH (t:Lt {urn}) CREATE (s)-[:AGGREGATED {…}]->(t)` / `SET` / `DELETE` by `aggKey`, admission-controlled and cancellable between sub-batches. COMPUTE reuses `pair_rules` unchanged; `_AggMeta` is stamped at run end; `AGGREGATION_MATERIALIZE_FINE_PAIRS` keeps the cube escape hatch. FalkorDB keeps its module as the override.

### 7.5 Trace v2 and the Lens walk
`trace_at_level`/`expand_aggregated` and the whole closure engine are lifted unchanged (G). Two dialect-driven divergences:
- **Hub paging cursor.** FalkorDB pages a hub by integer `id(r)` (`_page_raw_lineage_single` `:9324-9331`) and the endpoint enforces `^e:\d+$` (`graph.py:855`). `edge_page_order="keyset_urn_id"` renders `WHERE (o.urn > $afterUrn OR (o.urn = $afterUrn AND coalesce(r.id,'') > $afterId)) … ORDER BY o.urn, coalesce(r.id,'') LIMIT $limit` and mints `e:` + urlsafe-b64(`{"u": last_urn, "i": last_id}`); inclusive-next semantics are preserved by encoding the last-seen pair with strict `>`. **Required change: `graph.py:855` regex → `^e:[A-Za-z0-9_=-]+$`** (numeric cursors still match; the client treats the cursor as opaque). `engine_id_int` keeps today's text for FalkorDB.
- **`id(r)` as an edge identity string** in `_expand_raw_lineage_set` (`:9025`), `_edges_between_sets_once` (`:9829`), `_expand_aggregated_set` (`:8468`) — `id_fn` renders `id(r)` for both FalkorDB and ArcadeDB (RID string is fine as an identity), `elementId(r)` for Neo4j.
Preserved contract (pinned by `test_trace_closure_wire_contract.py` / `test_trace_closure_completeness.py`): seeds vs excludes (`exclude_urns` never decides where a walk starts, `:7475-7524`, `:9107-9111`), seed enumeration as two gathered queries (never `WITH [f] + collect(...)`, `:9121-9131`), degree-exact prefix walk with the `sum(degree)+1` tripwire, hub paging for a non-fitting first anchor, cut/depth frontier reasons, honesty precedence (`:7753-7761`), containment always shipping with chain-synthesised fallback edges (`:9932-9994`), `seedCursor="s:<urn>"` inclusive. `trace_closure_coarse` (`:7785-7962`) lifts unchanged (engine kwargs `context_engine.py:1391-1402`).

---

## 8. Deep search (`cypher/deep_search.py`)

The module is lifted whole (3,604 lines) with exactly four kinds of edit:
1. transport — `provider._ro_query(` → `provider._run_read(` (every call site: candidate scan `:2325`, count `:2556`, aggregations `:2659` …, discover `:1753`, `:1773`, path query);
2. catalogue — `"CALL db.labels() YIELD label RETURN label"` (`:1755`) → `provider._dialect.render(provider._dialect.labels_stmt)` (renders the same text for FalkorDB);
3. `EXISTS(n.`k`)` (`:459`, `:735`) → `provider._dialect.exists_property_tpl`;
4. `from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS` (`:66`) → the common location (hard PR-1 dependency).
`getattr(node, "properties", None)` in discover (`:1798-1799`) already duck-types the node cell → works on `CypherNode`. Positional `row[i]` reads (`_rows_to_buckets` `:2931-2932`, `_run_count` `:2561`, candidates via the projection's column list `:3399-3407`) are unchanged because rows stay positional. `provider._get_ancestor_chain`, `get_nodes_batch`, `_get_containment_edge_types`, `_get_lineage_edge_types`, `_entity_type_levels`, `_node_identity_property`, `_name_property`, `_cache_ns`, `_redis` — all present on the base under the same names. The three provider methods `deep_search`/`deep_search_explain`/`deep_search_discover` (`:3330-3356`) move to `_DeepSearchMixin`. FalkorDB's `falkordb_deep_search.py` becomes a re-export shim (or is deleted) — `backend/tests/test_deep_search_*` and `test_cypher_shapes.py` (patches `_ro_query`) must stay green byte-for-byte, which is the acceptance test. `match='fulltext'` stays deferred (`:294-298`); `fulltext_query_stmt` exists so lifting it is a local change. `migrate_native_properties.py --searchable-text` becomes provider-agnostic in M5 (it binds FalkorDB today).

---

## 9. Docker / dev / demo

**Compose** — new service after `falkordb` (`docker-compose.yml:50-113`), opt-in exactly like `seed` (`:687-688`):

```yaml
  # ── ArcadeDB (optional second graph engine) — `docker compose --profile arcadedb up -d arcadedb` ──
  arcadedb:
    profiles: ["arcadedb"]
    image: arcadedata/arcadedb:26.8.1
    restart: unless-stopped
    ports:
      - "${ARCADEDB_BIND:-127.0.0.1}:${ARCADEDB_PORT:-2480}:2480"
    environment:
      ARCADEDB_OPTS_MEMORY: "${ARCADEDB_OPTS_MEMORY:--Xms1G -Xmx1G}"
      ARCADEDB_SETTINGS: >-
        -Darcadedb.server.rootPassword=${ARCADEDB_ROOT_PASSWORD:?set ARCADEDB_ROOT_PASSWORD in .env}
        -Darcadedb.server.defaultDatabases=${ARCADEDB_DATABASE:-nexus_lineage}[root]
        -Darcadedb.server.mode=development
    volumes:
      - arcadedb_data:/home/arcadedb/databases
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS -o /dev/null http://localhost:2480/api/v1/ready || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 60s
volumes:
  arcadedb_data:
```

Loopback bind by default (FalkorDB's reasoning `:55-66`); root password required with no default (the `JWT_SECRET_KEY` policy, `.env.example:361-370`); `defaultDatabases` pre-creates the dev database. Dev overlay: `container_name: synodic-arcadedb-dev` under the same profile. `.env.example` block: `ARCADEDB_PORT=2480`, `ARCADEDB_ROOT_PASSWORD=` (required), `ARCADEDB_DATABASE=nexus_lineage`, commented `ARCADEDB_QUERY_TIMEOUT=5 / WRITE_TIMEOUT=15 / INIT_TIMEOUT=3 / PURGE_BATCH_TIMEOUT=30 / SAVE_BATCH_SIZE=2000 / QUERY_CONCURRENCY=20`, `ARCADEDB_TEST_URL=http://localhost:2480` (gates the contract + conformance tests). `dev.sh` (`:31-33`, `:125`): add `--profile arcadedb` to the `COMPOSE` array only when `ARCADEDB_ENABLED=true` is in the env file, so `./dev.sh infra` is unchanged for everyone else; one usage line.

**Demo scripts (`backend/scripts/arcadedb/`):**
- `seed_arcadedb_demo.py --url --user --password --database --scale N --wipe --via {batch,cypher}`: create database via `POST /server` unless `/exists`; `ArcadeSchema.ensure_types` for `domain, system, database, schema, table, column` + `CONTAINS, TRANSFORMS, FEEDS, AGGREGATED`; deterministic generator (`random.Random(42)`, URNs `urn:synodic:arcadedemo:{type}:{path}` after `import_layered_lineage.py:135`): scale 1 ≈ 1,000 nodes (2 domains × 2 systems × 2 databases × 3 schemas × 6 tables × 5 columns) with `CONTAINS` down the hierarchy, `TRANSFORMS` column→column along staging→mart and `FEEDS` table→table (~1,200 lineage edges); scale 2 ≈ 2,000. `--via batch` → NDJSON to `POST /batch/{db}?batchSize=1000` (`{"@type":"vertex","@class":"table","@id":"t1", urn, displayName, qualifiedName, description, tags, layerAssignment, childCount, sourceSystem, lastSyncedAt, level, searchableText}` / `{"@type":"edge","@class":"CONTAINS","@from":"t1","@to":"c1", id, confidence, properties}`) writing the same property set the base's write map produces (`:10950-10967`); `--via cypher` → `ArcadeDBProvider.save_custom_graph` (proves the write path).
- `smoke_arcadedb.py --api --email --password --checks browse,trace,closure,search,aggregate`: cookie login + `X-CSRF-Token` (memory `graph-routes-need-datasourceid`), `POST /api/v1/providers/test-connection` (`providers.py:325`), `POST /api/v1/providers` (`:363`), `POST /providers/{id}/discover-schema` (`:625`), workspace + `POST /workspaces/{ws}/data-sources` (`workspaces.py:434`) with `graph_name=<database>`, then with `?dataSourceId=`: `GET /graph/nodes/top-level` (`graph.py:1141`), `GET /graph/nodes/{urn}/children-with-edges` (`:1338`), `POST /graph/trace/v2` (`:815`), `POST /graph/trace/closure` (`:858`) fine + coarse + hub paging (`maxNodes=50` on the widest table), `POST /graph/edges/aggregated` (`:2367`; `stale=true, staleReason="unmaterialized"` before aggregation), `POST /graph/search/advanced` (`:1479`) + `/search/explain` + `/search/discover`, `POST /graph/nodes/degree` (`:1927`); `--checks aggregate` runs the job and re-asserts `stale=false`. Pass/fail table, non-zero exit on failure.
- `load_test_dataset.py --provider-id <id> --fixture demo --batch-size 2000` (`load_test_dataset.py:120-147` resolves the provider through `provider_manager._create_provider_instance`; `:171-176` injects containment) is the 228k-node write-path check once the descriptor branch exists.

---

## 10. Conformance kit, tests, Day-0 spike

### 10.1 Fake-executor unit suite — `backend/tests/test_cypher_provider_base_*.py`
`FakeCypherProvider(CypherGraphProvider)` implements the five `_run_*` methods with an ordered rule table `[(regex, rows | callable(params) | exception)]` returning `_Result(result_set=[...])` — the same fake style as `test_falkordb_ondemand_pairs.py:36-38` so FalkorDB's existing regex fakes port unchanged; it records `calls = [(kind, cypher, params, timeout, op, columns, language)]`. Files (TDD order):
1. `test_cypher_provider_base_golden.py` — **the byte-identity gate**: for every base method, run it under `FALKORDB_DIALECT` with the fake and compare each emitted Cypher against `backend/tests/golden/cypher/<method>__<branch>.cypher` captured from the current `FalkorDBProvider` *before* lifting (capture script `backend/scripts/capture_cypher_golden.py`, `UPDATE_CYPHER_GOLDEN=1`). A diff = the lift changed FalkorDB's Cypher. Then the same matrix under `ARCADEDB_DIALECT` pins the ArcadeDB renderings (only the dialect fragments may differ).
2. `test_cypher_provider_base_result.py` — `CypherResult`/`CypherNode`/`CypherRel` duck typing against the lifted readers (`_extract_node_from_result`, `_edge_from_row`), positional ordering with `columns=`, `EmptyResult`.
3. `test_cypher_provider_base_seam.py` — dynamic delegation (assign `p._ro_query = fake` on a `FalkorDBProvider` and assert a base method hits it), `_run_read_tolerant` masking per `ErrorKind`, `_classify_error` tables.
4. `test_cypher_provider_base_reads.py`, `_containment.py`, `_writes.py`, `_ancestors.py`, `_trace.py`, `_closure.py`, `_aggregation.py`, `_materialize.py`, `_deep_search.py` — ports of the relevant FalkorDB suites (`test_trace_v2_falkordb.py`, `test_falkordb_trace_structural.py`, `test_trace_closure_*.py`, `test_falkordb_ondemand_pairs.py`, `test_falkordb_write_casing.py`, `test_cypher_shapes.py`) run through the fake provider under both dialects; dialect-flag branches (union off, `keyset_urn_id`, `SET … = null`, `IS NOT NULL`, `unknown_label_match="error"`, `types_must_be_declared`) get their own cases.
5. `test_cypher_provider_base_imports.py` — source-text gate: no module-level `from backend.app`/`import backend.app` under `backend/graph/adapters/cypher/`.
6. `backend/tests/test_falkordb_no_unlabeled_unwind_match.py` `SCANNED_PATHS` (`:47-50`, currently `app/providers/falkordb_provider.py` + `services/versioning/projection.py`) gains every Cypher-bearing module: `graph/adapters/cypher/{reads,containment,lineage,labels,ancestors,aggregation,materialize,trace,closure,writes,introspection,deep_search}.py`, `graph/adapters/arcadedb/{dialect,schema}.py` (add a `_GRAPH_DIR` next to `_APP_DIR`).
7. `backend/tests/test_arcadedb_provider_client.py` (`httpx.MockTransport`: auth header, `/query` vs `/command` routing, request body, error table, session begin/commit/rollback, `/batch` NDJSON, `preflight` reasons), `test_arcadedb_provider_dialect.py` (template rendering, UNIQUE→NOTUNIQUE fallback), `test_arcadedb_provider_descriptor.py` (`build()` from an ORM-like row, flags).

### 10.2 Live contract-snapshot harness — one ~40-line file per provider
`backend/tests/regression/test_arcadedb_provider_contract.py` mirrors `test_spanner_provider_contract.py:91-161` and `test_falkordb_provider_contract.py:50-78`: skip unless `ARCADEDB_TEST_URL` (+ `ARCADEDB_TEST_USER`/`ARCADEDB_TEST_PASSWORD`); fixture creates `test_regression_{pid}` via `/server`, `_runner.seed(p)` (`_runner.py:26-43`), `_runner.run_all(p, snapshot_label="arcadedb")`, drops the database on teardown. Template for any future provider (Memgraph: swap the env var, constructor and create/drop calls). Capture with `UPDATE_PROVIDER_SNAPSHOTS=1`; then diff `snapshots/arcadedb/*.json` against `snapshots/falkordb/` by hand — the only legitimate difference is engine edge ids. Small harness change: `snapshot.py:_normalise` masks id fields matching `^\d+$|^#\d+:\d+$|^\d+:[0-9a-f-]+:\d+$` so FalkorDB / ArcadeDB / Neo4j snapshots compare byte-for-byte.

### 10.3 Dialect conformance suite — `backend/tests/regression/test_provider_dialect_conformance.py`
Parametrised over the PR-2 catalog: for each descriptor with a `conformance.test_url_env` that is set, build the provider, create a scratch database/graph, and for **every dialect point** execute the probe live and assert the declared value matches reality:

| Dialect point | Live probe | Assertion |
|---|---|---|
| `labels_stmt` / `rel_types_stmt` | seed 2 labels + 1 rel type; render and run | both seeded names returned (labels of empty declared types tolerated) |
| `property_keys_stmt` / sampled keys | run on the seeded label | includes `urn` |
| `node_index_stmts`, `edge_index_stmts`, `node_unique_index_stmts` | render for `(ConfL, urn)`; run twice | second run succeeds or raises with an `idempotent_error_markers` message; `indexes_stmt` (if any) lists it |
| `fulltext_index_stmts` + `fulltext_query_stmt` | create on `searchableText`; write a node; query a token | the node is returned (skipped when both are empty/None) |
| `id_fn` / `id_kind` | `MATCH ()-[r]->() RETURN <id_fn>(r) LIMIT 1` | Python type matches `id_kind`; for `engine_id_int` values are monotone across two created edges |
| `edge_page_order` | page a 5-edge hub with page size 2 using the base's own pager | 3 pages, no overlap, no gap |
| `supports_list_params` | `MATCH (n:ConfL) WHERE n.urn IN $urns RETURN count(n)` with a 3-list; `UNWIND $batch AS item RETURN item.urn` | succeeds iff flag |
| `unknown_label_match` | `MATCH (n:ConfNever) RETURN count(n)` | `"empty"` → 0 rows/0; `"error"` → raises and `_run_read_tolerant` returns `EmptyResult` |
| `types_must_be_declared` | `CREATE (n:ConfUndeclared {urn:'x'})` | succeeds iff flag is False |
| `supports_call_subquery` | `CALL { MATCH (n:ConfA) RETURN n UNION MATCH (n:ConfB) RETURN n } WITH n ORDER BY n.displayName LIMIT 5 RETURN n` | succeeds iff flag |
| `supports_exists_subquery` | `MATCH (n:ConfL) WHERE EXISTS { (n)--() } RETURN count(n)` | succeeds iff flag |
| `supports_call_in_transactions` | `CALL { … } IN TRANSACTIONS` parses | succeeds iff flag |
| `identifiers_case_insensitive` | create `:ConfCaseA {urn:'a'}` then `MATCH (n:CONFCASEA) RETURN count(n)` | 1 iff flag, else 0 |
| `count_is_constant_time` | seed 20k nodes of one label; time `MATCH (n:L) RETURN count(n)` vs `MATCH (n:L) RETURN count(n.urn)` (forces a scan) | flag True ⇒ ratio < 0.1 (and, where the engine exposes a plan — FalkorDB `GRAPH.EXPLAIN`, ArcadeDB SQL `EXPLAIN` — no scan operator); flag False ⇒ no assertion |
| `exists_property_tpl`, `remove_property_tpl` | render + run on a node with/without the property | expected row count; property gone after remove |
| pattern negation, `*1..N` with type alternation, list comprehension over `nodes(path)`, `collect(DISTINCT n)[..2]`, `SET n += $map`, `ALL(r IN relationships(p) WHERE …)` | the exact fragments the lifted code emits (`:3870`, `:4569-4575`, `:9666-9671`, `:11021`, `:4073`) | each executes |
| `aggregated_rel` | `MATCH ()-[r:<agg>]->() RETURN count(r)` | parses; on a case-insensitive engine `:aggregated` also parses (documented) |
| `timeout_injection` | a `UNWIND range(1, 5_000_000) …` query under `timeout=0.5` | `asyncio.TimeoutError` within 1 s; for `server_ms_param`/`tx_timeout` additionally no long-running query remains (FalkorDB `GRAPH.LIST`/`INFO`, ArcadeDB `/server list`) |
FalkorDB runs it gated on reachability exactly like `test_falkordb_provider_contract.py:26-47` (its declared flags are the ones the golden test relies on); ArcadeDB gated on `ARCADEDB_TEST_URL`. A future provider is "conformant" when this file is green with its descriptor.

### 10.4 Day-0 spike (M0; corrects the ArcadeDB column of §3.2)
`backend/scripts/arcadedb/day0_spike.py` (httpx; prints PASS/FAIL per probe; output committed as `docs/providers/arcadedb-day0.md`). Base: `curl -u root:$PW -H 'Content-Type: application/json' localhost:2480/api/v1/command/nexus_lineage -d '{"language":"opencypher","command":"…","params":{…},"serializer":"record"}'` (`/query/…` for reads).

| # | Unknown | Probe | Outcome A → | Outcome B → |
|---|---|---|---|---|
| 1 | Cypher `CREATE (:T)` auto-declares the type? | `CREATE (n:SpikeT {urn:'a'}) RETURN n` on a fresh db | `types_must_be_declared=False` | True → `ensure_*_type_stmts` before every write batch (planned default) |
| 2 | `MATCH (n:Unknown) RETURN count(n)` | run | `unknown_label_match="empty"` | `"error"` → `_run_read_tolerant` masks `unknown_type`; `get_nodes(entity_types=[…])` checks the catalogue first |
| 3 | O(1) counts | time SQL `SELECT count(*) FROM T` and Cypher `MATCH (n:T) RETURN count(n)` on the 200k demo; `EXPLAIN` both | SQL O(1) → `count_is_constant_time=True`, `get_counts_fast` uses `language="sql"` | scan → flag False, `get_counts_fast` returns None |
| 4 | Row JSON shape (`serializer:"record"`) | `MATCH (n:T)-[r]->(m) RETURN n, r, m.urn AS u, labels(n) AS l, id(r) AS eid, properties(r) AS p LIMIT 1` | vertex `{"@rid","@type","@cat":"v",…}`, edge `{"@cat":"e","@in","@out",…}` → codec as in §2 | other shape → codec table updated; `serializer:"graph"` per statement kind if rels need it |
| 5 | list params | `WHERE n.urn IN $urns` with a JSON list; `UNWIND $batch AS item RETURN item.urn` with a list of maps | `supports_list_params=True` | False → inline escaped literal lists (cap 2,000, chunked); writes via `/batch` NDJSON or one statement per row |
| 6 | `id(n)`/`id(r)` value | from #4 | RID string → `id_kind="str"`, `edge_page_order="keyset_urn_id"`, `graph.py:855` relaxed | int → `engine_id_int` |
| 7 | MERGE on UNIQUE index; rel MERGE with map key + ON CREATE/ON MATCH | `CREATE INDEX ON T (urn) UNIQUE`; `MERGE (n:T {urn:'a'}) SET n.x=1` twice; `MERGE (a)-[r:AGGREGATED {aggKey:'k'}]->(b) ON CREATE SET … ON MATCH SET …` | as designed | rel-map MERGE unsupported → `MATCH … OPTIONAL MATCH … CASE` two-statement shape in a `/begin` session |
| 8 | writes only via `/command`; autocommit per statement | send a write to `/query` (expect error); two `/command` writes without a session (both persist) | sessions only where atomicity is wanted (`update_edge` RMW, hooks) | every write batch in a session |
| 9 | server-side timeout | slow query with httpx `timeout=1.0`; check `/server` `list` / CPU; test `-Darcadedb.command.timeout` | per-request or global cancel exists → `timeout_injection` documented accordingly | client-only; risk list |
| 10 | case-insensitive identifiers | `CREATE VERTEX TYPE t2` then `MATCH (n:T2)` | collides → flag True | |
| 11 | Cypher features the lifted code emits | `CALL {} UNION … WITH n ORDER BY … LIMIT`; `MATCH p=(c)<-[:CONTAINS*1..10]-(a) RETURN [x IN nodes(p)[1..] \| x.urn], length(p)`; `NOT (n)<-[:CONTAINS]-()`; `collect(DISTINCT n)[..3]`; `SET n += $map`; `n.k IS NOT NULL` vs `EXISTS(n.k)`; `toUpper(type(r)) IN $list`; `ALL(r IN relationships(p) WHERE …)`; `[:A\|B*1..3]`; `UNION` of `RETURN 's' AS side, collect(urn) AS urns` branches; `*0..N` | each pass → flag/template set | each fail → the named fallback in §3.2 / §4 |
| 12 | HTTP concurrency | 20 concurrent `/query` | `ARCADEDB_QUERY_CONCURRENCY=20` default | lower |
| 13 | `/batch` semantics | POST the same NDJSON twice | upsert → `--via batch` re-runnable | duplicates → `--wipe` drops/recreates first |
| 14 | JSON row key order | `RETURN a.urn, b.urn, type(r), properties(r)` (unaliased) — compare key order to projection order across 50 rows | preserved → `list(row.values())` | not preserved → `columns=` at the ~10 unaliased multi-column sites |
| 15 | `properties(r)` / `keys(n)` content | from #4 | no `@` keys leak → codec passthrough | `@` keys present → codec strips them |
| 16 | `CALL db.labels()` / `db.relationshipTypes()` exist in the apoc-compatible namespace? | run both | yes → `labels_stmt` can be the FalkorDB text | no → SQL `schema:types` statements |

### 10.5 Live E2E
`smoke_arcadedb.py` (§9) against `./dev.sh up` + the `arcadedb` profile after M1, M2, M3, M5 with the matching `--checks`.

---

## 11. Neo4j follow-up appendix (design only)

- **`BoltExecutorMixin`** (shared by Neo4j and Memgraph): `_run_read` → `session.execute_read(work)` / `_run_write` → `execute_write` (`neo4j_provider.py:333-364`; the driver owns transient retry); `work` runs `tx.run(cypher, params)` and builds `CypherResult(result_set=[[…]], header=result.keys())` from `await result.values()` (positional — not `.data()`); `neo4j.graph.Node` → `CypherNode(id=element_id, labels=sorted(labels), properties=dict(node))` (`:410-418`), `Relationship` → `CypherRel(relation=rel.type, src_node=start_node.element_id, dest_node=end_node.element_id, …)`; `_run_*_proj` = source graph; `_classify_error` by driver exception name (`ServiceUnavailable`/`SessionExpired` → transient + driver reset, `:348-350`; `AuthError` → auth; `ClientError` with `SyntaxError` code → syntax).
- **`NEO4J_DIALECT`** = column 2 of §3.2 (`elementId`, `keyset_urn_id`, `CALL db.labels()`, `CREATE INDEX … IF NOT EXISTS FOR (n:L) ON (n.p)` (`:560`), unique via `CREATE CONSTRAINT`, fulltext `db.index.fulltext.queryNodes`, `IS NOT NULL`, `REMOVE`, `count_is_constant_time=True`, `supports_exists_subquery=True`, `supports_call_in_transactions=True`, case-sensitive, `timeout_injection="tx_timeout"`).
- **Inherited unchanged from the base:** every contract method — reads, containment, lineage (`:901-1001` is the same algorithm as FalkorDB's), `get_trace_lineage` (`:1003-1165` duplicate), trace v2 (`:1232-1460` is a hand-copied orchestrator replaced by the lifted `trace_at_level`), ancestors with Redis (`:2057-2123`), writes (`:2221-2342`), hooks (`:2368-2453` = `EdgeListIdempotency`), purge (`:2508-2580`), `discover_schema` (`:2602-2658`), plus the methods Neo4j lacks today: `get_top_level_or_orphan_nodes`, `get_children_with_edges` (ABC default today), keyset cursors, `trace_closure`(+coarse), on-demand rollup synthesis, the batch materialiser, deep search, `get_counts_fast`, `get_node_degrees`, `update_edge`/`delete_edge`.
- **Provider code left:** `preflight` (`:230-258`), `_ensure_connected`/`_get_driver` (`:260-277`), `close`, `list_graphs` (system db, `:2586-2596`) — and the `SchemaMapping` codec seam (`schema_mapping.py:207-312`, `entity_type_strategy="property"` filter `:485-494`) which becomes a constructor-injected `NodeCodec` + a `dialect.entity_type_filter_tpl`. Migration = `Neo4jProvider(BoltExecutorMixin, CypherGraphProvider)` and delete `:634-2700`; `test_neo4j_provider_contract.py` snapshots pin behaviour.

---

## 12. Task list (subagent-sized, verification per task) and risks

Commit by pathspec; no amend/stash/reset. Unit lane: `cd backend && pytest tests -k "provider or falkordb or aggregation" -q`.

**M0 — Day-0 spike + infra**
- T0.1 compose service + `.env.example` block + `dev.sh` profile toggle. Verify: `docker compose --profile arcadedb up -d arcadedb && curl -s -o /dev/null -w '%{http_code}\n' localhost:2480/api/v1/ready` → `204`.
- T0.2 `day0_spike.py` (§10.4 #1-#16) → `docs/providers/arcadedb-day0.md`; correct §3.2 column 3 and the descriptor flags. Verify: 16 PASS/FAIL rows printed.
- T0.3 `capture_cypher_golden.py` — run every `FalkorDBProvider` method under a recording fake and write `backend/tests/golden/cypher/*.cypher` from the CURRENT provider (before any lifting). Verify: golden files exist; `test_cypher_provider_base_golden.py` is green against FalkorDB itself.

**M1 — lifted base + ArcadeDB browse/writes/health (descriptor registered)**
- T1.1 `cypher/result.py`, `cypher/dialect.py` (+ `FALKORDB_DIALECT`), `cypher/timeouts.py`, `cypher/base.py` (seam, setters, capability properties). Verify: `test_cypher_provider_base_result.py`, `_seam.py`, `_imports.py`.
- T1.2 lift `labels.py`, `ancestors.py`, `reads.py`, `containment.py`, `lineage.py`, `introspection.py`, `writes.py` (mechanical sed + `CypherTimeouts` + dialect fragments); `FalkorDBProvider` inherits and adds the five delegating `_run_*` methods + 3 overrides (`ensure_projections`, `stamp_identity_urns`, `set_projection_mode`). Verify: golden test green under `FALKORDB_DIALECT`; the whole existing FalkorDB lane green (`-k falkordb`); `test_falkordb_provider_contract.py` snapshots unchanged.
- T1.3 `arcadedb/client.py`, `dialect.py`, `schema.py`, `provider.py`, `descriptor.py`; catalog/manager registration. Verify: `test_arcadedb_provider_*.py`; `python -m backend.scripts.load_test_dataset --provider-id <id> --fixture small`; `ARCADEDB_TEST_URL=… UPDATE_PROVIDER_SNAPSHOTS=1 pytest tests/regression/test_arcadedb_provider_contract.py -v` (trace/agg snapshots may pin `NotImplementedError` until M2, `_runner.py:93-104`).
- T1.4 `seed_arcadedb_demo.py` + `smoke_arcadedb.py --checks browse`. Verify: smoke table PASS for browse/children/top-level/search/discover.
- T1.5 dialect conformance suite (§10.3) — run for BOTH providers. Verify: `pytest tests/regression/test_provider_dialect_conformance.py` green with `FALKORDB_HOST` and `ARCADEDB_TEST_URL` set.

**M2 — trace v2 + rollup reads + hooks**
- T2.1 lift `trace.py` + the `IdempotencyBackend` seam in `aggregation.py` (`RedisSetIdempotency` byte-identical for FalkorDB; `EdgeListIdempotency`). Verify: `test_cypher_provider_base_trace.py`, `_aggregation.py`; FalkorDB lane green; live: `POST /graph/edges` then `/edges/aggregated` shows cells on ArcadeDB.
- T2.2 lift `get_aggregated_edges_between` + synthesis. Verify: ported `test_falkordb_ondemand_pairs.py` cases under both dialects; contract snapshot `trace_at_level2_d1` re-captured and compared to FalkorDB's.

**M3 — Lens walk**
- T3.1 lift `closure.py`; `edge_page_order` rendering; `graph.py:855` regex relax. Verify: `test_cypher_provider_base_closure.py`; `test_trace_closure_wire_contract.py` + `_completeness.py` green for FalkorDB; smoke `--checks closure` incl. hub paging.

**M4 — generic batch materialiser**
- T4.1 `cypher/materialize.py` (keyset EXTRACT/RECONCILE, `pair_rules` COMPUTE, APPLY, `v3:` cursor, `_AggMeta`); FalkorDB keeps its override. Verify: `test_cypher_provider_base_materialize.py`; live aggregation job on the ArcadeDB source → `/edges/aggregated` `stale=false`, `regime="boundary"`, `stampVersion=2`; a re-run reports small `aggregated_edges_affected`.

**M5 — deep search**
- T5.1 lift `deep_search.py` (four edit kinds, §8); FalkorDB re-export shim. Verify: `pytest tests -k "deep_search or cypher_shapes" -q` byte-identical explain outputs; `test_cypher_provider_base_deep_search.py` under both dialects; smoke `--checks search`.
- T5.2 `migrate_native_properties.py --searchable-text` provider-agnostic. Verify: run against the ArcadeDB source; `discover.missingSearchableText == 0`.

**Wrap-up** — `docs/providers/arcadedb.md` + `docs/providers/adding-a-cypher-provider.md` (the §6 checklist), memory note; PR description lists the descriptor, the `graph.py:855` change, the `SCANNED_PATHS` additions, and the PR-1/PR-2 assumptions actually met.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Lifting changes FalkorDB behaviour | the biggest risk of the whole approach | golden-Cypher gate captured BEFORE lifting; all 62 instance-patched fakes keep working by construction (dynamic delegation, preserved names); FalkorDB contract snapshots unchanged; dialect conformance for FalkorDB asserts the flags the golden text relies on |
| Generic Cypher slower than FalkorDB (no `reduce_count`, HTTP per statement) | browse/trace latency ×2-5 on large graphs | label-bucket index seeks stay core; `ARCADEDB_QUERY_CONCURRENCY`; slow-query telemetry from day one; `counts_fast` off unless proven |
| HTTP round trips in per-pair paths | hook writes and closure pages slow | batched idempotency (`add_batch`), gathered bucket queries, sessions only where atomic |
| 100 MB body / 30 s session expiry | large batches fail, long sessions expire | byte-aware chunking; short sessions; retry-on-transient |
| Case-insensitive identifiers | ontology types collapsing; `:AGGREGATED` vs a user `aggregated` | casefold-collision rejection at injection; catalogue casing on writes; sentinel check |
| Identity property (`id`-keyed sources) | MERGE keys on `urn`; reads empty until stamped | keyset `stamp_identity_urns`; read-time fallback in `_node_from_props`; identity property indexed |
| Cursor grammar coupling | hub paging impossible on string-id engines | `edge_page_order` + regex relax; client treats cursors as opaque |
| Row-order dependence (positional rows from JSON objects) | silent column swaps | Day-0 #14; `columns=` at unaliased multi-column sites; `header` cross-check in the ArcadeDB executor (assert `len(header)==len(row)`) |
| No server-side cancel on ArcadeDB | runaway queries survive a client timeout | Day-0 #9; tight client budgets; documented |
| Must-declare types | first write per new label fails; unknown-label reads may error | `ensure_*_type_stmts` before writes (memoised); tolerant reads |
| App-level lazy imports left in the base | boot coupling for workers | source-text gate (`test_cypher_provider_base_imports.py`) forbids module-level app imports; PR 1 moves the pure modules to common |
| PR size | review fatigue | milestones behind capability flags; descriptor registered in M1 so ArcadeDB is usable early with reduced capabilities |

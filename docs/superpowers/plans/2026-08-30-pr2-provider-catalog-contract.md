# PR 2 of 3 — Provider contract, provider catalog, Admin UI

Repo: `/Volumes/ASMT ASM246X Media/dataviz` · branch base: `main` · produced 2026-08-30 (read-only exploration; every `file:line` below was read, not inferred).

## 0. Where this sits in the stack, and the seams PR 1 / PR 3 plug into

| PR | Scope | What it must leave for the others |
|---|---|---|
| **PR 1** (planned separately) | Split `backend/app/providers/falkordb_provider.py` (11.3k lines) into a package | The import path `backend.app.providers.falkordb_provider` keeps exporting `FalkorDBProvider`, `resolve_falkordb_target`, `CursorMismatchError` (after PR 2, the latter is a *re-export* of `backend.common.interfaces.provider.CursorMismatchError`). If PR 1 lands first, PR 2's one FalkorDB edit (§2.1) is made in the package module that owns the keyset-cursor helpers instead of monolith lines 182-185. |
| **PR 2** (this plan) | Formal contract (injection setters as base defaults on FalkorDB's attribute names) + feature flags + error family; ONE catalog-driven factory; `GET /admin/providers/types`; descriptor-driven validation/probe/discovery; ONE frontend catalog module; drift tests; docs | The seams below. **Zero behaviour change for the FalkorDB path** (checklist in §7.3). |
| **PR 3** | `CypherGraphProvider` base + `ArcadeDBProvider` (HTTP API, `language: "opencypher"`) | Registers one descriptor module, one enum member, one migration, one frontend visual entry — nothing else. |

**Seams PR 3 plugs into (all created by PR 2):**

1. `backend/common/providers/catalog/arcadedb.py` — a `ProviderDescriptor` with `connection=ConnectionShape(kind="generic", default_port=2480, auth="basic", tls="flag", database_field=FieldSpec("database", …))`, `capability=…`, `build(spec)` doing the lazy `from backend.app.providers.arcadedb_provider import ArcadeDBProvider`, plus one import line in `catalog/__init__.py`.
2. `ProviderType.ARCADEDB = "arcadedb"` in `backend/common/models/management.py:12-16`.
3. Migration `20260830_arcadedb_provider` (content in §3.6) + the ORM `CheckConstraint` literal at `backend/app/db/models.py:424`.
4. `ArcadeDBProvider.provider_type = "arcadedb"` class attribute; the six injection setters are inherited (base-class defaults in §2.2, or the Cypher base's FalkorDB-derived versions) — nothing to re-implement; `preflight()` returning `PreflightResult` with the reason vocabulary in §4.4.
5. Frontend: one entry in `PROVIDER_TYPE_IDS` + `PROVIDER_VISUALS` in `frontend/src/services/providerTypes.ts`. The wizard renders the `generic` connection shape (host/port/database/basic-auth/TLS) without edits; the schema-mapping step appears automatically because the descriptor declares `schema_discovery`.

**Non-goals for PR 2:** no new provider type; no change to what FalkorDB does; no move of FalkorDB-specific knobs (`falkordbConnection`, `cacheConnection`, sentinel/cluster panels) into a generic renderer — those stay bespoke and are merely *selected* by the catalog; **no DataHub / GraphQL work of any kind** (the DataHub adapter file is not edited; see D1 in §1.5 and §9 item 9). `ProviderDescriptor.family` is a plain string label (`"cypher" | "gql" | "graphql" | "native"`) surfaced in `GET /admin/providers/types`; nothing branches on it.

**Strategic direction the recipe (§8) is written for:** other OpenCypher/Cypher stores (Neo4j, Memgraph, Kùzu, Apache AGE, …) join by implementing a `CypherExecutor` + a `CypherDialect` on PR 3's Cypher base (`backend/graph/adapters/cypher/`), registering one descriptor, and running the provider conformance kit (§6.4) — no core edits.

---

## 1. Verified findings that shape the design

### 1.1 The contract as it stands

- `backend/common/interfaces/provider.py`: `GraphDataProvider(ABC)` with **25 abstract** members (confirmed by `GraphDataProvider.__abstractmethods__`: `create_edge, create_node, delete_edge, get_aggregated_edges_between, get_ancestors, get_children, get_descendants, get_distinct_values, get_downstream, get_edges, get_full_lineage, get_node, get_nodes, get_nodes_by_layer, get_nodes_by_tag, get_ontology_metadata, get_parent, get_schema_stats, get_stats, get_trace_lineage, get_upstream, name, save_custom_graph, search_nodes, update_edge`) and 15 defaults: one real default (`get_children_with_edges` L153-209), four `NotImplementedError` defaults (`get_top_level_or_orphan_nodes` L215-252, `trace_at_level` L315-345, `expand_aggregated` L347-383, `trace_closure` L385-417), ten no-ops (`set_projection_mode` L513, `ensure_projections` L522, `on_lineage_edge_written` L526, `on_lineage_edge_deleted` L536, `on_containment_changed` L545, `count_aggregated_edges` L549, `purge_aggregated_edges` L560, `discover_schema` L577, `list_graphs` L594, `close` L602).
- Errors: `ProviderConfigurationError(RuntimeError)` L17-30, `ProviderInputError(ValueError)` L33-46. `CursorMismatchError(ValueError)` lives in `backend/app/providers/falkordb_provider.py:182-185` and is imported by `backend/app/api/v1/endpoints/graph.py:27` and caught at `graph.py:1246, 1275, 1333, 1393, 1853`; `backend/tests/test_keyset_cursor_direction.py:8` imports it from the FalkorDB module.
- Capabilities: `ProviderCapability` frozen dataclass L49-64, `PROVIDER_CAPABILITIES` dict keyed by string L69-75 (includes `"mock"`), `capability_for()` L82-84. **Only consumer:** `graph.py:255-284` (`_assert_copyable`, `supports_copy`). `backend/app/providers/base.py` is a 5-line re-export shim.
- `backend/tests/test_context_engine.py`, `test_context_engine_ontology_injection.py`, `test_context_engine_source_alignment.py`, `test_api_graph.py` **subclass `GraphDataProvider`** as test doubles → **no new abstract members may be added** (every new contract member is a default).

### 1.2 Undeclared contracts (call sites that must keep working)

| Method | Discovered how | Sites |
|---|---|---|
| `set_containment_edge_types(types, from_ontology=)` | `hasattr` | `context_engine.py:355-359`; direct one-arg call `aggregation/worker.py:296`; `scripts/load_test_dataset.py:177-180`; `scripts/resync_identity_repro.py:114` |
| `set_ontology_rules(rules)` | `hasattr` | `context_engine.py:360-369` — defined by NO concrete provider, only `versioned_write_provider.py:100` |
| `set_resolved_edge_metadata(meta, lineage_types)` | `hasattr` | `context_engine.py:370-374` |
| `set_entity_type_levels(levels)` | `hasattr` | `context_engine.py:375-385`; `worker.py:340-342`; `scripts/backfill_aggregated_levels.py:217-218` |
| `set_source_type_aliases(rel_map, entity_map=)` | `hasattr` | two-arg `context_engine.py:390-395, 608-609, 654-655`; **one-arg** `worker.py:316-327` |
| `set_node_identity(identity, name)` | `hasattr` | `context_engine.py:406-411`; `worker.py:306-307` |
| `ensure_indices(labels)` | `hasattr`/`getattr` | `context_engine.py:529-533`; `worker.py:354-356`; `aggregation/service.py:657`; scripts |
| `stamp_identity_urns()` | `hasattr` | `worker.py:370-372` |
| `set_admission_controller(ctl)` | `hasattr` | `worker.py:384-389`, direct `worker.py:722` |
| `materialize_aggregated_edges_batch(**kw)` | `hasattr` → `ValueError` | `context_engine.py:856-864`; **direct** `worker.py:1374`; scripts |
| `materialize_lineage_for_edge` | direct | `services/lineage_aggregator.py:23` (module has no production caller — tests only) |
| `trace_closure_coarse(...)` | `getattr` | `context_engine.py:1391` (absent → fine walk) |
| `trace_closure` | `getattr` | `context_engine.py:1405-1407` |
| `get_node_degrees(urns, edge_types)` | `getattr` → `{}` | `context_engine.py:832-835` |
| `get_counts_fast()` | `getattr` → `None` | `aggregation/reconcile_sweeper.py:628`; `insights_service/collector.py:510` |
| `prime_stats_cache(stats)` | `getattr` | `insights_service/collector.py:410` |
| `clear_content_caches()` | **direct** | `aggregation/service.py:1824, 2124` |
| `physical_graph_id()` | `getattr` + `_base` unwrap | `graph.py:591-619` |
| `preflight(deadline_s=)` | `getattr` + `inspect.iscoroutinefunction` | `manager.py:480-519` (L414: "Providers without a preflight() are never gated"); `providers.py:160-181`; `warmup.py:442-447` (reason `preflight_not_implemented`) |
| `inflight_ops()` | direct in `try/except` | `manager.py:937, 957, 1014` (only FalkorDB has it, L1079-1082) |
| `close()` | contract default | `manager.py:948, 1021`; `providers.py:198-203` |
| `deep_search*` | `DeepSearchProvider` Protocol (`services/deep_search/contracts.py:40-77`) | `advanced_search_service.py:417, 456, 481` (`NotImplementedError` → 501 via `graph.py:1422-1441`) |
| `get_nodes_batch(urns)` | none in api/services — only the providers' own `TraceOrchestrator` callbacks | FalkorDB L10038, Neo4j L1787, Spanner L1781 |

`CircuitBreakerProxy` (`backend/common/adapters/circuit.py:355-409`) forwards attribute access to `.target`; `VersionedWriteProvider.__getattr__` (`versioned_write_provider.py:85-88`) forwards non-private names to `_inner`; `DraftOverlayProvider` does **not** forward (`draft_overlay_provider.py:102-154`).

### 1.3 Dispatch — two verbatim copies

- `backend/app/providers/manager.py:1153-1273` `ProviderManager._create_provider_instance(provider_type, host, port, graph_name, tls_enabled, credentials=None, extra_config=None, provider_id=None)` (staticmethod).
- `backend/app/registry/provider_registry.py:290-395` `ProviderRegistry._create_provider_instance(self, …, credentials: dict, …)` — same body; the module re-exports `provider_manager` at L403.
- Callers: `manager.py:1112`, `provider_registry.py:228, 250`, `providers.py:141, 610`, `warmup.py:724-733`, `insights_service/discovery.py:83-93`, `scripts/load_test_dataset.py:141-149`, `tests/test_phase0_spanner_create_flow.py:170`. Tests monkeypatch `provider_registry._create_provider_instance` (`test_api_providers.py:279-290, 336-340, 377-380`) and call both statics positionally and by keyword (`test_falkordb_auth_gating.py:87-130`, `test_provider_cluster_config.py:93-105`, `test_falkordb_empty_graph.py:157-160`, `test_provider_registry.py:28-55`). **Both signatures are frozen.** `test_provider_registry.py:41` pins the message `"Unknown provider_type"`.

### 1.4 Persistence / API / frontend (as briefed, verified)

`ProviderType(str, Enum)` `management.py:12-16` (no MOCK); `ConnectionCredentials` L31-58 (`extra="forbid"`); `ProviderCreateRequest` L433-494 (validators L452-494), `ProviderUpdateRequest` L497-525 (no `provider_type` field), `ProviderResponse` L528-557. `ProviderORM` `db/models.py:386-427` with `ck_providers_provider_type` L423-426 listing `'falkordb','neo4j','datahub','spanner','mock'`. Migration precedent `alembic/versions/20260508_spanner_provider.py`. Endpoints in `providers.py` (routes: `/status` L206, `''` L304/L363, `/test-connection` L325, `/{id}` L373/L406/L443, `/{id}/impact` L461, `/{id}/test` L480, `/{id}/discover-schema` L625; gates L40-41). Router mounted at `api.py:64` with prefix `/admin/providers`. Frontend sites: §5.4.

### 1.5 Latent defects found while reading (each gets a decision in this plan)

| # | Defect | Evidence | PR 2 decision |
|---|---|---|---|
| D1 | **`DataHubGraphQLProvider` cannot be instantiated.** Missing 6 abstract members (`create_edge, delete_edge, get_aggregated_edges_between, get_full_lineage, get_trace_lineage, update_edge`); its `create_node(self, request)` also deviates from the ABC. Registering a DataHub provider "succeeds" (row written) but every probe/instantiation raises `TypeError: Can't instantiate abstract class…` | Confirmed by importing and constructing `DataHubGraphQLProvider("http://x")` | **Deferred — DataHub stays untouched per the lead.** The catalog contract test (§6.1 T4) carries `KNOWN_UNINSTANTIABLE = {"datahub"}` with this defect cited, so it still guards every other type (and PR 3's arcadedb). The 6-stub fix is a 30-line follow-up whenever DataHub is picked up (§9 item 9). |
| D2 | **Neo4j's `set_containment_edge_types(self, types)` has no `from_ontology` kwarg** (`neo4j_provider.py:428-434`) while `context_engine.py:356-359` calls it with `from_ontology=` → `TypeError` on the injection path | grep `from_ontology` in the Neo4j module: none | One-line signature fix (`from_ontology: bool = True`, unused), covered by the setter-signature test (§6.1 T2). |
| D3 | `clear_content_caches()` is called unconditionally (`aggregation/service.py:1824, 2124`) — FalkorDB-only method → `AttributeError` for other types | method list of Neo4j/Spanner | Base-class default no-op. |
| D4 | `DraftOverlayProvider` forwards only `set_containment_edge_types` + `set_node_identity` to `_base` (`draft_overlay_provider.py:118-144`); levels/edge-metadata/aliases never reach the base on a draft read (works only because the shared cached base was injected earlier) | file read | Forward the remaining four setters (8 lines) — same pattern as L142-144. |
| D5 | The wizard sends `username/password` for DataHub (`buildCredentials` L656-704) but the dispatch reads `credentials["token"]` (`manager.py:1230-1233`) → token never reaches DataHub | file read | The DataHub *descriptor* declares `auth="token"` and the wizard's generic codec emits `{token}` — catalog metadata + wizard only; the adapter file is untouched. |
| D6 | `lineage_aggregator.py` imports `FalkorDBProvider` at module level and `isinstance`-checks (L3, L37); no production callers | grep | Retype against `GraphDataProvider`; `get_aggregator` uses `supports_feature(provider, AGGREGATION_MATERIALIZATION)`. |
| D7 | `"mock"` is allowed by the CHECK and listed in `PROVIDER_CAPABILITIES`, but has no enum member, no class, no dispatch branch; `docs/BACKEND.md:474` cites a `mock_provider.py` that does not exist | grep | Not registrable; kept as a legacy DB literal (`LEGACY_DB_ONLY_TYPES`) so no narrowing migration is needed. `test_workspace_scoped_reads.py:296` posts `providerType: "mock"` and expects 403 (auth runs first) — unaffected. |
| D8 | Wizard schema discovery creates + deletes a **throwaway provider row** with `providerType: 'neo4j'` hard-coded (`ProviderOnboardingWizard.tsx:1147-1191`) | file read | New `POST /admin/providers/discover-schema` (unsaved payload, like `/test-connection`). |
| D9 | `search_nodes` contract signature is `(query, limit=10)` while FalkorDB L3326 / DataHub L163 / VersionedBranchProvider L95 accept `offset=0` | file read | Add `offset: int = 0` to the abstract signature (additive; optional hygiene). |

---

## 2. Formal contract redesign — `backend/common/interfaces/provider.py`

Design rules: (1) no new abstract members (§1.1); (2) every new default is the *exact* behaviour the call sites already assume when the attribute is missing; (3) FalkorDB keeps every override it has today (its setters upper-case, its `inflight_ops`, `preflight`, etc. — untouched).

### 2.1 Error family (contract-level)

```python
class ProviderConfigurationError(RuntimeError): ...   # unchanged, L17-30
class ProviderInputError(ValueError): ...             # unchanged, L33-46

class CursorMismatchError(ValueError):
    """Moved verbatim from backend/app/providers/falkordb_provider.py:182-185.
    Endpoints map this (and only this) to HTTP 400."""

class ProviderFeatureUnsupportedError(NotImplementedError):
    """The provider exists and is reachable but does not implement an OPTIONAL
    feature. Subclass of NotImplementedError so every existing
    ``except NotImplementedError`` (graph.py:960, 1541, 1594, 1639 → 501;
    advanced_search_service.py:430; context_engine.py:2154) keeps working."""
    def __init__(self, feature: "ProviderFeature | str", provider: str): ...
```

Edits: `falkordb_provider.py:182-185` becomes `from backend.common.interfaces.provider import CursorMismatchError  # re-export; endpoints/tests import it from the interface` (keep the name in the module namespace so `test_keyset_cursor_direction.py:8` and PR 1's package `__init__` keep working). `graph.py:27` → `from backend.common.interfaces.provider import CursorMismatchError, ProviderConfigurationError` (merge with L26). The four base-class `NotImplementedError` defaults (L249, L342, L380, L414) raise `ProviderFeatureUnsupportedError` instead (same messages).

### 2.2 The six injection setters as base-class members (no separate state object)

Lead's decision (master plan §2.1): the defaults store into **the same attribute names FalkorDB uses**. Verified why: 19 test files read those attributes directly (`grep -rl "_resolved_containment_types\|_entity_type_levels\|_resolved_edge_metadata\|_source_rel_aliases\|_node_identity_property" backend/tests` — e.g. `test_context_engine_ontology_injection.py`, `test_falkordb_materialize.py`, `test_cypher_shapes.py`, `test_phase3_spanner_owned_schema.py`), FalkorDB reads them in 42 places, and PR 3's Cypher base carries FalkorDB's richer setters — a second state model would only diverge. **The attribute names are therefore part of the contract**; PR 1's extracted `backend/common/providers/ontology_state.py` (the master plan's kernel module) must keep them, and if PR 1 lands first the interface defaults below may delegate to its plain-assignment variants.

Base-class additions (all defaults; `GraphDataProvider` has no `__init__` and subclasses never call `super().__init__()` — each setter simply assigns, and readers keep using `getattr(self, "_resolved_containment_types_set", False)`-style access exactly as today):

```python
class GraphDataProvider(ABC):
    provider_type: ClassVar[Optional[str]] = None   # catalog id; every registered adapter sets it

    # Defaults = the plain-assignment core of FalkorDB's own setters
    # (falkordb_provider.py:2319-2622) minus its side effects (level-digest
    # re-probe, ancestors-cache namespace). FalkorDB / Neo4j / Spanner keep their overrides.
    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        if from_ontology or types:                                        # L2339-2342
            self._resolved_containment_types: Set[str] = {t.upper() for t in (types or [])}
            self._resolved_containment_types_set = True
    def set_ontology_rules(self, rules: Any) -> None:
        self._ontology_rules = rules                                      # only versioned_write_provider.py:100 stores it today
    def set_resolved_edge_metadata(self, edge_type_metadata: Dict[str, Any], lineage_edge_types: List[str]) -> None:
        self._resolved_edge_metadata = {k.upper(): v for k, v in (edge_type_metadata or {}).items()}   # L2572-2574
        self._resolved_lineage_types: Set[str] = {t.upper() for t in (lineage_edge_types or [])}
        self._resolved_edge_metadata_set = True
    def set_entity_type_levels(self, mapping: Dict[str, int]) -> None:
        self._entity_type_levels: Dict[str, int] = dict(mapping or {})    # neo4j_provider.py:442 form (no digest)
    def set_source_type_aliases(self, relationship_aliases: Dict[str, List[str]],
                                entity_aliases: Optional[Dict[str, List[str]]] = None) -> None:
        self._source_rel_aliases = {str(k).upper(): [str(s) for s in v] for k, v in (relationship_aliases or {}).items()}   # L2591-2594
        self._source_entity_aliases = {str(k).upper(): [str(s) for s in v] for k, v in (entity_aliases or {}).items()}
    def set_node_identity(self, identity_property: Optional[str] = None, name_property: Optional[str] = None) -> None:
        # Verbatim L2614-2622: lazy import of backend.app.services.node_identity for
        # DEFAULT_IDENTITY_PROPERTY="urn" / DEFAULT_NAME_PROPERTY="name" (node_identity.py:45,52) —
        # the precedent FalkorDB sets. backend/common/providers/identity.py's
        # DEFAULT_DISPLAY_NAME_PROPERTY="displayName" is a different concept; do not use it here.
        self._node_identity_property = ...; self._name_property = ...
    def set_admission_controller(self, controller: Optional[Any]) -> None: pass     # FalkorDB stores it; others ignore
    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None) -> None: pass
    async def stamp_identity_urns(self) -> int: return 0
```

Signatures accept every call shape in the wild: `set_containment_edge_types(types, from_ontology=…)` (`context_engine.py:356-359`) and one-arg (`worker.py:296`); `set_source_type_aliases(m)` (`worker.py:327`) and `(m, m)` (`context_engine.py:392`); `set_node_identity(None, None)` (`context_engine.py:411`). Case handling: the defaults upper-case like FalkorDB and Neo4j (L433); Spanner's verbatim-spelling override (`spanner_provider.py:647-658`) stays. FalkorDB (`falkordb_provider.py:2319-2622`), Neo4j (`neo4j_provider.py:428-470`) and Spanner (`spanner_provider.py:647-693`) keep their overrides; only Neo4j gains the `from_ontology` kwarg (D2). PR 3's `ArcadeDBProvider` inherits the Cypher base's (FalkorDB-derived) setters and overrides nothing.

**Call-site policy ("plain calls, tolerant during transition"):** concrete providers now always have the members, but the three wrappers are not `GraphDataProvider` subclasses (`VersionedBranchProvider` defines only `set_containment_edge_types`; `DraftOverlayProvider` two setters; `VersionedWriteProvider` delegates). So the eight `hasattr` blocks collapse onto one helper instead of raw calls:

```python
# backend/common/interfaces/provider.py
def call_optional(provider: Any, method: str, *args: Any, **kwargs: Any) -> bool:
    """Call ``provider.<method>`` when present; True if it ran. Concrete providers
    always have the contract members; wrappers (versioned/draft) may not."""
    fn = getattr(provider, method, None)
    if not callable(fn): return False
    fn(*args, **kwargs); return True

async def await_optional(provider, method, *args, default=None, **kwargs): ...
```

Edits: `context_engine.py:355-385` (`_inject_resolved`) → six `call_optional(self.provider, "set_…", …)` lines; `:390-395, 406-411, 608-609, 654-655` likewise; `:529-533` → `await await_optional(self.provider, "ensure_indices", labels)`; `worker.py:306-307, 316-327, 340-342, 354-356, 370-372, 384-389` likewise (keep the `try/except`+warning wrappers as they are); `scripts/load_test_dataset.py:177`, `scripts/backfill_aggregated_levels.py:217` → `call_optional`. `worker.py:296` (direct call) stays.

### 2.3 Explicit optional features

```python
class ProviderFeature(str, Enum):
    WRITABLE = "writable"; FULL_CRUD = "full_crud"; GRAPH_COPY = "graph_copy"   # = the three existing bools
    TRACE_CLOSURE = "trace_closure"          # trace_closure()  (graph.py:960 → 501 trace_closure_unsupported)
    COARSE_TRACE = "coarse_trace"            # trace_closure_coarse() rollup lane (context_engine.py:1391)
    DEEP_SEARCH = "deep_search"              # DeepSearchProvider protocol
    AGGREGATION_MATERIALIZATION = "aggregation_materialization"   # materialize_aggregated_edges_batch
    BLANK_MODELS = "blank_models"            # versioning.py:1282 gate
    SCHEMA_DISCOVERY = "schema_discovery"    # discover_schema() is real (Neo4j L2602, Spanner L1754)
    MULTI_GRAPH = "multi_graph"              # list_graphs() enumerates real graphs

@dataclass(frozen=True)
class ProviderCapability:
    writable: bool; full_crud: bool; is_external: bool; supports_copy: bool
    features: FrozenSet[ProviderFeature] = frozenset()
    def supports(self, f: ProviderFeature) -> bool:
        if f is ProviderFeature.WRITABLE: return self.writable
        if f is ProviderFeature.FULL_CRUD: return self.full_crud
        if f is ProviderFeature.GRAPH_COPY: return self.supports_copy
        return f in self.features

_DEFAULT_CAPABILITY = ProviderCapability(writable=False, full_crud=False, is_external=True, supports_copy=False)  # unchanged

def capability_for(provider_type: Optional[str]) -> ProviderCapability:
    from backend.common.providers.catalog import descriptor_for   # lazy: the catalog imports this module
    d = descriptor_for(provider_type)
    return d.capability if d is not None else _DEFAULT_CAPABILITY
```

`PROVIDER_CAPABILITIES` (L69-75) is deleted — the catalog descriptors are the single source (grep: no importer other than the module itself). Feature matrix per type (from the adapters' actual method lists):

| type | writable | full_crud | external | copy | features |
|---|---|---|---|---|---|
| falkordb | ✓ | ✓ | – | ✓ | TRACE_CLOSURE, COARSE_TRACE, DEEP_SEARCH, AGGREGATION_MATERIALIZATION, BLANK_MODELS, MULTI_GRAPH |
| neo4j | ✓ | – | – | – | SCHEMA_DISCOVERY, MULTI_GRAPH (trace_at_level/expand yes; no trace_closure L1232-1377) |
| spanner | ✓ | ✓ | – | – | SCHEMA_DISCOVERY, MULTI_GRAPH (L1754, L1758) |
| datahub | – | – | ✓ | – | ∅ |

`backend/tests/test_provider_capability.py:11-12` compares `capability_for("falkordb")` to a 4-field literal → update that assertion to compare fields (or include `features=`).

**Two kinds of gate, stated explicitly:**

1. *Admission gates* — where the caller holds a provider **row** (endpoint/service), use `capability_for(row.provider_type).supports(ProviderFeature.X)` and answer 422 `provider_unsupported`. Sites converted in PR 2: `versioning.py:1282-1286` (BLANK_MODELS), `graph.py:278` (already `supports_copy` → `supports(GRAPH_COPY)`), `providers.py` discover-schema (SCHEMA_DISCOVERY, §4.3), `context_engine.py:856-857` (`materialize_aggregated_edges`: `supports_feature(self.provider, AGGREGATION_MATERIALIZATION)` else the same `ValueError`).
2. *Runtime tolerance* — on a live instance (possibly a wrapper) keep exception-based fallbacks: `ProviderFeatureUnsupportedError ⊂ NotImplementedError → 501`. Wrappers like `DraftOverlayProvider` implement `deep_search` by delegation (L458-481), so an instance-level feature lookup would be wrong for them; a row-level gate is the honest one.

Instance helpers (for the few places with no row in hand):

```python
def unwrap_provider(p: Any, max_depth: int = 5) -> Any:
    """Peel CircuitBreakerProxy(.target) → VersionedWriteProvider(._inner) → DraftOverlayProvider(._base).
    Mirrors graph.py:591-619."""
def provider_type_of(p: Any) -> Optional[str]: return getattr(type(unwrap_provider(p)), "provider_type", None)
def supports_feature(p: Any, f: ProviderFeature) -> bool: return capability_for(provider_type_of(p)).supports(f)
```

### 2.4 Per-method decisions

| Member | Decision | Justification |
|---|---|---|
| `preflight(*, deadline_s) -> PreflightResult` | **Documented required-by-convention; NOT a base default; NOT abstract.** The catalog contract test (§6.1 T4) asserts every registered class defines `async def preflight`. Docstring added to the ABC listing the `preflight.py:4-13` contract. | A base default returning a failure would make `manager.py:491-517` gate every such provider as `down`; a success default would lie; abstract breaks the four test doubles (§1.1). All four adapters implement it today. |
| `close()` | keep default no-op (L602) | already contract |
| `list_graphs()` | keep default `[]` (L594); meaning declared by `MULTI_GRAPH` | already contract |
| `inflight_ops() -> int` | **default `return 0`** | `manager.py:935-939` already treats exceptions as 0; 0 = idle, identical eviction behaviour |
| `get_nodes_batch(urns) -> List[GraphNode]` | **default** `await self.get_nodes(NodeQuery(urns=urns, limit=max(1, len(urns))))` | real behaviour, no caller depends on absence; lets PR 3's trace orchestration use it |
| `trace_closure_coarse(...)` | **stays out of the contract** (FalkorDB rollup lane); `context_engine.py:1391` keeps `getattr`; declared by `COARSE_TRACE` for information | provider-specific signature (`aggregated_edge_type`, `max_cells`); absence is a valid, handled state |
| `get_counts_fast() -> Optional[Dict]` | **default `return None`** ("counters cannot describe this graph") | exactly what `reconcile_sweeper.py:628-632` / `collector.py:510-518` do on absence; call sites keep `getattr` (collector's provider may be a wrapper) |
| `prime_stats_cache(stats)` | **default no-op** | `collector.py:410-412` |
| `get_node_degrees(urns, edge_types=None) -> Dict[str,int]` | **default `return {}`** ("absent means unknown") | `context_engine.py:829-835` |
| `clear_content_caches()` | **default no-op** | fixes D3; FalkorDB override untouched (L5610) |
| `physical_graph_id() -> Optional[str]` | **default `return None`** | `graph.py:611-613` returns the call's result; `None` = "no physical identity" = today's outcome for Neo4j/Spanner |
| `materialize_aggregated_edges_batch(**kwargs) -> Dict[str, Any]` | **default raises `ProviderFeatureUnsupportedError`**; admission via `AGGREGATION_MATERIALIZATION` | `worker.py:1374` calls it directly; today a non-FalkorDB job dies with `AttributeError` — after PR 2 with a typed error the job handler already maps to failed/non-retryable (verify in the worker's except chain when implementing; do not widen scope) |
| `materialize_lineage_for_edge` | stays FalkorDB-only (no contract); `lineage_aggregator.py` retyped (D6) | no production caller |
| `discover_schema()` | keep default `{}` (L577); admission via `SCHEMA_DISCOVERY` | endpoints stop returning `{}` for types that cannot discover (§4.3) |
| `deep_search*` | stays a Protocol (`contracts.py:40-77`); declared by `DEEP_SEARCH` | the Protocol is already provider-agnostic; wrappers implement it by delegation |
| `search_nodes` | add `offset: int = 0` to the abstract signature (D9, optional) | additive |

### 2.5 Backward compatibility

- **`DataHubGraphQLProvider`** (`backend/graph/adapters/datahub_provider.py`): **not edited** (lead's instruction). Its descriptor still exists (so the type keeps its card, label and `auth="token"` shape), `provider_class_path` points at the class, and T4 allow-lists it as known-uninstantiable (D1). No `provider_type` ClassVar is added to it — no instance ever exists to read it.
- **`VersionedWriteProvider`** (`versioned_write_provider.py`): unchanged — `__getattr__` forwards every new default to `_inner`; its two intercepts (L90-107) still forward via `getattr(..., None)`.
- **`VersionedBranchProvider`** (`versioned_branch_provider.py:54-70`): unchanged; reached only through `call_optional`.
- **`DraftOverlayProvider`** (`draft_overlay_provider.py:118-144`): add forwarders for `set_entity_type_levels`, `set_resolved_edge_metadata`, `set_source_type_aliases`, `set_ontology_rules` to `_base` (D4), same 3-line pattern as L142-144.
- **Test doubles** subclassing the ABC: unaffected (defaults only).
- **`CircuitBreakerProxy`**: unaffected (attribute forwarding).

### 2.6 Remaining leak edits (backend)

| Site | Today | After |
|---|---|---|
| `services/lineage_aggregator.py:3, 8, 35-39` | module import + `isinstance(provider, FalkorDBProvider)` | `from backend.common.interfaces.provider import GraphDataProvider, ProviderFeature, supports_feature`; `get_aggregator` returns `LineageAggregator(provider) if supports_feature(provider, AGGREGATION_MATERIALIZATION) else None`. `tests/test_lineage_aggregator.py` uses fakes via `LineageAggregator(provider=…)` — unaffected; its `get_aggregator` cases must pass a fake whose class sets `provider_type = "falkordb"` (update the test). |
| `endpoints/graph.py:27` | imports `CursorMismatchError` from the FalkorDB module | from the interface (§2.1) |
| `endpoints/versioning.py:1282-1286` | `prov.provider_type != "falkordb"` | `if not capability_for(prov.provider_type).supports(ProviderFeature.BLANK_MODELS):` same 422 body, message `f"Blank models are not supported on '{ptype}' providers yet."` |
| `endpoints/providers.py:155-160` | falkordb sentinel/cluster → `_ensure_connected()` | `descriptor.probe_strategy(extra_config) == "full_connect"` (§4.2) |
| `endpoints/providers.py:129-135` | reads `falkordbConnection.probeDeadlineS` | `descriptor.probe_deadline_s(extra_config, 2.0)` |
| `endpoints/providers.py:342-351` | Spanner host/port rejection inline | `descriptor.validate(req)` → 422 `provider_config_invalid` (§4.2) |
| `context_engine.py:856-857` | `hasattr(... "materialize_aggregated_edges_batch")` | `supports_feature(self.provider, AGGREGATION_MATERIALIZATION)` (same `ValueError` on false) |
| `frontend …/useBlankScopeOptions.ts:97` | `providerType === 'falkordb'` | `supportsFeature(provider.providerType, 'blank_models')` (§5) |

Deliberately **kept** (allow-listed in the drift test, §6.3): `providers/falkor_graph_registry.py:103` (a FalkorDB projection registry is FalkorDB by definition), `insights_service/discovery.py:210` (GRAPH.LIST drift semantics), `endpoints/redis_config.py:227` (Redis-role dashboard listing FalkorDB hosts), `scripts/check_trace_query_plans.py:106`, `scripts/backfill_aggregation.py:67` (FalkorDB tooling), `services/system_status/probes.py:556-672` (service keys, not provider types).

---

## 3. Provider catalog — `backend/common/providers/catalog/`

`backend/common/providers/__init__.py` is docstring-only (no imports), so importing the catalog pulls in nothing heavy. Driver modules are imported **inside `build()` only** — exactly as `manager.py:1168, 1213, 1229, 1240` do today.

### 3.1 Package layout

```
backend/common/providers/catalog/
  __init__.py      # public API: PROVIDER_CATALOG, register, descriptor_for, require_descriptor,
                   #   create_provider_instance, registered_type_ids, LEGACY_DB_ONLY_TYPES
                   #   + bottom-of-file `from . import falkordb, neo4j, datahub, spanner  # noqa` (self-registration)
  descriptor.py    # ProviderSpec, FieldSpec, ConnectionShape, ProviderDescriptor, ProviderRequestError
  falkordb.py      # register(ProviderDescriptor(id="falkordb", …, build=_build))
  neo4j.py
  datahub.py
  spanner.py
```

This is the layout the master plan's §2.2 fixes. Its architecture sketch also shows PR 3's descriptor living inside the adapter package (`backend/graph/adapters/arcadedb/descriptor.py`); both are satisfied by making `catalog/arcadedb.py` a two-liner — `from backend.graph.adapters.arcadedb.descriptor import DESCRIPTOR; register(DESCRIPTOR)` — **provided** `backend/graph/adapters/arcadedb/__init__.py` imports no provider/driver code at module level (the `build()` inside `descriptor.py` does the lazy import). T4's "no driver in `sys.modules` after importing the catalog" assertion enforces that for every type.

### 3.2 Dataclasses (`descriptor.py`)

```python
@dataclass(frozen=True)
class ProviderSpec:
    """Normalised constructor input — the union of what both dispatchers accept today
    (manager.py:1153-1162 / provider_registry.py:290-300)."""
    provider_type: str
    host: Optional[str]
    port: Optional[int]
    graph_name: Optional[str]
    tls_enabled: bool
    credentials: Mapping[str, Any]              # decrypted; {} when absent
    extra_config: Optional[Mapping[str, Any]]
    provider_id: Optional[str] = None

class ProviderRequestError(ValueError):
    """A create/test payload that is structurally wrong for this provider type.
    Endpoints map it to 422 {"type": "provider_config_invalid", …}."""

FieldKind = Literal["text", "number", "password", "textarea", "boolean"]
FieldLocation = Literal["column", "credentials", "extraConfig"]   # providers.host/port | encrypted blob | extra_config JSON

@dataclass(frozen=True)
class FieldSpec:
    key: str; label: str; kind: FieldKind; location: FieldLocation
    required: bool = False; secret: bool = False; default: Any = None
    placeholder: Optional[str] = None; help: Optional[str] = None

ShapeKind = Literal["generic", "falkordb", "spanner"]   # which frontend panel renders the connection step
AuthKind = Literal["basic", "token", "service_account", "none"]
ProbeStrategy = Literal["preflight", "full_connect"]

@dataclass(frozen=True)
class ConnectionShape:
    kind: ShapeKind
    uses_host_port: bool
    default_port: Optional[int]
    tls: Literal["flag", "none"]                 # "flag" = the tlsEnabled toggle is shown
    auth: AuthKind
    database_field: Optional[FieldSpec] = None   # generic shape: a provider-level default database (extraConfig)
    fields: Tuple[FieldSpec, ...] = ()           # informational for bespoke shapes; rendered for generic
    secret_credential_keys: Tuple[str, ...] = () # keys of ConnectionCredentials this type uses
    extra_config_keys: Tuple[str, ...] = ()      # FORM-OWNED extra_config keys (wizard rebuilds these)

ProviderFamily = Literal["cypher", "gql", "graphql", "native"]   # a LABEL only — nothing branches on it

@dataclass(frozen=True)
class ProviderDescriptor:
    id: str; label: str; description: str; docs_url: Optional[str]
    family: ProviderFamily                       # falkordb/neo4j "cypher", spanner "gql", datahub "graphql"
    capability: ProviderCapability
    connection: ConnectionShape
    build: Callable[[ProviderSpec], "GraphDataProvider"]
    provider_class_path: str                     # "backend.app.providers.falkordb_provider:FalkorDBProvider" (contract tests)
    validate: Callable[[Any], None] = lambda req: None            # raises ProviderRequestError
    probe_strategy: Callable[[Optional[Mapping[str, Any]]], ProbeStrategy] = lambda extra: "preflight"
    probe_deadline_s: Callable[[Optional[Mapping[str, Any]], float], float] = lambda extra, default: default
    admin_visible: bool = True
```

### 3.3 Registry (`__init__.py`)

```python
PROVIDER_CATALOG: Dict[str, ProviderDescriptor] = {}
LEGACY_DB_ONLY_TYPES: FrozenSet[str] = frozenset({"mock"})   # accepted by ck_providers_provider_type, never registrable (D7)

def register(d: ProviderDescriptor) -> ProviderDescriptor:
    if d.id in PROVIDER_CATALOG: raise RuntimeError(f"provider type {d.id!r} registered twice")
    PROVIDER_CATALOG[d.id] = d; return d
def descriptor_for(provider_type: Optional[str]) -> Optional[ProviderDescriptor]:
    return PROVIDER_CATALOG.get((provider_type or "").lower())
def require_descriptor(provider_type: str) -> ProviderDescriptor:
    d = descriptor_for(provider_type)
    if d is None: raise ValueError(f"Unknown provider_type: {(provider_type or '').lower()!r}")   # message pinned by test_provider_registry.py:41
    return d
def create_provider_instance(spec: ProviderSpec) -> "GraphDataProvider":
    return require_descriptor(spec.provider_type).build(spec)
def registered_type_ids() -> Tuple[str, ...]: return tuple(PROVIDER_CATALOG)

from . import falkordb, neo4j, datahub, spanner   # noqa: E402,F401  (PR 3 adds `arcadedb`)
```

### 3.4 Per-type descriptors — bodies moved verbatim from `manager.py`

`family` per type: falkordb `"cypher"`, neo4j `"cypher"`, spanner `"gql"`, datahub `"graphql"` (PR 3: arcadedb `"cypher"`). It is a label carried to the API/UI; no code path reads it.

**`falkordb.py`** — `_build(spec)` = `manager.py:1167-1210` unchanged (`resolve_falkordb_target(host, port)`; `_falkor_conn = (extra or {}).get("falkordbConnection")`; `_auth_enabled = (_falkor_conn or {}).get("authEnabled", True)`; the 12 kwargs incl. `graph_name=spec.graph_name or "nexus_lineage"`, `cache_redis_url=creds.get("cache_redis_url")`, `provider_id`, `extra_config`, `credentials=creds`). `probe_strategy(extra)`: `"full_connect"` when `((extra or {}).get("falkordbConnection") or {}).get("mode") in ("sentinel", "cluster")` (= `providers.py:155-159`). `probe_deadline_s(extra, default)`: `max(default, float(probeDeadlineS))` with the `TypeError/ValueError` tolerance (= `providers.py:129-135`). `validate(req)`: `_validate_falkordb_connection(req.extra_config); _validate_cache_connection(req.extra_config)` (the two helpers stay in `management.py:212, 392`; the pydantic model validators keep calling them too — no behaviour change). `connection = ConnectionShape(kind="falkordb", uses_host_port=True, default_port=6379, tls="flag", auth="basic", secret_credential_keys=("username","password","cache_username","cache_password","cache_sentinel_username","cache_sentinel_password","sentinel_username","sentinel_password","cache_redis_url"), extra_config_keys=("falkordbConnection","cacheConnection"))`. `provider_class_path="backend.app.providers.falkordb_provider:FalkorDBProvider"`. Capability per §2.3.

**`neo4j.py`** — `_build` = `manager.py:1213-1226` (`uri=f"{'bolt+s' if tls else 'bolt'}://{host}:{port or 7687}"`, `username=creds.get("username","neo4j")`, `password=creds.get("password","")`, `database=spec.graph_name or "neo4j"`, `extra_config`, `provider_id`, `credentials=creds`). Shape: `generic`, port 7687, `auth="basic"`, `extra_config_keys=("schemaMapping",)` plus the documented knobs `maxConnectionPoolSize`, `connectionTimeout`, `redisUrl` (informational fields, not form-owned). `provider_class_path="backend.graph.adapters.neo4j_provider:Neo4jProvider"`.

**`datahub.py`** — `_build` = `manager.py:1229-1233` (`base_url=spec.host or ""`, `token=creds.get("token")`). Shape: `generic`, `uses_host_port=True` (the host field is the base URL; port 8080 per the wizard default L299), `tls="none"`, `auth="token"`, `secret_credential_keys=("token",)`. `validate`: require a non-empty `host`. `provider_class_path="backend.graph.adapters.datahub_provider:DataHubGraphQLProvider"`.

**`spanner.py`** — `_build` = `manager.py:1239-1271` including the `SYNODIC_ALLOW_SPANNER_EMULATOR` env gate and the `ValueError` messages verbatim (`test_phase0_spanner_create_flow.py` P0.5 pins the emulator rejection). `validate(req)`: the host/port rejection text from `providers.py:342-351` (raised as `ProviderRequestError`). Shape: `kind="spanner"`, `uses_host_port=False`, `default_port=None`, `tls="none"`, `auth="service_account"`, `secret_credential_keys=("project_id","service_account_json")`, `extra_config_keys=("projectId","instanceId","databaseId","graphName","useEmulator","schemaMapping")`. `provider_class_path="backend.graph.adapters.spanner_provider:SpannerProvider"`.

Each adapter class gets `provider_type: ClassVar[str] = "<id>"` (FalkorDB: one line next to `name`, L2316).

### 3.5 Both entry points delegate

```python
# manager.py:1153-1273 →
@staticmethod
def _create_provider_instance(provider_type, host, port, graph_name, tls_enabled,
                              credentials=None, extra_config=None, provider_id=None) -> GraphDataProvider:
    """Dispatch to the catalog. Signature frozen (tests + 6 callers)."""
    from backend.common.providers.catalog import ProviderSpec, create_provider_instance
    return create_provider_instance(ProviderSpec(
        provider_type=provider_type, host=host, port=port, graph_name=graph_name,
        tls_enabled=tls_enabled, credentials=credentials or {}, extra_config=extra_config,
        provider_id=provider_id))

# provider_registry.py:290-395 →
def _create_provider_instance(self, provider_type, host, port, graph_name, tls_enabled,
                              credentials, extra_config=None, provider_id=None):
    from backend.app.providers.manager import ProviderManager
    return ProviderManager._create_provider_instance(provider_type, host, port, graph_name,
                                                     tls_enabled, credentials, extra_config, provider_id)
```

`apply_local_dev_falkordb_override` (`manager.py:55-75`) is consumed inside `resolve_falkordb_target` (FalkorDB module) — untouched. Callers (`providers.py:141, 610`, `warmup.py:724`, `discovery.py:83`, `load_test_dataset.py:141`) are unchanged; the monkeypatches in `test_api_providers.py` keep working because the endpoints still call `provider_registry._create_provider_instance` (the `provider_manager` alias, `providers.py:21`).

**Two `inspect.getsource` pins constrain this step** (master-plan guardrail (f)):
- `backend/tests/test_falkordb_host_resolution.py:113-116` asserts the source of `ProviderManager._create_provider_instance` contains `resolve_falkordb_target(` and not `apply_local_dev_falkordb_override(`. After delegation the resolver call lives in the falkordb descriptor's `_build`, so the pin is **retargeted deliberately** (its intent — ONE resolver function on every path — still holds): assert on `inspect.getsource(backend.common.providers.catalog.falkordb._build)`, and add `assert "create_provider_instance(" in inspect.getsource(mgr.ProviderManager._create_provider_instance)` so the manager provably delegates. Same treatment for any sibling pin on `provider_registry._create_provider_instance` (none found today).
- `backend/tests/test_worker_warmup_and_falkor_probe.py:194-204` asserts `_load_provider_for_outbound`'s source contains `extra_config` and `_create_provider_instance(` — §4.3 keeps that helper calling `provider_registry._create_provider_instance(...)`, so it holds unchanged.

### 3.6 Keeping `ProviderType`, the DB CHECK and the catalog in sync

- `ProviderType` (`management.py:12-16`) **stays a hand-written enum** (pydantic/OpenAPI need static members; `management.py:465` references `ProviderType.SPANNER`). Sync is enforced by `backend/tests/test_provider_catalog_sync.py` (§6.1 T3), not by generation.
- `db/models.py:423-426` CHECK literal must equal `registered_type_ids() ∪ LEGACY_DB_ONLY_TYPES`.
- The newest migration touching `ck_providers_provider_type` must declare the same set in `_NEW_TYPES`.

**Migration `backend/alembic/versions/20260830_arcadedb_provider.py`** (26-char id). Recommended to land in **PR 3** together with the enum member and descriptor (landing it in PR 2 forces the sync test to carry a `RESERVED_DB_TYPES = {"arcadedb"}` exception until PR 3). Content = `20260508_spanner_provider.py:1-77` with: docstring "Widen providers.provider_type CHECK to include arcadedb"; `revision = "20260830_arcadedb_provider"`; `down_revision = "<head at merge time — 20260827_1000_system_account when this plan was written; confirm with `cd backend && alembic heads`>"`; `_NEW_TYPES = ("falkordb","neo4j","datahub","spanner","mock","arcadedb")`; `_OLD_TYPES = ("falkordb","neo4j","datahub","spanner","mock")`; downgrade refuses when `provider_type='arcadedb'` rows exist. Rules from `docs/MIGRATIONS.md:89-141`: guard DDL, leave data unconditional (this one has only DDL); ORM literal updated in the same commit; CI `schema.yml` (`fresh-install` / `forward-migrate` / `chain-replay`) and `alembic-guards.yml` (32-char) cover it.

---

## 4. Admin API — `backend/app/api/v1/endpoints/providers.py`

### 4.1 `GET /api/v1/admin/providers/types`

- **Declare it immediately after `/status` (L206-292) and before `GET /{provider_id}` (L373)** — FastAPI matches in declaration order; declared later, `/types` would resolve as `provider_id="types"` → 404.
- Gate: `_REQUIRES_PROVIDER_READ` (L40) — the catalog is non-secret metadata and non-admin surfaces (view wizard scope step, workspace pages) render type labels. Writes stay `system:admin`.
- Handler: `return [descriptor_to_info(d) for d in PROVIDER_CATALOG.values() if d.admin_visible]` — pure, zero I/O.
- Models in `backend/common/models/management.py` next to `ProviderResponse` (camelCase aliases, `populate_by_name = True`):

```python
class ProviderTypeCapabilities(BaseModel):
    writable: bool; full_crud: bool = Field(alias="fullCrud"); is_external: bool = Field(alias="isExternal")
    supports_copy: bool = Field(alias="supportsCopy"); features: List[str]
class ProviderTypeField(BaseModel):
    key: str; label: str; kind: str; location: str; required: bool = False; secret: bool = False
    default: Optional[Any] = None; placeholder: Optional[str] = None; help: Optional[str] = None
class ProviderTypeConnectionShape(BaseModel):
    kind: str; uses_host_port: bool = Field(alias="usesHostPort"); default_port: Optional[int] = Field(None, alias="defaultPort")
    tls: str; auth: str; database_field: Optional[ProviderTypeField] = Field(None, alias="databaseField")
    fields: List[ProviderTypeField] = []; secret_credential_keys: List[str] = Field(alias="secretCredentialKeys")
    extra_config_keys: List[str] = Field(alias="extraConfigKeys")
class ProviderTypeInfo(BaseModel):
    id: str; label: str; description: str; docs_url: Optional[str] = Field(None, alias="docsUrl")
    family: str                                   # "cypher" | "gql" | "graphql" | "native" — informational
    capabilities: ProviderTypeCapabilities; connection_shape: ProviderTypeConnectionShape = Field(alias="connectionShape")
    admin_visible: bool = Field(True, alias="adminVisible")
```

Example row (falkordb): `{"id":"falkordb","label":"FalkorDB","description":"High-performance graph database","docsUrl":null,"family":"cypher","capabilities":{"writable":true,"fullCrud":true,"isExternal":false,"supportsCopy":true,"features":["trace_closure","coarse_trace","deep_search","aggregation_materialization","blank_models","multi_graph"]},"connectionShape":{"kind":"falkordb","usesHostPort":true,"defaultPort":6379,"tls":"flag","auth":"basic","databaseField":null,"fields":[],"secretCredentialKeys":[…],"extraConfigKeys":["falkordbConnection","cacheConnection"]},"adminVisible":true}`.

### 4.2 `/test-connection` (L325-360) and `/{id}/test` (L480-586) through the descriptor

`_run_connectivity_probe` (L102-203) changes only its type-specific lines:

```python
descriptor = descriptor_for(_provider_type_value(provider_type))
if descriptor is None:
    return ConnectionTestResult(success=False, error="provider_unsupported")
PREFLIGHT_DEADLINE_S = descriptor.probe_deadline_s(extra_config, 2.0)       # replaces L129-135
…
use_full_connect = descriptor.probe_strategy(extra_config) == "full_connect"   # replaces L155-159
```

Everything else (instance build via `provider_registry._create_provider_instance`, `_ensure_connected()` for full-connect, `preflight` → `get_stats()` fallback L183-187, close L196-203) is unchanged. `/test-connection` L342-351 becomes:

```python
descriptor = require_descriptor_or_422(req.provider_type)          # 422 provider_unsupported
try: descriptor.validate(req)
except ProviderRequestError as exc:
    raise HTTPException(422, detail={"type": "provider_config_invalid", "providerType": req.provider_type.value, "message": str(exc)})
```

The same two lines run at the top of `create_provider` (L363-370). `update_provider` (L406-440): `ProviderUpdateRequest` has no type; resolve the row (`old_prov.provider_type`) and call `descriptor.validate_update(req)` only if a descriptor defines one (default no-op) — the pydantic validators (`management.py:452-456, 521-525`) keep running as today, so no 422 shape changes for existing payloads. Only the inline Spanner check moves, and its shape becomes the structured one above (the frontend's `friendlyError` at `providerService.ts:187-215` already reads `detail.message`/`detail.type`; §5.3 adds the `provider_config_invalid` mapping).

### 4.3 Schema discovery

- `POST /{provider_id}/discover-schema` (L625-639): before `_load_provider_for_outbound`, read the row's type (it is already fetched inside the helper — hoist the type out or fetch via `with_short_session()` first) and `if not capability_for(ptype).supports(ProviderFeature.SCHEMA_DISCOVERY): raise HTTPException(422, {"type": "provider_unsupported", "message": …})`. Today FalkorDB/DataHub return `{}` silently.
- **New** `POST /discover-schema` (declare with `/test-connection`, before `/{provider_id}`): body `ProviderCreateRequest` (+ optional `assetName: str | None` — accept a wrapper model `SchemaDiscoveryRequest(provider: ProviderCreateRequest, asset_name: Optional[str] = Field(None, alias="assetName"))`), gate `system:admin`, same descriptor validation + capability check, builds a transient instance (`provider_registry._create_provider_instance(...)` with `graph_name=asset_name`), `asyncio.wait_for(instance.discover_schema(), 15)`, `close()` in `finally` — mirrors L632-639. This removes the wizard's throwaway row (D8).

### 4.4 Error / reason vocabulary (admin providers API)

| Where | Shape | Values |
|---|---|---|
| 422 unknown or incapable type | `{"detail": {"type": "provider_unsupported", "providerType": …, "message": …}}` | reuses the literal already used by `graph.py:280` and `versioning.py:1280, 1284` |
| 422 descriptor validation | `{"detail": {"type": "provider_config_invalid", "providerType": …, "message": …}}` | new |
| 200 `ConnectionTestResult.error` | reason code string | existing `preflight.py` vocabulary: `ok, connect_timeout, dns_unresolvable, tcp_refused, os_error: …, error: …, auth_required, auth_failed, auth_not_configured, cluster_mode_mismatch, empty_reply, redis_error: …, httpx_not_installed, preflight_not_implemented, warmup_wall_clock_exceeded`; **added in PR 2** for HTTP-speaking providers (DataHub today, ArcadeDB in PR 3): `tls_handshake` (`ssl.SSLError` branch in `preflight._classify`, L45-60 — the frontend key already exists at `providerService.ts:172`) and `http_status_<nnn>` for a non-2xx reply where the provider chooses not to classify; providers MUST map 401 → `auth_required` (no credential sent) / `auth_failed` (credential sent) and 403 → `auth_failed` themselves. Add a `http_json_preflight(url, *, deadline_s, headers, expect_status=(200, 204))` helper next to `http_head_preflight` (`preflight.py:335-360`) returning those codes — PR 3's `GET /api/v1/ready` (204) uses it. |
| 504 / 500 discover-schema | existing (`providers.py:636-639`) | unchanged |

---

## 5. Frontend — one catalog module

### 5.1 `frontend/src/services/providerTypes.ts` (new; pure data + helpers, no fetch → no import cycle with `providerService.ts`)

```ts
import type { ComponentType } from 'react'
import { Database } from 'lucide-react'
import { DataHubLogo, FalkorDBLogo, Neo4jLogo, SpannerLogo } from '@/components/admin/ProviderLogos'

export const PROVIDER_TYPE_IDS = ['falkordb', 'neo4j', 'datahub', 'spanner', 'mock'] as const
export type ProviderType = (typeof PROVIDER_TYPE_IDS)[number]
export function isProviderType(x: unknown): x is ProviderType

export interface ProviderTypeVisual {
  label: string          // 'FalkorDB' | 'Neo4j' | 'DataHub' | 'Google Spanner Graph' | 'Mock'
  shortLabel: string     // 'FDB' | 'Neo4j' | 'DH' | 'Spanner' | 'Mock'   (WorkspaceListRow)
  desc: string           // card blurb (wizard / RegistryConnections / ScopeStep)
  Logo: ComponentType<{ className?: string }>
  color: string          // card tint: 'text-amber-500 bg-amber-500/10 border-amber-500/20' …
  tint: string           // hero gradient (DataSourceProfile PROVIDER_TINT)
  accent: string         // accent bar (DataSourceGridCard)
}
export const PROVIDER_VISUALS: Record<ProviderType, ProviderTypeVisual>      // the ONLY place logos/colors/labels live
export const UNKNOWN_PROVIDER_VISUAL: ProviderTypeVisual                      // Database icon, slate tints, label = raw id
export function providerVisual(type: string | null | undefined): ProviderTypeVisual   // PROVIDER_VISUALS[type] ?? {...UNKNOWN, label: type}
export function providerLabel(type): string; export function providerShortLabel(type): string

// wire shape of GET /admin/providers/types (mirrors ProviderTypeInfo, camelCase)
export type ProviderFeature = 'writable' | 'full_crud' | 'graph_copy' | 'trace_closure' | 'coarse_trace' | 'deep_search'
  | 'aggregation_materialization' | 'blank_models' | 'schema_discovery' | 'multi_graph'
export type ShapeKind = 'generic' | 'falkordb' | 'spanner'
export type AuthKind = 'basic' | 'token' | 'service_account' | 'none'
export interface ProviderTypeField { key; label; kind; location; required?; secret?; default?; placeholder?; help? }
export interface ProviderTypeConnectionShape { kind: ShapeKind; usesHostPort: boolean; defaultPort: number | null; tls: 'flag' | 'none'; auth: AuthKind; databaseField: ProviderTypeField | null; fields: ProviderTypeField[]; secretCredentialKeys: string[]; extraConfigKeys: string[] }
export type ProviderFamily = 'cypher' | 'gql' | 'graphql' | 'native'   // label only; no UI behaviour hangs off it
export interface ProviderTypeInfo { id: string; label: string; description: string; docsUrl?: string | null; family: ProviderFamily; capabilities: { writable; fullCrud; isExternal; supportsCopy; features: string[] }; connectionShape: ProviderTypeConnectionShape; adminVisible: boolean }
export interface ProviderTypeEntry extends ProviderTypeInfo { visual: ProviderTypeVisual }
export function parseProviderTypeInfo(raw: unknown): ProviderTypeInfo | null   // hand-written runtime guard — there is no zod/OpenAPI client; `request<T>` merely casts `res.json()`
export function parseProviderTypeList(raw: unknown): ProviderTypeInfo[]        // drops malformed rows (logged once), never throws

/** Offline snapshot of the backend catalog for the 4 visible types (+ mock, adminVisible:false).
 *  Used while the catalog query is loading / in tests; a vitest pins it against
 *  `src/services/__fixtures__/providerTypes.backend.json` (exported from the backend, §6.2). */
export const STATIC_PROVIDER_TYPES: ProviderTypeEntry[]
export function mergeCatalog(infos: ProviderTypeInfo[] | undefined): ProviderTypeEntry[]   // info + providerVisual(info.id); falls back to STATIC when undefined
export function providerTypeEntry(id: string | null | undefined, types?: ProviderTypeEntry[]): ProviderTypeEntry  // lookup → static → synthetic unknown (generic shape, no features)
export function supportsFeature(idOrEntry: string | ProviderTypeEntry, feature: ProviderFeature, types?: ProviderTypeEntry[]): boolean
export function shapeKind(id, types?): ShapeKind; export function defaultPortFor(id, types?): number   // null → 0 (keeps `port: number`)
export function formOwnedExtraKeys(entry): Set<string>   // new Set(['schemaMapping', ...entry.connectionShape.extraConfigKeys])
```

`providerService.ts:17` becomes `export type { ProviderType } from './providerTypes'` (existing importers `ProviderOnboardingWizard.tsx:33` and `ScopeStep.tsx:42` keep compiling) and gains `listTypes(): Promise<ProviderTypeInfo[]>` (`GET ${ADMIN_API}/types`, `SILENT_READ`) plus `discoverSchemaUnsaved(req: ProviderCreateRequest, assetName?: string)` (`POST ${ADMIN_API}/discover-schema`, `timeoutMs: 20_000`). `friendlyError` gains two entries: `provider_config_invalid` (pass the message through) and a `http_status_` prefix rule.

### 5.2 `frontend/src/hooks/useProviderTypes.ts`

```ts
export function useProviderTypes(): { types: ProviderTypeEntry[]; byId: Record<string, ProviderTypeEntry>; isLoading: boolean; source: 'backend' | 'static' } {
  const q = useQuery({ queryKey: ['providers', 'types'], queryFn: () => providerService.listTypes(), staleTime: Infinity, retry: 1 })
  return useMemo(() => { const types = mergeCatalog(q.data); return { types, byId: …, isLoading: q.isLoading, source: q.data ? 'backend' : 'static' } }, [q.data, q.isLoading])
}
```

Same pattern as `useBlankScopeOptions.ts:48-52`. **The wizard takes the catalog as a prop** (`providerTypes?: ProviderTypeEntry[]`, default `STATIC_PROVIDER_TYPES`) and `RegistryConnections` (already rendered under `QueryClientProvider` in its test, `RegistryConnections.test.tsx:3`) calls the hook and passes it down — the three wizard test files (`ProviderOnboardingWizard.test.tsx`, `__tests__/ProviderOnboardingWizard.extraConfig.test.tsx`, `__tests__/ProviderOnboardingWizard.editTest.test.tsx`) render with only `MemoryRouter` and keep passing untouched.

### 5.3 Wizard refactor — `frontend/src/components/admin/ProviderOnboardingWizard.tsx` (2952 lines), exact edits

| Lines | Today | After |
|---|---|---|
| 33, 41 | imports `ProviderType`, the four logos | import `providerTypeEntry, shapeKind, defaultPortFor, supportsFeature, formOwnedExtraKeys, STATIC_PROVIDER_TYPES, type ProviderTypeEntry` from `@/services/providerTypes`; logos no longer imported here |
| 139-170 `ProviderOnboardingFormData` | `spanner?`, `falkordbConnection?` | add `generic: { database: string; token: string }` (host/port/username/password stay top-level as today) |
| 178-186 props | — | `providerTypes?: ProviderTypeEntry[]` |
| 188-223 `PROVIDER_TYPES` | 4 hard-coded cards | **deleted**; `const visibleTypes = providerTypes.filter(t => t.adminVisible)` |
| 293-295 `getProviderConfig` | array find | `providerTypeEntry(type, providerTypes)` (returns `{ label, visual }`) |
| 297-305 `defaultPortForProvider` | if-chain | `defaultPortFor(type, providerTypes)` |
| 307-309 `isSpanner` | `type === 'spanner'` | `shapeKind(type, providerTypes) === 'spanner'`; add `isFalkor(type)` = `shapeKind === 'falkordb'`, `isGeneric(type)` |
| 361-464 `buildInitialFormData(provider)` | `provider?.providerType === 'spanner' / 'falkordb'` (L364-365) | `buildInitialFormData(provider, types = STATIC_PROVIDER_TYPES)` — derive `isSpannerProvider/isFalkorDBProvider` from `shapeKind`; hydrate `generic.database` from `extra[entry.connectionShape.databaseField?.key]`; `generic.token = ''` (write-only) |
| 471-475 `FORM_OWNED_EXTRA_KEYS` | static set | `formOwnedExtraKeys(entry)`; `FORM_OWNED_FALKORDB_CONN_KEYS` (479-485) stays (FalkorDB-internal) |
| 507-650 `buildExtraConfig(formData)` | Spanner branch L526-533, FalkorDB branch L535-647 | `buildExtraConfig(formData, types?)`: `preserveUnknownKeys(raw, formOwnedExtraKeys(entry))`, common `schemaMapping` block unchanged, then `switch (entry.connectionShape.kind)`: `'spanner'` → existing body; `'falkordb'` → existing body; `'generic'` → `if (databaseField && formData.generic.database.trim()) out[databaseField.key] = …` |
| 656-704 `buildCredentials(formData)` | Spanner / FalkorDB branches | by `entry.connectionShape.auth`: `service_account` → existing L657-664; `token` → `{ token: formData.generic.token || undefined }`; `basic` → existing L665-703 (the FalkorDB cache/sentinel extras only when `kind === 'falkordb'`); `none` → `undefined`. Fixes D5. |
| 706-727 `buildConnectivityRequest` | `isSpannerType` | `usesHostPort = entry.connectionShape.usesHostPort` |
| 850-868 `steps` | `providerType === 'neo4j' \|\| 'spanner'` | `supportsFeature(entry, 'schema_discovery')` |
| 883-915 `canProceed` | Spanner fields L890-896, FalkorDB nodes L898-907 | by shape kind; generic adds `databaseField?.required && !formData.generic.database.trim() → false` and `auth === 'token' && !formData.generic.token → allowed` (token optional, as today's password) |
| 975 legacy-cache effect | `provider?.providerType !== 'falkordb'` | `!isFalkor(provider?.providerType)` |
| 1147-1191 `handleDiscoverSchema` | creates + deletes a throwaway `'neo4j'` row | `providerService.discoverSchemaUnsaved(buildConnectivityRequest(formData, types))`; `suggestedMapping` handling unchanged (L1169-1182) |
| 1223-1226 submit gate | unchanged | unchanged |
| 1251, 1257 `credentialsClear` | `providerType === 'falkordb'` | `isFalkor(formData.providerType)` |
| 1332 `currentConfig` | `getProviderConfig(...)` | `providerTypeEntry(...)`; usages `currentConfig.color/Logo/label` → `entry.visual.color/Logo`, `entry.label` |
| 1334-1387 `renderTypeStep` | maps `PROVIDER_TYPES` | maps `visibleTypes` (`entry.visual.Logo`, `entry.visual.color`, `entry.label`, `entry.description`); `onClick` sets `port: defaultPortFor(entry.id)`; grid stays `md:grid-cols-3` |
| 1426-1523 Spanner panel | `isSpanner(...)` | `shape.kind === 'spanner'` (JSX unchanged) |
| 1525-1543 host/port | rendered for every non-Spanner type | rendered when `shape.usesHostPort`; **insert** after it: `shape.databaseField && <GenericDatabaseField spec=…>` (label/placeholder/help from the spec) |
| 1546-1613 auth block | FalkorDB toggle + username/password | `shape.auth === 'basic'` → existing block (FalkorDB toggle only when `kind === 'falkordb'`); `shape.auth === 'token'` → one password-type "API token" input bound to `generic.token` (with the same "stored — leave blank to keep" hint when `authConfigured`); `'none'`/`'service_account'` → nothing here |
| 1615-2040, 1966, 2042 FalkorDB topology / TLS / cache panels | `providerType === 'falkordb'` | `isFalkor(formData.providerType)` (JSX unchanged) |
| 2309-2372 schema step | copy says "Neo4j" | `${entry.label}`; the discover button's `disabled={schemaLoading \|\| !formData.host}` becomes `!canProbe` (= `canProceed` for the connection step) |
| 2550, 2558 review "Access" | FalkorDB auth toggle check | `hasCredentials(formData, entry)` helper (basic: username/password; token: token; service_account: SA JSON) |
| 2645 review block for `neo4j` | schema-mapping summary | `supportsFeature(entry, 'schema_discovery')` |
| 2854-2856 step switch | unchanged | unchanged |

Nothing in the FalkorDB panels changes except the boolean that selects them. The generic shape's extra inputs (`database`, API token) are conditional on the selected descriptor, so the FalkorDB connection step renders exactly the same controls — a hard requirement of the positional queries in the existing wizard tests (§6.2).

### 5.4 Every type-enumerating site and its replacement (17 sites; 4 look-alikes excluded)

| # | Site | Today | Replacement |
|---|---|---|---|
| 1 | `services/providerService.ts:17` | literal union | `export type { ProviderType } from './providerTypes'` |
| 2 | `components/admin/ProviderOnboardingWizard.tsx` | §5.3 | §5.3 |
| 3 | `components/admin/RegistryConnections.tsx:21-30` | `PROVIDER_TYPES` + `getProviderConfig` | `const { types } = useProviderTypes()`; `providerTypeEntry(p.providerType, types).visual`; pass `providerTypes={types}` to the wizard |
| 4 | `components/admin/RegistryAssets.tsx:84-89` | 3-entry `PROVIDER_TYPES` (spanner missing!) | `providerVisual(type)` |
| 5 | `components/admin/ProviderLogos.tsx:122-133` `getProviderLogo` | substring match | body → `return providerVisual(type).Logo` (keep the export; the SVG components stay in this file — `providerTypes.ts` imports them, so `getProviderLogo` must import `providerVisual` lazily or move to `providerTypes.ts` with a re-export here to avoid a cycle: **move it**, re-export from `ProviderLogos.tsx`) |
| 6 | `components/admin/AdminInfrastructure/ProjectionPanel.tsx:33-35` `PROVIDER_LABEL` | 5-entry map | `providerLabel(type)` |
| 7 | `components/admin/AdminInfrastructure/GraphProvidersPanel.tsx:14-20` `TYPE_LABEL` | 5-entry map | `providerLabel(p.type)` |
| 8 | `components/views/ViewWizard/steps/ScopeStep.tsx:743-753` `PROVIDER_TYPE_META`, `PROVIDER_TYPE_ORDER`, `providerMeta` | copied meta | `providerVisual(type)`; `PROVIDER_TYPE_ORDER = PROVIDER_TYPE_IDS.filter(id => id !== 'mock')` |
| 9 | `components/views/ViewWizard/useBlankScopeOptions.ts:97` | `providerType === 'falkordb'` | `supportsFeature(provider.providerType, 'blank_models', types)` with `const { types } = useProviderTypes()` (hook already under react-query); update the doc comment L7-9 and L26 |
| 10 | `components/admin/workspace/WorkspaceListRow.tsx:120` | ternary short labels | `providerShortLabel(pt)` |
| 11 | `components/admin/workspace/WorkspaceHeroHeader.tsx:184` | ternary labels | `providerLabel(p.providerType)` |
| 12 | `components/admin/workspace/DataSourceGridCard.tsx:86-89` | ternary gradients | `providerVisual(providerInfo?.providerType).accent` |
| 13 | `pages/WorkspacesPage.tsx:44-49` `providerLabel` | local fn | delete; import `providerLabel` |
| 14 | `components/admin/workspace/useWorkspaceDetailData.ts:28` | comment `'falkordb' \| 'neo4j' \| 'datahub' \| 'mock'` | comment → "a `ProviderType` id (see providerTypes.ts)"; type stays `string` |
| 15 | `components/insights/DataSourceProfile.tsx:74-79, 279-280` `PROVIDER_TINT` | 4-entry map (+ `?? 'falkordb'` default) | `providerVisual(provider?.providerType).tint` / `.Logo` |
| 16 | `components/ingestion/profiling/ProfilingBoard.tsx:473` | `getProviderLogo(row.provider_type ?? 'falkordb')` | `providerVisual(row.provider_type).Logo` (unknown → neutral icon instead of silently FalkorDB) |
| 17 | `services/systemStatusService.ts:93` | comment listing types | comment → "a provider type id" |

Excluded (not provider types): `AdminRedis/index.tsx:552` and `services/redisConfigService.ts:13` (Redis *roles*), `AdminInfrastructure/ServiceTile.tsx:58,103` (infrastructure service keys), `lib/pageIndex.ts:293` (search keywords).

### 5.5 The TS `ProviderType` union — decision

Keep a **union derived from `PROVIDER_TYPE_IDS as const`** (compile-time exhaustiveness for `PROVIDER_VISUALS`, and `Record<ProviderType, …>` fails to compile the moment PR 3 adds `'arcadedb'` to the array without a visual — the desired forcing function), plus the runtime guard `isProviderType()` for wire data. Responses may carry ids a newer backend knows and this bundle does not; `providerVisual()` renders them with `UNKNOWN_PROVIDER_VISUAL` rather than crashing. `ProviderResponse.providerType` stays typed `ProviderType` (no callers narrow on it unsafely once §5.4 lands).

---

## 6. Tests (TDD order — each test is written red before its task)

Backend commands run from `backend/` (`pytest.ini`: `testpaths = tests`, `asyncio_mode = auto`). The CI-required suite is `python -m pytest tests/ -q -m "not integration" -k "falkordb or preflight or warmup or circuit or redis or bus or provider or probes or manager or aggregation or insights"` (`.github/workflows/backend-tests.yml`) — every new file name below contains `provider` so it lands in the required job. Frontend: `cd frontend && npx vitest run <path>` (CI: `npx vitest run`); `npx tsc --noEmit` is not gated (79 baseline errors — record the count before/after and do not add to it).

Lane facts (from the test explorer): the required backend lane runs 1407 tests today and `-k` matches file **paths** — name every new backend test file with `provider`, `manager` or `probes` in it (all files below comply); the full lane (6380 tests) is informational; root-run guards `python -m pytest backend/tests/test_alembic_revision_lengths.py backend/tests/test_feature_wiring.py -q --noconftest` must stay green (T3 imports the app, so it is deliberately NOT added to that job); `npm run lint` (180+ warnings) is not gated either — add to neither count; `backend/app/providers/` is a namespace package (no `__init__.py`) — do not add one; `backend/tests/test_jobs_lint.py` forbids `.publish(`/`.xadd(` outside its 16-entry allow-list — catalog code publishes nothing.

### 6.1 Backend

| # | File | Pins |
|---|---|---|
| T1 | `tests/test_provider_contract_defaults.py` | A minimal `GraphDataProvider` subclass (only the 25 abstract members) has: every §2.2 setter, and after calling them the FalkorDB attribute names hold the expected values without any `__init__` (`_resolved_containment_types == {"CONTAINS"}`, `_resolved_containment_types_set is True`, `set_containment_edge_types([], from_ontology=False)` leaves the sentinel unset, `_entity_type_levels`, `_resolved_edge_metadata`/`_resolved_lineage_types`/`_resolved_edge_metadata_set`, `_source_rel_aliases`/`_source_entity_aliases`, `_node_identity_property == "urn"` and `_name_property == "name"` after `set_node_identity(None, None)`), `inflight_ops()==0`, `get_counts_fast() is None`, `get_node_degrees()=={}`, `physical_graph_id() is None`, `clear_content_caches()`/`prime_stats_cache()` no-ops, `get_nodes_batch` delegates to `get_nodes` with `NodeQuery(urns=…)`, `materialize_aggregated_edges_batch` raises `ProviderFeatureUnsupportedError` which `isinstance(…, NotImplementedError)`; `CursorMismatchError` importable from the interface AND `backend.app.providers.falkordb_provider` (same object); `call_optional` returns False on a bare object and True on the double. |
| T2 | `tests/test_provider_setter_signatures.py` | For every catalog class (resolved from `provider_class_path`), `inspect.signature` of the six setters accepts the call shapes used in the wild: `set_containment_edge_types(types, from_ontology=True)` (catches D2), `set_source_type_aliases(m)` and `(m, m)`, `set_node_identity(None, None)`. |
| T3 | `tests/test_provider_catalog_sync.py` | `{m.value for m in ProviderType} == set(registered_type_ids())`; regex over `backend/app/db/models.py` text `provider_type IN \((.*?)\)` → set == catalog ∪ `LEGACY_DB_ONLY_TYPES`; newest `alembic/versions/*.py` containing `ck_providers_provider_type` (max by filename) parsed via `ast` → `_NEW_TYPES` set == the same; every descriptor: `admin_visible` types have label/description, `connection.default_port` is `int|None`, `secret_credential_keys ⊆ ConnectionCredentials.model_fields`, `extra_config_keys` non-empty only for shapes that own keys. |
| T4 | `tests/test_provider_catalog_classes.py` | For each descriptor: class resolves, `issubclass(cls, GraphDataProvider)`, `inspect.iscoroutinefunction(cls.preflight)`; for every id NOT in `KNOWN_UNINSTANTIABLE = {"datahub"}` (D1, cited in the test): `cls.provider_type == d.id` and `cls.__abstractmethods__ == frozenset()`; a datahub entry that unexpectedly becomes instantiable fails too ("remove it from the allow-list"). Instantiation smoke: `d.build(sample_spec)` succeeds for falkordb/neo4j (no I/O in constructors) and for spanner with `SYNODIC_ALLOW_SPANNER_EMULATOR=1` + `useEmulator` (per `test_phase0_spanner_create_flow.py:170` precedent). Also: importing `backend.common.providers.catalog` in a fresh subprocess leaves no `redis`/`neo4j`/`google.cloud` in `sys.modules`. |
| T5 | `tests/test_provider_dispatch_equivalence.py` | Monkeypatch each adapter class's `__init__` (on its module) with a recorder that stores kwargs and returns; call `ProviderManager._create_provider_instance(...)` and `ProviderRegistry()._create_provider_instance(...)` with identical positional args for each type (incl. falkordb with `falkordbConnection.authEnabled=false`, `cache_redis_url`, `tls_enabled=True`, `provider_id`); assert both recorders equal AND equal a **golden kwargs dict per type** written into the test (the snapshot of today's `manager.py:1190-1209 / 1214-1226 / 1230-1233 / 1263-1271`). Unknown type → `ValueError` matching `"Unknown provider_type"` from both entry points. |
| T6 | `tests/test_api_provider_types.py` | `GET /api/v1/admin/providers/types` → 200, 4 rows, camelCase keys, `falkordb.capabilities.features` contains `blank_models` and `connectionShape.kind == "falkordb"`, `falkordb.family == "cypher"`, `spanner.family == "gql"`, `datahub.connectionShape.auth == "token"`, no `mock`; with `UPDATE_PROVIDER_TYPES_FIXTURE=1` the test writes the response to `frontend/src/services/__fixtures__/providerTypes.backend.json` (F8 pins the frontend against it); a non-admin workspace user with `workspace:provider:read` gets 200 (same fixture style as `test_workspace_scoped_reads.py`); route ordering: `GET /admin/providers/types` does not 404 as `provider_id="types"`. |
| T7 | `tests/test_api_providers.py` (extend) | `/test-connection` with `providerType: "spanner"` + `host` → 422 `detail.type == "provider_config_invalid"`; unknown type → 422 `provider_unsupported` (pydantic rejects first — assert the enum 422 still fires); the existing `_create_provider_instance` monkeypatch tests unchanged; falkordb `mode: "cluster"` payload uses `_ensure_connected` (patch instance) — pins `probe_strategy`; `probeDeadlineS` test (L362-409) unchanged. |
| T8 | `tests/test_api_provider_discover_schema.py` | `POST /admin/providers/discover-schema` (unsaved, `system:admin`) calls `instance.discover_schema()` and closes; `POST /{id}/discover-schema` on a falkordb row → 422 `provider_unsupported`; neo4j → passes through. |
| T9 | `tests/test_provider_type_literals.py` | Source-level drift guard (§6.3). |
| T10 | `tests/test_provider_capability.py` (update) | field-wise assertions + `supports()` for the three legacy bools + `capability_for("mock")` == default (no longer registrable). |
| T11 | `tests/test_lineage_aggregator.py` (update) | `get_aggregator` cases use a fake with `provider_type = "falkordb"` / a plain fake → `None`. |
| T12 | *(dropped — DataHub is untouched in this effort; the D1 regression test ships with the eventual DataHub fix, §9 item 9)* | — |
| T13 | `tests/test_preflight_http.py` | `_classify(ssl.SSLError())=="tls_handshake"`; `http_json_preflight` maps 204→ok, 401→`auth_required`/`auth_failed` by `had_credentials`, 503→`http_status_503`, refused→`tcp_refused` (use an `asyncio` TCP server fixture as `test_preflight*.py` files already do). |
| T14 | `tests/test_draft_overlay_provider.py` (extend if present, else new) | The four new forwarders reach `_base` (D4). |

### 6.2 Frontend (vitest, jsdom)

| # | File | Pins |
|---|---|---|
| F1 | `src/services/__tests__/providerTypes.test.ts` | `PROVIDER_VISUALS` has every `PROVIDER_TYPE_IDS` member; `providerVisual('nope')` → unknown visual with `label === 'nope'`; `mergeCatalog(undefined)` → `STATIC_PROVIDER_TYPES`; `mergeCatalog([{id:'arcadedb', …}])` renders with the unknown visual; `supportsFeature('falkordb','blank_models')` true / `'neo4j'` false; `defaultPortFor('spanner') === 0`; `formOwnedExtraKeys(falkordb)` == `{schemaMapping, falkordbConnection, cacheConnection}`; `STATIC_PROVIDER_TYPES` deep-equals `__fixtures__/providerTypes.backend.json` (generated once by a backend test that dumps `GET /types` — `tests/test_api_provider_types.py` writes it only when `UPDATE_PROVIDER_TYPES_FIXTURE=1`). |
| F2 | `src/components/admin/ProviderOnboardingWizard.test.tsx` (extend) | type step renders one card per `adminVisible` entry from a custom `providerTypes` prop (a fake 5th type `{ id: 'acme', connectionShape: generic + databaseField + auth basic, features: ['schema_discovery'] }`): selecting it sets port from the catalog, shows Host/Port/Database/Username/Password, adds the Schema Mapping step, and the test-connection payload carries `extraConfig.database` — this is PR 3's acceptance test in disguise. DataHub card → API token field → `credentials.token` in the payload (D5). |
| F3 | `src/components/admin/__tests__/ProviderOnboardingWizard.discover.test.tsx` | Schema discovery calls `providerService.discoverSchemaUnsaved` with the current type; never calls `create`/`delete` (D8). |
| F4 | `src/components/admin/__tests__/ProviderOnboardingWizard.extraConfig.test.tsx` (existing) | must stay green untouched — the FalkorDB round-trip contract. |
| F5 | `src/components/admin/RegistryConnections.test.tsx` (extend) | mocks `providerService.listTypes` → cards/labels come from the merged catalog; when `listTypes` rejects, the static snapshot renders (no blank list). |
| F6 | `src/services/__tests__/providerTypes.drift.test.ts` | Source-level drift guard (§6.3). |
| F7 | `src/components/views/ViewWizard/useBlankScopeOptions.test.tsx` (new or extend) | `blankSupported` follows `blank_models` from the catalog (a fake type with the feature is supported; neo4j is not). |
| F8 | `src/services/__tests__/providerTypes.catalog.test.ts` | **Pins the catalog itself — today NO frontend test asserts the type list or card count; a new type silently renders with the FalkorDB logo/tint.** `STATIC_PROVIDER_TYPES` deep-equals `__fixtures__/providerTypes.backend.json` (written by backend T6); every `PROVIDER_TYPE_IDS` member has a `PROVIDER_VISUALS` entry with a Logo component, non-empty `label`/`shortLabel`/`desc`, and a `connectionShape` with `kind` in `{generic, falkordb, spanner}` and `defaultPort` `number \| null`; every backend row id ∈ `PROVIDER_TYPE_IDS` (else the bundle is stale — PR 3 will hit this deliberately); `providerVisual(id).Logo !== FalkorDBLogo` for every non-falkordb id; `providerVisual('nope').label === 'nope'` and its Logo is the neutral icon. |
| F9 | `src/services/__tests__/providerService.friendlyError.test.ts` (extend; 9 tests today) | new reason codes pinned here: `tls_handshake`, `http_status_503` (prefix rule → "The server answered HTTP 503…"), `provider_config_invalid` (message passthrough), `provider_unsupported`. |
| F10 | `src/services/__tests__/providerTypes.guard.test.ts` | Runtime guard for the new client (there is no OpenAPI client, no zod; `request<T>` in `providerService.ts:289-303` casts `res.json()`): `parseProviderTypeList` accepts the fixture verbatim, drops a row missing `connectionShape` (one console warning), tolerates unknown `family`/feature strings, returns `[]` for non-arrays, never throws. |

**Positional-query constraints from the existing wizard tests** (they must keep passing without edits to their existing `it` blocks): `ProviderOnboardingWizard.test.tsx` uses `getByRole('combobox')` SINGULAR (L122), `getAllByRole('spinbutton')[0]` (L59, L154), `findAllByRole('textbox')[0]/[1]` (L54-56) and `getByRole('button', { name: /falkordb/i })` (L50, L114, L147); `__tests__/ProviderOnboardingWizard.editTest.test.tsx` encodes the FalkorDB flow Connection → Review in one Next; `__tests__/…extraConfig.test.tsx:172-176` pins `buildExtraConfig` returning `undefined` in create mode for falkordb; `features/ontology/components/EvalContextBar.test.tsx:72` asserts the literal `/falkordb, falkordb:6379/` and L93-101 that `providerType: 'unknown'` hides the segment. Therefore: (a) type-specific inputs (`database`, API token, any new `<select>`) render **only** when the selected shape declares them, so the FalkorDB connection step keeps exactly one combobox and the same textbox/spinbutton order; (b) the FalkorDB card's accessible name stays "FalkorDB" and no other card label matches `/falkordb/i`; (c) the catalog never maps any id to the string `'unknown'` (that is the resolver's sentinel in `useDataSourceProviderMap`, not a type) and `providerVisual` never returns the FalkorDB visual for an unknown id; (d) `buildExtraConfig(formData)` keeps its one-argument call shape (the catalog argument is optional, defaulting to the static snapshot); (e) F2 appends `it` blocks to the main wizard test — it does not modify existing ones.

### 6.3 Source-level drift guards

- **Backend** `tests/test_provider_type_literals.py`: walk `backend/app`, `backend/common`, `backend/insights_service` (`.py`, excluding `tests`, `scripts`, `alembic`); regexes `provider_type\s*(==|!=)\s*["']`, `\.lower\(\)\s*==\s*["'](falkordb|neo4j|spanner|datahub|mock)["']`, `isinstance\([^)]*\b(FalkorDBProvider|Neo4jProvider|SpannerProvider|DataHubGraphQLProvider)\b`, `["'](falkordb|neo4j|spanner|datahub)["']\s*:\s*ProviderCapability`. Allow-list = `{path: expected_count}` for the deliberately kept sites (§2.6 list: `falkor_graph_registry.py:1`, `insights_service/discovery.py:1`, `redis_config.py:1`, `system_status/probes.py` service keys) plus the catalog package itself. Any other hit, or a count change, fails with the offending line.
- **Frontend** `src/services/__tests__/providerTypes.drift.test.ts`: `fs`-walk `src/**/*.{ts,tsx}` excluding `*.test.*`, `providerTypes.ts`, `ProviderLogos.tsx`; regexes `providerType\s*[!=]==\s*['"](falkordb|neo4j|datahub|spanner|mock)['"]`, `\b(pt|type|provider_type)\s*===\s*['"](neo4j|falkordb|datahub|spanner)['"]`, `['"](falkordb|neo4j|datahub|spanner)['"]\s*:\s*\{\s*label`. Allow-list: none (the two Redis-role sites and `ServiceTile` don't match these patterns). PR 3 must not add hits either.

### 6.4 Provider conformance kit — what "run the kit" means in the recipe (§8)

Four parts. PR 2 lands (2) and (4) and the *specification* of (1) and (3); the code for (1) and (3) belongs to PR 3 because both need the Cypher base's `CypherExecutor` / `CypherDialect` types, which do not exist yet (verified: no `cypher`/`dialect`/`executor` module under `backend/graph/adapters` or `backend/app/providers`).

**(1) Base fake-executor unit suite** — `backend/tests/test_cypher_provider_base.py` (no live DB; runs in the required lane by name). A `FakeCypherExecutor` records every `(cypher, params)` and returns canned rows. For each `CypherGraphProvider` method (the 25 abstract members plus `get_top_level_or_orphan_nodes`, `trace_at_level`, `expand_aggregated`, `trace_closure`, `discover_schema`, `list_graphs`, `ensure_indices`, `get_nodes_batch`, `get_counts_fast`) and each registered dialect, the compiled statement is pinned as a golden file `backend/tests/snapshots/cypher/<dialect>/<method>[.<case>].cypher` (capture with `UPDATE_CYPHER_SNAPSHOTS=1`, same pattern as `regression/snapshot.py`), and the params are asserted to be lists where `dialect.supports_list_params` is True (inlined otherwise). A new Cypher provider = one new `<dialect>/` snapshot directory; a dialect change = a reviewable diff.

**(2) Live contract-snapshot harness** — generalise the existing `backend/tests/regression/_runner.py` (`seed()` L26-43, `run_all()` L46-131) + `snapshot.py` (`assert_snapshot(provider=, name=, actual=)`; `UPDATE_PROVIDER_SNAPSHOTS=1` captures to `snapshots/<label>/<name>.json`; a missing snapshot auto-captures, `snapshot.py:95`). Changes:
- `seed()` L33-40: the `hasattr` guards become plain calls (setters are contract members after §2.2).
- New `_runner.make_contract_test(type_id: str, *, env_prefix: str, cleanup: Callable[[GraphDataProvider], Awaitable[None]], snapshot_label: str | None = None)` returning a ready `pytest` coroutine test: it skips unless `<PREFIX>_HOST` is set **and** `host:port` accepts a TCP connection (the `_neo4j_reachable` shape, `test_neo4j_provider_contract.py:20-32`, lifted into the runner), builds the provider **through the catalog** (`create_provider_instance(ProviderSpec(type_id, host=<PREFIX>_HOST, port=<PREFIX>_PORT, graph_name=<PREFIX>_GRAPH or f"test_regression_{pid}", tls_enabled=<PREFIX>_TLS, credentials={username/password/token from <PREFIX>_USERNAME/_PASSWORD/_TOKEN}, extra_config=json(<PREFIX>_EXTRA_CONFIG_JSON)))` — the same construction path as production), runs `cleanup` → `seed` → `run_all` → `cleanup` → `close()`.
- `run_all()` gains steps for the contract members it does not yet exercise: `get_top_level_or_orphan_nodes`, `trace_closure` (`ProviderFeatureUnsupportedError` → pinned `"unsupported"`, mirroring the `trace_at_level` pattern L91-104), `get_nodes_batch`, `list_graphs` contains the test graph when the descriptor declares `MULTI_GRAPH`, `preflight().ok is True`, `get_counts_fast()` is `None` or agrees with `get_stats`. New names auto-capture on first live run — commit the new `snapshots/falkordb/*.json`; existing names stay byte-identical (the FalkorDB do-not-change gate).
- Migrate `test_falkordb_provider_contract.py`, `test_neo4j_provider_contract.py`, `test_spanner_provider_contract.py` onto the factory (labels unchanged; the per-provider `cleanup` keeps its 2-6 lines — FalkorDB `await p._graph.delete()`, Neo4j `DETACH DELETE` by `urn:test:` prefix — because deletion primitives differ, the one thing the runner cannot own).
- Result: a new provider's `backend/tests/regression/test_<type>_provider_contract.py` is ~40 lines: docstring with the env vars, a `cleanup` coroutine, `test_<type>_provider_contract = _runner.make_contract_test("<type>", env_prefix="<TYPE>_TEST", cleanup=cleanup)`.

**(3) Dialect conformance suite** — `backend/tests/regression/dialect_conformance.py` (module, PR 3) + one `test_<type>_dialect_conformance.py` per Cypher provider using the same env gate as (2). It runs each dialect point against the live instance seeded with the regression fixture and asserts **the dialect's declared flag equals observed reality in both directions** (declared True but fails → fail; declared False but works → fail with "dialect is over-conservative"):

| point | probe | dialect surface it checks |
|---|---|---|
| introspection statements | run `labels_statement()`, `relationship_types_statement()`, `property_keys_statement()` | results ⊇ `{domain, schema, dataset}` / `{CONTAINS, DERIVES_FROM}` / `{urn, displayName}` |
| index DDL | run `create_index_statement("dataset", "urn")` twice, then `list_indexes_statement()` | second run must not raise iff `supports_index_if_not_exists`; index listed |
| fulltext | `fulltext_create_statement` + `fulltext_query_statement("Dataset")` | returns `d1..d3` iff `supports_fulltext`; when False the builder raises `DialectUnsupported` and `search_nodes` still finds them via the CONTAINS fallback |
| id / labels functions | `RETURN {node_id_expr("n")}, {labels_expr("n")}` on the root node | id is `int \| str`, labels contain `domain` |
| list params | `MATCH (n) WHERE n.urn IN $urns RETURN count(n)` with a 2-element list | 2 iff `supports_list_params`; otherwise the `inline_list()` rewrite yields 2 |
| unknown-label MATCH | `MATCH (n:NoSuchLabel) RETURN count(n)` | returns 0 iff not `unknown_label_raises`; raises the dialect's declared error class otherwise |
| count | `count_statement("dataset")` and `get_counts_fast()` | 3; `get_counts_fast()` non-None iff `supports_constant_time_counts` (FalkorDB's `reduce_count`, memory `falkordb-reduce-count-o1-counts`) |

**(4) Drift guards** — §6.3 (backend + frontend literal guards) plus T3 (enum/CHECK/migration sync) and T4 (catalog classes).

Running the kit for a new provider, in order: `cd backend && python -m pytest tests/test_cypher_provider_base.py -q` (no DB) → `<TYPE>_TEST_HOST=… python -m pytest tests/regression/test_<type>_provider_contract.py tests/regression/test_<type>_dialect_conformance.py -v` (live) → `python -m pytest tests/test_provider_catalog_sync.py tests/test_provider_catalog_classes.py tests/test_provider_type_literals.py -q` → `cd frontend && npx vitest run src/services/__tests__/providerTypes`.

---

## 7. Task list (subagent-sized; each task = tests red → green → verify)

Sequencing: T-A…T-D backend contract (independent of catalog), T-E…T-I catalog + API, T-J…T-N frontend, T-O docs. T-A/T-B/T-E can run in parallel; T-C depends on T-A; T-F depends on T-E; T-G depends on T-E + T-A; T-J…T-N depend on T-G's response shape only (they can start from the fixture JSON).

| # | Task | Files | Verify |
|---|---|---|---|
| **T-A** | Contract errors + setter/method defaults on FalkorDB's attribute names + helpers (§2.1, 2.2, 2.3 minus `capability_for`, 2.4) | `backend/common/interfaces/provider.py`; `falkordb_provider.py:182-185` (or PR 1's cursor module) → import/re-export; `graph.py:26-27` import merge; add `provider_type` ClassVar to `FalkorDBProvider` (L2316 area), `Neo4jProvider` (L172), `SpannerProvider` (L169) — not DataHub (untouched) | `pytest tests/test_provider_contract_defaults.py tests/test_keyset_cursor_direction.py tests/test_context_engine.py tests/test_context_engine_ontology_injection.py tests/test_context_engine_source_alignment.py -q` |
| **T-B** | D2 Neo4j kwarg; D4 draft-overlay forwarders (DataHub untouched) | `neo4j_provider.py:428`, `backend/app/providers/draft_overlay_provider.py:118-144` | `pytest tests/test_provider_setter_signatures.py tests/test_draft_overlay_provider.py -q` |
| **T-C** | Call sites → `call_optional`/`await_optional`; D3/D6 leak fixes; feature gates (`versioning.py:1282`, `context_engine.py:856`) | `context_engine.py:355-411, 529-533, 608-609, 654-655, 856-864`; `aggregation/worker.py:306-389`; `lineage_aggregator.py`; `versioning.py:1282-1286`; `scripts/load_test_dataset.py:177`, `scripts/backfill_aggregated_levels.py:217` | `pytest tests/ -q -m "not integration" -k "context_engine or aggregation or versioning or lineage_aggregator or worker"` |
| **T-D** | Preflight additions (`tls_handshake`, `http_json_preflight`) | `backend/common/interfaces/preflight.py:45-60, 335+` | `pytest tests/test_preflight_http.py -q -k preflight` |
| **T-E** | Catalog package: descriptor dataclasses, registry, four descriptors (bodies moved verbatim), `capability_for` → catalog, delete `PROVIDER_CAPABILITIES` | `backend/common/providers/catalog/{__init__,descriptor,falkordb,neo4j,datahub,spanner}.py`; `interfaces/provider.py` (`capability_for`) | `pytest tests/test_provider_catalog_sync.py tests/test_provider_catalog_classes.py tests/test_provider_capability.py -q` |
| **T-F** | Both dispatchers delegate (§3.5) + retarget the `getsource` pin at `test_falkordb_host_resolution.py:113-116` to the descriptor's `_build` (§3.5) | `manager.py:1153-1273`, `provider_registry.py:290-395`, `tests/test_falkordb_host_resolution.py:113-116` | `pytest tests/test_provider_dispatch_equivalence.py tests/test_provider_registry.py tests/test_falkordb_auth_gating.py tests/test_provider_cluster_config.py tests/test_falkordb_empty_graph.py tests/test_falkordb_host_resolution.py tests/test_merge_extra_config.py tests/test_phase0_spanner_create_flow.py tests/test_worker_warmup_and_falkor_probe.py -q` |
| **T-G** | Admin API: `/types`, descriptor validation/probe in `_run_connectivity_probe` + `/test-connection` + `create`, `/discover-schema` (unsaved) + capability gate on `/{id}/discover-schema`; response models | `providers.py`; `common/models/management.py` (models after L557) | `pytest tests/test_api_provider_types.py tests/test_api_providers.py tests/test_api_provider_discover_schema.py tests/test_workspace_scoped_reads.py -q` |
| **T-H** | Backend drift guard | `tests/test_provider_type_literals.py` | `pytest tests/test_provider_type_literals.py -q` (must be green with the allow-list exactly matching §2.6) |
| **T-I** | Full backend gate | — | `cd backend && python -m pytest tests/ -q -m "not integration" -k "falkordb or preflight or warmup or circuit or redis or bus or provider or probes or manager or aggregation or insights"` then the informational full suite; compare failure list to `main` (pre-existing failures per memory `dataviz-backend-test-harness`) |
| **T-J** | `providerTypes.ts` + fixture + `providerService.listTypes/discoverSchemaUnsaved` + `friendlyError` entries + `getProviderLogo` move | `src/services/providerTypes.ts`, `src/services/__fixtures__/providerTypes.backend.json`, `src/services/providerService.ts:17, 168-185, 313+`, `src/components/admin/ProviderLogos.tsx:122-133`, `src/hooks/useProviderTypes.ts` | `npx vitest run src/services` |
| **T-K** | Wizard refactor (§5.3) | `ProviderOnboardingWizard.tsx` | `npx vitest run src/components/admin` (F2/F3 new, F4 untouched-green) |
| **T-L** | Sites 3-4, 6-8, 10-17 (§5.4) | 13 files | `npx vitest run src/components/admin src/components/views src/pages src/components/insights src/components/ingestion` |
| **T-M** | `useBlankScopeOptions` feature gate (site 9) + F7 | `useBlankScopeOptions.ts:7-9, 26, 48-52, 97` | `npx vitest run src/components/views/ViewWizard` |
| **T-N** | Frontend drift guard + full gate | `src/services/__tests__/providerTypes.drift.test.ts` | `npx vitest run` (216+ files green); `npx tsc --noEmit 2>&1 \| grep -c "error TS"` ≤ baseline |
| **T-P** | Conformance kit parts (2) + (4) (§6.4): `make_contract_test` / env-gated catalog-built provider / plain setter calls / new `run_all` steps in `tests/regression/_runner.py`; migrate the three existing contract files onto the factory; add the `dialect_conformance.py` spec as a module docstring stub so PR 3 fills in code, not design | `backend/tests/regression/_runner.py`, `test_{falkordb,neo4j,spanner}_provider_contract.py`, `dialect_conformance.py` (docstring only) | `FALKORDB_TEST_HOST=localhost FALKORDB_TEST_PORT=6379 python -m pytest tests/regression/test_falkordb_provider_contract.py -v` (live; existing `snapshots/falkordb/*.json` byte-identical, new names auto-captured and committed); with the env unset the file reports `skipped`, never `failed` |
| **T-O** | Docs + ADR (§8) | see §8 | `grep -rn "PROVIDER_CAPABILITIES\|mock_provider.py" docs DEVELOPER_GUIDE.md` → none |

### 7.1 Commit discipline (from memory `parallel-lane-amend-swallows-sibling-commit` / `concurrent-session-git-add-sweep`)
Commit by explicit pathspec per task; no `--amend`/`stash`/`reset` in lanes; `git log -1 --format=%s` after each commit.

### 7.2 PR 1 interplay
If PR 1 has landed: T-A's FalkorDB edit goes into the package module that defines `CursorMismatchError`, and the package `__init__` re-exports it; `provider_class_path` stays `backend.app.providers.falkordb_provider:FalkorDBProvider`. If PR 1 has not landed: edit monolith L182-185; PR 1 must then keep the re-export (add to PR 1's checklist).

### 7.3 "Do NOT change behaviour" checklist — FalkorDB path

- [ ] `falkordb_provider.py` diff is exactly: (1) `provider_type = "falkordb"` ClassVar, (2) `CursorMismatchError` defined-in-place → imported-and-re-exported. Nothing else.
- [ ] T5 golden kwargs for falkordb equal today's `manager.py:1190-1209` byte-for-byte (host via `resolve_falkordb_target`, `port or 6379`, `graph_name or "nexus_lineage"`, `username/password` from creds, `connection_config=_falkor_conn`, `cache_redis_url=creds.get("cache_redis_url")`, `auth_enabled=(_falkor_conn or {}).get("authEnabled", True)`, `tls_enabled`, `provider_id`, `extra_config`, `credentials=creds`).
- [ ] `LOCAL_DEV_FALKORDB_OVERRIDE` still honoured on both entry points (`test_falkordb_host_resolution.py`).
- [ ] `/test-connection` for `mode in (sentinel, cluster)` still runs `_ensure_connected()` with an 8 s budget; `probeDeadlineS` still extends and never clips (`test_api_providers.py:362-409`).
- [ ] `manager.py:480-519` preflight gate untouched — FalkorDB's real `preflight` still gates; nothing new is gated (no base default `preflight`).
- [ ] `inflight_ops` real implementation untouched (L1079-1082); manager eviction unchanged (L935-950).
- [ ] FalkorDB setter overrides (upper-casing, digest re-probe in `set_entity_type_levels` L2344-2370, "ALWAYS RESET" identity/alias semantics) untouched; the base-class defaults are never reached for FalkorDB.
- [ ] `trace_closure_coarse` still discovered by `getattr` (`context_engine.py:1391`).
- [ ] `_assert_copyable` still answers 422 for non-copyable types with the same body (`graph.py:278-284`).
- [ ] Wizard: `__tests__/ProviderOnboardingWizard.extraConfig.test.tsx` green without edits; `falkordbConnection` / `cacheConnection` emission code unchanged (only the selecting boolean changed).
- [ ] `GET /admin/providers/status` still zero-I/O (`test_api_providers.py:179-227`).
- [ ] No new import of a driver module at import time of `backend.common.providers.catalog` (assert in T4: `sys.modules` has no `redis`/`neo4j`/`google.cloud` entry after importing the catalog in a fresh subprocess).

---

## 8. Docs to update (T-O)

| Doc | Edit |
|---|---|
| `DEVELOPER_GUIDE.md` (after "Adding a new database table", L584-592) | New recipe **"Adding a graph data provider"**, Cypher-first. **New Cypher / OpenCypher provider (Memgraph, Kùzu, Apache AGE, …)** = (1) a `CypherExecutor` implementation — how statements reach the engine (Bolt, HTTP, embedded); (2) a `CypherDialect` — the engine's spelling of introspection statements, index DDL, fulltext, id/labels functions, list params, unknown-label MATCH and count, each with its declared flag; (3) a `ProviderDescriptor` in `backend/common/providers/catalog/<type>.py` (+ the import line, a `ProviderType` member, a CHECK-widening migration copied from `20260508_spanner_provider.py`, and a `PROVIDER_TYPE_IDS` / `PROVIDER_VISUALS` entry in `frontend/src/services/providerTypes.ts`); method overrides on the Cypher base (`backend/graph/adapters/cypher/`, PR 3) **only** where the dialect differs or the engine has a native fast path (FalkorDB's O(1) counts is the canonical example). Then **run the provider conformance kit** (§6.4): the base's fake-executor suite → the live contract snapshot (`test_<type>_provider_contract.py`, ~40 lines, env-gated) → the dialect conformance suite → the drift guards. Non-Cypher stores implement `GraphDataProvider` directly (Spanner is the reference), with the same descriptor / enum / migration / frontend steps and the same kit minus the two Cypher-specific suites. Close with: "no other file should need editing — if one does, the catalog is missing a field; add it there." |
| `docs/BACKEND.md:394-500` §3 | Replace the classDiagram's hand-listed methods with the contract's three tiers (abstract / real defaults / feature-gated defaults + `ProviderFeature`), replace the capability table with the §2.3 matrix, add "Provider catalog" (descriptor fields, both dispatchers delegate, `GET /admin/providers/types`), fix L474 (`mock_provider.py` does not exist; `mock` is a legacy DB literal) and L464 ("~1000 lines"). |
| `docs/guide/ADMIN_SETUP.md:32-33`, `docs/guide/GLOSSARY.md:15`, `docs/guide/KEY_CONCEPTS.md:25` | Replace the hard-coded "(FalkorDB, Neo4j, DataHub, or Spanner)" with "any provider type offered under Admin → Add Provider (FalkorDB, Neo4j, DataHub, Google Spanner Graph today)" so PR 3 needs no user-doc edit. |
| `PLAN.md:14-21` | Add: "Provider types are registered once in a catalog (`backend/common/providers/catalog/`) that drives dispatch, validation, the admin API and the onboarding wizard." |
| `docs/DECISIONS.md` | **ADR-023: One registration per graph provider type** in the ADR-022 format (L616-656): Status Accepted, Date 2026-08, Context (22 scattered edit sites, two verbatim dispatchers, undeclared duck-typed contract, DataHub uninstantiable for months without a test noticing), Decision (descriptor catalog; contract defaults; `ProviderFeature` admission gates at the row level, exception tolerance at the instance level; frontend catalog + backend `/types`), Reasoning, Trade-offs (+ one place to add a type, + drift tests; − descriptors duplicate a little static data on the FE (`STATIC_PROVIDER_TYPES`) pinned by a fixture test; − `mock` legacy literal remains in the CHECK). Add a row to the Decision Summary table (L658+). |
| `docs/MIGRATIONS.md` | No change (PR 3's migration follows the existing rules). |

---

## 9. Assumptions and open questions for the lead

1. **Migration placement** — recommended PR 3 (§3.6). If the lead wants it in PR 2, add `RESERVED_DB_TYPES = {"arcadedb"}` to the sync test until PR 3 registers the type.
2. **`mock`** stays a legacy DB literal, unregistrable (D7). Removing it needs a narrowing migration that refuses when rows exist — out of scope.
3. **`GET /types` gate** = `workspace:provider:read` (non-secret metadata). If the lead prefers `system:admin`, the view-wizard scope step keeps using the static FE snapshot (it needs only labels), so nothing else changes.
4. **Behaviour fixes bundled into PR 2**: D1 (DataHub instantiable), D2 (Neo4j setter kwarg), D3 (`clear_content_caches` default), D4 (draft-overlay forwarders), D5 (DataHub token). Each is a latent crash today; none touches FalkorDB. Confirm they belong here rather than in a separate fix PR.
5. **`preflight` not defaulted** (§2.4) — the manager's "never gate a provider without a preflight" rule (`manager.py:414`) is the reason. If the lead wants it in the ABC anyway, the manager gate must additionally skip reason `preflight_not_implemented`.
6. **Wizard gets the catalog via a prop** (§5.2) to keep the three existing wizard test files untouched; `RegistryConnections` owns the hook call.
7. **D9 (`search_nodes` offset)** is optional hygiene; include only if it costs nothing in T-A.
8. The unsaved `POST /admin/providers/discover-schema` is new API surface (`system:admin`); it replaces a flow that wrote and deleted provider rows on every discovery click (D8).
9. **DataHub (D1) is deferred, not fixed** — per the instruction that DataHub stays untouched. Consequence: the DataHub card still exists in the wizard and `/test-connection` for it keeps returning `success:false, error:"Can't instantiate abstract class…"` as today; T4 allow-lists it. If the lead would rather hide the card until fixed, set `admin_visible=False` on the datahub descriptor (one line, no adapter edit) — recommended only if the user is not actively registering DataHub providers.
10. `family` is carried as a plain string (`cypher | gql | graphql | native`) through descriptor → `/types` → the FE type; no grouping or branching is implemented on it in PR 2.
11. **Master-plan reconciliation needed (two spots):** (a) master §2.1's last bullet and §2.5 still bundle the DataHub 6-stub fix and a "DataHub update" test, which the later "DataHub stays untouched" instruction supersedes — this plan follows the instruction (D1 deferred, T4 allow-list); (b) the master's Architecture sketch says `backend/common/providers/catalog.py` (module) while its §2.2 says the `catalog/` package — this plan follows §2.2 (package), with the ArcadeDB-descriptor-in-adapter variant shown in §3.1.
12. The `OntologyInjectionState` dataclass from the first draft is withdrawn per master §2.1 ("same attribute names FalkorDB uses, no separate state dataclass"); §2.2 now specifies the attribute-based defaults.

---

## 2.7 Ontology as a first-class contract obligation (added after PR 1's live verification)

PR 1's live like-for-like verification against the dev FalkorDB surfaced a defect that reframes
what §2.2 is for. It is recorded here because it changes the design, not merely the task list.

### The defect

`get_ontology_metadata` (`falkordb/stats.py`) does two different jobs in one method:

1. **Introspection** — which entity and edge types exist in the graph. A *fact about the graph*:
   deterministic, and safely cacheable under a graph-scoped key.
2. **Classification** — which of those types are containment vs lineage, the entity-type
   hierarchy, the root types. *Not* a fact about the graph: it is a function of the ontology
   **injected into this provider instance**, and the method explicitly tolerates the
   not-yet-injected case by treating containment as empty.

It then caches the combined result under `{graph}:stats_cache`-style key
`{ns}:ontology_cache` for `_SCHEMA_CACHE_TTL` (default 300s).

`ContextEngine._resolve_ontology` calls this method on a **fresh, uninjected** provider
(`context_engine.py:494`) *before* `_inject_resolved` runs the setters — by design, and
`stats.py` documents the ordering. So the app's own resolution path is what warms the shared
cache from an unconfigured instance.

**Measured on `solidatus_perf_medium`, and identically on the pre-refactor monolith (so this is
pre-existing, not a PR 1 regression):**

| cache warmed by | containment | lineage | hierarchy | roots |
|---|---|---|---|---|
| uninjected caller | `[]` | `['FLOWS_TO','HAS']` | 0 entries | `[]` |
| injected caller | `['HAS']` | `['FLOWS_TO']` | 4 | `['layer']` |

A correctly-injected reader arriving afterwards gets the **poisoned** value back — the cache
hit short-circuits before classification. Downstream that is a flat graph: no containment
structure, no root types, and `HAS` presented as a *flow* edge rather than *structural*, to
`graph.py:2432` and `:2513`. Same family as the earlier "wizard flat while canvas nests"
defect.

### The immediate fix (verified, patch held from PR 1 deliberately)

Capture whether containment was configured, and gate the shared-cache write on it. The
provisional answer is still returned to the caller that asked for it — introspection genuinely
wants the raw observed vocabulary — it is only withheld from the shared key, so the next
configured caller recomputes and caches the real classification.

Verified: `cache_carries_first_callers_state` flips true → **false**; an injected reader after
an uninjected warm now gets `containment=['HAS']`, hierarchy 4, roots `['layer']`. Targeted set
111 passed, required lane zero new failures. The patch is
`ontology-cache-fix.patch` in this plan's SDD workspace; it was deliberately **not** committed
to PR 1, whose whole value is a provable zero-behaviour-change guarantee.

### What this means for the contract — the part that outlives the bug

The bug is a symptom of ontology being **implicit**. Today a provider participates in ontology
by duck-typing: `context_engine.py:355` asks `hasattr(self.provider, 'set_containment_edge_types')`
and silently skips the provider if the attribute is missing. A second engine that simply does
not implement it gets no error — it gets a flat graph, and nobody finds out until a user says
the canvas looks wrong.

So §2.2's setters are not a compatibility shim; they are **the ontology lifecycle**, and PR 2
must make three things explicit in `GraphDataProvider`:

1. **Injection is a declared obligation.** The setters are base-class members with working
   defaults (§2.2), so every registered adapter — FalkorDB, ArcadeDB, Neo4j, Spanner, DataHub —
   participates by construction rather than by luck. The catalog contract test asserts each
   registered class either inherits or overrides all six.
2. **Configured-ness is observable.** A provider must be able to answer *"has an ontology been
   injected into me?"* — the `_resolved_containment_types_set` flag becomes a documented part of
   the contract rather than a private attribute nine call sites reach into. Anything deriving a
   cacheable answer from injected state consults it, which is exactly what the fix above does.
3. **Introspection and classification are separated.** Provider capability is *"tell me what
   types exist in this graph"*. Turning that vocabulary into containment/lineage/hierarchy is
   ontology-domain logic and is provider-independent — it belongs above the provider, or at
   minimum must never be cached under a key that does not encode the ontology it was computed
   against. PR 3's ArcadeDB provider should implement only the introspection half.

Point 3 is the structural change; points 1 and 2 are what stop the next engine reintroducing the
same class of defect. Together they are why ontology belongs in the contract work rather than in
a follow-up: an ArcadeDB provider written against a contract that leaves ontology implicit will
be flat, and it will look like an ArcadeDB bug.

---

## 10. Pre-flight corrections (read before executing §7 — these supersede)

A conflict scan against the live tree at `ccbb1855` found six things wrong with this plan. They
are corrected here rather than edited in place, so the record shows what was found. **Where §10
disagrees with anything above, §10 governs.**

### 10.1 Sequencing: T-E must follow T-A (§7's parallelism claim is wrong)

§7 says "T-A/T-B/T-E can run in parallel". T-E's descriptors construct
`ProviderCapability(features={ProviderFeature...})` and rewrite `capability_for` — both symbols
T-A introduces, in the same file. **T-E depends on T-A.** T-B remains genuinely parallel.

**T-P is missing from §7's dependency sentence entirely.** It builds providers through the
catalog and drops `hasattr` guards, so it depends on **T-E and T-A**. Corrected order:

```
T-A ──┬── T-C
      ├── T-E ──┬── T-F
      │         ├── T-G ── T-J..T-N
      │         └── T-P
      └── (T-B, T-D independent)
```

### 10.2 T-J cannot start from a fixture that does not exist yet

§7 says T-J "can start from the fixture JSON", and T-J's file list claims authorship of
`providerTypes.backend.json`. But §6's F1/F8 generate that fixture from **T-G's** backend test
(`UPDATE_PROVIDER_TYPES_FIXTURE=1`). Ownership is double-assigned and the dependency is real.
**Ruling: T-G owns the fixture and generates it; T-J consumes it.** T-J starts after T-G.

### 10.3 Stale `falkordb_provider.py` citations — that file is now a 163-line shim

PR 1 split the monolith; every logic citation below points into a file that no longer contains
it. **Use this table, not the line numbers above.** Re-grep before editing — a search string is
a fact, a line number is a snapshot.

| This plan says | It actually lives at |
|---|---|
| `CursorMismatchError` at `falkordb_provider.py:182-185` (§1.1, §2.1) | defined `backend/common/providers/cursors.py:39`; re-exported via `falkordb/cursors.py` → `falkordb/__init__.py` → shim. §2.1 wants it in `backend.common.interfaces.provider` — reconcile with the **kernel** module, not the monolith, and keep the same object identity |
| the six setters, `falkordb_provider.py:2319-2622` (§2.2) | `backend/app/providers/falkordb/ontology.py`: `set_containment_edge_types`:39, `set_entity_type_levels`:64, `set_admission_controller`:276, `set_resolved_edge_metadata`:282, `set_source_type_aliases`:296, `set_node_identity`:316 |
| "verbatim L2614-2622" (node-identity lazy import) | `ontology.py:316-343` |
| `provider_type` ClassVar "next to `name`, L2316" (§2.2/§3.4/T-A) | `name` is `ontology.py:36`; the composed class is `falkordb/provider.py:25` |
| `clear_content_caches` override "L5610" (§2.4) | `falkordb/aggregation.py:1071` |
| level-digest re-probe "L2344-2370" (§7.3) | inside `ontology.py:64-93` |
| `inflight_ops` "L1079-1082" (§7.3) | `falkordb/connection.py:312` |
| `get_nodes_batch` "FalkorDB L10038" (§1.2) | `falkordb/drill.py:696` |

### 10.4 §6.4's justification is factually wrong (the conclusion survives)

§6.4 defers conformance-kit parts (1) and (3) on the grounds that the `CypherExecutor` /
`CypherDialect` types "do not exist yet (verified: no cypher/dialect/executor module under
`backend/graph/adapters` or `backend/app/providers`)". **They exist**, at
`backend/common/providers/cypher/{executor,dialect}.py` — PR 1 created them; the grep checked
two directories and the answer was in a third.

The practical conclusion still holds — PR 2 cannot write `CypherGraphProvider`-based tests
because that **base class** does not exist until PR 3 — but the stated evidence was wrong.
Restate the reason as the base class, not the seam types. This plan's own §2.7 demands claims be
verified rather than inferred; that applies to the plan itself.

### 10.5 NEW TASK T-Q — land the ontology cache fix

§2.7 documents a verified fix held as `ontology-cache-fix.patch` in this plan's SDD workspace,
and says PR 2 lands it. **No task in §7 does.** `grep` finds zero references to `stats.py`,
`ontology_cache` or the patch outside §2.7 — and because §2.7 was appended after §8 and §9, a
task author reading in order meets the task list long before meeting it.

**T-Q** | Apply the held patch: capture `containment_configured` at the
`ProviderConfigurationError` fallback in `get_ontology_metadata` and gate the shared-cache write
on it, so a provisional classification is returned to its caller but never written to the shared
key | `backend/app/providers/falkordb/stats.py` (the fallback ~:366 and the cache write ~:505 —
re-grep, do not trust these) | targeted set + required lane; and re-run the reproduction in
`ontology-cache-fix.patch`'s companion probe: an injected reader after an uninjected cache warm
must see `containment=['HAS']`, hierarchy 4, roots `['layer']`, and
`cache_carries_first_callers_state` must be **false** |

T-Q depends on nothing and can run first. It is the only task in this PR that changes runtime
behaviour deliberately — keep it in its own commit so it can be reverted or cherry-picked
independently of the contract work.

### 10.6 D9 has no test either way

§9's D9 (`search_nodes` gains `offset`) is "include only if it costs nothing", and §6 gates
neither choice. **Ruling: drop D9 from this PR.** An optional change nothing verifies is a
change nobody can review; if the offset is wanted, it deserves its own task with a test.

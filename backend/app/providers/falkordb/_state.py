"""``_FalkorState`` — the instance-state contract the package's fifteen
mixins assume about ``self``.

``FalkorDBProvider`` is a bases tuple over fifteen mixins (``provider.py``).
Nothing about ordinary Python enforces that a method living in one mixin
only reads attributes some *other* mixin actually sets — every mixin sees
the same fully-composed ``self``, so a typo'd or orphaned attribute name is
invisible until something calls the method at runtime. This module is the
documentation of what the composed instance is assumed to carry, and the
claim ``tests/test_falkordb_package_guards.py`` checks every ``self._x``
read in the package against, statically.

Never a base class
-------------------
``FalkorDBProvider`` does NOT inherit from ``_FalkorState`` and must not
start doing so. A ``Protocol`` is a structural-typing aid for type
checkers and human readers; giving the provider a real (even empty)
dependency on it would add nothing but MRO surface, and would invite
someone to "complete" it into an enforced base class — which it cannot be
without breaking the three tests that build a provider via ``__new__``
and hand-set only the one or two attributes their test actually needs
(``tests/test_ensure_indices_onboarding.py:110`` via ``object.__new__``,
``tests/test_falkordb_ancestors_cache_reset.py:16`` and
``tests/test_falkordb_pool_resilience.py:218`` via
``FalkorDBProvider.__new__``). Those tests are *why* section 2 below
exists at all: an instance built that way has none of section 1's 44
attributes and none of section 2's 19, so any mixin method such a test
exercises must either not touch them or reach them through a tolerant
``getattr`` / a raising accessor whose contract the caller already
expects to satisfy first.

Source of truth
----------------
Every list below is generated, not hand-maintained prose, and the durable
way to regenerate it lives in this repository: run
``pytest tests/test_falkordb_package_guards.py``. Its
``test_guard2_init_assigned_matches_state_py``,
``test_guard2_late_assigned_matches_state_py`` and
``test_guard2_class_constants_matches_state_py`` each build a fresh
measurement of the package — an AST walk of every ``self.X`` store and
load in the package's mixin classes — and cross-check it against
``INIT_ASSIGNED`` / ``LATE_ASSIGNED`` / ``CLASS_CONSTANTS`` below. A
failure names exactly which attribute or constant drifted, and in which
direction, so treat those three tests as the regeneration instruction: if
you change which attributes a mixin reads or sets, update this file in
the same commit that makes them pass again.

What's below
------------
1. The ``_FalkorState`` Protocol itself — one annotated attribute per
   name in both groups, for humans and type checkers.
2. ``INIT_ASSIGNED`` — the 44 names as a plain ``frozenset``, mirroring
   group 1.
3. ``LATE_ASSIGNED`` — the 19 names as a ``dict`` to a one-line
   description of the default its readers pass (or, where every read is
   bare, the invariant that makes the bare read safe), mirroring group 2.
4. ``CLASS_CONSTANTS`` — the 8 class-level constants that are read from a
   mixin other than the one that owns them (so they only resolve because
   Python looks attributes up through the *whole* MRO of the composed
   class, not through whichever mixin happens to define the reading
   method). This is deliberately not the full inventory of class-level
   constants in the package — plenty more exist (``_MERGE_SUB_BATCH_MIN``
   and its siblings on ``AggregationMixin``, for instance) but are only
   ever read from the same mixin that defines them, which makes them
   ordinary class attributes rather than an inter-mixin assumption this
   file exists to document. The full inventory isn't tracked separately —
   grep each mixin module for its class-level assignments (the lines
   directly under ``class FooMixin:`` that aren't ``def``s) to see it.
"""
from __future__ import annotations

from typing import Any, Dict, FrozenSet, List, Optional, Protocol, Set


class _FalkorState(Protocol):
    """Documents the attributes a composed ``FalkorDBProvider`` instance is
    assumed to carry. See the module docstring: never a base class, never
    inherited — this is read, not run.
    """

    # -- 1. assigned in ConnectionMixin.__init__ (44) --------------------
    # Present on every instance built the normal way (``FalkorDBProvider(...)``)
    # from the moment ``__init__`` returns. See ``INIT_ASSIGNED`` below for
    # the plain-data mirror of this list.
    _admission_controller: Optional[Any]
    _aggregation_sub_batch_size: int
    _aggregation_sub_batch_under_target_run: int
    _auth_enabled: bool
    _bulk_create_batch_size: int
    _bulk_create_timeout_s: float
    _cache_redis_url: Optional[str]
    _conn_cfg: Optional[Any]  # FalkorDBConnConfig, resolved by _ensure_connected
    _conn_generation: int
    _connect_cooldown_s: float
    _connect_cooldown_until: float
    _connection_config: Optional[dict]
    _credentials: dict
    _db: Optional[Any]
    _extra_config: Optional[dict]
    _failover_lock: Any  # asyncio.Lock
    _graph: Optional[Any]
    _graph_name: str
    _host: str
    _inflight: int
    _level_digest: Optional[str]
    _levels_backfilled: Optional[bool]
    _levels_warning_for_digest: Optional[str]
    _password: Optional[str]
    _pool: Optional[Any]
    _port: int
    _proj_db: Optional[Any]
    _proj_graph: Optional[Any]
    _proj_pool: Optional[Any]
    _projection_mode: str
    _provider_id: Optional[str]
    _query_semaphore: Any  # asyncio.Semaphore
    _quiesce_cooldown_s: float
    _quiesce_target_s: float
    _quiesce_trigger_s: float
    _quiesce_until_monotonic: float
    _redis_available: bool
    _redis_pool: Optional[Any]
    _seed_file: Optional[str]
    _tls_enabled: bool
    _username: Optional[str]
    _write_concurrency_cap: int
    _write_latency_window: Any  # collections.deque[float], maxlen=50
    _write_semaphore: Any  # asyncio.Semaphore

    # -- 2. assigned ONLY outside __init__ (19) --------------------------
    # ABSENT on a __new__-built instance. See ``LATE_ASSIGNED`` below for
    # each one's default / bare-read invariant — this Protocol only
    # states the type once the assigning method has run.
    _agg_meta_cached: Optional[tuple]
    _casing_maps_cache: Optional[tuple]
    _entity_type_levels: Optional[Dict[str, int]]
    _indexed_entity_type_ids: Optional[List[str]]
    _name_property: Optional[str]
    _node_identity_property: Optional[str]
    _observed_rel_types: Optional[Set[str]]
    _reconcile_started: bool
    _reconcile_task: Optional[Any]  # asyncio.Task
    _redis: Any  # redis-py-compatible client; see LATE_ASSIGNED -- no default
    _regime_probe_cached: Optional[tuple]
    _resolved_containment_types: Optional[Set[str]]
    _resolved_containment_types_set: bool
    _resolved_edge_metadata: Optional[Dict[str, Any]]
    _resolved_edge_metadata_set: bool
    _resolved_lineage_types: Optional[Set[str]]
    _save_indices_ensured: bool
    _source_entity_aliases: Optional[Dict[str, List[str]]]
    _source_rel_aliases: Optional[Dict[str, List[str]]]


# ---------------------------------------------------------------------------
# Plain-data mirrors, consumed by tests/test_falkordb_package_guards.py.
#
# The Protocol above is for humans and type checkers; a Protocol's
# ``__annotations__`` are keyed by name but carry no room for "here is the
# default its readers pass" or "here is which group this name belongs to"
# without re-parsing the class body, so the guard test reads these instead.
# Both are hand-kept in sync with the measured package (see the module
# docstring); the guard cross-checks them against a fresh AST pass and
# fails loudly — naming the exact names added or removed — on drift.
# ---------------------------------------------------------------------------

INIT_ASSIGNED: FrozenSet[str] = frozenset({
    "_admission_controller",
    "_aggregation_sub_batch_size",
    "_aggregation_sub_batch_under_target_run",
    "_auth_enabled",
    "_bulk_create_batch_size",
    "_bulk_create_timeout_s",
    "_cache_redis_url",
    "_conn_cfg",
    "_conn_generation",
    "_connect_cooldown_s",
    "_connect_cooldown_until",
    "_connection_config",
    "_credentials",
    "_db",
    "_extra_config",
    "_failover_lock",
    "_graph",
    "_graph_name",
    "_host",
    "_inflight",
    "_level_digest",
    "_levels_backfilled",
    "_levels_warning_for_digest",
    "_password",
    "_pool",
    "_port",
    "_proj_db",
    "_proj_graph",
    "_proj_pool",
    "_projection_mode",
    "_provider_id",
    "_query_semaphore",
    "_quiesce_cooldown_s",
    "_quiesce_target_s",
    "_quiesce_trigger_s",
    "_quiesce_until_monotonic",
    "_redis_available",
    "_redis_pool",
    "_seed_file",
    "_tls_enabled",
    "_username",
    "_write_concurrency_cap",
    "_write_latency_window",
    "_write_semaphore",
})

LATE_ASSIGNED: Dict[str, str] = {
    "_agg_meta_cached": (
        "getattr default None (caches.py:100); assigned in "
        "caches.CacheMixin._aggregation_run_meta and reset to None in "
        "aggregation.AggregationMixin.clear_content_caches / "
        ".purge_aggregated_edges. Value is a (meta, timestamp) tuple or None."
    ),
    "_casing_maps_cache": (
        "getattr default None (writes.py:57); assigned in "
        "writes.WriteMixin._type_casing_maps. Value is a "
        "(timestamp, rels, labels) tuple or None."
    ),
    "_entity_type_levels": (
        "getattr default None (8 sites) or {} (5 sites) across "
        "aggregation/drill/ontology/schema/trace; assigned once in "
        "ontology.OntologyMixin.set_entity_type_levels. One bare read at "
        "ontology.py:81, immediately after its own assignment two lines "
        "above in the same method -- reads what it just set, not a "
        "caller-order invariant like _redis below."
    ),
    "_indexed_entity_type_ids": (
        "getattr default None (navigation.py:144); assigned in "
        "schema.SchemaMixin.ensure_indices. Value is a list[str] once set."
    ),
    "_name_property": (
        "getattr default None (ontology.py:479, schema.py:89); assigned "
        "in ontology.OntologyMixin.set_node_identity."
    ),
    "_node_identity_property": (
        "getattr default None (ontology.py:478, schema.py:88,200); "
        "assigned in ontology.OntologyMixin.set_node_identity."
    ),
    "_observed_rel_types": (
        "getattr default None (ontology.py:411); assigned in "
        "stats.StatsMixin.get_ontology_metadata. Value is a set[str] once set."
    ),
    "_reconcile_started": (
        "getattr default False (connection.py:781); assigned in "
        "connection.ConnectionMixin._schedule_reconcile_once and .close."
    ),
    "_reconcile_task": (
        "getattr default None (connection.py:1363); assigned in "
        "connection.ConnectionMixin._schedule_reconcile_once and .close."
    ),
    "_redis": (
        "NEVER read through getattr -- 46 bare `self._redis` reads across "
        "aggregation.py, ancestors.py, caches.py, connection.py and "
        "stats.py, zero guarded. Assigned only inside the connect path "
        "(connection.ConnectionMixin._ensure_connected, "
        "connection.py:633,636,644) and connection.ConnectionMixin.close "
        "(connection.py:1406) -- never in __init__. Every bare read "
        "depends on the invariant that _ensure_connected has already run "
        "on this instance; this is deliberate (moving it into __init__ "
        "would change behaviour, which no carve task may do) and is why "
        "it is not in INIT_ASSIGNED. A __new__-built test instance must "
        "hand-set it if the code path it exercises reads it without a "
        "surrounding try/except -- see tests/test_falkordb_clear_content_"
        "caches.py:60. Where the reader wraps the read in its own "
        "try/except (e.g. caches.CacheMixin._get_cached_label), a missing "
        "_redis degrades to a cache miss instead of raising, so those "
        "particular call sites tolerate an unset attribute despite the "
        "bare syntax."
    ),
    "_regime_probe_cached": (
        "getattr default None (caches.py:206); assigned in "
        "caches.CacheMixin._aggregation_storage_regime. Value is a "
        "(found, timestamp) tuple or None."
    ),
    "_resolved_containment_types": (
        "getattr default None (ancestors.py:52); assigned in "
        "ontology.OntologyMixin.set_containment_edge_types. One bare read "
        "at ontology.py:436, guarded by the sibling flag "
        "`if getattr(self, \"_resolved_containment_types_set\", False):` "
        "on the line above -- safe by construction, not by accident."
    ),
    "_resolved_containment_types_set": (
        "getattr default False (ontology.py:432); assigned alongside "
        "_resolved_containment_types in "
        "ontology.OntologyMixin.set_containment_edge_types."
    ),
    "_resolved_edge_metadata": (
        "getattr default None (stats.py:410); assigned in "
        "ontology.OntologyMixin.set_resolved_edge_metadata."
    ),
    "_resolved_edge_metadata_set": (
        "getattr default False (ontology.py:459); assigned alongside "
        "_resolved_edge_metadata and _resolved_lineage_types in "
        "ontology.OntologyMixin.set_resolved_edge_metadata."
    ),
    "_resolved_lineage_types": (
        "getattr default None (stats.py:411); assigned in "
        "ontology.OntologyMixin.set_resolved_edge_metadata. One bare read "
        "at ontology.py:464, guarded by the sibling flag "
        "`_resolved_edge_metadata_set` the same way "
        "_resolved_containment_types is -- safe by construction."
    ),
    "_save_indices_ensured": (
        "getattr default False (writes.py:215); assigned in "
        "writes.WriteMixin.save_custom_graph."
    ),
    "_source_entity_aliases": (
        "No static read anywhere, guarded or bare -- read only via "
        "ontology.OntologyMixin._alias_types(self, types, alias_attr), "
        "which does `getattr(self, alias_attr, None)` with the attribute "
        "NAME arriving as the parameter `alias_attr` from the string "
        "literal at the call site in "
        "ontology.OntologyMixin._alias_entity_types. Invisible to any "
        "static guard, including this package's own guard 2 -- documented "
        "here so the next person who greps for reads of this name and "
        "finds none does not conclude it is write-only and delete the "
        "setter that feeds it. Assigned in "
        "ontology.OntologyMixin.set_source_type_aliases."
    ),
    "_source_rel_aliases": (
        "Same mechanism as _source_entity_aliases: read only via "
        "_alias_types's dynamic getattr, this time from the call site in "
        "ontology.OntologyMixin._alias_rel_types. Assigned in "
        "ontology.OntologyMixin.set_source_type_aliases."
    ),
}

# The 8 class-level constants read from a mixin other than the one that
# owns them -- see point 4 of the module docstring for why this is a
# curated subset, not the package's full constant inventory.
CLASS_CONSTANTS: Dict[str, str] = {
    "TRACE_DEGREE_CAP": "ontology.OntologyMixin",
    "_BULK_WIPE_BATCH_SIZE": "aggregation.AggregationMixin",
    "_EDGES_BETWEEN_TIMEOUT": "connection.ConnectionMixin",
    # Read in ConnectionMixin.__init__ (connection.py) despite being owned
    # by AggregationMixin, which sits LATER in FalkorDBProvider's bases
    # tuple than ConnectionMixin. This resolves because a class attribute
    # is looked up through the composed class's whole MRO at
    # attribute-access time, by which point the bases tuple is already
    # fully built -- definition order among mixins is not load-bearing for
    # this kind of read, only for method-name shadowing across mixins (two
    # mixins defining the same method name, where the earlier one in the
    # bases tuple wins silently) -- a separate, one-time check made by
    # walking FalkorDBProvider.__mro__ for duplicate method names.
    "_MERGE_SUB_BATCH_SIZE": "aggregation.AggregationMixin",
    "_READ_TIMEOUT": "connection.ConnectionMixin",
    "_SCHEMA_CACHE_TTL": "stats.StatsMixin",
    "_TYPE_CASING_TTL_S": "writes.WriteMixin",
    "_WRITE_TIMEOUT": "connection.ConnectionMixin",
}

# Helper classes in the package with their own `self.x` attributes that are
# NOT provider state -- excluded from every list above and from the guard
# test's measurement (it only walks classes named `*Mixin` or
# `FalkorDBProvider`). Listed here only so a reader wondering "why isn't
# `edges_by_id` in LATE_ASSIGNED" finds the answer next to the lists it
# might otherwise expect it in.
HELPER_CLASSES_EXCLUDED: FrozenSet[str] = frozenset({
    "aggregation.AggRunMeta",
    "aggregation.AggregationBatchAbort",
    "closure._ClosureWalk",
    "errors._EmptyResult",
})

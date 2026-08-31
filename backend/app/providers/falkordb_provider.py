"""Compatibility shim.

The FalkorDB provider now lives in ``backend.app.providers.falkordb`` (a
package of area-mixins plus a shared kernel under ``backend/common/providers/``
— see ``docs/BACKEND.md`` §3 for the layout). This module re-exports the
package's public surface unchanged so every existing
``from backend.app.providers.falkordb_provider import ...`` site keeps
working without an edit. No ``DeprecationWarning`` yet: 40+ test files and
nine non-test call sites still import this path directly (six of them
importing a private name — see ``test_falkordb_package_guards.py``'s
``_GUARD1_ALLOWLIST``), and the warning lands in a later PR once those
consumers are repointed at the package.

Export contract: the 40 names below are the measured union of everything
the rest of the repo imports from this module today — 20 names imported
by name across 95 import statements (an AST pass at this task's own HEAD,
not inherited from the pre-package-split snapshot that first measured
this), 6 more read off the module object (e.g.
``fp._normalize_falkordb_host``, ``fp._BULK_CREATE_KNOBS_CACHE``),
``asyncio`` (two tests patch ``backend.app.providers.falkordb_provider.
asyncio.sleep``) and ``logger`` (two tests filter caplog on this module's
historic logger name) — plus a small set of names no current call site
imports by name but that cost nothing to keep resolvable. Grouped below
by the leaf module in the package that actually defines each one, with a
comment on who needs the group; narrow this list only by confirming (via
``test_falkordb_package_guards.py``'s guard 1 and guard 6) that nothing
still imports the name you want to drop.

Object identity, not just presence: the three memo sets —
``_UNLABELED_URN_UNSUPPORTED``, ``_INDEX_HEALTH_LOGGED`` (both defined in
``falkordb/schema.py``) and ``_BULK_CREATE_KNOBS_CACHE`` (defined in
``falkordb/knobs.py``) — are mutated in place at runtime (``.add()``,
``.clear()``) by code that reaches them through a DIFFERENT one of these
three modules (shim / package / leaf) than the one doing the mutating.
``tests/test_falkordb_empty_graph.py`` calls
``fp._BULK_CREATE_KNOBS_CACHE.clear()`` through this shim and expects the
real cache the provider reads to go empty; that only works because every
import below is a plain re-export of the same object, never a copy.
``_logged_legacy_blob`` is deliberately NOT re-exported for the opposite
reason: it is a bool mutated via ``global`` inside ``provider.py``, nothing
outside the package reads it, and a re-export here would bind a stale copy
the mutation never reaches.
"""
import asyncio  # noqa: F401 - tests patch this module's asyncio.sleep

from backend.app.providers.falkordb import (
    # The class the package exists for -- 71 import sites across app code,
    # scripts, and tests.
    FalkorDBProvider,
    # Row <-> GraphNode/GraphEdge mapping and property sanitization
    # (falkordb/rowmap.py) -- the versioning services import these
    # privately today (services/versioning/{service,projection,reconcile,
    # entity_serde,bootstrap_worker}.py, api/v1/endpoints/versioning.py;
    # see guard 1's allow-list) plus test_falkordb_native_properties.py /
    # test_node_property_hygiene.py / test_node_identity_read_path.py.
    _sanitize_label,
    _node_from_props,
    _RESERVED_NODE_KEYS,
    _split_user_properties,
    _compute_searchable_text,
    _sanitize_node_properties,
    _edge_from_row,
    # Host/port resolution (falkordb/hosts.py) -- manager.py,
    # falkor_graph_registry.py, provider_registry.py, and
    # test_falkordb_host_resolution.py / test_falkordb_empty_graph.py
    # (`fp._normalize_falkordb_host` is monkeypatched in place, so it must
    # stay the same object).
    resolve_falkordb_target,
    _normalize_falkordb_host,
    # Keyset-cursor pagination (falkordb/cursors.py) -- CursorMismatchError
    # is caught by api/v1/endpoints/graph.py; the rest are exercised by
    # test_keyset_cursor.py / test_keyset_cursor_direction.py /
    # test_top_level_provider_kwargs.py.
    CursorMismatchError,
    _encode_keyset_cursor,
    _decode_keyset_cursor,
    _keyset_sort_key,
    _keyset_sort,
    _validate_sort_direction,
    _CURSOR_PREFIX,
    # Bulk-create batching knobs (falkordb/knobs.py) --
    # test_falkordb_empty_graph.py calls `.clear()` on the cache and reads
    # the two defaults; must stay the same object, not a copy.
    _BULK_CREATE_KNOBS_CACHE,
    _BULK_CREATE_BATCH_DEFAULT,
    _BULK_CREATE_TIMEOUT_DEFAULT,
    _resolve_bulk_create_knobs,
    # AGGREGATED roll-up run metadata and control flow (falkordb/aggregation.py)
    # -- test_falkordb_ondemand_pairs.py / test_falkordb_delete_hook_canonical.py.
    AggRunMeta,
    AggregationBatchAbort,
    _completed,
    # Degree-exact closure-walk tuning (falkordb/closure.py) --
    # CLOSURE_QUERY_CAP_SECS is read by test_trace_closure_completeness.py;
    # the rest are the plan's defensive additions, no current importer.
    _ClosureWalk,
    CLOSURE_FRONTIER_PROBE_CAP,
    CLOSURE_QUERY_CAP_SECS,
    CLOSURE_WALK_SLICE,
    CLOSURE_WALK_RESERVE_FRACTION,
    # Per-server schema/index memo sets (falkordb/schema.py) -- must stay
    # the same object; onboarding and index-health code adds to these in
    # one module and other code (including this shim's consumers) reads
    # them through another.
    _UNLABELED_URN_UNSUPPORTED,
    _INDEX_HEALTH_LOGGED,
    # Connection/cluster error classifiers (falkordb/errors.py) --
    # test_falkordb_loading_state.py / test_falkordb_auth_matrix.py /
    # test_falkordb_empty_graph.py.
    _is_transient_connection_error,
    _is_cluster_routing_error,
    _is_loading_error,
    _is_missing_graph_error,
    _is_null_handle_error,
    _EmptyResult,
    _TRANSIENT_RETRY_BACKOFFS,
    # The package logger (falkordb/_log.py) -- test_ensure_indices_onboarding.py
    # filters caplog on this module's historic dotted name.
    logger,
)

__all__ = [
    "FalkorDBProvider",
    "_sanitize_label",
    "_node_from_props",
    "_RESERVED_NODE_KEYS",
    "_split_user_properties",
    "_compute_searchable_text",
    "_sanitize_node_properties",
    "_edge_from_row",
    "resolve_falkordb_target",
    "_normalize_falkordb_host",
    "CursorMismatchError",
    "_encode_keyset_cursor",
    "_decode_keyset_cursor",
    "_keyset_sort_key",
    "_keyset_sort",
    "_validate_sort_direction",
    "_CURSOR_PREFIX",
    "_BULK_CREATE_KNOBS_CACHE",
    "_BULK_CREATE_BATCH_DEFAULT",
    "_BULK_CREATE_TIMEOUT_DEFAULT",
    "_resolve_bulk_create_knobs",
    "AggRunMeta",
    "AggregationBatchAbort",
    "_completed",
    "_ClosureWalk",
    "CLOSURE_FRONTIER_PROBE_CAP",
    "CLOSURE_QUERY_CAP_SECS",
    "CLOSURE_WALK_SLICE",
    "CLOSURE_WALK_RESERVE_FRACTION",
    "_UNLABELED_URN_UNSUPPORTED",
    "_INDEX_HEALTH_LOGGED",
    "_is_transient_connection_error",
    "_is_cluster_routing_error",
    "_is_loading_error",
    "_is_missing_graph_error",
    "_is_null_handle_error",
    "_EmptyResult",
    "_TRANSIENT_RETRY_BACKOFFS",
    "logger",
    "asyncio",
]

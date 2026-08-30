"""Compatibility shim.

The FalkorDB provider now lives in backend/app/providers/falkordb/ (see
.superpowers/sdd/2026-08-30-pr1-falkordb-decoupling/task-3-brief.md). This
module re-exports its public surface unchanged so every existing
"from backend.app.providers.falkordb_provider import ..." site keeps
working without an edit. No DeprecationWarning yet: 40+ test files still
import this path directly, and the warning lands in a later PR once
consumers are repointed at the package.
"""
import asyncio  # noqa: F401 - tests patch this module's asyncio.sleep

from backend.app.providers.falkordb import (
    FalkorDBProvider,
    _sanitize_label,
    AggRunMeta,
    _node_from_props,
    _RESERVED_NODE_KEYS,
    _split_user_properties,
    resolve_falkordb_target,
    _compute_searchable_text,
    _decode_keyset_cursor,
    _sanitize_node_properties,
    CursorMismatchError,
    _edge_from_row,
    _encode_keyset_cursor,
    _is_transient_connection_error,
    _is_cluster_routing_error,
    _is_loading_error,
    _is_missing_graph_error,
    _is_null_handle_error,
    _keyset_sort,
    _keyset_sort_key,
    _normalize_falkordb_host,
    _validate_sort_direction,
    _BULK_CREATE_KNOBS_CACHE,
    CLOSURE_QUERY_CAP_SECS,
    _BULK_CREATE_BATCH_DEFAULT,
    _BULK_CREATE_TIMEOUT_DEFAULT,
    logger,
    AggregationBatchAbort,
    _EmptyResult,
    _CURSOR_PREFIX,
    _TRANSIENT_RETRY_BACKOFFS,
    _ClosureWalk,
    _completed,
    CLOSURE_FRONTIER_PROBE_CAP,
    CLOSURE_WALK_SLICE,
    CLOSURE_WALK_RESERVE_FRACTION,
    _UNLABELED_URN_UNSUPPORTED,
    _INDEX_HEALTH_LOGGED,
    _resolve_bulk_create_knobs,
)

# _logged_legacy_blob is deliberately NOT re-exported: it is a bool
# mutated in place via `global` inside provider.py, nothing outside the
# package reads it, and a re-export here would bind a stale copy the
# mutation never reaches.

__all__ = [
    "asyncio",
    "FalkorDBProvider",
    "_sanitize_label",
    "AggRunMeta",
    "_node_from_props",
    "_RESERVED_NODE_KEYS",
    "_split_user_properties",
    "resolve_falkordb_target",
    "_compute_searchable_text",
    "_decode_keyset_cursor",
    "_sanitize_node_properties",
    "CursorMismatchError",
    "_edge_from_row",
    "_encode_keyset_cursor",
    "_is_transient_connection_error",
    "_is_cluster_routing_error",
    "_is_loading_error",
    "_is_missing_graph_error",
    "_is_null_handle_error",
    "_keyset_sort",
    "_keyset_sort_key",
    "_normalize_falkordb_host",
    "_validate_sort_direction",
    "_BULK_CREATE_KNOBS_CACHE",
    "CLOSURE_QUERY_CAP_SECS",
    "_BULK_CREATE_BATCH_DEFAULT",
    "_BULK_CREATE_TIMEOUT_DEFAULT",
    "logger",
    "AggregationBatchAbort",
    "_EmptyResult",
    "_CURSOR_PREFIX",
    "_TRANSIENT_RETRY_BACKOFFS",
    "_ClosureWalk",
    "_completed",
    "CLOSURE_FRONTIER_PROBE_CAP",
    "CLOSURE_WALK_SLICE",
    "CLOSURE_WALK_RESERVE_FRACTION",
    "_UNLABELED_URN_UNSUPPORTED",
    "_INDEX_HEALTH_LOGGED",
    "_resolve_bulk_create_knobs",
]

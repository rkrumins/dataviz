"""The FalkorDB provider package.

``provider.py`` is the former ``backend/app/providers/falkordb_provider.py``,
moved here unchanged apart from its relative imports (which had to become
absolute — a module one directory deeper resolves ``..config`` to
``backend.app.providers.config``, which does not exist). The old path is
now a thin compatibility shim (``backend/app/providers/falkordb_provider.py``)
that imports from this package, so every existing import site keeps
working untouched.

The export list below is the AST-measured surface documented in
``.superpowers/sdd/2026-08-30-pr1-falkordb-decoupling/export-surface.md``:
every name the repo actually imports from the old module (or reads off it
by attribute), plus the plan's defensive additions. Mutable module state
(the cache dicts, the two log-once sets) is re-exported by reference here,
never copied — tests mutate them in place via ``.clear()`` and expect the
real state to change.

``provider.py`` now holds only ``class FalkorDBProvider`` and its bases
tuple — the last carve emptied the class body, so ``FalkorDBProvider`` is
the only name still sourced from ``.provider``; every other exported name
below comes straight from the leaf module that defines it rather than
from ``.provider`` (``errors.py``, ``hosts.py``, ``knobs.py``,
``rowmap.py``, ``schema.py``, ``aggregation.py``, ``closure.py``,
``cursors.py``).
"""
import asyncio

from .provider import FalkorDBProvider

# The rest of the export list: names ``provider.py`` no longer imports for
# its own use (its class body never references them), so they come
# straight from the leaf module that defines them. Same objects either
# way — the split above is purely about which module happens to import
# them first, not about identity.
from ._log import logger
from .rowmap import (
    _RESERVED_NODE_KEYS,
    _sanitize_node_properties,
    _node_from_props,
    _sanitize_label,
    _split_user_properties,
    _compute_searchable_text,
    _edge_from_row,
)
from .hosts import resolve_falkordb_target, _normalize_falkordb_host
from .cursors import (
    CursorMismatchError,
    _keyset_sort_key,
    _CURSOR_PREFIX,
    _encode_keyset_cursor,
    _decode_keyset_cursor,
    _keyset_sort,
    _validate_sort_direction,
)
from .knobs import (
    _BULK_CREATE_KNOBS_CACHE,
    _BULK_CREATE_BATCH_DEFAULT,
    _BULK_CREATE_TIMEOUT_DEFAULT,
    _resolve_bulk_create_knobs,
)
from .aggregation import AggregationBatchAbort, AggRunMeta, _completed
from .closure import (
    _ClosureWalk,
    CLOSURE_FRONTIER_PROBE_CAP,
    CLOSURE_QUERY_CAP_SECS,
    CLOSURE_WALK_SLICE,
    CLOSURE_WALK_RESERVE_FRACTION,
)
from .schema import _UNLABELED_URN_UNSUPPORTED, _INDEX_HEALTH_LOGGED
from .errors import (
    _is_cluster_routing_error,
    _is_null_handle_error,
    _is_missing_graph_error,
    _is_transient_connection_error,
    _is_loading_error,
    _EmptyResult,
    _TRANSIENT_RETRY_BACKOFFS,
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

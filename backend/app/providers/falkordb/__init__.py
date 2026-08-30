"""The FalkorDB provider package.

``provider.py`` is the former ``backend/app/providers/falkordb_provider.py``,
moved here unchanged apart from its relative imports (which had to become
absolute — a module one directory deeper resolves ``..config`` to
``backend.app.providers.config``, which does not exist). The old path is
now a thin compatibility shim (``backend/app/providers/falkordb_provider.py``)
that imports from this package, so every existing import site keeps
working untouched.

Export contract, stated once here rather than pointed at elsewhere: this
module keeps 40 names resolvable as module attributes — ``FalkorDBProvider``
itself; the row-mapping, host-resolution, keyset-cursor and bulk-create-knob
helpers; the aggregation and closure-walk primitives; the six connection/
cluster error classifiers; the three memo sets; and a handful of names no
current call site imports by name but that cost nothing to keep resolvable.
That is every name the repo imports from the old monolithic module (by name
or by attribute) plus a small defensive margin, and it is exactly what the
compatibility shim re-exports and what
``backend/tests/test_falkordb_package_guards.py``'s guard 6 pins by object
identity between this package and the shim — narrow it only by removing a
name from both places at once and confirming guard 6 (and every test that
imports the name) still passes.

``__all__`` below is a narrower list: the subset of those 40 names that is
genuinely part of this package's own public surface, by the ordinary
convention that a leading underscore means "not public" — ``FalkorDBProvider``,
``AggRunMeta``, ``AggregationBatchAbort``, ``CursorMismatchError``,
``resolve_falkordb_target``, the four ``CLOSURE_*`` tuning constants, and
``logger``. The other 30 names (every private helper, the memo sets, and
``asyncio`` — kept resolvable here only because the shim's own
``asyncio.sleep`` patch target needs it, not because it is this package's
API) stay importable by explicit name — the shim, 40+ existing test files,
and guard 6 all depend on that — but are not part of ``__all__``: they are
implementation detail a consumer should reach through the leaf module that
owns them, not through this package's advertised surface.

Mutable module state — the two per-server memo sets
(``_UNLABELED_URN_UNSUPPORTED``, ``_INDEX_HEALTH_LOGGED``, both owned by
``schema.py``) and the bulk-create knobs cache (``_BULK_CREATE_KNOBS_CACHE``,
owned by ``knobs.py``) — is re-exported by reference here, never copied.
``tests/test_falkordb_empty_graph.py`` calls
``fp._BULK_CREATE_KNOBS_CACHE.clear()`` through the shim and expects the
real cache the provider reads to empty; that only works because every
layer (leaf module, this package, the shim) hands back the identical
object rather than a copy.

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
    # The class the package exists for.
    "FalkorDBProvider",
    # Public dataclasses / exceptions callers construct, raise, or catch.
    "AggRunMeta",
    "AggregationBatchAbort",
    "CursorMismatchError",
    # Public helper functions and tuning constants with no leading underscore.
    "resolve_falkordb_target",
    "CLOSURE_FRONTIER_PROBE_CAP",
    "CLOSURE_QUERY_CAP_SECS",
    "CLOSURE_WALK_SLICE",
    "CLOSURE_WALK_RESERVE_FRACTION",
    "logger",
]

# The 30 names below (every leading-underscore helper, the three memo sets,
# and `asyncio`) are deliberately NOT in __all__: they are private-by-
# convention implementation detail, kept resolvable as module attributes
# only because the compatibility shim, 40+ existing test files, and guard
# 6's `_EXPORT_SURFACE` (`test_falkordb_package_guards.py`) all depend on
# `getattr(falkordb, name)` resolving, not on the name being advertised
# via `import *`. A future consumer should reach any of these through the
# leaf module that owns them (`errors.py`, `hosts.py`, `knobs.py`,
# `rowmap.py`, `schema.py`, `aggregation.py`, `closure.py`, `cursors.py`),
# not through this package's public surface.

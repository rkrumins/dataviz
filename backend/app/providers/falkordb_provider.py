"""
FalkorDB graph provider - persists graph data in FalkorDB and loads it via the application.
Implements GraphDataProvider interface using FalkorDB async client and Cypher queries.
"""

import asyncio
import base64
import json
import logging
import os
import time
from collections import defaultdict, deque
from typing import Awaitable, Callable, List, NamedTuple, Optional, Dict, Any, Set, Tuple


class AggRunMeta(NamedTuple):
    """Aggregation-run metadata resolved by ``_aggregation_run_meta``.

    ``regime``: 'cube' (every ancestor combination stored) or 'boundary'
    (canonical depth-diagonal only). ``stamp_version``: 2 = every stored
    :AGGREGATED edge carries sourceDepth/targetDepth; 1 = legacy stamps
    (depth unknown); 0 = env-forced, no stored contract. ``max_depth``:
    deepest containment depth stamped by the last run (None when
    unknown). ``last_materialized_at``: ISO timestamp of the last
    completed run (None = never / unknown)."""

    regime: str
    stamp_version: int
    max_depth: Optional[int]
    last_materialized_at: Optional[str]

from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery,
    LineageResult, GraphSchemaStats,
    PropertyFilter, TagFilter, TextFilter, FilterOperator,
    EntityTypeSummary, EdgeTypeSummary, TagSummary,
    OntologyMetadata, EdgeTypeMetadata, EntityTypeHierarchy,
    AggregatedEdgeResult, AggregatedEdgeInfo,
    ChildrenWithEdgesResult, TopLevelNodesResult,
    TraceResult, TraceFocus,
)
# The closure-walk models are not carried by the app-level re-export above.
from backend.common.models.graph import TraceClosureResult, TraceFrontierNode
from .base import GraphDataProvider
from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)

# Per-server (host, port) facts we only need to discover / report ONCE, so onboarding
# many graphs against the same FalkorDB doesn't re-probe and re-log the same thing on
# every graph. Whether a FalkorDB build supports a label-less property index, and whether
# we've already logged its index-health summary, are server-level — not per-graph.
_UNLABELED_URN_UNSUPPORTED: set = set()
_INDEX_HEALTH_LOGGED: set = set()


class AggregationBatchAbort(Exception):
    """Raised when sustained provider failure makes continuing pointless.

    The worker's outer try/except marks the job ``status=failed`` and
    preserves ``last_cursor`` so the job can be resumed once the
    provider recovers.
    """


async def _completed(value):
    """A completed awaitable — lets asyncio.gather mix cached values with
    live queries without special-casing."""
    return value


# Bulk-CREATE operator knobs — defaults shared with the class attributes.
_BULK_CREATE_BATCH_DEFAULT = 10000
_BULK_CREATE_TIMEOUT_DEFAULT = 60.0
# Parsed-knob memo keyed by the RAW env values, so the parse (and its
# operator-tuning log line) happens once per process per configuration —
# not once per provider construction, which at fleet scale (discovery
# transients, cache rebuilds) repeated the same line on every request.
_BULK_CREATE_KNOBS_CACHE: dict = {}


def _resolve_bulk_create_knobs() -> Tuple[int, float]:
    """(batch_size, timeout_s) for bulk-CREATE, env-tuned with clamps.

    Batch size: FalkorDB best practice is 10k-50k rows per UNWIND; the env
    dial lets operators shrink it where the default monopolizes the single
    Cypher thread under concurrent trace load. Timeout: bulk writes need more
    headroom than incremental MERGEs; ceiling stays below the server's
    TIMEOUT_MAX (180s in the shipped FALKORDB_ARGS) or FalkorDB rejects the
    per-query timeout and the write becomes unkillable server-side.
    """
    raw = (
        os.getenv("FALKORDB_BULK_CREATE_BATCH_SIZE"),
        os.getenv("FALKORDB_BULK_CREATE_TIMEOUT_S"),
    )
    if raw in _BULK_CREATE_KNOBS_CACHE:
        return _BULK_CREATE_KNOBS_CACHE[raw]

    size = _BULK_CREATE_BATCH_DEFAULT
    if raw[0] is not None:
        try:
            size = max(100, min(50000, int(raw[0])))
            if size != _BULK_CREATE_BATCH_DEFAULT:
                logger.info(
                    "FALKORDB_BULK_CREATE_BATCH_SIZE=%s (clamped to %d, "
                    "default %d): operator-tuned bulk-CREATE batch size.",
                    raw[0], size, _BULK_CREATE_BATCH_DEFAULT,
                )
        except ValueError:
            logger.warning(
                "FALKORDB_BULK_CREATE_BATCH_SIZE=%r is not an integer; "
                "falling back to default %d.", raw[0], _BULK_CREATE_BATCH_DEFAULT,
            )

    timeout_s = _BULK_CREATE_TIMEOUT_DEFAULT
    if raw[1] is not None:
        try:
            timeout_s = max(5.0, min(170.0, float(raw[1])))
            if timeout_s != _BULK_CREATE_TIMEOUT_DEFAULT:
                logger.info(
                    "FALKORDB_BULK_CREATE_TIMEOUT_S=%s (clamped to %.1fs, "
                    "default %.1fs): operator-tuned bulk-CREATE write timeout.",
                    raw[1], timeout_s, _BULK_CREATE_TIMEOUT_DEFAULT,
                )
        except ValueError:
            logger.warning(
                "FALKORDB_BULK_CREATE_TIMEOUT_S=%r is not a float; "
                "falling back to default %.1fs.", raw[1], _BULK_CREATE_TIMEOUT_DEFAULT,
            )

    _BULK_CREATE_KNOBS_CACHE[raw] = (size, timeout_s)
    return _BULK_CREATE_KNOBS_CACHE[raw]


def _sanitize_label(s: str) -> str:
    """Sanitize string for use as FalkorDB label/relationship type (alphanumeric + underscore)."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


# ── Keyset pagination cursor ────────────────────────────────────────────────
#
# displayName is NOT unique. A real graph holds hundreds of children all called
# "Accounts (Analytics)". A keyset of `displayName > $cursor` therefore SKIPS
# every row that shares the boundary row's name: when a page ends in the middle
# of a run of duplicates, the next page starts *after* the whole run and those
# rows are lost — silently, forever. That is how a node with 200 children paged
# out as 197.
#
# A keyset is only correct on a UNIQUE sort key, so the cursor carries the urn
# (which is unique) as a tiebreaker and the queries order by (displayName, urn).
#
# Direction: the cursor also records the sort direction it was minted under
# ("d", absent = "asc" for cursors minted before direction support). A page
# request whose direction disagrees with its cursor's is a client bug —
# continuing would silently skip or repeat rows — so providers reject the
# mismatch (ValueError → 400 at the endpoint).
_CURSOR_PREFIX = "k1:"

# How many closure-frontier candidates get a real degree probe. Every boundary
# node the walk did not finish is a candidate, and they all share ONE
# `get_node_degrees` wave — so a hub-heavy closure could otherwise turn its
# "what did I miss?" epilogue into the most expensive part of the request.
# Past the cap the entries still ship, with totalCount None ("there is more,
# we don't know how much"), which is what an unprobed frontier honestly is.
CLOSURE_FRONTIER_PROBE_CAP = int(os.getenv("CLOSURE_FRONTIER_PROBE_CAP", "1000"))

# ── The lazy trace's page shape ──────────────────────────────────────────
#
# A hop that trips its own LIMIT cannot say WHICH anchor's rows it dropped,
# so EVERY anchor in it becomes resumable. MEASURED on solidatus-test-large:
# one drill of a layer whose 29 objects carry 6,557 rollup edges between them
# tripped a flat limit and filed **476 cursors** — 476 follow-up requests to
# finish one expansion, against a whole-journey budget of 16.
#
# So the page is shaped in three layers instead:
#   * anchors are walked in small CHUNKS, so a trip costs at most one
#     chunk's worth of per-anchor cursors rather than the whole page;
#   * a chunk's LIMIT is generous per anchor (real estates measure ~226
#     incident lane edges per object), so only a genuine mega-hub trips it;
#   * the PAGE stops at a soft edge ceiling, and its resume is the keyset
#     cursor over the anchors themselves — ONE cursor, exact, no storm.
CLOSURE_LAZY_ANCHOR_CHUNK = int(os.getenv("CLOSURE_LAZY_ANCHOR_CHUNK", "25"))
CLOSURE_LAZY_EDGES_PER_ANCHOR = int(os.getenv("CLOSURE_LAZY_EDGES_PER_ANCHOR", "500"))
CLOSURE_LAZY_EDGE_CEILING = int(os.getenv("CLOSURE_LAZY_EDGE_CEILING", "8000"))

#: What the lazy path may spend DECORATING containment with real edge ids and
#: types (see `_hydrate_and_nest`). Under the cap the pair-fetch synthesizes
#: from the ancestor chains instead — the chains are the truth, so this costs
#: fidelity, never coverage.
#:
#: MEASURED on the 2.08M-node estate, one drill of a 751-child container
#: shipping 3,424 containment pairs: 689 ms with the decoration skipped,
#: 1,563 ms with it. (It was 7,764 ms before the pair query was taught to seek
#: an index — that fix bought 9×, and this cap buys the rest.) Nothing in the
#: trace overlay reads a containment edge's id or type, and this path answers
#: a click, so the decoration must not outbid the page.
CLOSURE_LAZY_CONTAINMENT_BUDGET_S = float(os.getenv("CLOSURE_LAZY_CONTAINMENT_BUDGET_S", "2.0"))


class CursorMismatchError(ValueError):
    """A pagination cursor (or sort_direction) that cannot serve the request —
    minted under the other direction, unreadable, or malformed. Endpoints map
    this (and only this) to HTTP 400; any other ValueError stays a 500."""


def _validate_sort_direction(sort_direction: str) -> str:
    direction = (sort_direction or "asc").lower()
    if direction not in ("asc", "desc"):
        raise CursorMismatchError(f"invalid sort_direction {sort_direction!r} (expected 'asc' or 'desc')")
    return direction


def _encode_keyset_cursor(display_name: Optional[str], urn: str, sort_direction: str = "asc") -> str:
    payload: Dict[str, Any] = {"n": display_name or "", "u": urn}
    if sort_direction == "desc":
        payload["d"] = "desc"
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    return _CURSOR_PREFIX + encoded


def _decode_keyset_cursor(cursor: str, sort_direction: str = "asc") -> Tuple[str, Optional[str]]:
    """(displayName, urn). A legacy displayName-only cursor yields urn=None, so a
    client that is mid-pagination across a deploy keeps working (with the old,
    lossy semantics) instead of erroring.

    Raises CursorMismatchError when the cursor was minted under a different
    sort direction than the one now requested (absent "d" = asc)."""
    if not cursor.startswith(_CURSOR_PREFIX):
        if sort_direction == "desc":
            raise CursorMismatchError("cursor direction mismatch: legacy asc cursor used with sort_direction=desc")
        return cursor, None
    raw = cursor[len(_CURSOR_PREFIX):]
    try:
        padded = raw + "=" * (-len(raw) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except Exception:  # pragma: no cover - corrupt cursor, fall back to prefix scan
        if sort_direction == "desc":
            raise CursorMismatchError("cursor direction mismatch: unreadable cursor used with sort_direction=desc")
        return cursor, None
    cursor_direction = data.get("d") or "asc"
    if cursor_direction != sort_direction:
        raise CursorMismatchError(
            f"cursor direction mismatch: cursor was minted for {cursor_direction!r}, "
            f"request asked for {sort_direction!r}"
        )
    return str(data.get("n", "")), data.get("u") or None


def _keyset_sort_key(node: Any) -> Tuple[bool, str, str]:
    """Sort rows the same way the ASC keyset does: (displayName, urn), nulls last."""
    name = getattr(node, "display_name", None)
    return (name is None, name or "", getattr(node, "urn", "") or "")


def _keyset_sort(nodes: List[Any], sort_direction: str) -> List[Any]:
    """Defensive re-sort matching the Cypher keyset order for the direction.

    DESC is a TRUE descending lexicographic sort of (displayName, urn) with
    null names kept last (parity with the ASC path). Implemented as a
    two-bucket `reverse=True` sort — NOT a per-character complement key: a
    negated-code-point tuple fails to invert Python's tuple-length rule, so
    prefix pairs mis-order ("Account" would sort before "Accounts" although
    true DESC is the opposite), and a cursor minted from that wrong page tail
    silently duplicates/skips rows at page boundaries."""
    if sort_direction != "desc":
        return sorted(nodes, key=_keyset_sort_key)
    named = [n for n in nodes if getattr(n, "display_name", None) is not None]
    unnamed = [n for n in nodes if getattr(n, "display_name", None) is None]
    named.sort(key=lambda n: (n.display_name, getattr(n, "urn", "") or ""), reverse=True)
    unnamed.sort(key=lambda n: getattr(n, "urn", "") or "", reverse=True)
    return named + unnamed


# Exception class names that indicate a Redis Cluster routing change (the
# slot moved to another node) or a transient connection drop where a
# single client rebuild + retry is the right response. Matched by name so
# we don't hard-import redis cluster exceptions at module load.
_CLUSTER_REDIRECT_EXC_NAMES = frozenset({
    "MovedError", "AskError", "ClusterDownError", "TryAgainError",
    "ConnectionError", "TimeoutError",
})


def _is_cluster_redirect(exc: BaseException) -> bool:
    """True when *exc* (or its cause) looks like a cluster redirect /
    transient connection error worth one transparent rebuild + retry."""
    seen = exc
    for _ in range(4):  # walk a short __cause__/__context__ chain
        if seen is None:
            break
        if type(seen).__name__ in _CLUSTER_REDIRECT_EXC_NAMES:
            return True
        seen = seen.__cause__ or seen.__context__
    return False


# Names that indicate a Redis Cluster *routing* change (the slot moved) —
# these require rebuilding the single-node client, not just a retry.
_CLUSTER_ROUTING_EXC_NAMES = frozenset({
    "MovedError", "AskError", "ClusterDownError", "TryAgainError",
})

# Short backoff schedule (seconds) for transparently retrying a transient
# connection drop. Three attempts keeps the total well inside a single op's
# budget while letting redis-py hand out a fresh pooled connection.
_TRANSIENT_RETRY_BACKOFFS: tuple = (0.25, 0.5, 1.0)

# Redis transient exception classes matched by *identity* (not by name) so a
# redis socket ``TimeoutError`` is retried while the unrelated
# ``asyncio.TimeoutError`` (the per-op deadline) is NOT — both share the name
# "TimeoutError", so name-matching would wrongly multiply a real query timeout.
try:  # pragma: no cover - redis is always installed in practice
    from redis.exceptions import (
        ConnectionError as _RedisConnectionError,
        TimeoutError as _RedisTimeoutError,
    )
    _TRANSIENT_REDIS_EXC: tuple = (_RedisConnectionError, _RedisTimeoutError)
except Exception:  # pragma: no cover
    _TRANSIENT_REDIS_EXC = ()

# BusyLoadingError (subclass of redis ConnectionError) is raised while
# FalkorDB replays its RDB snapshot into memory on restart — a transient,
# self-resolving "warming up" state, NOT a real outage. Matched by identity
# so it can be split off from the generic transient-connection path (which
# would retry it for ~1.75s and then trip the breaker on a load that takes
# many seconds). See _is_loading_error below.
try:  # pragma: no cover - redis is always installed in practice
    from redis.exceptions import BusyLoadingError as _RedisBusyLoadingError
    _LOADING_REDIS_EXC: tuple = (_RedisBusyLoadingError,)
except Exception:  # pragma: no cover
    _LOADING_REDIS_EXC = ()


def _is_cluster_routing_error(exc: BaseException) -> bool:
    """True when *exc* (or its cause) is a cluster slot-moved/ASK/down error
    that needs a single-node client rebuild before retrying."""
    seen = exc
    for _ in range(4):  # walk a short __cause__/__context__ chain
        if seen is None:
            break
        if type(seen).__name__ in _CLUSTER_ROUTING_EXC_NAMES:
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _is_transient_connection_error(exc: BaseException) -> bool:
    """True when *exc* (or its cause) is a transient redis connection drop
    (e.g. 'Connection reset by peer' under FalkorDB memory pressure) worth a
    short backoff + retry. Matched by isinstance against the redis exception
    classes so ``asyncio.TimeoutError`` (the per-op deadline, same class name)
    is excluded and never inflates a genuine slow-query timeout.

    AUTH failures are excluded even though redis-py's ``AuthenticationError``
    SUBCLASSES redis ``ConnectionError``: bad credentials are not a blip, so
    retrying them (and, in cluster mode, re-resolving the topology for them) just
    burns the budget and then trips the breaker — reporting a misconfiguration as an
    outage. They are surfaced as ProviderConfigurationError instead."""
    if not _TRANSIENT_REDIS_EXC:
        return False
    from backend.app.providers.falkordb_connection import is_auth_error

    if is_auth_error(exc):
        return False
    seen = exc
    for _ in range(4):  # walk a short __cause__/__context__ chain
        if seen is None:
            break
        if isinstance(seen, _TRANSIENT_REDIS_EXC):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _is_null_handle_error(exc: BaseException) -> bool:
    """True when *exc* is a ``NoneType`` attribute error from dereferencing a
    graph handle that was nulled mid-flight — e.g. the ProviderManager evicted
    and ``close()``-d this instance during a ``_run_guarded`` retry backoff.
    Treated as reconnect-and-retry rather than a hard failure."""
    return (
        isinstance(exc, AttributeError)
        and "NoneType" in str(exc)
        and ("query" in str(exc) or "ro_query" in str(exc) or "select_graph" in str(exc))
    )


def _is_missing_graph_error(exc: BaseException) -> bool:
    """True when *exc* indicates the FalkorDB graph KEY does not exist yet.

    ``GRAPH.RO_QUERY`` on a never-created (empty) graph returns
    ``ResponseError: Invalid graph operation on empty key``. That is a
    VALID "empty graph" state (0 nodes / 0 edges) — NOT a provider outage —
    so introspection reads (get_stats / get_schema_stats / ontology
    metadata) treat it as empty rather than failing the whole call and
    tripping a false "provider down". Matched by message because FalkorDB
    surfaces it as a generic ``ResponseError``, not a distinct class.
    """
    seen = exc
    for _ in range(4):  # walk a short __cause__/__context__ chain
        if seen is None:
            break
        msg = str(seen).lower()
        if "empty key" in msg and "graph" in msg:
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _is_loading_error(exc: BaseException) -> bool:
    """True when *exc* is FalkorDB reporting it is loading its dataset into
    memory (RDB replay on restart) — a transient, self-resolving "warming"
    state, NOT an outage. Matched by isinstance against redis
    ``BusyLoadingError`` AND by message (``LOADING Redis is loading the
    dataset in memory``) since the signal can arrive wrapped. Walks the
    ``__cause__``/``__context__`` chain like the siblings above.
    """
    seen = exc
    for _ in range(4):
        if seen is None:
            break
        if _LOADING_REDIS_EXC and isinstance(seen, _LOADING_REDIS_EXC):
            return True
        if "loading the dataset in memory" in str(seen).lower():
            return True
        seen = seen.__cause__ or seen.__context__
    return False


class _EmptyResult:
    """Stand-in for a FalkorDB query result with no rows — returned by the
    tolerant read path when the graph key doesn't exist yet."""
    result_set: list = []


def _normalize_falkordb_host(host: Optional[str]) -> str:
    """Resolve a stored FalkorDB host to something actually reachable.

    1. **Docker→host rewrite** (opt-in): when the backend runs inside a
       container, a stored ``localhost`` / ``127.0.0.1`` points at the
       *container itself*, not the operator's FalkorDB, so the provider is
       falsely "down". Setting ``FALKORDB_DOCKER_LOCALHOST_REWRITE`` (e.g.
       ``host.docker.internal`` on Docker Desktop) redirects it to a
       reachable target. This is the Docker-direction sibling of
       ``LOCAL_DEV_FALKORDB_OVERRIDE`` (which rewrites the Docker hostname →
       localhost for host-run processes).
    2. **IPv4 pin**: otherwise pin the literal ``localhost`` to ``127.0.0.1``
       to dodge IPv6 ``::1`` dual-stack connect failures against IPv4-only
       Docker port publishing (opt out with ``FALKORDB_DISABLE_IPV4_NORMALIZE``).

    Other hostnames are left untouched.
    """
    h = host or "localhost"
    if h in ("localhost", "127.0.0.1"):
        rewrite = os.getenv("FALKORDB_DOCKER_LOCALHOST_REWRITE", "").strip()
        if rewrite:
            return rewrite
    if h == "localhost" and os.getenv(
        "FALKORDB_DISABLE_IPV4_NORMALIZE", ""
    ).strip().lower() not in ("1", "true", "yes"):
        return "127.0.0.1"
    return h


def resolve_falkordb_target(host: Optional[str], port: Optional[int]) -> Tuple[str, int]:
    """Single host/port resolution path for a FalkorDB provider.

    Composes ``apply_local_dev_falkordb_override`` (Docker hostname → host,
    opt-in for host-run dev processes) then ``_normalize_falkordb_host``
    (env Docker→host rewrite / IPv4 pin), in that exact order — the same
    composition every call site previously assembled inline (provider
    creation, projection registry resolve, registry key-list). Consolidating
    here is what guarantees a given ``(host, port)`` resolves to the SAME
    target in every process, so the read instance and the projection
    instance can no longer drift apart.
    """
    from .manager import apply_local_dev_falkordb_override
    host, port = apply_local_dev_falkordb_override(host, port)
    host = _normalize_falkordb_host(host)
    return host, port


def _compute_searchable_text(
    display_name: Optional[str],
    qualified_name: Optional[str],
    description: Optional[str],
    user_properties: Optional[Dict[str, Any]],
) -> str:
    """Build a lowercased, space-joined searchable string for n.searchableText.

    Includes displayName, qualifiedName, description, and every
    string-valued user property value. Capped at
    ``DeepSearchSettings.searchable_text_cap_bytes`` (env
    ``DEEP_SEARCH_SEARCHABLE_TEXT_CAP``, default 8192) so a node with
    very large string properties can't bloat the denormalised field.

    Truncated at a word boundary when the cap fires so the tail
    doesn't end mid-token (a partial token would defeat
    ``CONTAINS '<word>'`` substring search).
    """
    parts: List[str] = []
    if display_name:
        parts.append(display_name)
    if qualified_name:
        parts.append(qualified_name)
    if description:
        parts.append(description)
    if user_properties:
        for value in user_properties.values():
            if isinstance(value, str):
                parts.append(value)
    result = " ".join(parts).lower()
    # Lazy import to avoid pulling settings into module import time
    # (this helper is hot — called on every write).
    from backend.app.services.deep_search import get_deep_search_settings
    cap = get_deep_search_settings().searchable_text_cap_bytes
    if len(result) <= cap:
        return result
    # Trim at the last word boundary <= cap so we never end mid-word.
    truncated = result[:cap]
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space]
    return truncated


# Reserved node-key set — fields the provider writes directly onto a FalkorDB
# node. User-supplied `properties` keys that collide with these names are
# dropped at write time so provider state stays authoritative. Used by both
# the write-side split helper and the read-side reconstruction of the user
# `properties` dict (everything NOT in this set is a user property).
#
# `properties` is included because nodes upserted before the native-property
# refactor still carry the legacy JSON blob; the read path parses it as a
# transitional fallback, and the write path strips it on next write.
# `propertiesRaw` is the post-refactor escape hatch — a JSON-stringified
# dict of values that couldn't be written natively (nested objects, lists
# of dicts, etc.).
_RESERVED_NODE_KEYS: frozenset = frozenset({
    "urn", "entityType", "displayName", "qualifiedName", "description",
    "tags", "layerAssignment", "childCount", "sourceSystem", "lastSyncedAt",
    "level", "levelDigest",
    # Denormalised internal fields the write paths SET directly on the node
    # (provider save + FalkorDB projector). They are NOT user properties and
    # not GraphNode fields, so without reserving them the read-path treats them
    # as user `properties` — surfacing `entityId` (the raw urn) and
    # `searchableText` ("<displayName> <qualifiedName> …") in the Properties
    # panel. This leak hit every node a post-merge full re-seed rewrote.
    "entityId", "searchableText",
    "properties",      # legacy blob — read path no longer hydrates from it
    "propertiesRaw",   # native escape hatch for non-scalar property values
    # Provenance written by the conformance stamp: which SOURCE property each
    # canonical value was filled from. They are what lets a re-pointed mapping
    # rewrite its own previous work without ever touching a node that carried a
    # native urn / displayName. Provider-owned bookkeeping, not user data.
    "urnSource", "nameSource",
})


# One-time warning latch (W1.3): logged once per provider boot when we
# encounter a pre-refactor node that still carries the ``n.properties``
# JSON blob. The read path no longer hydrates from the blob — operators
# run the backfill migration to surface those properties as native fields.
_logged_legacy_blob: bool = False


def _split_user_properties(
    props: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], str]:
    """Split a user-supplied `properties` dict into (native_scalar, residual_json).

    Returns
    -------
    native_scalar : dict
        Keys whose values are FalkorDB-native (scalars or flat lists of
        scalars). Suitable for `SET n += $native_scalar` — each key becomes
        a real node property and is therefore indexable and Cypher-queryable.
    residual_json : str
        JSON-stringified dict of values that couldn't be written natively
        (nested dicts, lists of dicts, anything heterogenous). Always a
        string — empty dict serialises to "{}" so the SET clause always
        has a value and we don't need a separate REMOVE round-trip when
        the residual becomes empty on an upsert.

    Keys that collide with `_RESERVED_NODE_KEYS` are dropped with a warning
    so user data can't shadow provider-owned fields like `urn` or `level`.
    `None` values are skipped (writing null would shadow an existing value).
    """
    native: Dict[str, Any] = {}
    residual: Dict[str, Any] = {}
    collided: List[str] = []
    for k, v in (props or {}).items():
        if v is None:
            continue
        if k in _RESERVED_NODE_KEYS:
            collided.append(k)
            continue
        if isinstance(v, bool) or isinstance(v, (str, int, float)):
            native[k] = v
        elif isinstance(v, list) and all(
            isinstance(x, (str, int, float, bool)) for x in v
        ):
            native[k] = v
        else:
            residual[k] = v
    if collided:
        logger.warning(
            "user-property keys collided with reserved node keys, dropping: %s",
            collided,
        )
    return native, json.dumps(residual)


def _sanitize_node_properties(payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Drop reserved keys from a node payload's nested ``properties`` dict on the WRITE path.

    The read path mirrors denormalised top-level fields (``childCount``, ``tags``, …) INTO
    ``properties``, and the canvas round-trips ``properties`` verbatim on save — so without this the
    stored version-row ``properties`` accumulates reserved keys, which the projector then drops one by
    one via :func:`_split_user_properties`, logging ``user-property keys collided with reserved node
    keys`` for every node. Sanitising on write keeps stored payloads to exactly the keys the projector
    would keep, silencing that flood and closing the pollution channel (same class as the earlier
    ``{id, confidence}`` corruption). Only the nested ``properties`` is touched — legitimate top-level
    fields (``urn``/``displayName``/``childCount``/…) are untouched. Returns the original payload
    unchanged when nothing is reserved (so hashes for already-clean payloads are byte-identical)."""
    if not isinstance(payload, dict) or not isinstance(payload.get("properties"), dict):
        return payload
    props = payload["properties"]
    clean = {k: v for k, v in props.items() if k not in _RESERVED_NODE_KEYS}
    if len(clean) == len(props):
        return payload
    return {**payload, "properties": clean}


def _node_from_props(
    props: Dict[str, Any],
    entity_type_str: Optional[str] = None,
    identity_property: Optional[str] = None,
    name_property: Optional[str] = None,
) -> Optional[GraphNode]:
    """Build GraphNode from FalkorDB node properties.

    ``identity_property`` / ``name_property`` are the source's resolved
    node-identity mapping (see ``backend.app.services.node_identity``). They
    make this function the READ-TIME half of the mapping: an id-keyed graph
    hydrates correctly on the very next request, without waiting for an
    aggregation run to stamp ``urn`` onto its nodes — which is what a
    read-only source or a dedicated projection can never get.

    Reconstructs the user `properties` dict from two layers, in
    increasing priority (later wins):

      1. Non-reserved native keys on the node — written by the
         post-refactor ingest path. The source of truth.
      2. JSON-stringified residual in `props['propertiesRaw']` —
         non-scalar values that couldn't be written natively (nested
         dicts, lists of dicts). Layered on top of native because
         residual keys are disjoint from native keys by construction.

    The pre-refactor ``n.properties`` legacy JSON blob is no longer
    consulted (W1.3 / greenfield cleanup). Nodes that still carry
    that blob will lose those properties on read until the next
    write hydrates them as native fields — operators run
    ``backend/scripts/migrate_native_properties.py`` to backfill.
    A one-time WARNING surfaces if such a node is observed so the
    operator knows to run the migration.
    """
    if not props:
        return None
    # Identity: the canonical `urn` when the node has one, else the source's
    # URN-equivalent. Before this fallback existed, EVERY node on an id-keyed
    # graph was dropped here — silently, one `return None` at a time — so the
    # canvas showed an empty graph and the mapping looked like it did nothing.
    urn = props.get("urn")
    if not urn and identity_property and identity_property != "urn":
        urn = props.get(identity_property)
    if not urn:
        return None
    entity_type = entity_type_str or props.get("entityType", "unknown")

    if "properties" in props:
        # Pre-refactor node still carries the legacy blob. Flag it once
        # per provider boot so operators can run the backfill. The
        # warning is bounded by ``_logged_legacy_blob`` (module-level
        # set) so we don't spam the logs in production.
        global _logged_legacy_blob
        if not _logged_legacy_blob:
            logger.warning(
                "deep_search: node urn=%s still carries the pre-refactor "
                "n.properties JSON blob; run "
                "backend/scripts/migrate_native_properties.py to backfill. "
                "These properties are NOT visible to advanced search "
                "until migrated.",
                props.get("urn"),
            )
            _logged_legacy_blob = True

    user_props: Dict[str, Any] = {}
    for k, v in props.items():
        if k in _RESERVED_NODE_KEYS:
            continue
        user_props[k] = v

    residual_blob = props.get("propertiesRaw")
    if isinstance(residual_blob, str) and residual_blob:
        try:
            residual_dict = json.loads(residual_blob)
            if isinstance(residual_dict, dict):
                user_props.update(residual_dict)
        except (json.JSONDecodeError, TypeError):
            pass

    try:
        return GraphNode(
            urn=str(urn),
            entityType=str(entity_type),
            # Onboarded third-party graphs often store the human name under
            # `name`/`title`/`label` rather than the platform's `displayName`,
            # which would otherwise render a BLANK node label. The source's
            # CONFIGURED name property goes first — that is the operator
            # telling us where the name lives, and it is the only thing that
            # can find a name under a key this list could never guess. The
            # common keys stay as the fallback for unmapped sources.
            displayName=(
                props.get("displayName")
                or (props.get(name_property) if name_property else None)
                or props.get("name")
                or props.get("title")
                or props.get("label")
                or ""
            ),
            qualifiedName=props.get("qualifiedName"),
            description=props.get("description"),
            properties=user_props,
            tags=json.loads(props["tags"]) if isinstance(props.get("tags"), str) else (props.get("tags") or []),
            layerAssignment=props.get("layerAssignment"),
            # childCount is LAYERED (2026-08-21 ruling, superseding the
            # 2026-08-20 one that nulled it here):
            #
            #   * paths that COUNT — get_node, get_nodes_batch, get_nodes,
            #     the children fetches, and every trace/closure hydration
            #     through them — overwrite this with a live count(child) over
            #     the configured containment types. That count is the truth.
            #   * paths that do NOT count — get_parent, get_ancestors,
            #     get_upstream/get_downstream, get_full_lineage,
            #     trace_at_level — echo the stored property, as they always
            #     did.
            #
            # Nulling it here was correct about the property (an ingest-time
            # snapshot that drifts) but wrong about the consequence: it turned
            # a stale-but-usually-right number into NO number on every
            # uncounted path, and a card hydrated by one of those renders
            # chevron-less. Stale beats absent when absent means "no affordance
            # at all"; the counted paths, which is where the canvas gets its
            # cards, are unaffected either way.
            childCount=props.get("childCount"),
            sourceSystem=props.get("sourceSystem"),
            lastSyncedAt=props.get("lastSyncedAt"),
        )
    except Exception as e:
        logger.warning(f"Failed to build GraphNode from props: {e}")
        return None


def _edge_from_row(source_urn: str, target_urn: str, rel_type: str, props: Dict[str, Any]) -> GraphEdge:
    """Build GraphEdge from FalkorDB edge data."""
    edge_id = props.get("id") or f"{source_urn}|{rel_type}|{target_urn}"
    return GraphEdge(
        id=edge_id,
        sourceUrn=source_urn,
        targetUrn=target_urn,
        edgeType=str(rel_type),
        confidence=props.get("confidence"),
        properties=json.loads(props["properties"]) if isinstance(props.get("properties"), str) else (props.get("properties") or {}),
    )


class FalkorDBProvider(GraphDataProvider):
    """
    Graph data provider backed by FalkorDB.
    Schema: nodes have label = entityType, properties include urn, displayName, etc.
    Edges use relationship type = edgeType (CONTAINS, PRODUCES, etc.).
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 6379,
        graph_name: str = "nexus_lineage",
        seed_file: Optional[str] = None,
        projection_mode: str = "in_source",
        username: Optional[str] = None,
        password: Optional[str] = None,
        connection_config: Optional[dict] = None,
        cache_redis_url: Optional[str] = None,
        auth_enabled: bool = True,
        tls_enabled: bool = False,
        provider_id: Optional[str] = None,
        extra_config: Optional[dict] = None,
        credentials: Optional[dict] = None,
    ):
        # IPv6 dual-stack guard: "localhost" resolves to BOTH ::1 and
        # 127.0.0.1, and Docker commonly publishes IPv4 only, so the redis
        # ConnectionPool's ::1 attempt fails ("Connect call failed
        # ('::1', 6379)") and surfaces as a false "provider down". Pin
        # localhost to IPv4 (opt-out via FALKORDB_DISABLE_IPV4_NORMALIZE).
        # Setting self._host here covers both the connection factory pool
        # and preflight(), which read self._host.
        self._host = _normalize_falkordb_host(host)
        self._port = port
        self._graph_name = graph_name
        self._seed_file = seed_file
        self._projection_mode = projection_mode  # "in_source" or "dedicated"
        # Connection topology config (standalone / sentinel / cluster).
        # Rides the provider record's extra_config["falkordbConnection"].
        # None / absent / "standalone" → legacy single-host behavior.
        # Resolved lazily in _ensure_connected via the connection factory.
        self._connection_config = connection_config
        # Per-provider dedicated cache Redis URL (carries a possible password,
        # so it travels via the encrypted credentials blob, not extra_config).
        # Deprecated alias — folded into ``self._credentials["cache_redis_url"]``
        # below so ``build_cache_client`` resolves it the same way as a
        # provider row's own encrypted ``cache_redis_url`` credential.
        self._cache_redis_url = cache_redis_url
        # Identity + raw config for the CACHE role's central resolver
        # (``build_cache_client``): the provider's own
        # ``extra_config.cacheConnection`` (non-secret topology/TLS) and its
        # decrypted credentials (cache_username/cache_password/... plus the
        # legacy cache_redis_url alias). Never the FalkorDB graph credentials
        # — the cache resolves its own auth, never inherits the graph's.
        self._provider_id = provider_id
        self._extra_config = extra_config
        merged_credentials = dict(credentials or {})
        if cache_redis_url and "cache_redis_url" not in merged_credentials:
            merged_credentials["cache_redis_url"] = cache_redis_url
        self._credentials = merged_credentials
        self._conn_cfg = None  # populated by _ensure_connected (FalkorDBConnConfig)
        # Failover state: a monotonic generation bumped on each client
        # rebuild, plus a lock so concurrent MOVED/connection errors
        # coalesce into a single rebuild instead of a thundering herd.
        self._conn_generation = 0
        self._failover_lock = asyncio.Lock()
        self._proj_db = None   # separate client for {graph}_proj on cluster
        self._proj_pool = None
        # P1.6 — credentials previously dropped silently in
        # ProviderManager._create_provider_instance, causing NOAUTH errors
        # to be mis-classified as network failures and triggering false
        # breaker storms. They're now plumbed end-to-end:
        #   __init__ → preflight (RESP AUTH before PING)
        #            → _ensure_connected (driver auth via from_url args)
        #
        # Per-provider auth gate (extra_config.falkordbConnection.authEnabled,
        # default true). When auth is DISABLED for this provider, null the
        # FalkorDB graph credentials at this single chokepoint so NOTHING
        # downstream sends AUTH — the graph pool kwargs, preflight's AUTH-
        # before-PING, and load_connection_config() all read these fields.
        # This prevents credential leakage / NOAUTH storms against an
        # unauthenticated FalkorDB. The cache Redis resolves its OWN auth via
        # ``self._credentials`` (never these fields) and is intentionally
        # NOT gated by this flag.
        # Auth is ON unless EXPLICITLY disabled. ``authEnabled`` rides
        # extra_config.falkordbConnection.authEnabled and callers pass through
        # whatever was stored (``.get("authEnabled", True)``), so a null / 0 /
        # wrong-typed value used to be falsy here and SILENTLY NULL a saved
        # password — the "auth_required despite a saved credential" footgun the
        # operator keeps hitting after configuring auth in the UI. Only a real,
        # explicit false (bool ``False`` or "false"/"0"/"no"/"off") disables
        # auth; anything else keeps the configured credential. A configured
        # password against a genuinely UNauthenticated instance is still safe —
        # preflight treats the "no password set" reply as reachable and the
        # connect path's auth-negotiation drops the stale credential and
        # reconnects.
        auth_off = auth_enabled is False or (
            isinstance(auth_enabled, str)
            and auth_enabled.strip().lower() in ("false", "0", "no", "off")
        )
        self._auth_enabled = not auth_off
        # Normalize BEFORE storing: ""/whitespace-only creds must mean "absent"
        # here exactly as they do in load_connection_config, or preflight (which
        # reads self._username/_password directly) and the connect path would
        # disagree about whether this provider authenticates.
        from backend.app.providers.falkordb_connection import normalize_credentials
        username, password = normalize_credentials(
            username, password,
            context=f"FalkorDB provider {provider_id or f'{self._host}:{port}'}",
        )
        self._username = username if self._auth_enabled else None
        self._password = password if self._auth_enabled else None
        # Footgun guard: auth EXPLICITLY disabled while a graph password is saved
        # — the password is nulled above, so the graph connects UNAUTHENTICATED
        # and an auth-required instance (e.g. a requirepass Redis Cluster)
        # reports "auth_required". Surface it loudly.
        if auth_off and (password or (credentials or {}).get("password")):
            logger.warning(
                "FalkorDB provider %s: authentication is EXPLICITLY DISABLED "
                "(falkordbConnection.authEnabled=false) but a graph password is "
                "saved — connecting UNAUTHENTICATED. An auth-required instance will "
                "report 'auth_required'. Enable authentication for this provider, "
                "or clear the saved password.",
                provider_id or f"{self._host}:{port}",
            )
        # Connection-level TLS toggle (the provider record's tls_enabled, plus
        # the finer falkordbConnection.tls object resolved in _ensure_connected).
        # Applies to the graph (all topologies), preflight, and the cache.
        self._tls_enabled = tls_enabled
        self._graph = None
        # Per-instance connect cooldown (WS0.1). A recent connect failure
        # short-circuits repeated connect attempts within (and across) a
        # request: an unreachable / blackhole host would otherwise be
        # re-probed for EVERY one of a request's ontology-introspection +
        # read queries, each paying the full socket_connect_timeout and
        # summing to tens of seconds before the request finally 503s.
        # monotonic() deadline; 0.0 = no cooldown. The first attempt after
        # it lapses is allowed through, so recovery self-heals.
        self._connect_cooldown_until: float = 0.0
        self._connect_cooldown_s: float = float(
            os.getenv("FALKORDB_CONNECT_COOLDOWN_S", "5")
        )
        # In-flight guarded-op count. The ProviderManager's recovery eviction
        # defers close() while this is > 0 so it cannot tear the pool out from
        # under a running aggregation job (the 'NoneType has no query' race).
        self._inflight = 0
        self._proj_graph = None  # Dedicated projection graph (when mode = "dedicated")
        self._pool = None       # Graph query pool (used by FalkorDB)
        self._redis_pool = None  # Separate pool for Redis data-structure ops (caching, SADD, etc.)
        self._db = None
        # P2.3 — graceful cache-disable mode. When the cache Redis is
        # unreachable but the FalkorDB graph is fine, set this to False
        # so cache reads return None silently and cache writes are
        # dropped. Provider works DEGRADED (slower reads, no
        # materialization tracking) but does NOT fail availability —
        # mirroring Neo4j's pattern at line 271-276 of neo4j_provider.py.
        self._redis_available: bool = True
        # Application-layer concurrency cap for Cypher queries. Pool size
        # is FALKORDB_GRAPH_POOL_SIZE (default 24); we cap query-issuing
        # tasks below that so a burst of slow traces cannot exhaust the
        # pool and surface as opaque socket timeouts. The remaining pool
        # headroom is reserved for non-trace work (writes, schema
        # introspection, health checks).
        self._query_semaphore = asyncio.Semaphore(
            int(os.getenv("FALKORDB_QUERY_CONCURRENCY", "20"))
        )
        # AIMD state for aggregation MERGE sub-batch sizing. Starts at the
        # ceiling and shrinks on observed latency creep; per-instance so
        # different graphs on the same provider keep independent state
        # (each ProviderManager cache key is (provider_id, graph_name)).
        self._aggregation_sub_batch_size: int = self._MERGE_SUB_BATCH_SIZE
        self._aggregation_sub_batch_under_target_run: int = 0

        # AGGREGATED edge level-stamping state. Must live on every
        # instance from construction — ``set_entity_type_levels`` (called
        # by ContextEngine ontology resolution) reads ``_level_digest``
        # before ``ensure_indices`` has necessarily run.
        #
        # The probe runs lazily — it needs the level map (and its digest)
        # before it can ask "are stamps fresh?". `set_entity_type_levels`
        # triggers the probe whenever the digest changes. Until then,
        # ``_levels_backfilled`` stays None and the trace fast path uses
        # the label-scan fallback (correct, slower).
        #
        # ``_level_digest`` is the SHA-256 of the entity_type→level map
        # currently injected onto this provider. AGGREGATED edges carry
        # ``r.levelDigest`` set to whatever digest was current when they
        # were stamped; a mismatch means the ontology drifted and stamps
        # need a re-run of backfill_aggregated_levels.py.
        #
        # ``_levels_warning_for_digest`` throttles the "edges not stamped"
        # warning to at most one log line per (provider lifetime, digest)
        # pair, so per-request probes don't spam.
        self._levels_backfilled: Optional[bool] = None
        self._level_digest: Optional[str] = None
        self._levels_warning_for_digest: Optional[str] = None

        # Phase 1.6/1.8 — operator dials for the bulk-CREATE UNWIND batch size
        # and write timeout. Parsed + logged ONCE per process per env value
        # (see _resolve_bulk_create_knobs): providers are constructed
        # continuously at fleet scale (discovery worker transients, cache
        # rebuilds), and re-logging the same operator tuning on every
        # construction read as a per-request warning storm.
        self._bulk_create_batch_size, self._bulk_create_timeout_s = (
            _resolve_bulk_create_knobs()
        )

        # Phase 2 — provider-internal hard cap and latency-quiesce circuit.
        #
        # The write semaphore puts a structural ceiling on in-flight
        # writes to FalkorDB per (provider_id, graph_name) instance.
        # No caller can exceed it; the worker, ingest hooks, future
        # callers are all gated through ``_proj_query``. Default 2
        # tolerates one bulk-rebuild batch + one incremental MERGE
        # without competing for the single FalkorDB Cypher thread.
        _write_conc_raw = os.getenv("FALKORDB_WRITE_CONCURRENCY", "2")
        try:
            _write_conc = max(1, min(32, int(_write_conc_raw)))
        except ValueError:
            _write_conc = 2
            logger.warning(
                "FALKORDB_WRITE_CONCURRENCY=%r not an int; default 2.",
                _write_conc_raw,
            )
        self._write_semaphore = asyncio.Semaphore(_write_conc)
        self._write_concurrency_cap: int = _write_conc

        # Distributed admission controller (aggregation writes). Injected
        # per-job by the aggregation worker via ``set_admission_controller``
        # so N workers × M pods share one write budget per FalkorDB
        # endpoint instead of each pod throttling only itself. None →
        # the per-process ``_write_semaphore`` above is the only gate.
        self._admission_controller: Optional[Any] = None

        # Latency-quiesce: rolling window of last 50 write latencies (in
        # seconds), computed as p95 lazily on each write attempt. When
        # p95 climbs above ``_quiesce_trigger_s``, the provider enters
        # a "busy" state — all subsequent writes raise ``ProviderBusy``
        # for ``_quiesce_cooldown_s`` seconds. The worker treats this
        # as park-and-resume (not retry/error). Distinct from the
        # circuit breaker which trips on hard errors; quiesce is flow
        # control on observed slowness.
        from collections import deque
        self._write_latency_window: deque[float] = deque(maxlen=50)
        self._quiesce_until_monotonic: float = 0.0  # 0 = not quiesced

        # Quiesce trigger: write p95 > ``_QUIESCE_MULTIPLE × WRITE_TIMEOUT_TARGET``.
        # The target represents the "this is healthy" upper bound; the
        # trigger is 3× that, on the theory that 3× slowdown means
        # overload, not jitter.
        _target_raw = os.getenv("FALKORDB_WRITE_TARGET_S", "2.0")
        try:
            _target = max(0.1, min(60.0, float(_target_raw)))
        except ValueError:
            _target = 2.0
        self._quiesce_target_s: float = _target
        self._quiesce_trigger_s: float = _target * 3.0

        _cooldown_raw = os.getenv("FALKORDB_QUIESCE_COOLDOWN_S", "30")
        try:
            self._quiesce_cooldown_s: float = max(1.0, min(600.0, float(_cooldown_raw)))
        except ValueError:
            self._quiesce_cooldown_s = 30.0

    @property
    def _proj(self):
        """Transparent access to the projection graph.

        When projection_mode is "in_source", AGGREGATED edges live in the
        same graph as source data. When "dedicated", they go to a separate
        graph key (e.g. nexus_lineage_proj) on the same Redis instance.
        """
        if self._projection_mode == "dedicated" and self._proj_graph is not None:
            return self._proj_graph
        return self._graph

    def inflight_ops(self) -> int:
        """Number of guarded graph ops currently executing. The manager uses
        this to avoid closing a provider mid-job during recovery eviction."""
        return self._inflight

    async def preflight(self, *, deadline_s: float = 1.5):
        """Fast reachability probe — TCP connect + Redis PING within
        ``deadline_s``. Does NOT touch the production pool, does NOT run
        any DDL. Returns a ``PreflightResult``; never raises for network
        failure.

        The ``/test`` admin endpoint and the manager's preflight gate
        invoke this before any expensive driver work, so an unreachable
        host fails fast (≤1.5s) instead of triggering 30-45s of half-
        blocking init in ``_ensure_connected``.

        P1.6 — credential plumbing: when a username/password is configured,
        ``redis_ping_preflight`` runs ``AUTH`` before ``PING``. Without
        this, an auth-protected FalkorDB would fail preflight with
        NOAUTH and trigger the same false breaker storm we're trying to
        prevent for unreachable hosts. When TLS is enabled, the probe
        completes a real TLS handshake (else a TLS-only server is wrongly
        marked unreachable). For sentinel the probe hits the first configured
        sentinel node (failover is the sentinel pool's job). For CLUSTER the
        probe resolves and pings the node that OWNS this graph — probing only
        an entry node would report healthy while the owning node is dead —
        falling back to the first startup node when discovery fails;
        connect() remains the authoritative topology check.
        """
        from backend.common.interfaces.preflight import (
            redis_ping_preflight, is_auth_reachable_reason,
        )
        from backend.app.providers.falkordb_connection import load_connection_config
        from backend.common.adapters.redis_tls import build_ssl_context

        # Resolve TLS/topology so preflight matches what connect() will use.
        cfg = self._conn_cfg or load_connection_config(
            self._connection_config,
            host=self._host, port=self._port,
            username=self._username, password=self._password,
            tls_enabled=self._tls_enabled,
            credentials=self._credentials,
        )
        # Reachability + AUTH probe. It must be CHEAP and deadline-clean by
        # construction — a health probe must never build a heavyweight client.
        ssl_ctx = build_ssl_context(cfg.tls_settings())

        if cfg.mode == "cluster" and not cfg.cluster_nodes:
            # Cluster mode with no startup nodes is a CONFIG error connect()
            # will also raise. Falling through to a standalone ping of
            # self._host probed the wrong thing entirely — typically localhost
            # — and reported a verdict about a host nobody will dial.
            from backend.common.interfaces.preflight import PreflightResult
            return PreflightResult.failure("cluster_nodes_missing", 0)

        if cfg.mode == "cluster" and cfg.cluster_nodes:
            # Do NOT build a RedisCluster to resolve the owning node here.
            # RedisCluster.initialize() connects to EVERY startup node, verifies
            # full slot coverage and RETRIES, and its aclose() blocks our
            # deadline-cancel — one slow/down node adds ~2s (measured) and under
            # real network latency this overruns the warmup budget, surfacing as
            # 'warmup_wall_clock_exceeded'; on discovery-timeout the old code then
            # pinged cluster_nodes[0], which may itself be the down node
            # ('connect_timeout'). Owning-node discovery is the CONNECT path's
            # job (cached in TopologyGraphClients; a dead slot owner is
            # re-resolved + evicted there). The probe only needs "is the cluster
            # reachable and are the credentials good?" — a raw AUTH+PING to any
            # LIVE startup node answers that, deterministically (self._password,
            # no discovery / no learned-auth strip in the probe path). Try nodes
            # in order so one down node never fails the probe.
            nodes = list(cfg.cluster_nodes)
            per_node = max(0.5, deadline_s / len(nodes))
            result = None
            for node_host, node_port in nodes:
                result = await redis_ping_preflight(
                    node_host, node_port,
                    deadline_s=per_node,
                    username=self._username,
                    password=self._password,
                    ssl_context=ssl_ctx,
                )
                # ok → reachable. A definitive auth verdict (auth_required /
                # auth_failed) is the same on every node — the whole cluster
                # shares ONE credential — so stop rather than retry N nodes.
                if result.ok or is_auth_reachable_reason(result.reason):
                    break
                # else (connect_timeout / refused / dns) this node is down —
                # try the next one.
            return result

        # Standalone pings host:port directly. Sentinel resolves the CURRENT
        # master first (a Sentinel daemon answers PONG while its master is dead);
        # that discovery is a single lightweight query, deadline-bounded, with a
        # fallback to the first sentinel node.
        host, port = self._host, self._port
        discover = None
        probe_username, probe_password = self._username, self._password
        probe_ssl = ssl_ctx
        if cfg.mode == "sentinel" and cfg.sentinel_nodes:
            host, port = cfg.sentinel_nodes[0]
            from backend.app.providers.falkordb_connection import (
                _sentinel_auth_kwargs,
                resolve_sentinel_master,
            )
            # The FALLBACK target is a Sentinel DAEMON: its own auth and its own
            # TLS listener, not the data plane's. Probing it with the graph
            # password / graph TLS context reported auth_failed or a garbled
            # handshake against a perfectly healthy tier on any deployment where
            # the two differ (e.g. TLS data plane + plaintext sentinels).
            # Discovery socket budget: the 1.0s floor false-failed discovery on
            # a >1s-RTT sentinel tier, silently downgrading the probe to a
            # daemon PING (a dead master read green). A provider's
            # connectTimeout raises it, capped by the preflight deadline.
            discover_s = min(deadline_s, max(1.0, cfg.socket_connect_timeout or 1.0))
            sentinel_kw = _sentinel_auth_kwargs(cfg, discover_s)
            probe_username = sentinel_kw.get("username")
            probe_password = sentinel_kw.get("password")
            probe_ssl = build_ssl_context(cfg.sentinel_tls_settings())
            discover = resolve_sentinel_master(cfg, discover_s)

        if discover is not None:
            started = time.monotonic()
            try:
                host, port = await asyncio.wait_for(
                    discover, timeout=max(0.5, deadline_s * 0.6),
                )
                # Discovery succeeded → the probe target is the MASTER: back to
                # data-plane credentials and data-plane TLS.
                probe_username, probe_password = self._username, self._password
                probe_ssl = ssl_ctx
            except Exception:
                pass
            deadline_s = max(0.3, deadline_s - (time.monotonic() - started))
        return await redis_ping_preflight(
            host, port,
            deadline_s=deadline_s,
            username=probe_username,
            password=probe_password,
            ssl_context=probe_ssl,
            # Standalone mode against a cluster-enabled node silently sees only
            # one node's graphs — surface it as a config verdict here (the /test
            # wizard and discovery last_error both carry preflight reasons).
            # Sentinel targets are never cluster nodes; cluster mode never
            # reaches this call.
            detect_cluster=(cfg.mode == "standalone"),
        )

    def _build_pool_kwargs(self, socket_timeout: float) -> dict:
        """Graph connection-pool kwargs (sizing + timeouts + auth). TLS is
        applied inside the connection factory (raw pools need
        ``connection_class=SSLConnection``). Shared by the initial connect and
        the failover rebuild so the two can never drift apart."""
        graph_pool_size = (
            (self._conn_cfg.graph_pool_size if self._conn_cfg else None)
            or int(os.getenv("FALKORDB_GRAPH_POOL_SIZE", "24"))
        )
        from backend.app.providers.falkordb_connection import resilient_pool_kwargs

        kw: dict = {
            "max_connections": graph_pool_size,
            "decode_responses": True,
            **resilient_pool_kwargs(
                socket_timeout=socket_timeout,
                connect_timeout=(
                    self._conn_cfg.socket_connect_timeout if self._conn_cfg else None
                ),
            ),
        }
        # P1.6 — auth so the pool issues AUTH transparently (else NOAUTH is
        # mis-classified as a network failure and trips a false breaker).
        if self._username:
            kw["username"] = self._username
        if self._password:
            kw["password"] = self._password
        return kw

    async def _build_and_verify(self, graph_pool_kwargs: dict, init_timeout: float) -> None:
        """Build the graph client (+ the dedicated projection client on cluster),
        select the graphs, and verify the pool with ONE bounded connection-level
        PING. Shared by the initial connect and both auth-renegotiation rebuilds
        in ``_ensure_connected`` so the three paths can never drift apart.

        The verify is a Redis PING, never a GRAPH query: a read-only graph query
        raises "empty key" on a never-created graph (false "provider down"), and
        a read-write one would lazily create an empty graph key per probe.
        """
        from redis.asyncio import Redis
        from backend.app.providers.falkordb_connection import (
            build_graph_client,
            verify_not_cluster_node,
        )

        self._db, self._pool = await build_graph_client(
            self._conn_cfg,
            graph_name=self._graph_name,
            pool_kwargs=graph_pool_kwargs,
        )
        self._graph = self._db.select_graph(self._graph_name)
        # Projection graph for dedicated mode. On a Redis Cluster,
        # {graph}_proj may hash to a DIFFERENT shard than {graph}, so route it
        # through its own owning-node client; else it shares the same client.
        if self._projection_mode == "dedicated":
            proj_name = f"{self._graph_name}_proj"
            if self._conn_cfg.mode == "cluster":
                self._proj_db, self._proj_pool = await build_graph_client(
                    self._conn_cfg,
                    graph_name=proj_name,
                    pool_kwargs=graph_pool_kwargs,
                )
                self._proj_graph = self._proj_db.select_graph(proj_name)
            else:
                self._proj_db = self._db
                self._proj_graph = self._db.select_graph(proj_name)
        await asyncio.wait_for(
            Redis(connection_pool=self._pool).ping(),
            timeout=init_timeout,
        )
        # Standalone config against a cluster-enabled node would silently see
        # only one node's graphs — fail loud at build time (no-op otherwise).
        await verify_not_cluster_node(self._conn_cfg, self._pool, init_timeout)

    async def _ensure_connected(self):
        """Lazy connection to FalkorDB.

        Schema reconciliation (``ensure_indices``, ``ensure_projections``)
        is intentionally NOT run here — it is dispatched as a fire-and-
        forget background task on first successful connect so a slow DDL
        sweep cannot extend the request-path budget. See
        ``_schedule_reconcile_once`` below.
        """
        if self._graph is not None:
            return
        # WS0.1 connect cooldown: if a very recent connect attempt already
        # failed, fast-fail (<1ms) instead of re-paying the full
        # socket_connect_timeout. Without this, a single request's ontology
        # introspection (4-5 queries) + read + retries each re-probe an
        # unreachable/blackhole host and the request takes tens of seconds to
        # 503. The first attempt after the window lapses is allowed through.
        _now = time.monotonic()
        if _now < self._connect_cooldown_until:
            from redis.exceptions import ConnectionError as _RedisConnErr
            raise _RedisConnErr(
                f"FalkorDB {self._graph_name}: unreachable "
                f"(connect cooldown {self._connect_cooldown_until - _now:.1f}s)"
            )
        try:
            # Non-blocking ConnectionPool: on exhaustion raises ConnectionError
            # immediately instead of blocking the caller (and, for asyncio
            # BlockingConnectionPool, stalling the event loop while waiting
            # on a semaphore inside the loop itself). The circuit-breaker
            # proxy around this provider translates the failure into
            # ProviderUnavailable before it reaches the web tier.
            from backend.app.providers.falkordb_connection import (
                load_connection_config,
                build_cache_client,
            )

            # Resolve the connection topology (standalone / sentinel /
            # cluster). Default mode is standalone → byte-for-byte the
            # legacy single-host path. Sentinel/Cluster route via the
            # connection factory's adapter (the FalkorDB client only
            # accepts ``connection_pool=``). A single FalkorDB graph key
            # lives on one node, so cluster mode routes to the owning node.
            # tls_enabled (+ falkordbConnection.tls) gives TLS/mTLS in every
            # mode; resolved into self._conn_cfg so preflight/cache reuse it.
            self._conn_cfg = load_connection_config(
                self._connection_config,
                host=self._host, port=self._port,
                username=self._username, password=self._password,
                tls_enabled=self._tls_enabled,
                credentials=self._credentials,
            )
            socket_timeout = self._graph_socket_timeout()
            # The graph-pool socket timeout bounds a single Cypher query
            # (floored above the server's TIMEOUT_MAX — see
            # _graph_socket_timeout). Auth + TLS are applied inside the
            # connection factory (TLS via connection_class=SSLConnection on
            # the raw pools); pool_kwargs carries only sizing/timeouts/auth/
            # decode. Built once here and reused verbatim on failover rebuild.
            _graph_pool_kwargs = self._build_pool_kwargs(socket_timeout)
            if self._conn_cfg.mode != "standalone":
                logger.info(
                    "FalkorDB provider connecting graph %r via %s",
                    self._graph_name, self._conn_cfg.describe(),
                )
            # Redis for non-graph ops (caching, materialization tracking,
            # ancestor chains, stats). Resolved centrally via the CACHE role
            # (``build_cache_client``): the provider's own
            # ``extra_config.cacheConnection`` + encrypted cache_* credentials
            # win, else the global ``REDIS_CACHE_*`` endpoint, else the legacy
            # ``CACHE_REDIS_URL`` env. ALWAYS a DEDICATED endpoint with its OWN
            # auth and its OWN TLS — never inherited from FalkorDB (that
            # inheritance used to silently produce "no TLS" or "system trust
            # store" depending on the cache URL's scheme). ``None`` means no
            # cache is configured anywhere → cache DISABLED; the cache is never
            # co-located on the FalkorDB instance (ADR-020).
            from backend.common.adapters import TimeoutRedis
            redis_op_timeout = float(os.getenv("FALKORDB_REDIS_OP_TIMEOUT", "3"))
            # P2.3 — cache Redis is a BEST-EFFORT dependency. Wrapped in
            # its own try/except so an unreachable cache Redis sets
            # ``self._redis_available=False`` and degrades gracefully
            # instead of taking the whole provider down. Graph queries
            # (the load-bearing path) still work; cache misses just go
            # to the source. Without this, a cache Redis outage kills
            # FalkorDB availability even when FalkorDB itself is healthy.
            self._redis_available = True
            try:
                _raw_redis = build_cache_client(
                    provider_id=self._provider_id or "env",
                    extra_config=self._extra_config,
                    credentials=self._credentials,
                )
                self._redis_pool = None
                # Wrap in TimeoutRedis — every async call and pipeline.execute()
                # automatically gets an asyncio.wait_for() deadline. No call-site
                # wrapping needed. See backend/common/adapters/timeout_redis.py.
                if _raw_redis is None:
                    # No cache endpoint configured anywhere → degrade.
                    logger.warning(
                        "FalkorDB provider %r: no cache Redis configured — "
                        "ancestor/URN caches disabled (DEGRADED, graph queries "
                        "unaffected). Configure REDIS_CACHE_* / "
                        "extra_config.cacheConnection to enable caching.",
                        self._graph_name,
                    )
                    self._redis = None
                    self._redis_available = False
                else:
                    self._redis = TimeoutRedis(_raw_redis, timeout=redis_op_timeout)
            except Exception as exc:
                # Cache Redis construction failed. Provider continues
                # without cache; queries are slower but available.
                logger.warning(
                    "FalkorDB cache Redis unavailable (%s) — provider running "
                    "in cache-disabled mode (DEGRADED).", exc,
                )
                self._redis = None
                self._redis_available = False
            # Build graph client(s) + verify with one bounded PING (see
            # _build_and_verify — if the verify fails, the connect failed and
            # the caller's circuit breaker records it).
            from backend.app.providers.falkordb_connection import connect_verify_budget

            _init_timeout = connect_verify_budget(
                self._conn_cfg, float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
            )
            try:
                await self._build_and_verify(_graph_pool_kwargs, _init_timeout)
            except Exception as _auth_exc:
                from backend.app.providers.falkordb_connection import (
                    is_auth_not_configured_error,
                    is_auth_required_error,
                    mark_instance_unauthenticated,
                    normalize_credentials,
                    raise_auth_config_error,
                    strip_credentials,
                    unmark_instance_unauthenticated,
                )

                if is_auth_not_configured_error(_auth_exc) and (
                    self._username or self._password
                ):
                    # The instance has NO authentication configured but this provider
                    # carries credentials (a stale password on the row, or auth turned
                    # off on the server). Reconnect WITHOUT them rather than reporting
                    # a healthy graph as down; the lesson is remembered for every other
                    # connection to this instance.
                    logger.warning(
                        "FalkorDB at %s has NO authentication configured but this "
                        "provider carries credentials — reconnecting without them.",
                        self._conn_cfg.describe(),
                    )
                    mark_instance_unauthenticated(self._conn_cfg)
                    self._conn_cfg = strip_credentials(self._conn_cfg)
                    self._username = None
                    self._password = None
                    await self._build_and_verify(
                        self._build_pool_kwargs(socket_timeout), _init_timeout,
                    )
                elif (
                    is_auth_required_error(_auth_exc)
                    and self._auth_enabled
                    and not (self._username or self._password)
                    and (
                        self._credentials.get("username")
                        or self._credentials.get("password")
                    )
                ):
                    # The mirror case: NOAUTH on a connect we made WITHOUT
                    # credentials while the row HAS them — the self-heal above
                    # nulled them earlier (instance was unauthenticated then) and
                    # authentication has since been re-enabled on the server.
                    # Restore the row credentials, un-learn, rebuild once WITH
                    # them; a second auth failure is a clean config error, so
                    # this can never loop.
                    logger.warning(
                        "FalkorDB at %s now REQUIRES authentication (it was "
                        "previously observed unauthenticated) — reconnecting with "
                        "the provider's saved credentials.",
                        self._conn_cfg.describe(),
                    )
                    unmark_instance_unauthenticated(self._conn_cfg)
                    self._username, self._password = normalize_credentials(
                        self._credentials.get("username"),
                        self._credentials.get("password"),
                    )
                    self._conn_cfg = load_connection_config(
                        self._connection_config,
                        host=self._host, port=self._port,
                        username=self._username, password=self._password,
                        tls_enabled=self._tls_enabled,
                        credentials=self._credentials,
                    )
                    try:
                        await self._build_and_verify(
                            self._build_pool_kwargs(socket_timeout), _init_timeout,
                        )
                    except Exception as _auth_exc2:
                        raise_auth_config_error(self._conn_cfg, _auth_exc2)
                        raise
                else:
                    # NOAUTH (instance wants credentials we lack) or WRONGPASS
                    # (credentials rejected) → a CONFIGURATION error, not an outage:
                    # raising ProviderConfigurationError keeps the breaker closed and
                    # tells the operator what to fix. Anything else propagates as-is.
                    raise_auth_config_error(self._conn_cfg, _auth_exc)
                    raise

            # Schema reconciliation runs OFF the request path. Fire-and-
            # forget background task; failures are logged but do not affect
            # connect outcome. Subsequent connects are no-ops because of the
            # ``_graph is not None`` guard above, so reconcile fires once
            # per provider instance, not once per query.
            self._schedule_reconcile_once()

            # Optional lazy seed (cheap when graph is non-empty; bounded by
            # the same init_timeout for the count query).
            if self._seed_file:
                count_result = await asyncio.wait_for(
                    self._graph.ro_query("MATCH (n) RETURN count(n) AS c", params={}),
                    timeout=_init_timeout,
                )
                if count_result.result_set and count_result.result_set[0][0] == 0:
                    await self._seed_from_file()
        except Exception as e:
            logger.error(f"FalkorDB connection failed: {e}")
            # WS0.1: arm the connect cooldown so the rest of this request's
            # queries (and immediately-following requests) fast-fail instead of
            # each re-paying the connect timeout against an unreachable host.
            self._connect_cooldown_until = time.monotonic() + self._connect_cooldown_s
            # Roll back any half-initialised graph state so a FAILED connect
            # does not leave a zombie handle. self._graph is assigned (line
            # above) BEFORE the verifying PING, so without this the
            # ``_graph is not None`` guard at the top of this method would make
            # every later call believe it is connected, skip reconnect, and
            # hammer a dead handle through the transient-retry stack
            # (~8-12s/call) instead of failing clean (~2-3s) and letting the
            # circuit breaker open. Next call does a fresh connect attempt.
            self._graph = None
            self._db = None
            self._proj_graph = None
            self._proj_db = None
            raise

    def _schedule_reconcile_once(self) -> None:
        """Schedule ``ensure_indices`` + ``ensure_projections`` as a
        background task. Idempotent — guarded by ``_reconcile_started``.

        Failures are logged at WARNING and do NOT raise into the connect
        path. The next call requiring a missing index will surface a
        logical error from the query, which is the correct signal — not
        a 30-45s connect-time stall.
        """
        if getattr(self, "_reconcile_started", False):
            return
        self._reconcile_started = True

        async def _run():
            try:
                await self.ensure_indices()
                await self.ensure_projections()
                logger.info("FalkorDB reconcile complete (host=%s port=%s)", self._host, self._port)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "FalkorDB reconcile failed (host=%s port=%s): %s — provider remains usable",
                    self._host, self._port, exc,
                )

        # Detach the task — we don't await it. Hold a reference to prevent
        # GC under Python's "task may be GC'd before completion" rule.
        self._reconcile_task = asyncio.create_task(
            _run(), name=f"falkordb-reconcile-{self._host}:{self._port}"
        )

    # ── Timeout-guarded query helpers ────────────────────────────────
    # Every Cypher query routed through these methods gets an
    # asyncio.wait_for() deadline. TimeoutError is a network-class
    # exception — the CircuitBreakerProxy counts it toward the failure
    # budget and opens the breaker after fail_max consecutive failures.
    # Sourced from app.config.resilience so a single env var
    # (FALKORDB_QUERY_TIMEOUT / FALKORDB_WRITE_TIMEOUT) tunes every
    # consumer rather than each module reading os.getenv directly.
    from ..config import resilience as _resilience
    _READ_TIMEOUT = _resilience.FALKORDB_QUERY_TIMEOUT_SECS
    _WRITE_TIMEOUT = _resilience.FALKORDB_WRITE_TIMEOUT_SECS
    _EDGES_BETWEEN_TIMEOUT = _resilience.FALKORDB_EDGES_BETWEEN_TIMEOUT_SECS
    del _resilience

    # FalkorDB engine cancels the query 500ms before the asyncio deadline so
    # the DB-side cancel races first (frees the worker thread + the pool
    # connection); asyncio.wait_for is the safety net for socket-level hangs.
    #
    # Clamped to the server's TIMEOUT_MAX: FalkorDB REJECTS (never runs) a
    # query whose TIMEOUT parameter exceeds it, so an over-budget caller
    # (e.g. the insights materialization's 600s) must degrade to "run for
    # up to TIMEOUT_MAX" rather than fail instantly with "The query TIMEOUT
    # parameter value cannot exceed the TIMEOUT_MAX configuration parameter".
    @staticmethod
    def _db_timeout_ms(seconds: float) -> int:
        from ..config import resilience
        ms = max(500, int(seconds * 1000) - 500)
        cap = resilience.FALKORDB_SERVER_TIMEOUT_MAX_MS
        if cap > 0:
            ms = min(ms, cap)
        return ms

    def _graph_socket_timeout(self) -> float:
        """Socket recv/send timeout for the GRAPH query pools.

        Floored above the server's TIMEOUT_MAX: the redis client applies
        ``socket_timeout`` to each ``read_response``, and a long-running
        Cypher query sends no bytes until it completes — a socket timeout
        below the query budget kills legitimate queries mid-flight. The
        hang-net role the low per-tier value played is preserved by the
        per-call ``asyncio.wait_for`` in ``_ro_query``/``_query``, which
        bounds every call at its own (much smaller) budget regardless of
        socket state.
        """
        from ..config import resilience
        configured = (
            (self._conn_cfg.socket_timeout if self._conn_cfg else None)
            or float(os.getenv("FALKORDB_SOCKET_TIMEOUT", "10"))
        )
        cap_ms = resilience.FALKORDB_SERVER_TIMEOUT_MAX_MS
        if cap_ms <= 0:
            return configured
        return max(configured, cap_ms / 1000.0 + 15.0)

    async def _rebuild_graph_client_for_failover(self, seen_generation: int) -> None:
        """Re-resolve and rebuild the FalkorDB client(s) after a cluster
        MOVED / connection drop. Coalesced: if another task already
        rebuilt past ``seen_generation`` we no-op. In cluster mode this
        re-discovers the node owning the graph key; in sentinel/standalone
        it reconnects against the (possibly newly-promoted) master/host.
        """
        if self._conn_cfg is None:
            return
        async with self._failover_lock:
            if seen_generation != self._conn_generation:
                return  # someone else already rebuilt for this failure
            from backend.app.providers.falkordb_connection import (
                build_graph_client, aclose_graph_client,
            )

            socket_timeout = self._graph_socket_timeout()
            # Same kwargs as the initial connect (auth; TLS re-applied inside
            # the factory) so failover never drops credentials or TLS.
            pool_kwargs = self._build_pool_kwargs(socket_timeout)

            old_pool, old_proj_pool = self._pool, self._proj_pool
            old_db, old_proj_db = self._db, self._proj_db
            self._db, self._pool = await build_graph_client(
                self._conn_cfg, graph_name=self._graph_name, pool_kwargs=pool_kwargs,
            )
            self._graph = self._db.select_graph(self._graph_name)
            if self._projection_mode == "dedicated":
                proj_name = f"{self._graph_name}_proj"
                if self._conn_cfg.mode == "cluster":
                    self._proj_db, self._proj_pool = await build_graph_client(
                        self._conn_cfg, graph_name=proj_name, pool_kwargs=pool_kwargs,
                    )
                    self._proj_graph = self._proj_db.select_graph(proj_name)
                else:
                    self._proj_db = self._db
                    self._proj_graph = self._db.select_graph(proj_name)
            self._conn_generation += 1
            logger.warning(
                "FalkorDB %s: rebuilt client after failover (generation %d, %s).",
                self._graph_name, self._conn_generation, self._conn_cfg.describe(),
            )
            # Best-effort close of superseded clients AND pools. Closing the pool
            # alone is not enough in cluster mode: the client is a RedisCluster
            # holding a pool PER node, which the pinned pool does not own. In-flight
            # ops on them either complete or fail and are retried by _run_guarded.
            for old_d, old_p in ((old_db, old_pool), (old_proj_db, old_proj_pool)):
                if old_d is self._db or old_d is self._proj_db:
                    old_d = None            # still in use — rebuilt to the same object
                if old_p is self._pool or old_p is self._proj_pool:
                    old_p = None
                await aclose_graph_client(old_d, old_p)

    async def _run_guarded(self, call: Callable[[], Awaitable[Any]]) -> Any:
        """Execute a graph call with transparent retries for transient
        failures so the circuit breaker stays closed on blips.

        Two failure classes are absorbed:

        * **Transient connection drops** (redis ``ConnectionError`` /
          ``TimeoutError``, e.g. 'Connection reset by peer' under FalkorDB
          memory pressure) — retried with a short backoff in ALL modes.
          redis-py hands out a fresh pooled connection on the next call, so
          the retried op succeeds once FalkorDB recovers. Reads are
          idempotent; a retried write/flush re-applies at most one chunk's
          weight via MERGE ON MATCH (bounded, self-healing). In CLUSTER
          mode the second and later retries escalate to a full topology
          re-resolve (see below): a silently-dead owning node (rotated pod,
          new address) never answers MOVED, so redialing the pinned address
          would otherwise fail forever.
        * **Cluster routing changes** (Moved/Ask/ClusterDown) — only in
          cluster mode: rebuild the single-node client (re-resolve the key
          owner) and retry.

        ``call`` must reference ``self._graph`` / ``self._proj`` lazily so a
        retry after a rebuild picks up the new client. A non-transient query
        error propagates immediately. Retries run inside the caller's per-op
        ``asyncio.wait_for`` budget and query semaphore, so they still count
        against the concurrency cap; only ``asyncio.TimeoutError`` (the
        per-op deadline) is never retried.
        """
        attempt = 0
        max_retries = len(_TRANSIENT_RETRY_BACKOFFS)
        # In-flight op count: the manager's recovery-eviction defers close()
        # while this is > 0 so it can't tear the pool out from under a job.
        self._inflight += 1
        try:
            while True:
                try:
                    return await call()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # FalkorDB is loading its RDB into memory on restart — a
                    # transient "warming up" state, not an outage. Fast-fail
                    # with ProviderLoading (a logical/ignored signal, so the
                    # breaker stays CLOSED and this instance recovers the moment
                    # its load finishes) instead of retrying for ~1.75s and then
                    # tripping the breaker on a load that takes many seconds.
                    # The caller (FE) polls per the Retry-After hint.
                    if _is_loading_error(exc):
                        from backend.common.adapters import ProviderLoading
                        raise ProviderLoading(
                            provider_name=self._graph_name,
                            reason="graph is starting up (loading dataset into memory)",
                            retry_after_seconds=5,
                        ) from exc
                    cluster = (
                        self._conn_cfg is not None
                        and self._conn_cfg.mode == "cluster"
                    )
                    # Cluster slot moved → rebuild the single-node client, retry.
                    if cluster and _is_cluster_routing_error(exc):
                        if attempt >= max_retries:
                            raise
                        gen = self._conn_generation
                        attempt += 1
                        logger.warning(
                            "FalkorDB %s: cluster redirect (%s) — rebuilding "
                            "client and retrying (%d/%d).",
                            self._graph_name, type(exc).__name__,
                            attempt, max_retries,
                        )
                        await self._rebuild_graph_client_for_failover(gen)
                        continue
                    # Transient connection drop (any mode) OR a graph handle that
                    # was nulled mid-flight (evicted/closed by the manager's
                    # recovery path during this retry) → rebuild the client and
                    # retry within budget. _ensure_connected is a no-op when the
                    # handle is still live (redis-py self-heals the pool) and a
                    # full rebuild when close() nulled it.
                    handle_lost = _is_null_handle_error(exc)
                    if (handle_lost or _is_transient_connection_error(exc)) and attempt < max_retries:
                        backoff = _TRANSIENT_RETRY_BACKOFFS[attempt]
                        attempt += 1
                        # Cluster: the pinned single-node pool redials the SAME
                        # address, so once a plain redial has also failed
                        # (attempt 2+) assume the owning node is gone — a
                        # rotated pod comes back at a NEW address and a dark
                        # node never answers MOVED — and re-resolve the
                        # topology (finds the promoted replica) instead of
                        # redialing a corpse. The first retry stays the cheap
                        # redial: it absorbs same-node blips (reset-by-peer)
                        # without pool churn.
                        reresolve = cluster and not handle_lost and attempt >= 2
                        logger.warning(
                            "FalkorDB %s: %s (%s) — %s + retry %d/%d after %.2fs.",
                            self._graph_name,
                            "lost graph handle" if handle_lost else "transient connection error",
                            type(exc).__name__,
                            "cluster topology re-resolve" if reresolve else "reconnect",
                            attempt, max_retries, backoff,
                        )
                        try:
                            if reresolve:
                                await self._rebuild_graph_client_for_failover(
                                    self._conn_generation
                                )
                            else:
                                await self._ensure_connected()
                        except Exception as reconnect_exc:
                            # If FalkorDB is loading (RDB replay) during the
                            # reconnect, surface the retryable warming signal
                            # rather than a hard failure that steps the breaker.
                            if _is_loading_error(reconnect_exc):
                                from backend.common.adapters import ProviderLoading
                                raise ProviderLoading(
                                    provider_name=self._graph_name,
                                    reason="graph is starting up (loading dataset into memory)",
                                    retry_after_seconds=5,
                                ) from reconnect_exc
                            # Reconnect failed → the host is unreachable, not a
                            # transient blip. Stop retrying and surface the
                            # failure now so the breaker opens fast instead of
                            # burning the remaining retries (each a fresh ~2-3s
                            # connect attempt) against a dead host.
                            logger.warning(
                                "FalkorDB %s: reconnect during retry failed (%s) — "
                                "treating as unreachable, not retrying.",
                                self._graph_name, reconnect_exc,
                            )
                            raise reconnect_exc from exc
                        await asyncio.sleep(backoff)
                        continue
                    raise
        finally:
            self._inflight -= 1

    async def _guarded_timed(
        self,
        runner: Callable[[], Awaitable[Any]],
        *,
        kind: str,
        cypher: str,
        op: Optional[str],
        budget: float,
    ):
        """Semaphore + guard + slow-query telemetry for every Cypher.

        Emits one WARNING line when DB execution OR semaphore-queue wait
        exceeds ``FALKORDB_SLOW_QUERY_MS``. The two durations are reported
        separately on purpose: ``queue_ms`` is the saturation signal (work
        waiting for a slot), ``query_ms`` attributes cost to the query
        shape. Zero overhead below the threshold beyond three monotonic
        reads; never raises from the logging path.
        """
        from ..config.resilience import FALKORDB_SLOW_QUERY_MS

        queued_at = time.monotonic()
        async with self._query_semaphore:
            started = time.monotonic()
            rows: Optional[int] = None
            err: Optional[str] = None
            try:
                result = await self._run_guarded(runner)
                rs = getattr(result, "result_set", None)
                rows = len(rs) if rs is not None else 0
                return result
            except Exception as exc:
                err = type(exc).__name__
                raise
            finally:
                try:
                    query_ms = int((time.monotonic() - started) * 1000)
                    queue_ms = int((started - queued_at) * 1000)
                    if max(query_ms, queue_ms) >= FALKORDB_SLOW_QUERY_MS:
                        logger.warning(
                            "falkordb slow %s: graph=%s op=%s query_ms=%d queue_ms=%d "
                            "budget_s=%.1f rows=%s err=%s cypher=%.80s",
                            kind, self._graph_name, op or "-", query_ms, queue_ms,
                            budget, "-" if rows is None else rows, err or "-",
                            " ".join(cypher.split()),
                        )
                except Exception:  # pragma: no cover — telemetry must not mask results
                    pass

    async def _ro_query(self, cypher: str, params: dict = None, *, timeout: float = None,
                        op: Optional[str] = None):
        """Timeout-guarded read-only query on the source graph."""
        t = timeout if timeout is not None else self._READ_TIMEOUT

        async def _call():
            return await asyncio.wait_for(
                self._graph.ro_query(cypher, params=params or {}, timeout=self._db_timeout_ms(t)),
                timeout=t,
            )

        return await self._guarded_timed(_call, kind="ro", cypher=cypher, op=op, budget=t)

    async def _empty_key_is_genuine(self) -> bool:
        """Whether an "Invalid graph operation on empty key" really means the
        graph is empty.

        Standalone/Sentinel: yes — one endpoint serves every key, so the error
        can only mean the graph key does not exist yet.

        Cluster: verify before believing it. The SAME error comes back when a
        read lands on a node that does not hold the graph key — a stale pinned
        handle after a slot migration, or a replica promoted without its
        shard's data — and masking that as "0 nodes / 0 edges" is how a graph
        silently reads as empty on one pod while another still shows data. A
        slot-routed EXISTS through the cluster client asks the CURRENT owner:
        0 → genuinely absent (mask as empty); 1 → the graph exists and the
        empty read was a misroute (fail loud); probe error → fail loud, never
        mask on an unhealthy cluster.
        """
        if self._conn_cfg is None or self._conn_cfg.mode != "cluster":
            return True
        try:
            exists = await asyncio.wait_for(
                self._db.execute_command("EXISTS", self._graph_name),
                timeout=float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
            )
        except Exception as probe_exc:
            logger.warning(
                "empty-key verification: EXISTS probe for %r failed (%s) — "
                "treating the empty read as UNVERIFIED and failing loud.",
                self._graph_name, probe_exc,
            )
            return False
        if int(exists or 0) == 0:
            return True
        logger.warning(
            "empty-key verification: graph %r EXISTS on the cluster but a read "
            "reported 'empty key' — the read landed on a node that does not "
            "hold the graph (stale routing or an unsynced promotee). Failing "
            "loud and rebuilding the client.", self._graph_name,
        )
        # Heal, don't just detect: the client that produced the misroute stays
        # cached otherwise (the bare ResponseError is not classified as a
        # routing error, so _run_guarded never rebuilds for it) and every
        # subsequent read keeps failing until an unrelated MOVED or a restart.
        # The rebuild re-resolves the owning node; the CURRENT read still
        # raises (fail loud), the next one uses the fresh route.
        try:
            await self._rebuild_graph_client_for_failover(self._conn_generation)
        except Exception:                            # pragma: no cover - best effort
            logger.warning(
                "empty-key verification: client rebuild after stale-route "
                "detection failed for %r.", self._graph_name, exc_info=True,
            )
        return False

    async def _is_verified_missing_graph(self, exc: BaseException) -> bool:
        """The ONLY predicate that may mask an 'empty key' error as an empty
        graph: matches the error AND (in cluster mode) verifies via EXISTS that
        the graph is genuinely absent. Every masking site calls this — a bare
        ``_is_missing_graph_error`` check silently converts a cluster misroute
        into '0 rows'."""
        return _is_missing_graph_error(exc) and await self._empty_key_is_genuine()

    async def _ro_query_tolerant(self, cypher: str, params: dict = None, *, timeout: float = None,
                                 op: Optional[str] = None):
        """Like :meth:`_ro_query`, but a missing/empty graph yields an empty
        result set instead of raising. For introspection reads where an empty
        graph is a valid 0-result state (the graph key may not exist yet).
        On a cluster the empty-key signal is verified first — see
        :meth:`_empty_key_is_genuine`."""
        try:
            return await self._ro_query(cypher, params=params, timeout=timeout, op=op)
        except Exception as exc:
            if await self._is_verified_missing_graph(exc):
                return _EmptyResult()
            raise

    async def _query(self, cypher: str, params: dict = None, *, timeout: float = None,
                     op: Optional[str] = None):
        """Timeout-guarded write query on the source graph."""
        t = timeout if timeout is not None else self._WRITE_TIMEOUT

        async def _call():
            return await asyncio.wait_for(
                self._graph.query(cypher, params=params or {}, timeout=self._db_timeout_ms(t)),
                timeout=t,
            )

        return await self._guarded_timed(_call, kind="write", cypher=cypher, op=op, budget=t)

    async def _proj_ro_query(self, cypher: str, params: dict = None, *, timeout: float = None,
                             op: Optional[str] = None):
        """Timeout-guarded read-only query on the projection graph."""
        t = timeout if timeout is not None else self._READ_TIMEOUT

        async def _call():
            return await asyncio.wait_for(
                self._proj.ro_query(cypher, params=params or {}, timeout=self._db_timeout_ms(t)),
                timeout=t,
            )

        return await self._guarded_timed(_call, kind="proj-ro", cypher=cypher, op=op, budget=t)

    def _quiesce_p95(self) -> float:
        """p95 of the rolling write-latency window (seconds). 0 if window empty."""
        if not self._write_latency_window:
            return 0.0
        sorted_lat = sorted(self._write_latency_window)
        idx = int(0.95 * (len(sorted_lat) - 1))
        return sorted_lat[idx]

    def _check_quiesce_gate(self) -> None:
        """Raise ``ProviderBusy`` if quiesce is active. Phase 2.

        Called at the entry of every write before doing any I/O. The
        check is monotonic-time based so a clock change doesn't
        accidentally unfreeze a quiesced provider.
        """
        if self._quiesce_until_monotonic <= 0.0:
            return
        now = time.monotonic()
        remaining = self._quiesce_until_monotonic - now
        if remaining <= 0:
            # Cooldown elapsed — clear the gate. Latency window stays;
            # if the underlying issue persists, it'll re-trip on the
            # next slow write.
            self._quiesce_until_monotonic = 0.0
            self._write_latency_window.clear()
            logger.info(
                "FalkorDB %s: quiesce cooldown elapsed, accepting writes again.",
                self._graph_name,
            )
            return
        from backend.common.adapters import ProviderBusy
        raise ProviderBusy(
            provider_name=self._graph_name,
            reason=(
                f"write p95 above {self._quiesce_trigger_s:.1f}s; "
                f"quiesce cooldown {remaining:.0f}s remaining"
            ),
            retry_after_seconds=max(1, int(remaining) + 1),
        )

    def _record_write_latency(self, elapsed_s: float) -> None:
        """Append a write-latency sample and trip quiesce if p95 crossed
        the trigger threshold. Phase 2.
        """
        self._write_latency_window.append(elapsed_s)
        # Only consider tripping once we have enough samples for p95 to
        # be meaningful (avoid one-off slow first call from quiescing
        # the provider). 10 samples is a reasonable floor.
        if len(self._write_latency_window) < 10:
            return
        if self._quiesce_until_monotonic > 0.0:
            return  # already quiesced
        p95 = self._quiesce_p95()
        if p95 > self._quiesce_trigger_s:
            self._quiesce_until_monotonic = (
                time.monotonic() + self._quiesce_cooldown_s
            )
            logger.warning(
                "FalkorDB %s: write p95=%.2fs > trigger %.1fs; entering "
                "quiesce for %.0fs. New writes will raise ProviderBusy "
                "until cooldown elapses.",
                self._graph_name, p95,
                self._quiesce_trigger_s, self._quiesce_cooldown_s,
            )

    async def _proj_query(self, cypher: str, params: dict = None, *, timeout: float = None):
        """Timeout-guarded write query on the projection graph.

        Phase 2: also gated by ``_write_semaphore`` (per-graph hard cap
        on concurrent writes) and the latency-quiesce circuit. Records
        observed latency for the p95 trip decision.
        """
        # Quiesce gate — raises ``ProviderBusy`` if the provider is
        # currently in cooldown after a sustained p95 spike. Worker
        # treats this as park-and-resume (not retry).
        self._check_quiesce_gate()

        t = timeout if timeout is not None else self._WRITE_TIMEOUT

        async def _call():
            t_start = time.monotonic()
            try:
                return await asyncio.wait_for(
                    self._proj.query(
                        cypher, params=params or {},
                        timeout=self._db_timeout_ms(t),
                    ),
                    timeout=t,
                )
            finally:
                # Record latency regardless of success/failure so quiesce
                # trips even when slow writes are also erroring out (the
                # symptom we'd want to back off from).
                self._record_write_latency(time.monotonic() - t_start)

        async with self._write_semaphore:
            async with self._query_semaphore:
                return await self._run_guarded(_call)

    async def _seed_from_file(self):
        """Load graph from seed JSON file if graph is empty."""
        import os as _os
        path = self._seed_file
        if not path or not _os.path.exists(path):
            logger.warning(f"Seed file not found: {path}")
            return
        try:
            with open(path, "r") as f:
                data = json.load(f)
            nodes = [GraphNode(**n) for n in data.get("nodes", [])]
            edges = [GraphEdge(**e) for e in data.get("edges", [])]
            # Limit for large files
            if len(nodes) > 50000:
                nodes = nodes[:50000]
            if len(edges) > 100000:
                edges = edges[:100000]
            await self.save_custom_graph(nodes, edges)
            logger.info(f"Seeded {len(nodes)} nodes and {len(edges)} edges from {path}")
        except Exception as e:
            logger.error(f"Seed failed: {e}")

    async def stamp_identity_urns(self) -> int:
        """Stamp per-source CONFORMANCE properties onto every node that lacks them, so the entire
        urn-keyed write / index / read / trace stack works for an onboarded graph that keys nodes
        by e.g. ``id`` and names them under e.g. ``name`` instead of the platform's ``urn`` /
        ``displayName``.

        This is THE definitive fix. The AGGREGATED write and every read filter on the ``urn``
        PROPERTY (a ``MERGE`` cannot key on a ``coalesce`` expression), and the read stack renders
        ``displayName`` verbatim — so resolving identity only in the aggregation directory left
        in-source aggregation attaching ZERO edges, and a non-``displayName`` name rendered blank.
        Stamping both up front makes all of it work unchanged.

        * ``urn`` ← ``identity_property``  (only when it's a non-default property)
        * ``displayName`` ← ``name_property``  (piggybacks on the urn pass, or runs standalone only
          for a CUSTOM name property — a fully conforming source stays a complete no-op)

        Each stamped value records WHICH property it came from, in ``urnSource`` / ``nameSource``.
        That provenance is what makes the mapping editable rather than write-once: a fill-only pass
        can never rewrite a node it already stamped, so re-pointing a source from ``id`` to ``uuid``
        used to leave every existing node on the OLD identity forever, with no error and no way to
        tell from the graph which nodes were wrong. A node whose marker disagrees with the current
        mapping is now re-stamped from the new property.

        Safe: in-source projection only (never mutates a possibly read-only source behind a
        dedicated projection); a node with NO marker carried its own native ``urn`` /
        ``displayName`` and is never touched, so this can only ever overwrite values it wrote
        itself; batched by internal ID range (no property index needed); best-effort per batch.
        Idempotent — a re-run with an unchanged mapping only touches nodes added since the last
        one. Returns properties stamped.
        """
        ident = str(getattr(self, "_node_identity_property", None) or "urn").replace("`", "")
        name_prop = str(getattr(self, "_name_property", None) or "name").replace("`", "")
        stamp_urn = bool(ident) and ident != "urn"
        # Name-stamp piggybacks on a urn stamp, or runs standalone only for a non-default name
        # property — so a conforming (urn/displayName) source never triggers a write pass.
        stamp_name = bool(name_prop) and name_prop != "displayName" and (stamp_urn or name_prop != "name")
        if not stamp_urn and not stamp_name:
            return 0
        if getattr(self, "_projection_mode", None) == "dedicated":
            return 0  # projection is separate; don't write to the (maybe read-only) source
        await self._ensure_connected()
        try:
            res = await self._ro_query("MATCH (n) RETURN max(ID(n))", op="identity.max_id")
            rows = res.result_set or []
            max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
        except Exception as exc:
            logger.warning(
                "FalkorDB %s: conformance stamp skipped — max-id probe failed: %s",
                self._graph_name, exc,
            )
            return 0
        if max_id < 0:
            return 0

        # Two cases per property:
        #   FILL     — the canonical value is missing, so take it from the source property;
        #   RE-POINT — we filled it before from a DIFFERENT property (the marker says so),
        #              so the mapping changed under us and the old value is stale.
        # A node with no marker and a value present is native data: excluded by both.
        #
        # The two properties are stamped in ONE pass (these are full scans; two passes would
        # double the cost on a multi-million-node graph), which means the WHERE matches a node
        # that qualifies for EITHER. Each SET is therefore guarded by its OWN condition — an
        # unguarded pair would let a node that only needed a displayName fill also have its
        # native urn overwritten.
        sets, wheres = [], []
        if stamp_urn:
            urn_cond = (
                f"((n.`urn` IS NULL OR (n.`urnSource` IS NOT NULL AND n.`urnSource` <> $ident)) "
                f"AND n.`{ident}` IS NOT NULL)"
            )
            sets.append(
                f"n.`urn` = CASE WHEN {urn_cond} THEN n.`{ident}` ELSE n.`urn` END, "
                f"n.`urnSource` = CASE WHEN {urn_cond} THEN $ident ELSE n.`urnSource` END"
            )
            wheres.append(urn_cond)
        if stamp_name:
            name_cond = (
                f"((n.`displayName` IS NULL OR (n.`nameSource` IS NOT NULL "
                f"AND n.`nameSource` <> $nameProp)) AND n.`{name_prop}` IS NOT NULL)"
            )
            sets.append(
                f"n.`displayName` = CASE WHEN {name_cond} THEN n.`{name_prop}` "
                f"ELSE n.`displayName` END, "
                f"n.`nameSource` = CASE WHEN {name_cond} THEN $nameProp ELSE n.`nameSource` END"
            )
            wheres.append(name_cond)
        set_clause = ", ".join(sets)
        where_clause = " OR ".join(wheres)

        width = 50_000
        stamped = 0
        lo = 0
        while lo <= max_id:
            hi = lo + width
            try:
                r = await self._query(
                    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND ({where_clause}) "
                    f"SET {set_clause}",
                    params={
                        "lo": lo, "hi": hi, "ident": ident, "nameProp": name_prop,
                    },
                    op="identity.stamp",
                )
                stamped += int(getattr(r, "properties_set", 0) or 0)
            except Exception as exc:
                logger.warning(
                    "FalkorDB %s: conformance stamp batch [%d,%d) failed (continuing): %s",
                    self._graph_name, lo, hi, exc,
                )
            lo = hi
        if stamped:
            logger.info(
                "FalkorDB %s: conformance stamp set %d propert(y/ies) (urn←%s, displayName←%s).",
                self._graph_name, stamped, ident if stamp_urn else "—",
                name_prop if stamp_name else "—",
            )
        return stamped

    async def ensure_indices(self, entity_type_ids: Optional[List[str]] = None):
        """Create indices for node labels and properties.

        When *entity_type_ids* is provided (e.g. from the resolved ontology),
        those labels are indexed in addition to the hardcoded defaults.

        The label/property policy lives in ``index_policy`` — shared with the
        alignment-analysis endpoint so its performance predictions can never
        drift from what is actually indexed here.
        """
        from backend.app.providers.index_policy import INDEXED_NODE_PROPS, indexed_labels

        labels = indexed_labels(entity_type_ids)
        # Remember the ontology vocabulary the indices were built for, so
        # label-union readers (get_nodes_by_layer) can anchor on the same
        # label set the label-scoped indexes actually cover.
        self._indexed_entity_type_ids = list(entity_type_ids or [])
        # Idempotent CREATE INDEX is fine if the index already exists.
        properties = list(INDEXED_NODE_PROPS)
        # Index the source's URN-equivalent too, so the identity-urn stamp's
        # NULL-urn lookup and any direct property access are index-backed rather
        # than full label scans. No-op when the source uses the default `urn`
        # (already in INDEXED_NODE_PROPS).
        _ident = getattr(self, "_node_identity_property", None)
        if _ident and _ident != "urn" and _ident not in properties:
            properties.append(_ident)

        _init_timeout = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))
        # Failure accounting: "already indexed" is success (idempotent DDL);
        # everything else is collected and reported in ONE warning at the end
        # so a persistently failing CREATE INDEX (unsupported server version,
        # timeouts) is visible instead of silently swallowed. Still
        # best-effort — this method never raises; queries work unindexed.
        failures: list[str] = []

        async def _create_index(cypher: str) -> None:
            try:
                # Server-side timeout too — an abandoned DDL statement
                # must not keep burning FalkorDB CPU after the client
                # deadline fires.
                await asyncio.wait_for(
                    self._graph.query(
                        cypher, timeout=self._db_timeout_ms(_init_timeout),
                    ),
                    timeout=_init_timeout,
                )
            except Exception as exc:
                if "already indexed" in str(exc).lower():
                    return
                failures.append(f"{cypher}: {type(exc).__name__}: {exc}")

        total = 0
        for label in labels:
            for prop in properties:
                total += 1
                await _create_index(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")

        # Edge-property indices on :AGGREGATED powering the level-pair
        # fast path used by ``_expand_aggregated_set``. With these in
        # place, ``WHERE r.sourceLevel = $L AND r.targetLevel = $L``
        # becomes a composite index seek instead of a per-edge property
        # read after the rel-typed MATCH. Idempotent CREATE INDEX, best-
        # effort: older FalkorDB releases may not support edge-property
        # indices, in which case the trace continues to work via the
        # legacy neighbour-label scan fallback.
        # Composite index attempt first — when supported by the FalkorDB
        # version this is a single index seek on (sourceLevel, targetLevel)
        # rather than two single-column lookups OR-merged by the planner.
        # Idempotent; falls back to two single-column indices below if the
        # planner does not support composite edge indices.
        aggregated_edge_indices = [
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceLevel, r.targetLevel)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceLevel)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.targetLevel)",
            # Depth stamps (stampVersion>=2) are the PREFERRED read filters
            # (Q3 mixed-depth derivation, trace structural drill) — without
            # these they run as Conditional Traverse property reads.
            # Verified supported on FalkorDB v4.16.0 (WS0 D1 spike).
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth, r.targetDepth)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.targetDepth)",
        ]
        for index_cypher in aggregated_edge_indices:
            total += 1
            await _create_index(index_cypher)

        if failures:
            logger.warning(
                "ensure_indices: %d/%d index statements failed (queries still "
                "work, unindexed). First failures: %s",
                len(failures), total, "; ".join(failures[:3]),
            )
        else:
            logger.debug("ensure_indices: %d index statements ensured", total)

    @property
    def name(self) -> str:
        return "FalkorDBProvider"

    def set_containment_edge_types(self, types: List[str], from_ontology: bool = True) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        authoritative containment edge types from the resolver.

        Parameters
        ----------
        types : list
            The containment edge types. Empty list means the ontology explicitly
            defines no containment types (flat graph, no hierarchy).
        from_ontology : bool
            True if these came from a real ontology definition (assigned or system).
            False if from introspection-only — an empty list should NOT suppress
            the hardcoded fallback.

        Cache invalidation is implicit: the ancestors cache key
        (``_ancestors_cache_key``) hashes the resolved type set, so a
        change to ``types`` automatically routes reads/writes to a
        different Redis namespace. No manual flush is needed; old
        namespaces are simply unreachable and lazy-evicted by Redis.
        """
        if from_ontology or types:
            self._resolved_containment_types: Set[str] = {t.upper() for t in types}
            self._resolved_containment_types_set = True
        # else: introspection-only with no containment found — don't set sentinel

    def set_entity_type_levels(self, mapping: Dict[str, int]) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        entity-type → hierarchy.level mapping. Used both at write time
        (populates ``n.level`` on upsert for the level index) and at read
        time (resolves levels via ``labels(n)[0]`` so trace queries work
        even when ``n.level`` hasn't been backfilled on existing nodes).

        Also computes a ``levelDigest`` over the map. AGGREGATED edges
        stamp this digest at materialization time; the cold-start probe
        compares stamped digests to the current one to decide whether
        backfill is needed. When the digest changes (ontology edited),
        we re-trigger the probe so the staleness state refreshes without
        a process restart.
        """
        from backend.app.services.ontology_levels import compute_level_digest

        self._entity_type_levels: Dict[str, int] = dict(mapping)
        new_digest = compute_level_digest(self._entity_type_levels)

        if new_digest != self._level_digest:
            self._level_digest = new_digest
            # New digest → re-probe in the background. Don't block here;
            # the probe runs against the graph and we don't want
            # ontology resolution to wait for it.
            try:
                asyncio.create_task(self._check_levels_backfilled())
            except RuntimeError:
                # No running loop (rare — usually only in synchronous
                # test paths). The probe will run on first trace.
                pass

    def _get_node_level(self, entity_type: Any) -> Optional[int]:
        """Resolve a node's hierarchy level from the cached mapping. Returns
        None when ontology hasn't been resolved or the entity type is unknown
        — backfill or read-time fallback handles those cases.
        """
        mapping = getattr(self, "_entity_type_levels", None)
        if not mapping:
            return None
        return mapping.get(str(entity_type))

    # Per-frontier-node AGGREGATED out-degree cap. When a single node has
    # more aggregated peers than this, the BFS keeps the top-N by weight
    # and emits a MegaNodeInfo so the frontend can render a "+N more"
    # chip. Override via env. Default 5000 — high enough that legitimate
    # hub Domains (lots of underlying lineage) aren't truncated.
    TRACE_DEGREE_CAP: int = int(os.getenv("TRACE_DEGREE_CAP", "5000"))

    async def _check_levels_backfilled(self) -> None:
        """Probe: are :AGGREGATED edges stamped with the CURRENT level digest?

        Sets ``self._levels_backfilled`` to ``True | False``:
          - True  → all edges carry ``r.levelDigest == self._level_digest``
                    → the level-pair fast path can be trusted.
          - False → some edges are missing the digest or carry a stale one
                    (ontology drifted) → the trace path falls back to the
                    label-scan codepath for those edges (correct, slower).

        Logs at most once per (provider lifetime, digest) pair via
        ``_levels_warning_for_digest`` — re-runs with the same digest stay
        quiet. A new digest (ontology edit) re-arms the warning.

        Traces are never refused — the legacy label-scan codepath returns
        correct results during backfill windows. Refusing would break every
        trace whenever the ontology changes.

        Best-effort: if the level map hasn't been injected yet, or the
        probe itself fails (FalkorDB not ready), we leave the flag as None
        and a later call will re-probe.
        """
        digest = self._level_digest
        if not digest:
            # No level map yet — backfilled status is undefined.
            return

        try:
            result = await asyncio.wait_for(
                self._graph.query(
                    "MATCH ()-[r:AGGREGATED]->() "
                    "WHERE r.levelDigest IS NULL OR r.levelDigest <> $digest "
                    "RETURN count(r) AS stale LIMIT 1",
                    params={"digest": digest},
                ),
                timeout=3.0,
            )
            rows = getattr(result, "result_set", None) or []
            stale = int(rows[0][0]) if rows and rows[0] else 0
            self._levels_backfilled = (stale == 0)
            if stale > 0 and self._levels_warning_for_digest != digest:
                logger.warning(
                    "trace: %d AGGREGATED edges have stale or missing "
                    "levelDigest (current=%s) — run "
                    "backfill_aggregated_levels.py to refresh stamps",
                    stale, digest[:12],
                )
                self._levels_warning_for_digest = digest
        except Exception as exc:
            logger.warning("trace: levels_backfilled check failed: %s", exc)
            # Leave None — probed again on demand if needed

    async def _resolve_root_anchor(
        self, urn: str, ctypes: List[str],
    ) -> Tuple[str, int]:
        """Walk containment UP to the absolute Root (a node with no incoming
        containment edge). Returns ``(root_urn, root_level)``.

        Used by skeleton-first trace when ``level=0``: regardless of
        starting nesting depth, we end up at the topmost reachable
        ancestor. When no level-0 ancestor exists (orphan), we return
        the highest level actually reached — caller surfaces this as
        ``meta.fallbackLevel``.

        Cycle-safe: the variable-length walk uses a node-uniqueness
        predicate so a self-referencing typedef ``CONTAINS`` edge can't
        cause runaway expansion.
        """
        if not ctypes:
            # No containment configured — focus is its own root.
            return urn, -1

        max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
        # Find topmost containment ancestor — the deepest reachable walk
        # via incoming containment edges. We use `*1..N` (not `*0..N`)
        # because FalkorDB's planner trips on zero-length paths in the
        # filtered form. Handle the "focus is already top" case with
        # COALESCE on the outer query (anc is null → return focus).
        # The focus anchor is label-qualified via the urn→label cache
        # (urn-index seek, not an All-Node-Scan), and the containment
        # types are a pattern ALTERNATION so the walk never expands
        # non-containment edges at all (the old ALL(rel IN c …) filter
        # expanded EVERY edge type then discarded mismatches).
        focus_label = await self._get_cached_label(urn)
        f_anchor = (
            f"(focus:{_sanitize_label(focus_label)} {{urn: $urn}})"
            if focus_label else "(focus {urn: $urn})"
        )
        c_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        cypher = (
            f"MATCH {f_anchor} "
            f"OPTIONAL MATCH (focus)<-[c:{c_alt}*1..{max_depth}]-(anc) "
            "WITH focus, anc, size(c) AS depth "
            "ORDER BY depth DESC LIMIT 1 "
            "RETURN COALESCE(anc.urn, focus.urn) AS urn, "
            "       COALESCE(anc.level, focus.level, -1) AS level"
        )
        try:
            result = await self._ro_query(
                cypher, params={"urn": urn}, timeout=1.5, op="trace.root_anchor",
            )
            rows = result.result_set or []
            if rows and rows[0]:
                root_urn = rows[0][0] or urn
                lvl = rows[0][1]
                level = int(lvl) if lvl is not None else -1
                return root_urn, level
        except Exception as exc:
            logger.warning("trace: root anchor resolution failed for %s: %s", urn, exc)
        return urn, -1

    def _types_at_level(self, level: int) -> List[str]:
        """Return entity-type IDs whose ontology hierarchy.level == ``level``.

        Used by trace/expand to filter via ``labels(n)[0] IN $typesAtLevel``
        instead of ``n.level = $level`` — the label-based filter works
        immediately on every existing graph (labels are written at upsert),
        whereas ``n.level`` only works after backfill_node_levels.py runs.
        """
        mapping = getattr(self, "_entity_type_levels", None) or {}
        return [t for t, lvl in mapping.items() if lvl == level]

    async def set_projection_mode(self, mode: str) -> None:
        """Dynamically switch the projection target for aggregation operations.

        Because provider instances are cached and shared across data sources,
        projection_mode cannot be baked into the constructor.  The aggregation
        worker calls this per-job to route AGGREGATED edges to the correct
        graph (source or dedicated ``{graph_name}_proj``).

        Must be called AFTER ``_ensure_connected()`` so ``self._db`` is ready.
        """
        await self._ensure_connected()
        old = self._projection_mode
        self._projection_mode = mode
        if mode == "dedicated":
            if self._proj_graph is None:
                proj_name = f"{self._graph_name}_proj"
                if self._conn_cfg is not None and self._conn_cfg.mode == "cluster":
                    # {graph}_proj may hash to a DIFFERENT shard than {graph}, so it
                    # needs its own owning-node client — reusing self._db would send
                    # the AGGREGATED writes to the wrong node (MOVED/CROSSSLOT).
                    # Same routing _ensure_connected does when the mode is known at
                    # connect time; this path is the per-job switch.
                    from backend.app.providers.falkordb_connection import (
                        build_graph_client,
                    )
                    socket_timeout = self._graph_socket_timeout()
                    self._proj_db, self._proj_pool = await build_graph_client(
                        self._conn_cfg,
                        graph_name=proj_name,
                        pool_kwargs=self._build_pool_kwargs(socket_timeout),
                    )
                    self._proj_graph = self._proj_db.select_graph(proj_name)
                else:
                    self._proj_graph = self._db.select_graph(proj_name)
        else:
            # Switching back to in_source — clear proj_graph so _proj returns _graph
            self._proj_graph = None
        logger.info(
            "Projection mode changed %s → %s for graph %s",
            old, mode, self._graph_name,
        )

    def set_admission_controller(self, controller: Optional[Any]) -> None:
        """Inject the distributed write-admission controller for aggregation
        writes (see ``backend.app.services.aggregation.admission``). Called
        per-job by the aggregation worker; pass None to detach."""
        self._admission_controller = controller

    def set_resolved_edge_metadata(
        self,
        edge_type_metadata: Dict[str, Any],
        lineage_edge_types: List[str],
    ) -> None:
        """Called by ContextEngine after ontology resolution to inject the
        authoritative edge classification from the resolver.
        When set, get_ontology_metadata() uses this instead of
        re-deriving from env vars and hardcoded type names.
        """
        self._resolved_edge_metadata = {k.upper(): v for k, v in edge_type_metadata.items()}
        self._resolved_lineage_types: Set[str] = {t.upper() for t in lineage_edge_types}
        self._resolved_edge_metadata_set = True

    def set_source_type_aliases(
        self,
        relationship_aliases: Dict[str, List[str]],
        entity_aliases: Optional[Dict[str, List[str]]] = None,
    ) -> None:
        """Per-source vocabulary alignment (Task E): ``UPPER(declared) → [observed
        spelling(s)]`` for types the graph spells differently than the ontology
        declares. Injected by ``ContextEngine._resolve_ontology`` from live
        introspection. FalkorDB matches relationship types / labels case-SENSITIVELY,
        so a ``[:HAS]`` pattern misses a ``has`` graph; :meth:`_alias_rel_types`
        translates declared → observed at the single point a type set becomes Cypher.

        Empty maps (governed/canonical graphs, where observed == declared) make the
        translation an identity. Always call this on resolution so a stale alias set
        from a prior ontology can't leak into the next query."""
        self._source_rel_aliases: Dict[str, List[str]] = {
            str(k).upper(): [str(s) for s in v] for k, v in (relationship_aliases or {}).items()}
        self._source_entity_aliases: Dict[str, List[str]] = {
            str(k).upper(): [str(s) for s in v] for k, v in (entity_aliases or {}).items()}

    def set_node_identity(
        self,
        identity_property: Optional[str] = None,
        name_property: Optional[str] = None,
    ) -> None:
        """Per-source node-identity mapping: which physical property plays the
        role of ``urn``, and which holds the human name.

        Resolved across all four scopes by
        ``backend.app.services.node_identity`` and injected here by the
        aggregation worker (before materialization) and by ``ContextEngine``
        (before any read). Same "ALWAYS RESET" contract as
        :meth:`set_source_type_aliases`, and for the same reason: provider
        instances are cached and shared per ``(provider_id, graph_name)``, so
        omitting the call would leak the previous source's mapping into the
        next query. Passing ``None`` restores the platform defaults — that is a
        meaningful instruction, not a no-op.
        """
        from backend.app.services.node_identity import (
            DEFAULT_IDENTITY_PROPERTY, DEFAULT_NAME_PROPERTY,
        )
        self._node_identity_property = (
            str(identity_property).strip() if identity_property else ""
        ) or DEFAULT_IDENTITY_PROPERTY
        self._name_property = (
            str(name_property).strip() if name_property else ""
        ) or DEFAULT_NAME_PROPERTY

    def _alias_types(self, types, alias_attr: str):
        """Translate each declared/canonical type to the source's observed spelling(s)
        via the injected alias map; identity when there's no alias (governed graphs,
        or a type the source spells the same). A declared type can expand to MULTIPLE
        observed spellings (same-source multi-variant), so all are matched at once."""
        if not types:
            return types
        aliases = getattr(self, alias_attr, None)
        if not aliases:
            return types
        out: List[str] = []
        for t in types:
            mapped = aliases.get(str(t).upper())
            if mapped:
                out.extend(mapped)
            else:
                out.append(t)
        seen = list(dict.fromkeys(out))          # dedupe, preserve order
        return set(seen) if isinstance(types, (set, frozenset)) else seen

    def _containment_hop_bound(self) -> int:
        """Upper bound for upward containment walks. Physical depth can
        exceed the LABEL count (recursive same-label nesting, e.g.
        Folder⊃Folder…), so the bound is 2× the level-map size with a
        floor of 16, overridable for pathologically deep hierarchies via
        AGGREGATION_MAX_CONTAINMENT_HOPS. Reader walks and ancestor-chain
        computation MUST share this bound or they disagree with the
        writer about which ancestors exist."""
        override = os.getenv("AGGREGATION_MAX_CONTAINMENT_HOPS")
        if override:
            try:
                return max(1, min(64, int(override)))
            except ValueError:
                pass
        levels = getattr(self, "_entity_type_levels", None) or {}
        return max(2 * len(levels), 16)

    def _floor_case_fold(self, types, observed):
        """Universal case-fold floor: union each resolved type with every
        observed spelling that shares its case-fold, so a declared ``TO``
        still resolves to a graph's ``To``/``to`` even when the injected
        alias map is empty (a governed-but-drifted source, or introspection
        that came back empty). Monotonic — only ADDS same-casefold spellings
        the graph actually has; it never drops a type, so a mismatched cache
        can't make a query miss. Mirrors the aggregation pipeline's
        ``_fold_expand`` at the read-path choke point every consumer flows
        through (trace / top-level / containment / lineage accessors)."""
        if not types or not observed:
            return types
        by_fold: Dict[str, List[str]] = {}
        for o in observed:
            by_fold.setdefault(str(o).casefold(), []).append(str(o))
        out: List[str] = list(types)
        have = set(out)
        for t in list(out):
            for variant in by_fold.get(str(t).casefold(), []):
                if variant not in have:
                    have.add(variant)
                    out.append(variant)
        return set(out) if isinstance(types, (set, frozenset)) else out

    def _alias_rel_types(self, types):
        # Alias translation first (declared → the source's mapped spelling),
        # then a case-fold floor from the reliably-probed observed vocabulary
        # (populated by get_ontology_metadata, which has an edge-scan fallback)
        # so an empty/partial alias map can never cause a silent case miss.
        aliased = self._alias_types(types, "_source_rel_aliases")
        return self._floor_case_fold(aliased, getattr(self, "_observed_rel_types", None))

    def _alias_entity_types(self, types):
        return self._alias_types(types, "_source_entity_aliases")

    def _get_containment_edge_types(self) -> Set[str]:
        """Return the authoritative containment edge type set.

        Single source of truth: the ontology-resolved types injected by
        ContextEngine / aggregation. Empty is a valid resolved state
        (flat graph with no containment hierarchy). Anything else
        raises ``ProviderConfigurationError`` — silently defaulting in
        a multi-tenant system masks ontology-coverage bugs the
        resolution gate is meant to surface.

        The legacy ``CONTAINMENT_EDGE_TYPES`` env-var fallback was
        removed: it was an operator escape hatch from the era before
        the resolution gate, and it lets aggregation paths bypass the
        per-data-source ontology assignment. Operators that need to
        configure containment now do so by editing the ontology.
        """
        if getattr(self, "_resolved_containment_types_set", False):
            # Translate the (uppercased) canonical set to the source's observed
            # spellings so the case-SENSITIVE Cypher patterns match a differently-
            # cased graph. Identity for governed/canonical graphs.
            return self._alias_rel_types(self._resolved_containment_types)
        raise ProviderConfigurationError(
            "Containment edge types are not configured for this provider. "
            "ContextEngine / aggregation must call set_containment_edge_types() "
            "with the resolved ontology before invoking provider methods that "
            "depend on containment classification."
        )

    def _get_lineage_edge_types(self) -> Set[str]:
        """Return the authoritative lineage edge type set.

        Mirrors ``_get_containment_edge_types``. The set is populated by
        ``set_resolved_edge_metadata`` (called from
        ``ContextEngine._resolve_ontology``) from the live ontology's
        ``is_lineage`` flags. Empty is a valid resolved state (graph has
        no lineage edges); a missing set raises ``ProviderConfigurationError``
        so silent misconfiguration is impossible — search predicates that
        depend on lineage (``isOrphan``, ``degree``, ``withinHops``) must
        fail loudly if the ontology was never injected.

        No hardcoded fallback: the whole point of the ontology resolution
        gate is that lineage classification is per-data-source.
        """
        if getattr(self, "_resolved_edge_metadata_set", False):
            # Translate to the source's observed spellings (parity with the containment
            # accessor) so accessor-driven lineage rendering (e.g. deep-search) matches a
            # differently-cased graph. Classification reads the raw uppercase set directly,
            # so it is unaffected.
            return self._alias_rel_types(self._resolved_lineage_types)
        raise ProviderConfigurationError(
            "Lineage edge types are not configured for this provider. "
            "ContextEngine / aggregation must call set_resolved_edge_metadata() "
            "with the resolved ontology before invoking provider methods that "
            "depend on lineage classification (e.g. degree / isOrphan / "
            "withinHops predicates)."
        )

    def _extract_node_from_result(self, row) -> Optional[GraphNode]:
        """Extract GraphNode from a FalkorDB result row (Node or dict of properties)."""
        if not row:
            return None
        cell = row[0] if isinstance(row, (list, tuple)) else row
        ident = getattr(self, "_node_identity_property", None)
        name_prop = getattr(self, "_name_property", None)
        if hasattr(cell, "properties"):
            props = cell.properties or {}
            labels = getattr(cell, "labels", None) or []
            entity_type = labels[0] if labels else props.get("entityType", "unknown")
            return _node_from_props(props, entity_type, ident, name_prop)
        if isinstance(cell, dict):
            return _node_from_props(cell, None, ident, name_prop)
        return None

    # ---- URN → label cache (Redis Hash) ----

    @property
    def _cache_ns(self) -> str:
        """Namespace for ALL provider-level Redis cache keys (urn→label,
        ancestor chains, ontology/stats/regime markers, agg-membership).

        Must identify the PHYSICAL graph — (FalkorDB endpoint, graph name)
        — NOT the graph name alone. ``graph_name`` defaults to the literal
        ``"nexus_lineage"`` when unset and the DB uniqueness constraint is
        (workspace, provider, graph_name), so the SAME graph_name can name
        DIFFERENT physical graphs on different FalkorDB instances. Keying
        caches by graph_name alone let a shared ``CACHE_REDIS_URL`` leak
        URN labels / ancestor chains / regime across two tenants' graphs
        that happen to share a name — wrong labels (dropped nodes), wrong
        ancestor trees (cross-tenant rollups). host:port:graph_name keeps
        distinct instances distinct; the same instance+graph legitimately
        shares (it is literally the same physical graph). NOTE this is a
        cache prefix only — the FalkorDB graph SELECTION still uses the
        bare ``self._graph_name``.
        """
        host = getattr(self, "_host", "") or ""
        port = getattr(self, "_port", "") or ""
        return f"{host}:{port}:{self._graph_name}"

    def physical_graph_id(self) -> str:
        """Public read-only accessor for this provider's physical-graph
        identity — the same (host, port, graph_name) triple ``_cache_ns``
        uses. Exposed so callers OUTSIDE this module (the response cache's
        ``CacheScope.graph_ns`` in graph_cache.py) can namespace their own
        cache keys by physical graph without duplicating the host/port/
        graph_name plumbing here."""
        return self._cache_ns

    def _urn_label_key(self) -> str:
        return f"{self._cache_ns}:urn_labels"

    def _agg_last_materialized_key(self) -> str:
        return f"{self._cache_ns}:agg:last_materialized_at"

    def _agg_regime_key(self) -> str:
        return f"{self._cache_ns}:agg:regime"

    def _agg_members_prefix(self) -> str:
        """Prefix for the per-pair agg-membership SETs (aggregation
        bookkeeping). A method so tests can stub it, and so the physical
        namespace stays in one place."""
        return f"{self._cache_ns}:agg_members"

    async def _aggregation_run_meta(self) -> "AggRunMeta":
        """Resolved aggregation-run metadata for the read paths.

        Precedence: the operator's fine-pairs env escape hatch → the
        in-graph ``_AggMeta`` singleton (written atomically by the batch
        pipeline at run end — survives Redis loss and topology splits) →
        the legacy Redis regime marker → a graph probe for non-conforming
        rows (NULL aggKey or NULL level stamps — legacy strategies and
        pre-canonical incremental writers). Cached ~5 minutes.

        ``regime``: 'cube' = every ancestor combination stored (readers
        serve purely from storage; mixed-level derivation MUST stay off
        or every mixed weight double-counts); 'boundary' = canonical
        depth-diagonal only (depth-keyed derivation fills the rest).
        ``stamp_version`` >= 2 means every edge carries
        sourceDepth/targetDepth. ``last_materialized_at`` feeds the
        result payload + the context-engine backfill trigger, so a graph
        that HAS materialized but lost its Redis key no longer
        re-triggers materialization on every empty read."""
        cached = getattr(self, "_agg_meta_cached", None)
        now = time.monotonic()
        if cached and now - cached[1] < 300.0:
            return cached[0]
        meta: Optional[AggRunMeta] = None
        try:
            res = await self._proj_ro_query(
                "MATCH (m:_AggMeta {id: 'singleton'}) "
                "RETURN m.regime, m.stampVersion, m.maxDepth, "
                "m.lastMaterializedAt LIMIT 1",
            )
            rows = res.result_set or []
            if rows and rows[0] and rows[0][0] in ("cube", "boundary"):
                row = rows[0]
                meta = AggRunMeta(
                    str(row[0]),
                    int(row[1]) if row[1] is not None else 1,
                    int(row[2]) if row[2] is not None else None,
                    str(row[3]) if row[3] is not None else None,
                )
        except Exception as e:
            logger.debug("Aggregation _AggMeta read failed: %s", e)
        if meta is None:
            meta = await self._legacy_regime_meta()
        if os.getenv(
            "AGGREGATION_MATERIALIZE_FINE_PAIRS", "false"
        ).strip().lower() in ("1", "true", "yes", "on"):
            # Operator escape hatch forces the cube CONTRACT (mixed-level
            # derivation off) without discarding the resolved timestamp
            # or stamp version.
            meta = meta._replace(regime="cube")
        self._agg_meta_cached = (meta, now)
        return meta

    async def _legacy_regime_meta(self) -> "AggRunMeta":
        """Marker fallback for graphs that predate ``_AggMeta``. Stamp
        version 1: depth stamps unknown — depth-keyed readers must not
        trust them and fall back to stored rows only.

        READ PATHS NEVER PROBE: the old non-conforming-row probe scanned
        up to every :AGGREGATED relation (measured 2.0s over 1M cells on
        the 3M graph) once per 5 minutes ON THE READ PATH. Graphs with no
        marker now resolve to regime="unknown" — readers serve stored
        cells + the exact raw mirror with ``stale=true`` and let the
        auto-materialization trigger heal the graph. The probe survives
        only in :meth:`_aggregation_storage_regime` for WRITE-hook
        dispatch (rare, and a wrong guess there risks double-counted
        increments, which staleness signalling cannot excuse)."""
        regime: Optional[str] = None
        last_at: Optional[str] = None
        try:
            if self._redis is not None:
                raw = await self._redis.get(self._agg_regime_key())
                if raw:
                    val = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
                    if val == "boundary":
                        regime = "boundary"
                    elif val == "fine":
                        regime = "cube"
                raw = await self._redis.get(self._agg_last_materialized_key())
                if raw is not None:
                    last_at = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
        except Exception as e:
            logger.debug("Aggregation regime marker read failed: %s", e)
        return AggRunMeta(regime or "unknown", 1, None, last_at)

    async def _probe_nonconforming_cells(self) -> Optional[bool]:
        """One LIMIT-1 scan for rows missing aggKey/level stamps. None =
        probe failed. NOT for read paths — write-hook dispatch only."""
        try:
            res = await self._proj_ro_query(
                "MATCH ()-[r:AGGREGATED]->() "
                "WHERE r.aggKey IS NULL OR r.sourceLevel IS NULL "
                "RETURN 1 LIMIT 1",
                op="agg.regime_probe",
            )
            return bool(res.result_set)
        except Exception as e:
            logger.debug("Aggregation regime probe failed: %s", e)
            return None

    async def _aggregation_storage_regime(self) -> str:
        """Legacy two-value view of ``_aggregation_run_meta``:
        ``'boundary'`` when the stored set is the canonical selection,
        ``'fine'`` when it is (or may be) a full cube.

        WRITE-HOOK consumer: on ``unknown`` (no _AggMeta, no marker) it
        still probes for non-conforming rows — a wrong regime guess here
        double-counts incremental weights, and writes are rare enough
        that the probe is acceptable off the read path. The probe result
        rides the 5-minute meta cache."""
        meta = await self._aggregation_run_meta()
        if meta.regime == "boundary":
            return "boundary"
        if meta.regime == "cube":
            return "fine"
        # unknown → probe once (cached alongside the meta for 5 min).
        cached = getattr(self, "_regime_probe_cached", None)
        now = time.monotonic()
        if cached and now - cached[1] < 300.0:
            found = cached[0]
        else:
            found = await self._probe_nonconforming_cells()
            self._regime_probe_cached = (found, now)
        if found is False:
            return "boundary"
        return "fine"

    def _agg_in_flight_key(self, ds_id: str) -> str:
        return f"materialize:in-flight:{ds_id}"

    def _urn_label_ttl(self) -> int:
        return int(os.getenv("FALKORDB_URN_LABEL_CACHE_TTL_S", "604800"))  # 7d

    async def _cache_urn_label(self, urn: str, label: str) -> None:
        """Store a single urn→label mapping."""
        try:
            key = self._urn_label_key()
            await self._redis.hset(key, urn, label)
            # TTL on EVERY write path (not only warmup): a TTL-less hash is
            # unevictable under volatile-lru, so a fleet of warmed 2M-node
            # graphs would wedge Redis at maxmemory. Refresh-on-write keeps
            # active graphs warm and lets idle ones expire.
            await self._redis.expire(key, self._urn_label_ttl())
        except Exception:
            pass  # best-effort

    async def _cache_urn_labels_bulk(self, mapping: Dict[str, str]) -> None:
        """Bulk-store urn→label mappings via pipeline."""
        if not mapping:
            return
        try:
            pipe = self._redis.pipeline(transaction=False)
            key = self._urn_label_key()
            for urn, label in mapping.items():
                pipe.hset(key, urn, label)
            pipe.expire(key, self._urn_label_ttl())  # keep the hash evictable
            await pipe.execute()
        except Exception:
            pass  # best-effort

    async def _get_cached_label(self, urn: str) -> Optional[str]:
        """Look up the label for a URN from Redis cache."""
        try:
            return await self._redis.hget(self._urn_label_key(), urn)
        except Exception:
            return None

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()

        # DETERMINISTIC childCount: counted live from real containment
        # edges when types are configured — never the stored property.
        try:
            _ct_types = self._get_containment_edge_types() or []
        except ProviderConfigurationError:
            # Unconfigured provider (probes, pre-ontology warmup): degrade
            # to the bare form — childCount falls back to the stored property
            # rather than reporting a count nothing computed. Narrow on
            # purpose: this getter's ONLY expected failure is "not configured",
            # and a bare `except` here would have swallowed a real bug into a
            # silently uncounted read.
            _ct_types = []
        ct = "|".join(_sanitize_label(t) for t in _ct_types if t)
        count_clause = (
            f" OPTIONAL MATCH (n)-[:{ct}]->(child) RETURN n, count(child) as childCount"
            if ct else " RETURN n"
        )

        def _from_row(row) -> Optional[GraphNode]:
            if ct and isinstance(row, (list, tuple)) and len(row) >= 2:
                node = self._extract_node_from_result([row[0]])
                if node is not None:
                    node.child_count = int(row[1])
                    if node.properties is not None:
                        node.properties['childCount'] = int(row[1])
                return node
            return self._extract_node_from_result(row)

        # Try label-aware lookup first (index-assisted, 10-50x faster)
        label = await self._get_cached_label(urn)
        if label:
            result = await self._ro_query(
                f"MATCH (n:{_sanitize_label(label)} {{urn: $urn}}){count_clause}",
                params={"urn": urn},
                op="nodes.get",
            )
            if result.result_set and len(result.result_set) > 0:
                return _from_row(result.result_set[0])

        # Fallback: label-less scan (still works, just slower)
        result = await self._ro_query(
            f"MATCH (n) WHERE n.urn = $urn{count_clause}",
            params={"urn": urn},
            op="nodes.get_unlabeled",
        )
        if result.result_set and len(result.result_set) > 0:
            node = _from_row(result.result_set[0])
            # Backfill the cache for next time
            if node:
                await self._cache_urn_label(urn, str(node.entity_type))
            return node
        return None

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        await self._ensure_connected()

        params: Dict[str, Any] = {}
        conditions = []

        # Label-indexed matching: use per-label MATCH with UNION for O(1) index lookup
        # instead of MATCH (n) WHERE toLower(labels(n)[0]) IN $types which scans all nodes.
        use_label_union = bool(query.entity_types) and not query.urns
        if use_label_union:
            # Align declared entity types to the graph's observed label spelling (Task E):
            # the label-union MATCH (n:Label) is case-sensitive, so a `Table` filter must
            # become `TABLE` against a TABLE graph. The non-union path below already compares
            # case-insensitively (toLower). Identity for governed graphs.
            types = list(self._alias_entity_types([str(t) for t in query.entity_types]))
            # Build per-label conditions (shared across all UNION branches)
            shared_conditions = []
        else:
            shared_conditions = None  # not used

        if not use_label_union:
            if query.entity_types:
                # Fallback for combined entity_types + urns queries
                types_lower = [t.lower() for t in [str(t) for t in query.entity_types]]
                params["entityTypesLower"] = types_lower
                conditions.append("toLower(labels(n)[0]) IN $entityTypesLower")

        if query.urns:
            if len(query.urns) == 1:
                conditions.append("n.urn = $urn0")
                params["urn0"] = query.urns[0]
            else:
                params["urnList"] = query.urns
                conditions.append("n.urn IN $urnList")

        if query.tags:
            # Tags stored as JSON array string - match quoted tag in JSON
            params["tagVal"] = json.dumps(query.tags[0])
            tag_cond = "(n.tags IS NOT NULL AND n.tags CONTAINS $tagVal)"
            conditions.append(tag_cond)
            if shared_conditions is not None:
                shared_conditions.append(tag_cond)

        if query.search_query:
            params["search"] = query.search_query.lower()
            search_cond = "(toLower(toString(n.displayName)) CONTAINS $search OR toLower(toString(n.urn)) CONTAINS $search)"
            conditions.append(search_cond)
            if shared_conditions is not None:
                shared_conditions.append(search_cond)

        offset = int(query.offset or 0)
        limit = query.limit or 100
        params["skip"] = offset
        params["limit"] = limit

        # Child count: only compute when needed (skip for bulk lineage fetches)
        include_child_count = query.include_child_count

        # ── URN-anchored fetch: label-index seeks, not an All-Node-Scan ──
        # ``MATCH (n) WHERE n.urn IN $list`` was a full node scan on this
        # FalkorDB build (no label-less URN index) — measured 1.6s for 100
        # urns on a 2M-node graph, and this is the /nodes/query hydration hot
        # path. Bucket the urns by label via the warmed urn->label cache and
        # seek each label's URN index; the unresolved-label residue keeps the
        # unlabeled pattern. Other filters (entity type, tags, search) ride
        # along as WHERE conditions. Pagination/order are applied in Python
        # over the merged, bounded result (the urn set IS the bound).
        if query.urns:
            extra_conditions = [c for c in conditions
                                if "n.urn " not in c and "n.urn=" not in c]
            containment_rel_types = ""
            if include_child_count:
                containment = list(self._get_containment_edge_types())
                containment_rel_types = "|".join(
                    _sanitize_label(t) for t in containment)

            def _urn_cypher(label: str) -> str:
                anchor = f"(n:{label})" if label else "(n)"
                where = " AND ".join(["n.urn IN $urnList", *extra_conditions])
                base = f"MATCH {anchor} WHERE {where}"
                if include_child_count and containment_rel_types:
                    return (f"{base} WITH n "
                            f"OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child) "
                            f"RETURN n, count(child) as childCount")
                if include_child_count:
                    return f"{base} RETURN n, 0 as childCount"
                return f"{base} RETURN n"

            async def _fetch_bucket(label: str, bucket: List[str]) -> list:
                try:
                    res = await self._ro_query(
                        _urn_cypher(label),
                        params={**params, "urnList": bucket},
                        op="nodes.query",
                    )
                    return res.result_set or []
                except Exception as e:
                    if await self._is_verified_missing_graph(e):
                        return []
                    logger.warning(f"get_nodes urn bucket failed: {e}")
                    return []

            buckets = await self._label_buckets(query.urns)
            rows_per_bucket = await asyncio.gather(*[
                _fetch_bucket(lbl, b) for lbl, b in buckets
            ])
            merged: List[GraphNode] = []
            for rows in rows_per_bucket:
                for row in rows:
                    if include_child_count:
                        n = self._extract_node_from_result(row[0])
                        child_count = row[1]
                    else:
                        n = self._extract_node_from_result(row)
                        child_count = None
                    if not n:
                        continue
                    if query.property_filters and not self._match_property_filters(n, query.property_filters):
                        continue
                    if query.tag_filters and not self._match_tag_filters(n, query.tag_filters):
                        continue
                    if query.name_filter and not self._match_text_filter(n.display_name, query.name_filter):
                        continue
                    if child_count is not None:
                        n.child_count = int(child_count)
                        if n.properties:
                            n.properties['childCount'] = int(child_count)
                    merged.append(n)
            # Stable displayName order (matches the SKIP/LIMIT paths), then
            # apply the requested window over the bounded urn result.
            merged.sort(key=lambda n: (n.display_name is None, n.display_name or ""))
            return merged[offset:offset + limit]

        if use_label_union:
            # Build UNION query with per-label MATCH clauses (uses FalkorDB label indices)
            where_suffix = (" WHERE " + " AND ".join(shared_conditions)) if shared_conditions else ""
            union_branches = []
            for t in types:
                safe_label = _sanitize_label(t)
                union_branches.append(f"MATCH (n:{safe_label}){where_suffix} RETURN n")
            # Wrap in subquery pattern: UNION all branches, then paginate + child count
            inner = " UNION ".join(union_branches)
            if include_child_count:
                containment = list(self._get_containment_edge_types())
                containment_rel_types = "|".join([_sanitize_label(t) for t in containment])
                if containment_rel_types:
                    cypher = (
                        f"CALL {{ {inner} }} "
                        f"WITH n ORDER BY n.displayName SKIP $skip LIMIT $limit "
                        f"OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child) "
                        f"RETURN n, count(child) as childCount"
                    )
                else:
                    cypher = (
                        f"CALL {{ {inner} }} "
                        f"WITH n ORDER BY n.displayName SKIP $skip LIMIT $limit "
                        f"RETURN n, 0 as childCount"
                    )
            else:
                cypher = (
                    f"CALL {{ {inner} }} "
                    f"WITH n ORDER BY n.displayName SKIP $skip LIMIT $limit "
                    f"RETURN n"
                )
        else:
            # Original non-UNION path (URN lookups, no entity_types, etc.)
            clauses = ["MATCH (n)"]
            if conditions:
                clauses.append("WHERE " + " AND ".join(conditions))

            if include_child_count:
                containment = list(self._get_containment_edge_types())
                containment_rel_types = "|".join([_sanitize_label(t) for t in containment])
                clauses.append("WITH n SKIP $skip LIMIT $limit")
                if containment_rel_types:
                    clauses.append(f"OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child)")
                    clauses.append("RETURN n, count(child) as childCount")
                else:
                    clauses.append("RETURN n, 0 as childCount")
            else:
                clauses.append("RETURN n SKIP $skip LIMIT $limit")

            cypher = " ".join(clauses)

        try:
            result = await self._ro_query(cypher, params=params)
        except Exception as e:
            if await self._is_verified_missing_graph(e):
                return []  # never-created / empty key = legitimately no data
            logger.warning(f"get_nodes query failed: {e}")
            raise  # connection refused / transient = surface it (breaker -> 503)

        nodes = []
        for row in (result.result_set or []):
            if include_child_count:
                n = self._extract_node_from_result(row[0])
                child_count = row[1]
            else:
                n = self._extract_node_from_result(row)
                child_count = None
            if n:
                if query.property_filters and not self._match_property_filters(n, query.property_filters):
                    continue
                if query.tag_filters and not self._match_tag_filters(n, query.tag_filters):
                    continue
                if query.name_filter and not self._match_text_filter(n.display_name, query.name_filter):
                    continue

                # Apply dynamic child count when available
                if child_count is not None:
                    n.child_count = int(child_count)
                    if n.properties:
                        n.properties['childCount'] = int(child_count)

                nodes.append(n)
                if len(nodes) >= limit:
                    break
        return nodes

    def _match_property_filters(self, node: GraphNode, filters: List[PropertyFilter]) -> bool:
        for f in filters:
            val = node.properties.get(f.field)
            if hasattr(node, f.field):
                val = getattr(node, f.field)
            if not self._match_operator(val, f.operator, f.value):
                return False
        return True

    def _match_operator(self, actual: Any, op: FilterOperator, target: Any) -> bool:
        if op == FilterOperator.EXISTS:
            return actual is not None
        if op == FilterOperator.NOT_EXISTS:
            return actual is None
        if actual is None:
            return False
        if op == FilterOperator.EQUALS:
            return actual == target
        if op == FilterOperator.CONTAINS:
            return str(target).lower() in str(actual).lower()
        if op == FilterOperator.STARTS_WITH:
            return str(actual).lower().startswith(str(target).lower())
        if op == FilterOperator.ENDS_WITH:
            return str(actual).lower().endswith(str(target).lower())
        try:
            if op == FilterOperator.GT:
                return actual > target
            if op == FilterOperator.LT:
                return actual < target
        except Exception:
            return False
        if op == FilterOperator.IN:
            return isinstance(target, list) and actual in target
        if op == FilterOperator.NOT_IN:
            return isinstance(target, list) and actual not in target
        return True

    def _match_tag_filters(self, node: GraphNode, filter: TagFilter) -> bool:
        node_tags = set(node.tags or [])
        target_tags = set(filter.tags)
        if filter.mode == "any":
            return not node_tags.isdisjoint(target_tags)
        if filter.mode == "all":
            return target_tags.issubset(node_tags)
        if filter.mode == "none":
            return node_tags.isdisjoint(target_tags)
        return True

    def _match_text_filter(self, text: str, filter: TextFilter) -> bool:
        t = text if filter.case_sensitive else text.lower()
        q = filter.text if filter.case_sensitive else filter.text.lower()
        if filter.operator == "equals":
            return t == q
        if filter.operator == "contains":
            return q in t
        if filter.operator == "startsWith":
            return t.startswith(q)
        if filter.operator == "endsWith":
            return t.endswith(q)
        return True

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        q = NodeQuery(search_query=query, limit=limit, offset=offset)
        return await self.get_nodes(q)

    async def deep_search(self, query, *, deadline_ms=None):
        """Advanced server-side search. See ``backend/common/models/search.py``.

        Implementation lives in ``falkordb_deep_search.execute_deep_search``
        to keep this provider module focused. Imported lazily to avoid a
        circular dependency at module load (the deep-search module
        imports from this one's read-path helpers indirectly via
        ``_extract_node_from_result`` and friends).
        """
        from .falkordb_deep_search import execute_deep_search
        await self._ensure_connected()
        return await execute_deep_search(self, query, deadline_ms=deadline_ms)

    async def deep_search_explain(self, query):
        """Compile-only path. Mirrors ``deep_search`` (lazy import to
        avoid the circular load order)."""
        from .falkordb_deep_search import explain_deep_search
        await self._ensure_connected()
        return explain_deep_search(self, query)

    async def deep_search_discover(self, *, sample_per_label: int = 200):
        """Schema discovery. Mirrors ``deep_search`` (lazy import)."""
        from .falkordb_deep_search import discover_native_property_keys
        await self._ensure_connected()
        return await discover_native_property_keys(
            self, sample_per_label=sample_per_label,
        )

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        await self._ensure_connected()

        offset = query.offset or 0
        limit = query.limit or 100

        # Relationship types as a PATTERN alternation (alias-mapped to this
        # graph's observed spellings), not a post-hoc `type(r) IN` filter —
        # the traversal then never visits other edge types on hub nodes.
        types: Optional[List[str]] = None
        if query.edge_types:
            raw = [t.value if hasattr(t, "value") else str(t) for t in query.edge_types]
            types = [t for t in self._alias_rel_types(raw) if t]
        rel_pattern = (
            f"[r:{'|'.join(_sanitize_label(t) for t in types)}]" if types else "[r]"
        )

        extra_conditions: List[str] = []
        extra_params: Dict[str, Any] = {}
        if query.min_confidence is not None:
            extra_params["minConf"] = query.min_confidence
            extra_conditions.append("r.confidence >= $minConf")

        is_between = bool(query.source_urns and query.target_urns)
        op = "edges.between" if is_between else "edges.query"
        timeout = self._EDGES_BETWEEN_TIMEOUT if is_between else None

        # URN-anchored reads (the /edges/between hydration path) run one
        # urn-index-seeked sub-query per label bucket, gathered — an
        # unlabeled `a.urn IN $list` anchor is a FULL node scan on builds
        # without a label-less URN index (measured 310ms/2M nodes, before
        # even walking edges). Bucketing keeps result sets disjoint (a node
        # has one label), so a simple merge + truncate preserves semantics
        # at offset 0. offset>0 or anyUrns fall back to the legacy single
        # query below — those shapes have no index-friendly form.
        anchor_urns = query.source_urns or query.target_urns
        if anchor_urns and offset == 0 and not query.any_urns:
            anchor_on_source = bool(query.source_urns)
            conditions = list(extra_conditions)
            params: Dict[str, Any] = {**extra_params, "limit": limit}
            if anchor_on_source and query.target_urns:
                params["targetUrns"] = query.target_urns
                conditions.append("b.urn IN $targetUrns")

            async def _run_bucket(label: str, bucket: List[str]) -> list:
                var = "a" if anchor_on_source else "b"
                node = f"({var}:{label})" if label else f"({var})"
                pattern = (
                    f"MATCH {node}-{rel_pattern}->(b)" if anchor_on_source
                    else f"MATCH (a)-{rel_pattern}->{node}"
                )
                where = " AND ".join([f"{var}.urn IN $anchorUrns"] + conditions)
                try:
                    res = await self._ro_query(
                        f"{pattern} WHERE {where} "
                        "RETURN a.urn AS src, b.urn AS tgt, type(r) AS relType, "
                        "properties(r) AS rprops LIMIT $limit",
                        params={**params, "anchorUrns": bucket},
                        timeout=timeout, op=op,
                    )
                    return res.result_set or []
                except Exception as exc:
                    logger.warning("get_edges bucket query failed: %s", exc)
                    return []

            rows_per_bucket = await asyncio.gather(*[
                _run_bucket(label, bucket)
                for label, bucket in await self._label_buckets(list(anchor_urns))
            ])
            edges: List[GraphEdge] = []
            for rows in rows_per_bucket:
                for row in rows:
                    edges.append(_edge_from_row(row[0], row[1], row[2], row[3] or {}))
                    if len(edges) >= limit:
                        break
                if len(edges) >= limit:
                    break
            return edges

        cypher = f"MATCH (a)-{rel_pattern}->(b)"
        params = dict(extra_params)
        conditions = list(extra_conditions)
        if query.source_urns:
            params["sourceUrns"] = query.source_urns
            conditions.append("a.urn IN $sourceUrns")
        if query.target_urns:
            params["targetUrns"] = query.target_urns
            conditions.append("b.urn IN $targetUrns")
        if query.any_urns:
            params["anyUrns"] = query.any_urns
            conditions.append("(a.urn IN $anyUrns OR b.urn IN $anyUrns)")
        if conditions:
            cypher += " WHERE " + " AND ".join(conditions)
        params["skip"] = offset
        params["limit"] = limit
        cypher += " RETURN a.urn AS src, b.urn AS tgt, type(r) AS relType, properties(r) AS rprops SKIP $skip LIMIT $limit"

        result = await self._ro_query(cypher, params=params, timeout=timeout, op=op)
        edges = []
        for row in (result.result_set or []):
            src, tgt, rel_type, rprops = row[0], row[1], row[2], (row[3] or {})
            edges.append(_edge_from_row(src, tgt, rel_type, rprops))
        return edges

    async def get_children(
        self,
        parent_urn: str,
        entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> List[GraphNode]:
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)
        # None = caller didn't specify, use ontology/fallback; [] = explicitly no containment
        target_edge_types = set(self._alias_rel_types(edge_types)) if edge_types is not None else set(self._get_containment_edge_types())
        rel_list = list(target_edge_types)
        if not rel_list:
            # No containment types defined — hierarchy is flat, no children exist
            return []

        search_where = ""
        params: Dict[str, Any] = {"parent": parent_urn, "lim": limit, "relTypes": rel_list}

        if search_query:
            search_where = "AND (toLower(c.displayName) CONTAINS toLower($searchQuery) OR toLower(c.urn) CONTAINS toLower($searchQuery)) "
            params["searchQuery"] = search_query

        # Keyset pagination (O(log N) with FalkorDB indices vs O(N) for SKIP).
        # COMPOSITE on (displayName, urn) — displayName is not unique, and a
        # non-unique keyset drops rows at page boundaries (_encode_keyset_cursor).
        cursor_where = ""
        cmp = "<" if sort_direction == "desc" else ">"
        if cursor:
            cursor_name, cursor_urn = _decode_keyset_cursor(cursor, sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                cursor_where = (
                    f"AND (c.displayName {cmp} $cursorName "
                    f"OR (c.displayName = $cursorName AND c.urn {cmp} $cursorUrn)) "
                )
                params["cursorUrn"] = cursor_urn
            else:
                cursor_where = f"AND c.displayName {cmp} $cursorName "  # legacy cursor
        else:
            # Fallback to offset when no cursor (first page or legacy callers)
            params["skip"] = offset

        # ORDER BY must match the keyset exactly, or paging skips/repeats rows.
        order_suffix = ""
        if sort_property:
            safe_prop = _sanitize_label(sort_property)
            dir_kw = " DESC" if sort_direction == "desc" else ""
            order_suffix = f" ORDER BY c.{safe_prop}{dir_kw}, c.urn{dir_kw}"

        # Use SKIP only when no cursor is provided (first page)
        skip_clause = "" if cursor else " SKIP $skip"

        if len(rel_list) == 1:
            rel = _sanitize_label(rel_list[0])
            cypher = (
                f"MATCH (p)-[r:{rel}]->(c) "
                f"WHERE p.urn = $parent {search_where}{cursor_where}"
                f"WITH c{order_suffix}{skip_clause} LIMIT $lim "
                f"OPTIONAL MATCH (c)-[rc]->(gc) WHERE type(rc) IN $relTypes "
                f"RETURN c, count(gc) as childCount"
            )
        else:
            cypher = (
                f"MATCH (p)-[r]->(c) "
                f"WHERE p.urn = $parent AND type(r) IN $relTypes {search_where}{cursor_where}"
                f"WITH c{order_suffix}{skip_clause} LIMIT $lim "
                f"OPTIONAL MATCH (c)-[rc]->(gc) WHERE type(rc) IN $relTypes "
                f"RETURN c, count(gc) as childCount"
            )

        from ..config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS
        result = await self._ro_query(cypher, params=params, timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS, op="children.page")
        # Align the entity-type post-filter to the graph's observed label spelling (Task E),
        # so a declared `Table` still matches a TABLE-graph node. Identity for governed graphs.
        entity_types = self._alias_entity_types(entity_types) if entity_types else entity_types
        nodes = []
        for row in (result.result_set or []):
            # Extract node and childCount
            n = self._extract_node_from_result(row[0])
            child_count = row[1]
            if n and (not entity_types or n.entity_type in entity_types):
                # Valid dynamic child count overrides static property if present, or fills gap
                if child_count is not None:
                    n.child_count = int(child_count)
                    # Also update properties so it serializes correctly if needed (though Pydantic model uses field)
                    if n.properties:
                        n.properties['childCount'] = int(child_count)
                nodes.append(n)
        return nodes

    async def get_children_with_edges(
        self,
        parent_urn: str,
        edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None,
        sort_direction: str = "asc",
    ) -> ChildrenWithEdgesResult:
        """Optimized single-roundtrip: children + containment edges + cross-child lineage edges.

        Supports cursor-based pagination for O(log N) performance at any page depth.
        When `cursor` is provided, it takes precedence over `offset`.
        """
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)

        # --- Step 1: Fetch children with containment edges (returns edge r) ---
        target_edge_types = set(self._alias_rel_types(edge_types)) if edge_types is not None else set(self._get_containment_edge_types())
        lineage_edge_types = self._alias_rel_types(lineage_edge_types) if lineage_edge_types else lineage_edge_types
        rel_list = list(target_edge_types)
        if not rel_list:
            # No containment types — return empty result
            return ChildrenWithEdgesResult(
                children=[], containmentEdges=[], lineageEdges=[],
                totalChildren=0, hasMore=False,
            )

        search_where = ""
        params: Dict[str, Any] = {"parent": parent_urn, "lim": limit, "relTypes": rel_list}

        if search_query:
            search_where = "AND (toLower(c.displayName) CONTAINS toLower($searchQuery) OR toLower(c.urn) CONTAINS toLower($searchQuery)) "
            params["searchQuery"] = search_query

        # Keyset pagination, O(log N) vs SKIP's O(N). The keyset is COMPOSITE
        # (displayName, urn): displayName alone is not unique, and a non-unique
        # keyset silently drops every row sharing the boundary row's name — see
        # _encode_keyset_cursor.
        cursor_where = ""
        cmp = "<" if sort_direction == "desc" else ">"
        if cursor:
            cursor_name, cursor_urn = _decode_keyset_cursor(cursor, sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                cursor_where = (
                    f"AND (c.displayName {cmp} $cursorName "
                    f"OR (c.displayName = $cursorName AND c.urn {cmp} $cursorUrn)) "
                )
                params["cursorUrn"] = cursor_urn
            else:
                # Legacy cursor minted before the tiebreaker existed.
                cursor_where = f"AND c.displayName {cmp} $cursorName "
        else:
            params["skip"] = offset

        # ORDER BY must match the keyset exactly, or paging skips/repeats rows.
        order_suffix = ""
        if sort_property:
            safe_prop = _sanitize_label(sort_property)
            dir_kw = " DESC" if sort_direction == "desc" else ""
            order_suffix = f" ORDER BY c.{safe_prop}{dir_kw}, c.urn{dir_kw}"

        skip_clause = "" if cursor else " SKIP $skip"

        # Query returns child node, containment edge properties, and grandchild count.
        # Anchors + relationships are index-friendly (root cause of the 5-11s
        # children reads on multi-million-node graphs):
        #  * the parent match is label-qualified via the urn→label cache so it
        #    is a URN-index seek, not an All-Node-Scan (this build has no
        #    label-less URN index — unlabeled residue keeps the old pattern);
        #  * relationship types are pattern alternations ([r:HAS|PART_OF]),
        #    not post-hoc `type(r) IN` filters, so the traversal never visits
        #    edges of other types on hub nodes (both r and the grandchild rc).
        rel_alt = "|".join(_sanitize_label(t) for t in rel_list)
        parent_label = await self._get_cached_label(parent_urn)
        p_anchor = f"(p:{_sanitize_label(parent_label)})" if parent_label else "(p)"
        cypher = (
            f"MATCH {p_anchor}-[r:{rel_alt}]->(c) "
            f"WHERE p.urn = $parent {search_where}{cursor_where}"
            f"WITH p, r, c{order_suffix}{skip_clause} LIMIT $lim "
            f"OPTIONAL MATCH (c)-[rc:{rel_alt}]->(gc) "
            f"RETURN c, count(gc) as childCount, p.urn as parentUrn, type(r) as relType, properties(r) as rprops"
        )

        from ..config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS
        result = await self._ro_query(cypher, params=params, timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS, op="children.page")

        children: List[GraphNode] = []
        containment_edges: List[GraphEdge] = []
        child_urns: List[str] = []

        for row in (result.result_set or []):
            n = self._extract_node_from_result(row[0])
            child_count = row[1]
            parent_u = row[2]
            rel_type = row[3]
            rprops = row[4] or {}

            if n:
                if child_count is not None:
                    n.child_count = int(child_count)
                    if n.properties:
                        n.properties['childCount'] = int(child_count)
                children.append(n)
                child_urns.append(n.urn)

                # Build containment edge from the matched relationship
                containment_edges.append(_edge_from_row(parent_u, n.urn, rel_type, rprops))

        # --- Step 2: Fetch cross-child lineage edges (scoped to current page only) ---
        # Only use the current page's child URNs + parent, NOT cumulative URNs.
        # This keeps the query O(pageSize²) instead of O(totalLoaded²).
        lineage_edges_list: List[GraphEdge] = []
        if include_lineage_edges and len(child_urns) >= 2:
            page_urns = [parent_urn] + child_urns
            exclude_types = list(target_edge_types) + ["AGGREGATED"]

            # Prefer a TYPED alternation: explicit lineage types from the
            # caller, else the resolved ontology's lineage set. The untyped
            # NOT-filter form survives only for graphs with no resolved
            # lineage vocabulary (pre-ontology) — there is nothing to type on.
            effective_lineage = lineage_edge_types or [
                t for t in self._get_lineage_edge_types() if t
            ]
            lineage_params: Dict[str, Any] = {"pageUrns": page_urns}
            if effective_lineage:
                # Case-INSENSITIVE match. A rebuild reseeds edges with the type spelling stored in
                # the Postgres payload, and the reader's ontology→observed alias map can be stale
                # (a projection rebuild does NOT invalidate resolved_ontology_cache), so a
                # case-sensitive `[lr:Type]` alternation silently misses a differently-cased stored
                # spelling → raw lineage edges vanish from the canvas. Matching on
                # `toUpper(type(lr))` renders them regardless of stored casing / alias freshness.
                # This lineage step is already page-scoped (a.urn IN $bucketUrns AND b.urn IN
                # $pageUrns), so the untyped scan is over a tiny neighborhood. (Containment step 1
                # keeps its typed alternation — a deliberate hub-node index optimization, and its
                # canonical-uppercase types already match.)
                lr_pattern = "[lr]"
                lineage_where = "AND toUpper(type(lr)) IN $lineageUpper "
                lineage_params["lineageUpper"] = [_sanitize_label(t).upper() for t in effective_lineage]
            else:
                lr_pattern, lineage_where = "[lr]", "AND NOT type(lr) IN $excludeTypes "
                lineage_params["excludeTypes"] = exclude_types

            # Anchor `a` per label bucket (urn-index seeks); `b` stays an
            # IN-filter over the small page set after the typed traversal.
            async def _lineage_for(label: str, bucket: List[str]) -> list:
                a_anchor = f"(a:{label})" if label else "(a)"
                try:
                    res = await self._ro_query(
                        f"MATCH {a_anchor}-{lr_pattern}->(b) "
                        f"WHERE a.urn IN $bucketUrns AND b.urn IN $pageUrns {lineage_where}"
                        f"RETURN a.urn, b.urn, type(lr), properties(lr)",
                        params={**lineage_params, "bucketUrns": bucket},
                        timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS,
                        op="children.lineage",
                    )
                    return res.result_set or []
                except Exception as exc:
                    logger.warning("children page-lineage query failed: %s", exc)
                    return []

            lineage_rows = await asyncio.gather(*[
                _lineage_for(label, bucket)
                for label, bucket in await self._label_buckets(page_urns)
            ])
            for rows in lineage_rows:
                for row in rows:
                    lineage_edges_list.append(_edge_from_row(row[0], row[1], row[2], row[3] or {}))

        has_more = len(children) >= limit
        total = offset + len(children) + (1 if has_more else 0)
        # Defensive re-sort before deriving the keyset cursor: FalkorDB may
        # discard ORDER BY around an aggregating RETURN (count(gc) here), and
        # the cursor MUST be the page's boundary sort key or keyset pagination
        # skips rows. LIMIT selection is unaffected (known engine behaviour).
        # Sorts on (displayName, urn) — the same composite key the cursor uses,
        # in the requested direction.
        if sort_property == "displayName" and children:
            # Derive the index permutation from _keyset_sort (the single
            # source of keyset order, incl. the DESC prefix semantics) so the
            # paired containment_edges list stays aligned with its child.
            ordered = _keyset_sort(list(children), sort_direction)
            index_of = {id(node): i for i, node in enumerate(children)}
            order = [index_of[id(node)] for node in ordered]
            children = [children[i] for i in order]
            containment_edges = [containment_edges[i] for i in order]
            child_urns = [children[i].urn for i in range(len(children))]
        next_cursor = (
            _encode_keyset_cursor(children[-1].display_name, children[-1].urn, sort_direction)
            if children and has_more else None
        )

        return ChildrenWithEdgesResult(
            children=children,
            containmentEdges=containment_edges,
            lineageEdges=lineage_edges_list,
            totalChildren=total,
            hasMore=has_more,
            nextCursor=next_cursor,
        )

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        await self._ensure_connected()
        containment = self._get_containment_edge_types()
        if not containment:
            # No containment types — flat graph, no parent
            return None
        # Match any containment-type edge where child is target — typed
        # alternation + label-seeked child anchor (index seek, no scan).
        c_alt = "|".join(_sanitize_label(t) for t in containment if t)
        child_label = await self._get_cached_label(child_urn)
        c_anchor = (
            f"(c:{_sanitize_label(child_label)} {{urn: $child}})"
            if child_label else "(c {urn: $child})"
        )
        result = await self._ro_query(
            f"MATCH (p)-[r:{c_alt}]->{c_anchor} RETURN p",
            params={"child": child_urn},
            op="nodes.parent",
        )
        if result.result_set and len(result.result_set) > 0:
            return self._extract_node_from_result(result.result_set[0])
        return None

    async def get_top_level_or_orphan_nodes(
        self,
        *,
        root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        limit: int = 100,
        cursor: Optional[str] = None,
        include_child_count: bool = True,
        query_timeout: Optional[float] = None,
        known_total_count: Optional[int] = None,
        sort_direction: str = "asc",
    ) -> TopLevelNodesResult:
        """Return structurally top-level nodes (no incoming containment edge).

        Mixes ontology root-type instances and orphan non-root instances so the
        wizard can show both in one list, with a root/orphan split in the
        badge text. Classification is done in Python on the returned rows.

        Pagination is cursor-based on displayName for stability under writes:
        callers pass cursor=None for the first page and the returned
        next_cursor for subsequent pages.

        query_timeout overrides the default per-query timeout for both the
        page and count queries. known_total_count, when given, skips the
        count query entirely and uses the value directly (e.g. a caller
        serving from a materialized cache that already knows the total).
        """
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)

        from ..config.resilience import (
            FALKORDB_TOP_LEVEL_COUNT_TIMEOUT_SECS,
            FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS,
        )
        t = query_timeout if query_timeout is not None else FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS
        # Count is best-effort with a shorter budget (display-only); an
        # explicit query_timeout (e.g. the collector's materialization)
        # keeps its generous budget for both queries.
        ct = query_timeout if query_timeout is not None else FALKORDB_TOP_LEVEL_COUNT_TIMEOUT_SECS

        # Raises ProviderConfigurationError if no types resolvable — surfaced
        # as HTTP 400 by the endpoint. An empty set is a valid state meaning
        # "flat graph, every node is top-level".
        containment = self._get_containment_edge_types()
        containment_rel_types = "|".join([_sanitize_label(t) for t in sorted(containment)])
        # Align entity-type labels/roots to the source's observed spellings (labels are
        # case-sensitive too), so root classification and the label-union filter match.
        root_entity_types = self._alias_entity_types(root_entity_types)
        entity_types = self._alias_entity_types(entity_types)
        root_types_set = {str(t) for t in (root_entity_types or [])}

        params: Dict[str, Any] = {"limit": int(limit)}

        # ── Build optional filters ────────────────────────────────────────
        # Each filter produces a WHERE fragment applied uniformly to both the
        # page query and the count query.
        filter_fragments: List[str] = []

        if search_query:
            params["search"] = search_query.lower()
            filter_fragments.append(
                "(toLower(toString(n.displayName)) CONTAINS $search "
                "OR toLower(toString(n.urn)) CONTAINS $search)"
            )

        # Structural top-level predicate — the whole point of this method.
        # Empty containment set = flat graph, skip the predicate entirely.
        #
        # Direction-reversed from the original `NOT ()-[:T]->(n)` so n
        # (already bound by the outer MATCH) is the anchor of the pattern.
        # Same semantics — "no incoming :T edge to n" — but the planner
        # walks n's incoming adjacency list directly instead of scanning
        # all :T relationships. Avoids the O(N) full-graph scan that was
        # a top contributor to the FalkorDB CPU pin under load.
        #
        # IMPORTANT: keep the openCypher-1.0 pattern-negation form. Do NOT
        # rewrite to `NOT EXISTS { MATCH ... }` — that is Neo4j 4.x+ / ISO
        # GQL syntax and is NOT supported by FalkorDB. The subquery form
        # silently throws, gets caught below, and returns empty — which
        # was the original bug.
        if containment_rel_types:
            filter_fragments.append(
                "NOT (n)<-[:" + containment_rel_types + "]-()"
            )

        # ── Build MATCH clause: label UNION if entity_types specified ─────
        use_label_union = bool(entity_types)
        safe_types: List[str] = []
        if use_label_union:
            safe_types = [_sanitize_label(str(t)) for t in entity_types if str(t)]
            if not safe_types:
                use_label_union = False

        # Page-query cursor: keyset over (displayName, urn) for stability under
        # writes. The urn tiebreaker is what makes the key UNIQUE — without it a
        # run of same-named nodes straddling a page boundary is silently dropped
        # (_encode_keyset_cursor).
        page_filters = list(filter_fragments)
        cmp = "<" if sort_direction == "desc" else ">"
        if cursor is not None:
            cursor_name, cursor_urn = _decode_keyset_cursor(str(cursor), sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                params["cursorUrn"] = cursor_urn
                page_filters.append(
                    f"(n.displayName {cmp} $cursorName "
                    f"OR (n.displayName = $cursorName AND n.urn {cmp} $cursorUrn))"
                )
            else:
                page_filters.append(f"n.displayName {cmp} $cursorName")  # legacy cursor

        def _build_match(filters: List[str]) -> str:
            where_clause = (" WHERE " + " AND ".join(filters)) if filters else ""
            if use_label_union:
                branches = [
                    f"MATCH (n:{label}){where_clause} RETURN n"
                    for label in safe_types
                ]
                return "CALL { " + " UNION ".join(branches) + " }"
            return f"MATCH (n){where_clause}"

        # ── Page query ────────────────────────────────────────────────────
        dir_kw = "DESC" if sort_direction == "desc" else "ASC"
        if include_child_count and containment_rel_types:
            page_cypher = (
                _build_match(page_filters)
                + f" WITH n ORDER BY n.displayName {dir_kw}, n.urn {dir_kw} LIMIT $limit"
                + f" OPTIONAL MATCH (n)-[:{containment_rel_types}]->(child)"
                # Re-project through a non-aggregating WITH before ORDER BY:
                # FalkorDB discards an ORDER BY that sits directly on an
                # aggregating RETURN (and also a trailing RETURN ... ORDER BY),
                # so the pre-aggregation window order is lost. Materializing the
                # count into a WITH first, then ordering that WITH, restores the
                # displayName-ordered output the keyset cursor depends on.
                + f" WITH n, count(child) as childCount ORDER BY n.displayName {dir_kw}, n.urn {dir_kw}"
                + " RETURN n, childCount"
            )
        else:
            page_cypher = (
                _build_match(page_filters)
                + f" WITH n ORDER BY n.displayName {dir_kw}, n.urn {dir_kw} LIMIT $limit"
                + " RETURN n, 0 as childCount"
            )

        try:
            page_result = await self._ro_query(page_cypher, params=params, timeout=t, op="toplevel.page")
        except asyncio.TimeoutError as e:
            # Same type (GraphCache stale-fallback and the 503 handler match
            # on it) but with a non-empty str() so the surfaced reason names
            # the budget that actually fired instead of a blank string.
            raise asyncio.TimeoutError(
                f"top-level page query exceeded {t:.0f}s provider budget "
                f"(graph={self._graph_name})"
            ) from e
        except Exception as e:
            if not await self._is_verified_missing_graph(e):
                logger.warning(f"get_top_level_or_orphan_nodes page query failed: {e}")
                raise  # connection refused / transient = surface it (breaker -> 503)
            page_result = None  # never-created / empty key = legitimately no data

        nodes: List[GraphNode] = []
        root_type_count = 0
        orphan_count = 0
        if page_result and page_result.result_set:
            for row in page_result.result_set:
                node = self._extract_node_from_result(row[0] if isinstance(row, (list, tuple)) else row)
                if not node:
                    continue
                try:
                    child_count = int(row[1]) if isinstance(row, (list, tuple)) and len(row) > 1 else None
                except (TypeError, ValueError):
                    child_count = None
                if child_count is not None:
                    node.child_count = child_count
                    if node.properties is not None:
                        node.properties["childCount"] = child_count
                # Classify: root-type instance vs orphan of non-root type
                if root_types_set and str(node.entity_type) in root_types_set:
                    root_type_count += 1
                else:
                    orphan_count += 1
                nodes.append(node)

        # Defense-in-depth: guarantee displayName-ordered output even if the
        # engine reorders across the aggregating RETURN, so next_cursor is
        # always the page boundary and keyset pagination never overlaps/skips.
        # Uses the same key (and direction) the cursor compares on.
        # Classification/childCount are already attached above and are
        # order-independent.
        nodes = _keyset_sort(nodes, sort_direction)

        has_more = len(nodes) >= int(limit)
        next_cursor = (
            _encode_keyset_cursor(nodes[-1].display_name, nodes[-1].urn, sort_direction)
            if (has_more and nodes) else None
        )

        if known_total_count is not None:
            # Caller already knows the total (e.g. serving from a materialized
            # cache) — skip the full-scan count query entirely.
            total_count = int(known_total_count)
        else:
            # ── Total count query (no cursor filter) ──────────────────────────
            # We run this separately so the page result reflects the cursor, but
            # the total accurately shows how many top-level entities exist.
            count_params: Dict[str, Any] = {}
            if "search" in params:
                count_params["search"] = params["search"]

            if use_label_union:
                where_clause = (" WHERE " + " AND ".join(filter_fragments)) if filter_fragments else ""
                count_branches = [
                    f"MATCH (n:{label}){where_clause} RETURN n"
                    for label in safe_types
                ]
                count_cypher = "CALL { " + " UNION ".join(count_branches) + " } RETURN count(n) as total"
            else:
                where_clause = (" WHERE " + " AND ".join(filter_fragments)) if filter_fragments else ""
                count_cypher = f"MATCH (n){where_clause} RETURN count(n) as total"

            total_count: Optional[int] = 0
            try:
                count_result = await self._ro_query(count_cypher, params=count_params, timeout=ct, op="toplevel.count")
                if count_result and count_result.result_set:
                    first = count_result.result_set[0]
                    total_count = int(first[0] if isinstance(first, (list, tuple)) else first)
            except asyncio.TimeoutError:
                # Best-effort: the count is display-only, has_more is derived
                # from the page size, and on large graphs the full-scan count
                # is expected to miss its budget. Degrade instead of failing
                # the whole request.
                logger.warning(
                    "get_top_level_or_orphan_nodes count query degraded: "
                    f"exceeded {ct:.0f}s budget (graph={self._graph_name}); "
                    "returning totalCount=null"
                )
                total_count = None
            except Exception as e:
                if not await self._is_verified_missing_graph(e):
                    logger.warning(f"get_top_level_or_orphan_nodes count query failed: {e}")
                    raise  # connection refused / transient = surface it (breaker -> 503)
                total_count = len(nodes)  # never-created / empty key = 0 top-level nodes

        return TopLevelNodesResult(
            nodes=nodes,
            totalCount=total_count,
            hasMore=has_more,
            nextCursor=next_cursor,
            rootTypeCount=root_type_count,
            orphanCount=orphan_count,
        )

    async def _traverse_lineage(
        self,
        start_urn: str,
        direction: str,
        depth: int,
        descendant_types: Optional[List[str]] = None,
    ) -> Set[str]:
        """Single-query lineage traversal using bounded variable-length Cypher paths.

        Uses *1..{depth} (literal bound) instead of unbounded *1.. so the
        query planner can prune early. Entity-type filtering is pushed into
        Cypher via labels(neighbor)[0] rather than fetching all nodes to
        filter in Python.
        """
        await self._ensure_connected()
        containment = list(self._get_containment_edge_types())
        safe_depth = max(1, min(int(depth), 20))  # Clamp to sane range
        params: Dict[str, Any] = {
            "startUrn": start_urn,
            "containmentTypes": containment,
        }

        # Entity-type filter pushed into Cypher
        type_clause = ""
        if descendant_types:
            allowed = [t.value if hasattr(t, "value") else str(t) for t in descendant_types]
            params["allowedTypes"] = allowed
            type_clause = "AND labels(neighbor)[0] IN $allowedTypes "

        if direction == "upstream":
            cypher = (
                f"MATCH (start) WHERE start.urn = $startUrn "
                f"MATCH path = (neighbor)-[*1..{safe_depth}]->(start) "
                f"WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes) "
                f"{type_clause}"
                f"RETURN DISTINCT neighbor.urn AS urn"
            )
        else:
            cypher = (
                f"MATCH (start) WHERE start.urn = $startUrn "
                f"MATCH path = (start)-[*1..{safe_depth}]->(neighbor) "
                f"WHERE ALL(r IN relationships(path) WHERE NOT type(r) IN $containmentTypes) "
                f"{type_clause}"
                f"RETURN DISTINCT neighbor.urn AS urn"
            )

        result = await self._ro_query(cypher, params=params)
        return {
            row[0] for row in (result.result_set or [])
            if row[0] and row[0] != start_urn
        }

    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        upstream_urns = await self._traverse_lineage(urn, "upstream", depth, descendant_types)
        all_urns = upstream_urns | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=upstream_urns,
            downstreamUrns=set(),
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        downstream_urns = await self._traverse_lineage(urn, "downstream", depth, descendant_types)
        all_urns = downstream_urns | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=set(),
            downstreamUrns=downstream_urns,
            totalCount=len(nodes),
            hasMore=False,
        )

    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[str]] = None,
    ) -> LineageResult:
        up = await self._traverse_lineage(urn, "upstream", upstream_depth, descendant_types)
        down = await self._traverse_lineage(urn, "downstream", downstream_depth, descendant_types)
        all_urns = up | down | {urn}
        nodes = await self.get_nodes(NodeQuery(urns=list(all_urns), limit=len(all_urns), include_child_count=False))
        node_ids = {n.urn for n in nodes}
        edges = await self.get_edges(EdgeQuery(any_urns=list(all_urns), limit=len(all_urns) * 10))
        edges = [e for e in edges if e.source_urn in node_ids and e.target_urn in node_ids]
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=up,
            downstreamUrns=down,
            totalCount=len(nodes),
            hasMore=False,
        )


    # ------------------------------------------------------------------ #
    # Projection / Materialization Lifecycle Hooks                         #
    # ------------------------------------------------------------------ #

    async def ensure_projections(self) -> None:
        """Create indices on the projection target for fast AGGREGATED reads
        and (critically) for the unlabeled MERGE that runs on the write path.

        The aggregation worker issues ``MERGE (s {urn: item.s})`` without a
        label. Per-label URN indexes (created in ``_initialize_indices``)
        don't help here — FalkorDB's planner can't fan out across labeled
        indexes for an unlabeled MATCH. Without a property-only URN index,
        every MERGE in the aggregation hot path becomes a full node scan,
        which is the root cause of the 200% CPU spikes observed on million-
        node graphs (one outer batch fans out to ~100 sub-batches × 500
        MERGEs, each scanning all nodes).

        FalkorDB versions vary on whether ``CREATE INDEX FOR (n) ON (n.urn)``
        without a label predicate is supported; we attempt it best-effort
        and fall through silently on older releases (the existing per-label
        URN indexes remain in place for labeled queries).
        """

        try:
            await self._proj_query("CREATE INDEX FOR (n:_Projection) ON (n.urn)")
        except Exception:
            pass  # Index may already exist

        # Label-less URN index. FalkorDB's openCypher requires a label on an index, so
        # `CREATE INDEX FOR (n) ON (n.urn)` is unsupported on every build — AND it is no
        # longer needed: every write/read hot path (bulk load, incremental MERGE, and the
        # AGGREGATED upsert at projection.py) is label-qualified and served by the per-label
        # URN indexes. Discover support ONCE PER SERVER so onboarding many graphs doesn't
        # re-attempt and re-log the same fallback on each graph (the recurring "falling back
        # to per-label indexes" noise).
        server = (self._host, self._port)
        if server not in _UNLABELED_URN_UNSUPPORTED:
            try:
                await self._proj_query("CREATE INDEX FOR (n) ON (n.urn)")
            except Exception:
                _UNLABELED_URN_UNSUPPORTED.add(server)
                logger.info(
                    "FalkorDB %s:%s uses the labeled-index strategy (no label-less property "
                    "index on this build; every hot path is label-qualified and index-driven "
                    "via the per-label URN indexes). Expected — not a degradation.",
                    self._host, self._port,
                )

        # Index-health smoke probe: log the summary ONCE per server (not per onboarded
        # graph). Surfaces a genuinely missing index without spamming every reconcile.
        if server not in _INDEX_HEALTH_LOGGED:
            _INDEX_HEALTH_LOGGED.add(server)
            await self._log_aggregation_index_health()

    async def _log_aggregation_index_health(self) -> None:
        """Introspect the projection graph's index catalogue and log a
        one-line summary of AGGREGATED-relevant indexes.

        Runs ``CALL db.indexes()`` defensively (column order varies by
        FalkorDB version; row shape may differ on very old releases).
        Categorizes results into:

        - **labeled URN indexes**: ``(:Label) ON (n.urn)`` — drives every
          label-qualified MATCH in the bulk-rebuild path.
        - **unlabeled URN index**: ``() ON (n.urn)`` — drives the
          incremental MERGE path and the label-resolution fallback.
        - **AGGREGATED edge indexes**: ``()-[r:AGGREGATED]-() ON
          (r.sourceLevel ...)`` — drives the trace fast path.

        Never raises; never blocks startup. A missing index is reported
        at WARNING level so it surfaces in operator alerts.
        """
        try:
            res = await asyncio.wait_for(
                self._proj.ro_query("CALL db.indexes()", {}),
                timeout=2.0,
            )
        except Exception as exc:
            logger.info(
                "Index health probe on %s: CALL db.indexes() not "
                "available (%s) — skipping. Operator should verify "
                "indexes manually if aggregation perf is poor.",
                self._graph_name, exc,
            )
            return

        rows = res.result_set or []
        labeled_urn: List[str] = []
        unlabeled_urn = False
        aggregated_indexes: List[str] = []

        for row in rows:
            # FalkorDB row column order historically: label, properties,
            # types, language, stopwords, entitytype, info. We only need
            # the first three and read defensively.
            if not row:
                continue
            label = row[0] if len(row) > 0 else None
            props = row[1] if len(row) > 1 else None
            entity_type_col = row[5] if len(row) > 5 else None

            # Normalize: label may be None / "" for unlabeled indexes.
            # props is typically a list of strings.
            prop_list: List[str] = []
            if isinstance(props, (list, tuple)):
                prop_list = [str(p) for p in props]
            elif isinstance(props, str):
                prop_list = [props]

            is_edge_index = False
            if isinstance(entity_type_col, str):
                is_edge_index = entity_type_col.upper().startswith("RELAT")

            # Edge index on AGGREGATED?
            if (
                is_edge_index
                and isinstance(label, str)
                and label.upper() == "AGGREGATED"
            ):
                aggregated_indexes.append(
                    f"({label} ON {prop_list})"
                )
                continue

            # Node index on URN.
            if "urn" in prop_list:
                if label:
                    labeled_urn.append(str(label))
                else:
                    unlabeled_urn = True

        if labeled_urn or unlabeled_urn or aggregated_indexes:
            logger.info(
                "Index health on %s: labeled_urn=%d (%s), "
                "unlabeled_urn=%s, aggregated_edge_indexes=%d (%s)",
                self._graph_name,
                len(labeled_urn),
                ",".join(sorted(set(labeled_urn))[:8])
                + ("..." if len(set(labeled_urn)) > 8 else ""),
                "present" if unlabeled_urn else "MISSING",
                len(aggregated_indexes),
                "; ".join(aggregated_indexes) or "none",
            )
        else:
            logger.warning(
                "Index health on %s: NO URN or AGGREGATED indexes detected. "
                "Aggregation will scan every node on every MERGE/MATCH — "
                "this is the 200%% CPU configuration. Verify "
                "_initialize_indices ran and the FalkorDB version supports "
                "the CREATE INDEX syntax in use.",
                self._graph_name,
            )

        if not unlabeled_urn:
            # Labeled-only is a fully supported strategy: every hot path
            # (ancestor chains, node directory, apply MERGEs, the
            # incremental write hook, on-demand reads) anchors on the
            # per-label URN indexes. Health depends only on whether every
            # ontology label is covered — warn on GAPS, not on the
            # server lacking unlabeled-index support.
            entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
            expected: set = set()
            for lbl in entity_levels:
                expected.update(self._alias_entity_types([lbl]))
            have = set(labeled_urn)
            missing = sorted(l for l in expected if l not in have)
            if missing:
                logger.warning(
                    "Index health on %s: no unlabeled URN index (server "
                    "does not support it) and %d ontology label(s) lack a "
                    "URN index: %s. Queries anchored on those labels will "
                    "scan — run ensure_indices / retrigger aggregation to "
                    "create them.",
                    self._graph_name, len(missing), ", ".join(missing[:8]),
                )
            else:
                logger.info(
                    "Index health on %s: labeled-only strategy active "
                    "(server lacks unlabeled-index support; every ontology "
                    "label has a URN index — job hot paths are index-"
                    "driven; bounded visible-set reads may still issue "
                    "single-scan queries).",
                    self._graph_name,
                )

    def _ancestors_cache_key(self) -> str:
        """Return the Redis Hash key for ancestor chains in this graph,
        scoped by the resolved containment-types fingerprint.

        Different containment configurations resolve to different
        ancestor chains for the same URN, so they must live in
        different cache namespaces. Without this scoping, a prior job
        that ran with empty ``containment_edge_types`` would cache
        ``"[]"`` for every URN and every subsequent job (with proper
        types) would silently see cache hits and produce only
        leaf-to-leaf AGGREGATED edges instead of propagating up the
        containment tree.

        The fingerprint is a short SHA1 over the sorted, upper-cased
        type names. Empty / unset → a stable empty-set fingerprint
        that flat-graph aggregations reuse safely. Identical
        configurations (across jobs, across caller paths) reuse the
        same key — full intra- and cross-job caching preserved.
        """
        import hashlib

        types = getattr(self, "_resolved_containment_types", None) or set()
        if not isinstance(types, (set, frozenset, list, tuple)):
            types = set()
        normalised = ",".join(sorted(t.upper() for t in types))
        digest = hashlib.sha1(normalised.encode("utf-8")).hexdigest()[:12]
        return f"{self._cache_ns}:ancestors:{digest}"

    async def _get_ancestor_chain(self, urn: str) -> List[str]:
        """Get pre-computed ancestor chain from Redis Hash, or compute + cache it.

        Returns list of URNs from immediate parent to root (ordered).
        The cache key includes a containment-types fingerprint so a
        change to the resolved containment configuration cannot return
        a stale chain from a prior config (see ``_ancestors_cache_key``).
        """
        cache_key = self._ancestors_cache_key()
        try:
            raw = await self._redis.execute_command("HGET", cache_key, urn)
            if raw:
                return json.loads(raw)
        except Exception:
            pass

        # Cache miss — compute from graph and store
        ancestors = await self._compute_ancestor_chain(urn)
        try:
            await self._redis.execute_command(
                "HSET", cache_key, urn, json.dumps(ancestors)
            )
            # TTL so the ancestors hash stays evictable (see _cache_urn_label).
            await self._redis.expire(cache_key, self._ancestor_cache_ttl())
        except Exception as e:
            logger.debug(f"Failed to cache ancestor chain for {urn}: {e}")
        return ancestors

    async def _compute_ancestor_chain(self, urn: str) -> List[str]:
        """Single Cypher query to walk containment edges upward (1 query instead of N).

        Variable-length depth bound is the number of entity-type levels
        in the resolved ontology (clamped to a 10 floor for safety on
        cold caches). This is tighter and more correct than the legacy
        hardcoded ``*1..10`` for shallow ontologies, and extends to
        deeper ones without code edits.
        """
        # Delegates to the label-driven bulk path — the previous
        # unlabeled ``WHERE child.urn = $urn`` was a full node scan per
        # call on servers without unlabeled-index support.
        chains = await self._compute_ancestor_chains_bulk_cypher([urn])
        return chains.get(urn, [])

    async def _compute_and_store_ancestors_bulk(
        self,
        urns: List[str],
    ) -> Dict[str, List[str]]:
        """Compute and cache ancestor chains for multiple URNs at once.

        Uses Redis pipeline for batch HGET/HSET and a single bulk Cypher
        (``UNWIND $urns AS u``) to compute every missing chain in one
        round-trip per chunk, eliminating the per-URN compile + send +
        receive overhead that previously dominated this path on large
        outer batches. Cache namespace is scoped by containment-types
        fingerprint (see ``_ancestors_cache_key``) so a config change
        cannot leak stale chains from a prior configuration.

        On bulk-Cypher failure, falls back to the per-URN path with
        bounded concurrency so a single planner hiccup doesn't fail the
        whole outer batch.
        """
        cache_key = self._ancestors_cache_key()
        result: Dict[str, List[str]] = {}

        if not urns:
            return result

        # First, try to fetch all from cache in one pipeline
        try:
            pipe = self._redis.pipeline(transaction=False)
            for u in urns:
                pipe.execute_command("HGET", cache_key, u)
            cached = await pipe.execute()

            missing_urns = []
            for i, u in enumerate(urns):
                if cached[i]:
                    try:
                        result[u] = json.loads(cached[i])
                    except Exception:
                        missing_urns.append(u)
                else:
                    missing_urns.append(u)
        except Exception:
            missing_urns = list(urns)

        if missing_urns:
            try:
                computed = await self._compute_ancestor_chains_bulk_cypher(missing_urns)
            except Exception as exc:
                logger.warning(
                    "Bulk ancestor Cypher failed for %d urns (%s); "
                    "falling back to per-URN computation.",
                    len(missing_urns), exc,
                )
                _MAX_ANCESTOR_CONCURRENCY = 4
                sem = asyncio.Semaphore(_MAX_ANCESTOR_CONCURRENCY)

                async def _compute_with_sem(urn: str) -> tuple[str, list]:
                    async with sem:
                        try:
                            return urn, await self._compute_ancestor_chain(urn)
                        except Exception as e:
                            logger.warning(
                                "Failed to compute ancestor chain for %s: %s", urn, e,
                            )
                            return urn, []

                pairs = await asyncio.gather(
                    *(_compute_with_sem(u) for u in missing_urns),
                )
                computed = {u: chain for u, chain in pairs}

            for u in missing_urns:
                result[u] = computed.get(u, [])

            # Batch-store all computed chains in one pipeline.
            #
            # The cache is an OPTIMIZATION, never a hard dependency. There is no
            # cache client when CACHE_REDIS_URL is unset OR when the dedicated
            # cache Redis is simply DOWN (``build_cache_client`` returns None by
            # construction — it never co-locates the cache on FalkorDB). Guard
            # the write: this line used to raise AttributeError on a None client
            # and, because the raise escaped the whole method, it THREW AWAY the
            # chains that had just been computed successfully above. Callers saw
            # `truncated: ancestors_failed` and a trace with NO containment tree
            # — i.e. a cache outage silently broke the graph read path, the exact
            # inverse of the decoupling's intent.
            if self._redis is not None:
                store_pipe = self._redis.pipeline(transaction=False)
                for u in missing_urns:
                    store_pipe.execute_command(
                        "HSET", cache_key, u, json.dumps(result.get(u, [])),
                    )
                # TTL so the ancestors hash stays evictable (see _cache_urn_label).
                store_pipe.expire(cache_key, self._ancestor_cache_ttl())
                try:
                    await store_pipe.execute()
                except Exception as e:
                    logger.debug(f"Failed to batch-store ancestor chains: {e}")

        return result

    def _ancestor_cache_ttl(self) -> int:
        return int(os.getenv("FALKORDB_ANCESTOR_CACHE_TTL_S", "604800"))  # 7d

    async def _compute_ancestor_chains_bulk_cypher(
        self,
        urns: List[str],
    ) -> Dict[str, List[str]]:
        """Compute ancestor chains for many URNs in a single Cypher.

        Preserves the longest-path semantics of
        ``_compute_ancestor_chain``: each URN's chain is the ordered
        ``[parent, grandparent, ...]`` along the longest containment
        path, matching what callers that depend on parent-before-
        grandparent ordering already expect.

        Internally chunked to bound the per-query parameter size; the
        planner sees one set of bound variables per chunk and only one
        round-trip is paid per chunk regardless of how many URNs miss
        the cache. This is the fix for the per-URN scan amplification
        documented in the aggregation hardening plan.
        """
        out: Dict[str, List[str]] = {u: [] for u in urns}
        if not urns:
            return out

        containment = list(self._get_containment_edge_types())
        if not containment:
            # Flat graph — no ancestors for any URN.
            return out

        containment_cypher = "|".join(_sanitize_label(t) for t in containment)
        max_depth = self._containment_hop_bound()

        # Keep parameter lists bounded so a single misconfigured outer
        # batch (e.g. 10k URNs) doesn't generate a single oversized
        # query plan that itself spikes provider CPU. The default is tuned
        # to cut per-page round-trips (each page resolves ~2×batch_size URNs);
        # override via FALKORDB_ANCESTOR_CHUNK_SIZE.
        chunk_size = int(os.getenv("FALKORDB_ANCESTOR_CHUNK_SIZE", "2000"))

        # LABEL-DRIVEN anchoring. An unlabeled ``MATCH (child) WHERE
        # child.urn IN $urns`` is a FULL node scan per chunk on FalkorDB
        # versions without unlabeled-index support (observed: 1776-urn
        # chunk timing out on a 1M-node graph, then degrading to 1776
        # per-URN full scans). Every ontology label has a URN index, so
        # each chunk is classified per label (indexed IN lookups) and
        # the path expansion anchors on ``(child:Label)`` — index seeks
        # end to end. URNs matching no ontology label sit outside the
        # containment hierarchy and keep their pre-initialized [] chain.
        def _chain_cypher(label_clause: str) -> str:
            return (
                f"MATCH (child{label_clause}) WHERE child.urn IN $urns "
                f"OPTIONAL MATCH path = (child)<-[:{containment_cypher}*1..{max_depth}]-(a) "
                "WITH child.urn AS u, "
                "     [n IN nodes(path)[1..] | n.urn] AS chain_candidate, "
                "     coalesce(length(path), 0) AS plen "
                "ORDER BY u, plen DESC "
                "WITH u, collect(chain_candidate) AS candidates "
                "RETURN u, coalesce(candidates[0], []) AS chain"
            )

        for i in range(0, len(urns), chunk_size):
            chunk = urns[i : i + chunk_size]
            # Bucket via the urn→label cache (per-label bootstrap on miss)
            # instead of the previous per-label MEMBERSHIP query + chain
            # query run SEQUENTIALLY per ontology label (2·L round trips
            # per chunk — the dominant sequential amplifier of trace
            # hydration). One chain query per non-empty bucket, GATHERED;
            # the unresolved-label residue keeps the unlabeled fallback.
            buckets = await self._label_buckets(chunk)

            async def _chain_for(label: str, bucket: List[str]) -> list:
                clause = f":{label}" if label else ""
                try:
                    res = await self._ro_query(
                        _chain_cypher(clause), params={"urns": bucket},
                        op="trace.chains",
                    )
                    return res.result_set or []
                except Exception as exc:
                    logger.warning(
                        "ancestor chain bucket (%s, %d urns) failed: %s",
                        label or "<unlabeled>", len(bucket), exc,
                    )
                    return []

            for rows in await asyncio.gather(*[
                _chain_for(lbl, bucket) for lbl, bucket in buckets
            ]):
                for row in rows:
                    # Drop None entries (node lacked .urn) so callers
                    # don't defend against them.
                    out[row[0]] = [c for c in (row[1] or []) if c]

        return out

    # ------------------------------------------------------------------ #
    # Batch-level materialization (used by materialize_aggregated_edges_batch)
    # ------------------------------------------------------------------ #

    # Max ancestor pairs per Cypher UNWIND+MERGE call.  Each input edge
    # fans out to ~4 ancestor pairs (s_chain × t_chain), so 5000 input
    # edges produce ~20K pairs.  A single MERGE with 20K items + REDUCE
    # exceeds FalkorDB's 3s socket_timeout.  500 pairs keeps each call
    # well under 1s while still being 500× fewer round-trips than the
    # old per-edge approach. This is the *ceiling*; the per-graph
    # adaptive sizer (``_aggregation_sub_batch_size``) shrinks toward
    # ``_MERGE_SUB_BATCH_MIN`` when MERGE latency creeps past
    # ``_MERGE_SUB_BATCH_TARGET_HIGH_S`` (AIMD), and grows back toward
    # the ceiling after a run of healthy sub-batches.
    _MERGE_SUB_BATCH_SIZE = 500
    _MERGE_SUB_BATCH_MIN = 50
    _MERGE_SUB_BATCH_TARGET_HIGH_S = 2.0
    _MERGE_SUB_BATCH_TARGET_LOW_S = 0.8
    _MERGE_SUB_BATCH_GROW_AFTER = 5
    _MERGE_SUB_BATCH_GROW_STEP = 100

    # UNWIND batch size for bulk-CREATE. FalkorDB's documented best
    # practice is 10k–50k rows per UNWIND: large batches amortize the
    # parser/planner overhead, and CREATE is O(1) per row so larger
    # batches don't widen the per-row variance. The layered-lineage
    # importer uses 2000 because its writes are MERGE-on-node (which is
    # more variance-prone); our path is CREATE-on-relationship, which
    # tolerates and benefits from the higher number.
    _BULK_CREATE_BATCH_SIZE = _BULK_CREATE_BATCH_DEFAULT
    _BULK_WIPE_BATCH_SIZE = 50000    # cursored DELETE chunk for AGGREGATED wipe

    async def _wipe_aggregated_edges(
        self,
        *,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> int:
        """Drop all :AGGREGATED edges on the projection graph in cursored chunks.

        Returns the total number of edges deleted. Each chunk is bounded so
        a single statement can't exceed the write timeout on a graph with
        millions of AGGREGATED edges; the loop converges when a chunk
        deletes zero rows.

        Short-circuits with a single cheap existence probe before issuing
        any DELETE — on a fresh graph (first bulk rebuild ever), this
        saves the millisecond-scale empty-DELETE round-trip; more
        importantly, on a graph where AGGREGATED happens to already be
        empty, the probe returns instantly and we don't pay any wipe
        time at all.
        """
        probe = await self._proj_query(
            "MATCH ()-[r:AGGREGATED]->() RETURN r LIMIT 1"
        )
        if not (probe.result_set or []):
            logger.info(
                "Bulk wipe AGGREGATED on %s: graph has no AGGREGATED edges, "
                "skipping wipe phase.", self._graph_name,
            )
            return 0

        total_deleted = 0
        while True:
            if should_cancel is not None and should_cancel():
                from backend.app.services.aggregation.cancel import JobCancelled
                from datetime import datetime, timezone
                raise JobCancelled(
                    job_id="<bulk-wipe-cancel>",
                    observed_at=datetime.now(timezone.utc).isoformat(),
                )
            res = await self._proj_query(
                "MATCH ()-[r:AGGREGATED]->() "
                f"WITH r LIMIT {self._BULK_WIPE_BATCH_SIZE} "
                "DELETE r RETURN count(r) AS n"
            )
            n = 0
            if res.result_set:
                first = res.result_set[0]
                n = (first[0] if first else 0) or 0
            total_deleted += int(n)
            if n == 0:
                break
            logger.info(
                "Bulk wipe AGGREGATED on %s: chunk deleted %d (running total %d)",
                self._graph_name, n, total_deleted,
            )
        return total_deleted

    async def _purge_aggregated_idempotency_namespace(self) -> None:
        """Drop all Redis SADD members tracking AGGREGATED edge contributors.

        Required before a bulk rebuild — stale members from a prior attempt
        would inflate weights or carry stale contributor edge_ids forward
        into the rebuilt graph.
        """
        pattern = f"{self._agg_members_prefix()}:*"
        cursor: int = 0
        deleted = 0
        try:
            while True:
                reply = await self._redis.execute_command(
                    "SCAN", cursor, "MATCH", pattern, "COUNT", 1000,
                )
                # python-redis returns (cursor, [keys]); both may be bytes.
                next_cursor, keys = reply[0], reply[1]
                if isinstance(next_cursor, (bytes, bytearray)):
                    next_cursor = int(next_cursor)
                else:
                    next_cursor = int(next_cursor)
                if keys:
                    pipe = self._redis.pipeline(transaction=False)
                    for k in keys:
                        pipe.delete(k)
                    await pipe.execute()
                    deleted += len(keys)
                cursor = next_cursor
                if cursor == 0:
                    break
        except Exception as exc:
            logger.warning(
                "Idempotency namespace purge failed on %s (continuing — stale "
                "members may inflate the first incremental edge's weight): %s",
                self._graph_name, exc,
            )
            return
        if deleted:
            logger.info(
                "Purged %d Redis agg_members keys on %s before bulk rebuild.",
                deleted, self._graph_name,
            )

    async def _label_buckets(
        self, urns: List[str],
    ) -> List[Tuple[str, List[str]]]:
        """Group URNs by their sanitized node label so every anchor can
        be label-qualified into a per-label URN-index SEEK. This build
        has no label-less URN index, so an unlabeled ``WHERE n.urn IN
        $list`` anchor is a FULL node/relation scan with per-row IN-list
        membership — observed live at 4-9s per query on a 2M-node graph
        (and timing out the stored aggregated read entirely). The ``""``
        bucket collects URNs whose label could not be resolved; callers
        keep the unlabeled pattern for that (bounded) residue."""
        uniq = list(dict.fromkeys(u for u in urns if u))
        if not uniq:
            return []
        try:
            labels = await self._resolve_urn_labels_bulk(uniq)
        except Exception as exc:
            logger.debug("label bucketing failed (%s) — unlabeled fallback", exc)
            return [("", uniq)]
        buckets: Dict[str, List[str]] = {}
        for u in uniq:
            buckets.setdefault(labels.get(u) or "", []).append(u)
        return sorted(buckets.items())

    async def _resolve_urn_labels_bulk(
        self, urns: List[str],
    ) -> Dict[str, Optional[str]]:
        """Resolve URN → sanitized-label for many URNs at once.

        First consults the Redis URN→label cache populated as a side
        effect of node upserts / get_node calls. For misses, falls back
        to a single bulk Cypher querying labels for the missing URNs
        (one round-trip regardless of miss count). Caches results back
        to Redis for subsequent calls.

        Returns dict with every input URN as a key; the value is
        ``None`` when the URN's label could not be resolved (caller
        routes through the unlabeled fallback CREATE path for these).
        """
        out: Dict[str, Optional[str]] = {}
        if not urns:
            return out

        label_key = self._urn_label_key()
        missing: List[str] = []

        try:
            pipe = self._redis.pipeline(transaction=False)
            for u in urns:
                pipe.hget(label_key, u)
            raws = await pipe.execute()
            for u, raw in zip(urns, raws):
                if raw is None:
                    missing.append(u)
                else:
                    lbl = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
                    out[u] = _sanitize_label(lbl)
        except Exception:
            missing = list(urns)

        if missing:
            try:
                # Cache-miss bootstrap via PER-LABEL index seeks. The
                # previous single unlabeled ``WHERE n.urn IN $urns`` scan
                # was itself the bottleneck it tried to avoid: on builds
                # without a label-less URN index it is a FULL node scan —
                # observed timing out on a 2M-node graph, which then
                # dumped every reader into the unlabeled slow path
                # (cold-cache chicken-and-egg: resolving labels needed a
                # label). Enumerating the graph's few observed labels and
                # seeking each label's URN index turns the bootstrap into
                # K index-driven queries; the startup warmup caps out at
                # 200k nodes per label, so big graphs ALWAYS hit this
                # path for most of their nodes.
                rows: list = []
                try:
                    lbl_res = await self._ro_query(
                        "CALL db.labels() YIELD label RETURN label",
                        timeout=5.0,
                    )
                    observed = [
                        str(r[0]) for r in (lbl_res.result_set or [])
                        if r and r[0] and not str(r[0]).startswith("_")
                    ]
                except Exception:
                    observed = []
                if observed:
                    unresolved = list(missing)
                    for lbl in observed:
                        if not unresolved:
                            break
                        safe = _sanitize_label(lbl)
                        res = await self._ro_query(
                            f"MATCH (n:{safe}) WHERE n.urn IN $urns "
                            "RETURN n.urn AS u",
                            params={"urns": unresolved},
                        )
                        hit = {
                            r[0] for r in (res.result_set or []) if r and r[0]
                        }
                        rows.extend([u, lbl] for u in hit)
                        if hit:
                            unresolved = [u for u in unresolved if u not in hit]
                    res = type("R", (), {"result_set": rows})()
                else:
                    # Label enumeration unavailable — legacy single scan.
                    res = await self._ro_query(
                        "MATCH (n) WHERE n.urn IN $urns "
                        "RETURN n.urn AS u, labels(n)[0] AS label",
                        params={"urns": missing},
                    )
                # The cache is an OPTIMIZATION, never a hard dependency. Resolve
                # the result FIRST, then write the cache only if a client exists.
                # This pipeline used to be opened BEFORE the loop, so a None
                # client (unset CACHE_REDIS_URL, or the dedicated cache Redis
                # simply DOWN — build_cache_client returns None by construction)
                # raised before ``out`` was ever populated. That threw away labels
                # which had resolved perfectly well and pushed the caller into the
                # unlabeled-MATCH fallback — i.e. a FULL NODE SCAN, the
                # 4-9s-on-2M-nodes antipattern this very cache exists to avoid.
                # A cache outage must not knock every label lookup off its index.
                resolved_labels: List[Tuple[str, str]] = []
                for row in res.result_set or []:
                    urn, label = row[0], row[1]
                    if label:
                        safe = _sanitize_label(label)
                        out[urn] = safe
                        resolved_labels.append((urn, safe))
                    else:
                        out[urn] = None
                if resolved_labels and self._redis is not None:
                    try:
                        store_pipe = self._redis.pipeline(transaction=False)
                        for urn, safe in resolved_labels:
                            store_pipe.hset(label_key, urn, safe)
                        await store_pipe.execute()
                    except Exception:
                        pass
            except Exception as exc:
                logger.warning(
                    "Bulk URN label resolution failed for %d URNs (will fall "
                    "back to unlabeled MATCH for these): %s",
                    len(missing), exc,
                )

        for u in urns:
            out.setdefault(u, None)
        return out

    async def _ensure_label_urn_indexes(self, labels: Set[str]) -> None:
        """Create per-label URN indexes for every label that will be
        matched during bulk-CREATE. Idempotent — best-effort on failure.

        Mirrors the pattern in the layered-lineage importer — indexes go in
        BEFORE any writes so every MATCH/CREATE row is an index seek.
        """
        if not labels:
            return
        _init_timeout = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))
        for label in labels:
            try:
                await asyncio.wait_for(
                    self._proj.query(
                        f"CREATE INDEX FOR (n:{label}) ON (n.urn)",
                    ),
                    timeout=_init_timeout,
                )
            except Exception:
                pass  # already exists or unsupported

    async def _warmup_urn_label_cache_for_aggregation(self) -> None:
        """Pre-populate the Redis URN→label cache via one labeled scan
        per label in the graph.

        This is the Phase 1.8 fix for the write-side timeout fire on
        `sol_xlarge_test2`. Without warmup, `_resolve_urn_labels_bulk`
        falls back to a single unlabeled bulk Cypher
        (``MATCH (n) WHERE n.urn IN $urns ...``) on every cache miss.
        On a multi-million-node graph without an unlabeled URN index,
        that single Cypher can exceed the 5s read timeout and return
        no rows — leaving every URN in the missing list mapped to
        ``None``, which previously routed pairs to the (now-removed)
        unlabeled-fallback CREATE that scanned per row and busted the
        write timeout.

        With warmup, the cache is hot for every legitimately-labeled
        node BEFORE Phase C runs. Per-label scans use the per-label
        URN index (already created in ``_initialize_indices`` /
        ``_ensure_label_urn_indexes``), so each scan is index-assisted
        and fast. URNs still unresolved after warmup are genuinely
        label-less (legacy MERGE residue) or missing nodes; Phase 1.8
        drops those pairs with a count + sample warning rather than
        scanning forever.
        """
        try:
            res = await asyncio.wait_for(
                self._proj.ro_query("CALL db.labels() YIELD label RETURN label", {}),
                timeout=2.0,
            )
        except Exception as exc:
            logger.info(
                "URN→label warmup on %s: CALL db.labels() unavailable (%s); "
                "skipping warmup. _resolve_urn_labels_bulk will run its "
                "fallback Cypher on cache miss.",
                self._graph_name, exc,
            )
            return

        labels: List[str] = []
        for row in (res.result_set or []):
            if row and row[0]:
                lbl = row[0].decode("utf-8") if isinstance(row[0], (bytes, bytearray)) else str(row[0])
                if lbl.startswith("_"):
                    continue  # system-internal labels carry no URNs
                labels.append(lbl)
        if not labels:
            return

        label_key = self._urn_label_key()
        t_start = time.monotonic()
        total_cached = 0

        # Per-label hard cap to bound memory + cache size on huge labels.
        # ``layered_lineage_perf_xlarge`` style graphs sit well below this, and
        # any label with >200k nodes likely doesn't benefit from a full
        # cache pre-warm anyway (the per-label index seek at lookup time
        # is already fast).
        per_label_cap = int(os.getenv("FALKORDB_URN_LABEL_WARMUP_PER_LABEL_CAP", "200000"))
        per_label_timeout = float(os.getenv("FALKORDB_URN_LABEL_WARMUP_TIMEOUT_S", "30"))

        # CONTAINER-FIRST (BFS-priority) warm: the canvas opens at the
        # roots and expands container-by-container, so the nodes every
        # early request resolves are the CONTAINERS — and there are only
        # thousands of them even on a 2M-node graph. The stored
        # :AGGREGATED endpoints ARE that working set by construction
        # (every rollup endpoint is a container the canvas can show), and
        # the relation-anchored scan carries the labels along — no
        # dependence on denormalized properties (childCount proved
        # unpopulated on real import paths). The per-label fill passes
        # below top up to the cap; HSET idempotency dedupes the overlap.
        try:
            prio_pipe = self._redis.pipeline(transaction=False)
            prio_count = 0
            for prio_cypher in (
                f"MATCH (s)-[r:AGGREGATED]->() "
                f"RETURN DISTINCT s.urn, labels(s)[0] LIMIT {per_label_cap}",
                f"MATCH ()-[r:AGGREGATED]->(t) "
                f"RETURN DISTINCT t.urn, labels(t)[0] LIMIT {per_label_cap}",
            ):
                pr = await asyncio.wait_for(
                    self._proj.ro_query(prio_cypher, {}),
                    timeout=per_label_timeout,
                )
                for row in (pr.result_set or []):
                    if row and row[0] and row[1]:
                        urn = row[0]
                        if isinstance(urn, (bytes, bytearray)):
                            urn = urn.decode("utf-8")
                        prio_pipe.hset(
                            label_key, urn, _sanitize_label(str(row[1])),
                        )
                        prio_count += 1
            if prio_count:
                await prio_pipe.execute()
                total_cached += prio_count
                logger.info(
                    "URN→label warmup on %s: container-priority pass cached "
                    "%d rollup-endpoint entries.",
                    self._graph_name, prio_count,
                )
        except Exception as exc:
            logger.debug(
                "URN→label warmup on %s: container-priority pass failed "
                "(%s) — per-label fill only.", self._graph_name, exc,
            )

        for label in labels:
            safe = _sanitize_label(label)
            rows: list = []
            remaining = per_label_cap - len(rows)
            if remaining > 0:
                try:
                    lr = await asyncio.wait_for(
                        self._proj.ro_query(
                            f"MATCH (n:{safe}) RETURN n.urn LIMIT {remaining}",
                            {},
                        ),
                        timeout=per_label_timeout,
                    )
                    rows.extend(lr.result_set or [])
                except Exception as exc:
                    logger.warning(
                        "URN→label warmup on %s: scan for label %r failed (%s); "
                        "skipping. Pairs with %s-labeled endpoints may still hit "
                        "the resolver fallback Cypher.",
                        self._graph_name, label, exc, label,
                    )
            if not rows:
                continue

            pipe = self._redis.pipeline(transaction=False)
            count = 0
            for row in rows:
                urn = row[0]
                if not urn:
                    continue
                if isinstance(urn, (bytes, bytearray)):
                    urn = urn.decode("utf-8")
                pipe.hset(label_key, urn, safe)
                count += 1
            try:
                await pipe.execute()
                total_cached += count
            except Exception as exc:
                logger.warning(
                    "URN→label warmup on %s: pipeline failed for label %r "
                    "(%d entries lost): %s",
                    self._graph_name, label, count, exc,
                )

        # TTL on the whole per-graph hash: the cache Redis runs
        # volatile-lru, which can ONLY evict keys that carry a TTL — a
        # TTL-less hash is unevictable and a fleet of warmed 2M-node
        # graphs would wedge the instance at maxmemory. Refreshed on
        # every warmup; idle graphs age out and the self-healing
        # bootstrap rebuilds them on first touch.
        try:
            ttl_s = int(os.getenv("FALKORDB_URN_LABEL_CACHE_TTL_S", "604800"))
            if ttl_s > 0:
                await self._redis.expire(label_key, ttl_s)
        except Exception:
            pass

        elapsed_ms = (time.monotonic() - t_start) * 1000
        logger.info(
            "URN→label warmup on %s: cached %d urn→label entries across "
            "%d labels in %.1fms",
            self._graph_name, total_cached, len(labels), elapsed_ms,
        )

    async def _estimate_lineage_edge_count(
        self, lineage_types: List[str],
    ) -> int:
        """Best-effort lineage-edge total WITHOUT a full-graph scan.

        Reads the graph stats the stats service already maintains
        (``{graph}:stats_cache``, written by ``get_stats``) and sums the
        counts for the resolved lineage types. Returns 0 when no cache is
        available — the caller treats 0 as "unknown" and drives progress
        off the processed-edge count instead of a percentage.
        """
        if not lineage_types or self._redis is None:
            return 0
        try:
            cached = await self._redis.get(f"{self._cache_ns}:stats_cache")
            if not cached:
                return 0
            data = json.loads(cached)
            counts = data.get("edgeTypeCounts") or {}
            wanted = {str(t).upper() for t in lineage_types}
            total = 0
            for t, c in counts.items():
                if str(t).upper() in wanted:
                    try:
                        total += int(c)
                    except (ValueError, TypeError):
                        continue
            return total
        except Exception:
            return 0

    async def _derive_lineage_types_from_cache(
        self, containment: List[str],
    ) -> List[str]:
        """Derive lineage edge types from cached graph stats (no scan).

        Only used when the caller supplied no explicit lineage whitelist —
        in practice the ontology always freezes lineage types onto the job,
        so this is a defensive fallback.
        """
        if self._redis is None:
            return []
        exclude = {str(c).upper() for c in (containment or [])} | {"AGGREGATED"}
        try:
            cached = await self._redis.get(f"{self._cache_ns}:stats_cache")
            if not cached:
                return []
            data = json.loads(cached)
            counts = data.get("edgeTypeCounts") or {}
            return [t for t in counts if str(t).upper() not in exclude]
        except Exception:
            return []


    async def _resolve_chain_levels(
        self,
        s_chain: List[str],
        t_chain: List[str],
        entity_levels: Dict[str, int],
        *,
        caller: str,
    ) -> Optional[Tuple[Dict[str, int], Dict[str, str]]]:
        """(urn → level, urn → label) for both ancestor chains via the
        urn→label cache — the level/label resolution SHARED by the write
        and delete hooks so their pair selection can never diverge.

        Returns ``None`` when the hook must DEFER to the batch pipeline: a
        partially-resolved chain silently yields non-canonical rep pairs
        (a missing middle label makes the "deepest rep" skip a level),
        polluting the boundary. No level map ⇒ empty maps (legacy mode)."""
        urn_levels: Dict[str, int] = {}
        urn_labels: Dict[str, str] = {}
        if not entity_levels:
            return urn_levels, urn_labels
        chain_urns = list(dict.fromkeys(s_chain + t_chain))
        # The urn→label cache records the graph's OBSERVED spellings;
        # the level map is keyed by DECLARED ontology ids. Re-key by
        # every observed spelling, or alias-variant sources resolve
        # zero levels and the hooks defer on every single write.
        levels_by_spelling: Dict[str, int] = {}
        for _lbl, _lv in entity_levels.items():
            for _sp in self._alias_entity_types([_lbl]):
                levels_by_spelling[str(_sp)] = _lv
            levels_by_spelling[_lbl] = _lv
        try:
            label_key = self._urn_label_key()
            label_pipe = self._redis.pipeline(transaction=False)
            for u in chain_urns:
                label_pipe.hget(label_key, u)
            rows = await label_pipe.execute()
            unresolved = 0
            for u, raw in zip(chain_urns, rows):
                if not raw:
                    unresolved += 1
                    continue
                lbl = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
                urn_labels[u] = lbl
                lvl = levels_by_spelling.get(lbl)
                if lvl is not None:
                    urn_levels[u] = lvl
            if unresolved:
                logger.debug(
                    "%s: %d chain member(s) not in the urn→label cache — "
                    "deferring to the batch pipeline.", caller, unresolved,
                )
                return None
        except Exception as exc:
            logger.warning("%s: level lookup failed: %s", caller, exc)
            return None
        return urn_levels, urn_labels

    async def _get_ancestor_dag_pair(
        self, source_urn: str, target_urn: str,
    ) -> Optional[Tuple[Dict[str, int], Dict[str, int], bool, bool]]:
        """Both endpoints' ancestor CLOSURES ({ancestor_or_self: depth})
        plus whether each endpoint is itself a container — the DAG input
        the shared pair rules run on. Multi-parent nodes keep every
        ancestry (the flat-chain walk collapsed them to one). Two bounded
        label-free queries: the endpoint profile (children count + depth,
        the WS3 shape) and the distinct-ancestor depth query. Returns
        None when containment types are unconfigured."""
        try:
            containment = list(self._get_containment_edge_types())
        except Exception:
            return None
        if not containment:
            return None
        c_pattern = "|".join(
            _sanitize_label(t) for t in self._alias_rel_types(containment)
        )
        hops = self._containment_hop_bound()
        urns = [source_urn, target_urn]
        prof = await self._ro_query(
            f"MATCH (n) WHERE n.urn IN $urns "
            f"OPTIONAL MATCH (n)-[:{c_pattern}]->(ch) "
            f"WITH n, count(ch) AS kids "
            f"OPTIONAL MATCH p = (a)-[:{c_pattern}*1..{hops}]->(n) "
            f"RETURN n.urn, kids, coalesce(max(length(p)), 0)",
            params={"urns": urns},
        )
        profile: Dict[str, Tuple[bool, int]] = {}
        for row in (prof.result_set or []):
            if row and row[0]:
                profile[str(row[0])] = (int(row[1] or 0) > 0, int(row[2] or 0))
        anc = await self._ro_query(
            f"MATCH (a)-[:{c_pattern}*1..{hops}]->(child) "
            f"WHERE child.urn IN $urns "
            f"WITH DISTINCT child.urn AS cu, a "
            f"OPTIONAL MATCH q = (r0)-[:{c_pattern}*1..{hops}]->(a) "
            f"RETURN cu, a.urn, coalesce(max(length(q)), 0)",
            params={"urns": urns},
        )
        closures: Dict[str, Dict[str, int]] = {u: {} for u in urns}
        for row in (anc.result_set or []):
            if row and row[0] and row[1]:
                closures[str(row[0])][str(row[1])] = int(row[2] or 0)
        s_prof = profile.get(source_urn, (False, 0))
        t_prof = profile.get(target_urn, (False, 0))
        s_cl = dict(closures.get(source_urn) or {})
        t_cl = dict(closures.get(target_urn) or {})
        s_cl[source_urn] = s_prof[1]
        t_cl[target_urn] = t_prof[1]
        return s_cl, t_cl, s_prof[0], t_prof[0]

    def _hook_pairs(
        self,
        regime: str,
        source_urn: str,
        target_urn: str,
        s_cl: Dict[str, int],
        t_cl: Dict[str, int],
        s_is_container: bool,
        t_is_container: bool,
    ) -> List[Tuple[str, str]]:
        """Pair selection for the incremental hooks — the shared
        ``pair_rules`` the batch pipeline stores, dispatched on the
        stored regime so the hook writes exactly what the batch would:
        boundary → canonical depth-bridged container pairs; cube → the
        full ancestor cross-product (raw mirror excluded, matching the
        batch default). Sorted for a deterministic Redis pipeline."""
        from backend.common.providers.pair_rules import boundary_pairs, cube_pairs

        if regime == "cube":
            pairs = set(cube_pairs(
                s_cl, t_cl, include_leaf_mirror=False,
                s=source_urn, t=target_urn,
            ))
        else:
            s_reps = {
                a: d for a, d in s_cl.items()
                if a != source_urn or s_is_container
            }
            t_reps = {
                a: d for a, d in t_cl.items()
                if a != target_urn or t_is_container
            }
            pairs = boundary_pairs(s_reps, t_reps)
        return sorted(pairs)

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> int:
        """Materialize AGGREGATED edges when a lineage edge is written.

        Used for real-time per-edge materialization on individual writes.
        For bulk aggregation, use ``materialize_aggregated_edges_batch`` instead.

        Uses pre-computed ancestor chains instead of Cypher variable-length
        paths, eliminating the Cartesian product explosion.

        Idempotency: Uses Redis Sets to track which leaf edges contribute
        to each AGGREGATED pair. SADD is naturally idempotent.

        Batching: Collects all new pairs, then issues a single UNWIND+MERGE
        instead of one Cypher call per ancestor pair.

        Returns the number of AGGREGATED pairs whose graph edge was
        newly created or had its weight/sourceEdgeTypes updated as a
        result of this call. Returns 0 if every pair was already
        recorded in the Redis idempotency set (nothing to do). Callers
        sum this across the batch to report *actual graph edges
        affected* rather than *input edges processed*.
        """
        await self._ensure_connected()

        # DAG closures (every ancestry of a multi-parent node — the flat
        # chain collapsed them to one and silently dropped the rest) +
        # the stored regime, so the hook writes exactly the pair set the
        # batch pipeline owns.
        dag = await self._get_ancestor_dag_pair(source_urn, target_urn)
        if dag is None:
            logger.debug(
                "on_lineage_edge_written: containment unresolved for "
                "%s -> %s — deferring to the batch pipeline",
                source_urn, target_urn,
            )
            return 0
        s_cl, t_cl, s_cont, t_cont = dag
        meta = await self._aggregation_run_meta()

        members_key_prefix = self._agg_members_prefix()

        # Resolve ontology levels for every closure member up front (one
        # urn→label cache pipeline) — labels anchor the MERGE on per-label
        # URN indexes; levels survive as display stamps.
        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
        resolved = await self._resolve_chain_levels(
            list(s_cl), list(t_cl), entity_levels, caller="on_lineage_edge_written",
        )
        if resolved is None:
            return 0
        urn_levels, urn_labels = resolved

        if entity_levels and not urn_levels:
            # Level map exists but no chain member resolved (cold
            # urn→label cache). Level STAMPS would pollute the boundary;
            # skipping only delays visibility until the next batch run
            # reconciles.
            logger.debug(
                "on_lineage_edge_written: no chain levels resolved "
                "for %s -> %s — deferring to the batch pipeline",
                source_urn, target_urn,
            )
            return 0
        # Shared pair rule, regime-dispatched — mirrors the batch
        # pipeline on any graph shape (levels are stamps, never the
        # selector; depth stamps come from the closures).
        pairs_to_check = self._hook_pairs(
            meta.regime, source_urn, target_urn, s_cl, t_cl, s_cont, t_cont,
        )

        if not pairs_to_check:
            return 0
        depth_of = {**t_cl, **s_cl}

        # Pipeline: SADD for all pairs.
        # Do NOT silently fallback on Redis failure — the previous
        # ``except: sadd_results = [1] * len(...)`` treated every pair
        # as "newly added" and set weight=1, producing incorrect
        # AGGREGATED edges. Let the exception propagate so the caller
        # can count it as an error and, on sustained failure, abort the
        # job via AggregationBatchAbort.
        pipe = self._redis.pipeline(transaction=False)
        for s_urn, t_urn in pairs_to_check:
            member_key = f"{members_key_prefix}:{s_urn}:{t_urn}"
            pipe.execute_command("SADD", member_key, edge_id)
        sadd_results = await pipe.execute()

        # Phase 2: keep only pairs this raw edge hasn't contributed to
        # yet (SADD=1). Weight accounting is INCREMENT-BY-ONE on the
        # graph edge itself — never an overwrite from the Redis set's
        # SCARD, which is a separate accounting system from the batch
        # pipeline's raw-scan weights and would clobber a
        # pipeline-computed weight (observed class: 12,000 → 1).
        new_pairs = [(pairs_to_check[i], sadd_results[i]) for i in range(len(pairs_to_check)) if sadd_results[i] != 0]
        if not new_pairs:
            return 0

        # Phase 3: single UNWIND+MERGE for all new pairs, stamped with
        # the levels resolved up front. Coalesce in the Cypher SET
        # preserves backfilled level values when a fresh resolution
        # misses (same rationale as the batched materializer).
        # UNKNOWN_LEVEL sentinel for endpoints whose label has no declared
        # level. Stamping -1 (instead of leaving sourceLevel NULL) keeps
        # the backfill convergent: the digest WHERE filter sees the edge
        # as "stamped" and skips it on re-runs.
        from backend.app.services.ontology_levels import UNKNOWN_LEVEL

        merge_batch = []
        for (s_urn, t_urn), _ in new_pairs:
            merge_batch.append({
                "s": s_urn, "t": t_urn,
                # Shared edge identity with the batch pipeline: without
                # aggKey the two writers create PARALLEL edges for the
                # same pair, and reconcile (which deletes by aggKey) can
                # never remove the hook's copy.
                "k": f"{s_urn}|{t_urn}",
                "sl": urn_levels.get(s_urn, UNKNOWN_LEVEL),
                "tl": urn_levels.get(t_urn, UNKNOWN_LEVEL),
                # Structural depth stamps — the readers' filter dimension.
                "sd": depth_of.get(s_urn),
                "td": depth_of.get(t_urn),
            })

        # Stamp the current levelDigest so the cold-start probe doesn't
        # flag freshly-created edges as needing backfill. When the
        # ontology drifts later, these edges go stale alongside the
        # pre-existing ones and the next backfill run re-stamps them.
        digest = self._level_digest or ""

        # Do NOT catch exceptions here — the previous ``except: return 0``
        # silently swallowed MERGE failures (including the "Batched
        # AGGREGATED_MERGE failed: timeout" error). The caller in
        # materialize_aggregated_edges_batch has a per-edge try/except
        # that logs and increments the error counter; on sustained
        # failure, AggregationBatchAbort aborts the job and preserves
        # last_cursor for resume.

        _SET_CLAUSE = (
            "MERGE (s)-[r:AGGREGATED {aggKey: item.k}]->(t) "
            "SET r.weight = coalesce(r.weight, 0) + 1, "
            "r.sourceLevel = item.sl, "
            "r.targetLevel = item.tl, "
            "r.sourceDepth = item.sd, "
            "r.targetDepth = item.td, "
            "r.levelDigest = $digest, "
            "r.sourceEdgeTypes = CASE "
            "  WHEN r.sourceEdgeTypes IS NULL THEN [$edgeType] "
            "  WHEN NOT $edgeType IN r.sourceEdgeTypes "
            "    THEN r.sourceEdgeTypes + $edgeType "
            "  ELSE r.sourceEdgeTypes END, "
            "r.latestUpdate = timestamp()"
        )
        # Anchor node MERGEs on the per-label URN indexes (an unlabeled
        # ``MERGE (s {urn: ...})`` is a full node scan per item on
        # servers without unlabeled-index support). Canonical pairs are
        # containers whose labels resolved above; items with unknown
        # labels (legacy level-less graphs) keep the unlabeled pattern.
        by_label_pair: Dict[Tuple[str, str], list] = {}
        unlabeled_items: list = []
        for item in merge_batch:
            s_lbl = urn_labels.get(item["s"])
            t_lbl = urn_labels.get(item["t"])
            if s_lbl and t_lbl:
                by_label_pair.setdefault(
                    (_sanitize_label(s_lbl), _sanitize_label(t_lbl)), [],
                ).append(item)
            else:
                unlabeled_items.append(item)
        for (s_lbl, t_lbl), items in by_label_pair.items():
            await self._proj_query(
                "UNWIND $batch AS item "
                f"MERGE (s:{s_lbl} {{urn: item.s}}) "
                f"MERGE (t:{t_lbl} {{urn: item.t}}) "
                + _SET_CLAUSE,
                params={"batch": items, "edgeType": edge_type, "digest": digest},
            )
        if unlabeled_items:
            await self._proj_query(
                "UNWIND $batch AS item "
                "MERGE (s {urn: item.s}) "
                "MERGE (t {urn: item.t}) "
                + _SET_CLAUSE,
                params={"batch": unlabeled_items, "edgeType": edge_type, "digest": digest},
            )
        return len(merge_batch)

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        """Decrement AGGREGATED edge weights when a lineage edge is removed.

        Mirror of ``on_lineage_edge_written`` (shared chain/level
        resolution + canonical pair selection), inverted:

        * SREM is the GATE — only a pair this edge verifiably contributed
          to via the hook (its id sat in the pair's ``agg_members`` set)
          is touched. The batch pipeline never populates those sets, so
          its cells are left alone for its own reconcile — the old SCARD
          path OVERWROTE pipeline-computed weights with set cardinality
          and DELETED any pair whose set was empty, i.e. every
          batch-written cell (the "12,000 → 1" data-loss class).
        * The graph write is a decrement-by-one via the
          ``AGGREGATED(aggKey)`` edge-index seek — no node lookups at
          all, so nothing to label-anchor; a cell reaching weight 0 is
          deleted in the same query.
        """
        await self._ensure_connected()

        dag = await self._get_ancestor_dag_pair(source_urn, target_urn)
        if dag is None:
            return  # defer to the batch pipeline, like the write hook
        s_cl, t_cl, s_cont, t_cont = dag
        meta = await self._aggregation_run_meta()

        members_key_prefix = self._agg_members_prefix()

        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
        resolved = await self._resolve_chain_levels(
            list(s_cl), list(t_cl), entity_levels, caller="on_lineage_edge_deleted",
        )
        if resolved is None:
            return  # defer to the batch pipeline, like the write hook
        urn_levels, _urn_labels = resolved

        if entity_levels and not urn_levels:
            logger.debug(
                "on_lineage_edge_deleted: no chain levels resolved "
                "for %s -> %s — deferring to the batch pipeline",
                source_urn, target_urn,
            )
            return
        # Shared pair rule, regime-dispatched (write-hook parity) — the
        # SREM gate below still limits writes to hook-tracked pairs.
        pairs = self._hook_pairs(
            meta.regime, source_urn, target_urn, s_cl, t_cl, s_cont, t_cont,
        )
        if not pairs:
            return

        # SREM gate: 1 ⇒ this edge's contribution was tracked for the
        # pair — its stored weight (hook-incremented OR pipeline-computed
        # while the edge existed) includes it, so decrementing is exact.
        # 0 ⇒ untracked (pipeline-only cell, or a Redis flush): leave it
        # for the next batch reconcile rather than guess.
        try:
            pipe = self._redis.pipeline(transaction=False)
            for s_urn, t_urn in pairs:
                pipe.execute_command(
                    "SREM", f"{members_key_prefix}:{s_urn}:{t_urn}", edge_id,
                )
            srem_results = await pipe.execute()
        except Exception as exc:
            logger.warning(
                "on_lineage_edge_deleted: members-set SREM failed (%s) — "
                "leaving weights for the next batch reconcile", exc,
            )
            return

        keys = [
            f"{s_urn}|{t_urn}"
            for (s_urn, t_urn), removed in zip(pairs, srem_results)
            if removed
        ]
        if not keys:
            return

        try:
            await self._proj_query(
                "UNWIND $keys AS k "
                "MATCH ()-[r:AGGREGATED {aggKey: k}]->() "
                "SET r.weight = r.weight - 1, r.latestUpdate = timestamp() "
                "WITH r WHERE r.weight <= 0 DELETE r",
                params={"keys": keys},
            )
        except Exception as e:
            logger.error(f"Batched AGGREGATED decrement failed: {e}")

    async def on_containment_changed(self, urn: str) -> None:
        """Invalidate ancestor cache for a node and its descendants, then rebuild.

        When a node's parent changes, its entire subtree's ancestor chains
        are invalidated and lazily recomputed on next access. Targets the
        current containment-types namespace; older namespaces are
        unreachable so they don't need to be touched.
        """
        await self._ensure_connected()
        cache_key = self._ancestors_cache_key()

        # Invalidate this node's cached chain
        try:
            await self._redis.hdel(cache_key, urn)
        except Exception:
            pass

        # Invalidate descendants (BFS through containment)
        containment = list(self._get_containment_edge_types())
        queue = deque([urn])
        visited: Set[str] = {urn}

        while queue:
            current = queue.popleft()
            result = await self._ro_query(
                "MATCH (p)-[r]->(c) WHERE p.urn = $urn AND type(r) IN $ctypes RETURN c.urn",
                params={"urn": current, "ctypes": containment},
            )
            child_urns = [row[0] for row in (result.result_set or []) if row[0] and row[0] not in visited]
            if child_urns:
                try:
                    pipe = self._redis.pipeline(transaction=False)
                    for cu in child_urns:
                        pipe.execute_command("HDEL", cache_key, cu)
                        visited.add(cu)
                        queue.append(cu)
                    await pipe.execute()
                except Exception:
                    pass

        logger.info(f"Invalidated ancestor cache for {len(visited)} nodes under {urn}")

    async def clear_content_caches(self) -> None:
        """Bulk counterpart to :meth:`on_containment_changed`: clears every
        containment-digest ancestors namespace and the urn→label cache,
        and drops the in-process aggregation run-meta memo.

        Call only from the confirmed-source-change signal (e.g. after an
        external bulk load/re-parent) — per-node edits still go through
        ``on_containment_changed``. Without this, both the read path and
        the aggregation rebuild worker keep resolving ancestor chains
        from the old graph shape for up to the 7-day content-cache TTL.

        Best-effort and never-raising: a no-op if no cache Redis is
        configured; any failure is logged and swallowed.
        """
        try:
            await self._ensure_connected()
            if self._redis is not None:
                pattern = f"{self._cache_ns}:ancestors:*"
                cursor = 0
                while True:
                    cursor, keys = await self._redis.scan(cursor, match=pattern, count=500)
                    if keys:
                        await self._redis.delete(*keys)
                    if cursor == 0:
                        break
                await self._redis.delete(self._urn_label_key())
        except Exception as e:
            logger.warning(f"clear_content_caches failed: {e}")
        finally:
            self._agg_meta_cached = None

    async def count_aggregated_edges(self) -> int:
        """Cheap COUNT for purge progress reporting. Returns the current
        number of materialized AGGREGATED edges in the projection graph.
        """
        await self._ensure_connected()
        result = await self._proj_query(
            "MATCH ()-[r:AGGREGATED]->() RETURN count(r) AS total"
        )
        return int(result.result_set[0][0]) if result.result_set else 0

    async def purge_aggregated_edges(
        self,
        *,
        batch_size: int = 10_000,
        progress_callback: Optional[Callable[[int], Awaitable[None]]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> int:
        """Remove ALL materialized AGGREGATED edges from the graph.

        Also deletes the Redis ``{graph_name}:agg_members:*`` tracking
        sets. These sets are the idempotency state used by
        :meth:`on_lineage_edge_written` (SADD returns 0 when an edge_id
        is already a member, short-circuiting the MERGE). If they are
        NOT purged together with the graph edges, the next materialize
        run silently no-ops — the source edges appear "already
        contributed" even though the AGGREGATED edges they produced are
        gone from the graph, and the caller sees
        ``aggregated_edges_affected`` numbers that match the input
        count but 0 edges actually written to the graph.

        The deletion runs in batches of ``batch_size`` so multi-million-
        edge purges (a) report progress to the caller via
        ``progress_callback`` and (b) cannot silently truncate at the
        single hard-coded LIMIT 100000 the previous one-shot DELETE used.
        Each iteration's actual deleted count is summed into the
        running total handed to the callback.

        The Redis key prefix was renamed from ``agg:sourceEdgeIds:`` to
        ``agg_members:`` in an earlier refactor of
        :meth:`on_lineage_edge_written`; this method's scan pattern was
        not updated and so cleaned nothing until this fix.
        """
        await self._ensure_connected()

        # Clamp to a safe, non-zero range. 0 / negative would loop
        # forever; very large values defeat the progress-reporting
        # purpose this method exists for.
        if batch_size <= 0:
            batch_size = 10_000
        batch_size = min(batch_size, 100_000)

        try:
            total_deleted = 0
            while True:
                # Cooperative cancel between DELETE batches. The previous
                # batch's DELETE already landed in FalkorDB, so raising
                # here cannot orphan a Cypher transaction. Without this
                # hook a multi-million-edge purge cannot be cancelled
                # without ``task.cancel()`` interrupting a mid-flight
                # DELETE — same pattern as the materialise path.
                if should_cancel is not None and should_cancel():
                    from backend.app.services.aggregation.cancel import JobCancelled
                    from datetime import datetime, timezone
                    raise JobCancelled(
                        job_id="<provider-cancel>",
                        observed_at=datetime.now(timezone.utc).isoformat(),
                    )

                result = await self._proj_query(
                    f"MATCH ()-[r:AGGREGATED]->() "
                    f"WITH r LIMIT {int(batch_size)} "
                    f"DELETE r "
                    f"RETURN count(r) AS deleted"
                )
                deleted_in_batch = (
                    int(result.result_set[0][0]) if result.result_set else 0
                )
                total_deleted += deleted_in_batch

                if progress_callback is not None:
                    try:
                        await progress_callback(total_deleted)
                    except Exception as cb_exc:
                        # Progress reporting must never abort the actual
                        # deletion — log and keep going.
                        logger.warning(
                            "purge_aggregated_edges progress_callback raised: %s",
                            cb_exc,
                        )

                # Anything less than a full batch means we've drained
                # the AGGREGATED relations.
                if deleted_in_batch < batch_size:
                    break

            # Clean up Redis tracking keys for this graph. Must match the
            # prefix used by on_lineage_edge_written exactly (see
            # docstring). Done after all graph DELETEs succeed so a
            # mid-purge crash can't leave the tracker keys cleared while
            # AGGREGATED edges still exist (which would silently no-op
            # the next materialize run).
            pattern = f"{self._agg_members_prefix()}:*"
            cursor = 0
            cleaned = 0
            while True:
                cursor, keys = await self._redis.scan(cursor, match=pattern, count=500)
                if keys:
                    await self._redis.delete(*keys)
                    cleaned += len(keys)
                if cursor == 0:
                    break

            # Bump the aggregation-state EPOCH — the in-graph _AggMeta
            # FIRST: it is the readers' authoritative source (outranks
            # the Redis marker), so a Redis-only bump is shadowed and the
            # purge stays invisible to meta-driven readers. The regime is
            # KEPT as 'cube': an empty store trivially satisfies the cube
            # contract, which keeps on-demand derivation OFF — re-probing
            # an empty store resolves 'boundary' and the structural
            # reader would then RE-DERIVE the purged cells from raw
            # lineage on the next canvas read (purge-then-resurrect).
            # ``edgeCount = 0`` + ``purgedAt`` make the state inspectable.
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            try:
                await self._proj_query(
                    "MATCH (m:_AggMeta {id: 'singleton'}) "
                    "SET m.edgeCount = 0, m.regime = 'cube', "
                    "m.lastMaterializedAt = $now, m.purgedAt = $now",
                    params={"now": now_iso},
                )
                # Readers cache the resolved meta ~5 min — drop this
                # instance's copy so it answers honestly immediately.
                self._agg_meta_cached = None
            except Exception as exc:
                logger.warning(
                    "purge_aggregated_edges: could not update the in-graph "
                    "_AggMeta epoch: %s", exc,
                )
            # Redis mirror second. ``lastMaterializedAt`` rides on every
            # aggregated-edge response and is the client caches'
            # invalidation signal — without this bump a purge was
            # invisible to every consumer. Best-effort — marker failures
            # must never fail a purge whose deletes already landed.
            try:
                if self._redis is not None:
                    await self._redis.set(
                        self._agg_last_materialized_key(), now_iso,
                    )
                    if hasattr(self, "_agg_regime_key"):
                        await self._redis.set(self._agg_regime_key(), "fine")
            except Exception as exc:
                logger.warning(
                    "purge_aggregated_edges: could not bump the "
                    "aggregation-state epoch marker: %s", exc,
                )

            logger.info(
                "Purged %d AGGREGATED edges and %d Redis tracking keys from %s",
                total_deleted, cleaned, self._graph_name,
            )
            return total_deleted
        except Exception as e:
            logger.error("Failed to purge AGGREGATED edges: %s", e)
            raise

    async def materialize_lineage_for_edge(
        self,
        source_urn: str,
        target_urn: str,
        lineage_edge_type: str,
    ) -> bool:
        """Legacy wrapper — delegates to on_lineage_edge_written."""
        try:
            edge_id = f"{source_urn}|{lineage_edge_type}|{target_urn}"
            await self.on_lineage_edge_written(source_urn, target_urn, edge_id, lineage_edge_type)
            return True
        except Exception as e:
            logger.error(f"Failed to materialize lineage: {e}")
            return False

    async def materialize_aggregated_edges_batch(
        self,
        batch_size: int = 1000,
        containment_edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        last_cursor: Optional[str] = None,
        progress_callback: Optional[Any] = None,
        intra_batch_callback: Optional[Callable[[int], Awaitable[None]]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
        resume_processed: int = 0,
        resume_created: int = 0,
        tuning: Optional[Dict[str, Any]] = None,
        job_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Materialize :AGGREGATED rollup edges (single resumable pipeline).

        Delegates to ``backend.app.providers.falkordb_materialize`` — see
        that module for the EXTRACT -> COMPUTE -> RECONCILE -> APPLY design,
        the ``v3:`` cursor contract, and the tuning env vars. The legacy
        wipe-first bulk rebuild, epoch-swept streaming rebuild, and
        cursor-paged MERGE loop (with their AGGREGATION_BULK_REBUILD_ENABLED
        / AGGREGATION_STREAMING_REBUILD_ENABLED flags) were removed — this
        is the only strategy. Rollback is a version rollback.
        """
        await self._ensure_connected()
        from backend.app.providers.falkordb_materialize import (
            materialize_aggregated_edges,
        )
        return await materialize_aggregated_edges(
            self,
            batch_size=batch_size,
            containment_edge_types=containment_edge_types,
            lineage_edge_types=lineage_edge_types,
            last_cursor=last_cursor,
            progress_callback=progress_callback,
            intra_batch_callback=intra_batch_callback,
            should_cancel=should_cancel,
            resume_processed=resume_processed,
            resume_created=resume_created,
            tuning=tuning,
            job_id=job_id,
        )

    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
        *,
        timeout: Optional[float] = None,
    ) -> AggregatedEdgeResult:
        """Read pre-materialized AGGREGATED edges from the projection graph.

        Pure index lookup — O(|sourceUrns|), sub-millisecond at any scale.
        No live fallback: if materialization hasn't run, returns empty result
        so the caller knows to trigger a backfill.
        """
        from fastapi import HTTPException
        from ..config.resilience import (
            AGGREGATED_EDGE_PAGE_SIZE,
            AGGREGATED_EDGE_RESULT_CAP,
            AGGREGATED_SOURCE_URN_BATCH_SIZE,
        )

        if len(source_urns) > 100_000:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "TOO_MANY_SOURCE_URNS",
                    "limit": 100000,
                    "received": len(source_urns),
                },
            )

        await self._ensure_connected()

        # The Cypher LIMIT is a PAGE size, not the answer size. It is still
        # needed — without it every batch materializes + weight-sorts its
        # FULL match set on the server in one go — but ``_run_batch`` below
        # pages until the match set is exhausted, so bounding per-query
        # server work no longer bounds the data returned. Previously this
        # LIMIT was the answer: anything past 100k rows was dropped, and
        # since an oversized payload is never cached (delete-on-oversize)
        # a >cap model rendered a DIFFERENT arbitrary subset on every open.
        #
        # Anchors are LABEL-QUALIFIED per source-label bucket: without a
        # label the planner has no URN index on this build and falls back
        # to scanning EVERY :AGGREGATED relation with per-row IN-list
        # membership — observed timing out (and returning an empty
        # canvas) at 595k stored cells × 600 visible urns. With the label
        # it is |batch| index seeks + local out-edge expansion.
        def _cypher_for(label: str, *, resume: bool) -> str:
            anchor = f"(s:{label})" if label else "(s)"
            where = ["s.urn IN $sourceUrns"]
            if target_urns:
                where.append("t.urn IN $targetUrns")
            where.append("s.urn <> t.urn")
            if resume:
                # Strictly after the previous page's last row in the total
                # order below. Written out longhand because Cypher has no
                # row-value comparison operator.
                where.append(
                    "(coalesce(r.weight, 0) < $lastWeight "
                    "OR (coalesce(r.weight, 0) = $lastWeight "
                    "AND (s.urn > $lastSourceUrn "
                    "OR (s.urn = $lastSourceUrn AND t.urn > $lastTargetUrn))))"
                )
            return (
                f"MATCH {anchor}-[r:AGGREGATED]->(t) "
                f"WHERE {' AND '.join(where)} "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                # coalesce, not a bare r.weight: a null weight compares as
                # null against every integer, so `weight < $lastWeight` would
                # be null for those rows and every page after the first would
                # skip them permanently. 0 is what the row->model conversion
                # already maps a missing weight to, so payloads are unchanged.
                "coalesce(r.weight, 0) AS weight, r.sourceEdgeTypes AS types "
                # Total order, and the keyset the resume predicate walks.
                # weight is a COUNT, so ties are pervasive and a page
                # boundary lands mid-tie-group; (s.urn, t.urn) is what makes
                # that boundary exact and repeatable across pages.
                "ORDER BY weight DESC, sUrn, tUrn "
                f"LIMIT {AGGREGATED_EDGE_PAGE_SIZE}"
            )

        batch_failed = False

        async def _run_batch(label: str, batch: List[str]) -> list:
            """Read every matching cell for this batch, paging as needed.

            Stops only when the server returns a short page (match set
            exhausted), the read fails, or the runaway guard trips — never
            at a fixed row count that would silently drop the remainder.
            """
            nonlocal batch_failed
            rows: list = []
            last: Optional[list] = None
            while True:
                params: Dict[str, Any] = {"sourceUrns": batch}
                if target_urns:
                    params["targetUrns"] = target_urns
                if last is not None:
                    params["lastWeight"] = int(last[2]) if last[2] else 0
                    params["lastSourceUrn"] = last[0]
                    params["lastTargetUrn"] = last[1]
                try:
                    result = await self._proj_ro_query(
                        _cypher_for(label, resume=last is not None),
                        params=params, timeout=timeout, op="agg.cells",
                    )
                    page = result.result_set or []
                except Exception as e:
                    # Keep the pages already read — they are a correct prefix
                    # of the answer — and let batch_failed drive
                    # degraded/stale so the partial is flagged, not cached
                    # full-TTL as if it were complete.
                    logger.warning(f"AGGREGATED edge read failed: {e}")
                    batch_failed = True
                    return rows
                rows.extend(page)
                if len(page) < AGGREGATED_EDGE_PAGE_SIZE:
                    return rows
                if len(rows) >= AGGREGATED_EDGE_RESULT_CAP:
                    # Not marked degraded: the data is fine, the request is
                    # pathological. Length alone drives truncated=true.
                    logger.warning(
                        "AGGREGATED edge read on %s hit the runaway guard at "
                        "%d rows (AGGREGATED_EDGE_RESULT_CAP) — returning a "
                        "truncated result. Narrow the request or raise the "
                        "guard if the instance has headroom.",
                        self._graph_name, len(rows),
                    )
                    return rows
                last = page[-1]

        batch_size = AGGREGATED_SOURCE_URN_BATCH_SIZE
        runs: List[Tuple[str, List[str]]] = []
        for label, bucket in await self._label_buckets(source_urns):
            for i in range(0, len(bucket), batch_size):
                runs.append((label, bucket[i:i + batch_size]))
        batch_results = await asyncio.gather(*[
            _run_batch(lbl, b) for lbl, b in runs
        ])
        if len(runs) > 1:
            merged: Dict[Tuple[str, str], list] = {}
            for batch_rows in batch_results:
                for row in batch_rows:
                    key = (row[0], row[1])
                    existing = merged.get(key)
                    if existing is None:
                        merged[key] = list(row)
                    else:
                        existing[2] = (int(existing[2]) if existing[2] else 0) + (int(row[2]) if row[2] else 0)
                        ex_types = existing[3] if isinstance(existing[3], list) else ([existing[3]] if existing[3] else [])
                        new_types = row[3] if isinstance(row[3], list) else ([row[3]] if row[3] else [])
                        existing[3] = list(dict.fromkeys([*ex_types, *new_types]))
            rows = list(merged.values())
        else:
            rows = batch_results[0] if batch_results else []

        # Leaf-involving pairs (column→column, column→table, column→domain,
        # …) are no longer materialized — the full cube scales as
        # edges × hierarchy depth and OOMs the instance on large graphs.
        # They are completed here for the requested (bounded) URN sets
        # WITHOUT containment walks: exact typed raw mirrors + Redis
        # ancestor-chain resolution in Python (see
        # _synthesize_ondemand_lineage_pairs). Canonical container pairs
        # come from the materialized rows above with complete weights;
        # mixed-depth container pairs are derived from those cells via
        # the depth-stamp indexes.
        try:
            meta = await self._aggregation_run_meta()
        except Exception as e:
            logger.warning("Failed to resolve aggregation run meta: %s", e)
            meta = AggRunMeta("unknown", 1, None, None)
        raw_rows, mixed_rows, synth_degraded, stale_reason = (
            await self._synthesize_ondemand_lineage_pairs(
                source_urns, target_urns, containment_edges, lineage_edges,
                meta=meta, timeout=timeout,
            )
        )
        if raw_rows or mixed_rows:
            rows = [list(row) for row in rows]
            by_pair = {(row[0], row[1]): row for row in rows}
            # Leaf-involving rows are disjoint from materialized cells by
            # construction — a collision means a stale pre-boundary fine
            # cell still exists (graph not yet re-aggregated); the
            # materialized row wins until reconcile cleans it away.
            for row in raw_rows:
                pair = (row[0], row[1])
                if pair not in by_pair:
                    row = list(row)
                    by_pair[pair] = row
                    rows.append(row)
            # Mixed-level derived rows carry ONLY the strictly-below-the-
            # coarse-endpoint portion — ADD to a materialized canonical
            # row for the same pair (disjoint provenance), else append.
            for row in mixed_rows:
                existing = by_pair.get((row[0], row[1]))
                if existing is None:
                    row = list(row)
                    by_pair[(row[0], row[1])] = row
                    rows.append(row)
                    continue
                existing[2] = (
                    (int(existing[2]) if existing[2] else 0)
                    + (int(row[2]) if row[2] else 0)
                )
                ex_types = existing[3] if isinstance(existing[3], list) else (
                    [existing[3]] if existing[3] else []
                )
                new_types = row[3] if isinstance(row[3], list) else (
                    [row[3]] if row[3] else []
                )
                existing[3] = list(dict.fromkeys([*ex_types, *new_types]))

        # A failed materialized-edge batch is the same "answer is
        # incomplete for this graph state" condition as an on-demand
        # sub-query failure — fold it into the same degraded/stale_reason
        # computation rather than a parallel flag.
        degraded = synth_degraded or batch_failed
        if degraded and not stale_reason:
            stale_reason = "degraded"

        # The legacy single-query read returned rows weight-descending;
        # preserve that contract now that synthesized rows are appended.
        rows = sorted(rows, key=lambda r: -(int(r[2]) if r[2] else 0))
        return self._rows_to_aggregated_result(
            rows, last_materialized_at=meta.last_materialized_at,
            degraded=degraded,
            stale=bool(stale_reason),
            stale_reason=stale_reason,
            stamp_version=meta.stamp_version,
            regime=meta.regime,
        )

    # ------------------------------------------------------------------
    # Helpers for get_aggregated_edges_between
    # ------------------------------------------------------------------

    async def _synthesize_ondemand_lineage_pairs(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        containment_edges: Optional[List[str]],
        lineage_edges: Optional[List[str]],
        *,
        meta: Optional["AggRunMeta"] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[list, list, bool, Optional[str]]:
        """Complete the materialized cells for the requested (bounded) URN
        sets WITHOUT walking containment in Cypher. Returns
        ``(leaf_rows, mixed_rows, degraded, stale_reason)``.

        The previous implementation ran, on EVERY read in boundary regime:
        a per-node inbound path enumeration (``*1..16`` — the depth
        profile), and ``*0..16`` upward-resolution walks for leaf and
        mixed pairs. Measured 10-26s per canvas request on a 7.7M-element
        graph WITH healthy stampVersion=2 cells. All replaced by:

        * leaf detection — single-hop child-count probe (no walk);
        * containment depth — max over the node's own stamped incident
          :AGGREGATED cells (``_frontier_depths_from_stamps``,
          depth-index-backed);
        * upward resolution (leaf far-endpoints and Q3 mixed pairs) —
          READ-THROUGH the Redis ancestor-chain cache (cache hit = free;
          miss computes the chain bounded to this call's far set and
          caches it), resolved in Python. The first browse of a container
          set pays a bounded, one-time ancestor walk; subsequent reads hit
          the cache. This decouples read-cache warming from
          materialization — a cold cache no longer drops pairs or reports
          a stale condition that would (pointlessly) re-trigger a job.

        Regime dispatch (no probes here — see ``_aggregation_run_meta``):
        ``cube``    → exact raw mirror only (cells are complete; anything
                      more double-counts). Not stale.
        ``unknown`` → exact raw mirror + stale "unmaterialized" (the
                      trigger heals the graph).
        ``boundary`` + stampVersion < 2 → exact raw mirror + stale
                      "legacy_cells" (depth-keyed derivation impossible
                      until re-materialization re-stamps).
        ``boundary`` + stampVersion >= 2 → the structural path below.

        Weight semantics preserved from the walk implementation: leaf
        rows are disjoint from materialized cells; mixed rows carry only
        the strictly-below portion and are ADDED to canonical rows.
        Multi-parent chains resolve to every requested ancestor exactly
        once per (pair) — same dedupe the DISTINCT walk applied.
        """
        ltypes = self._alias_rel_types(
            [t for t in (lineage_edges or []) if t and t != "AGGREGATED"]
        )
        if not ltypes or not source_urns:
            return [], [], False, None
        if meta is None:
            meta = await self._aggregation_run_meta()

        if meta.regime != "boundary" or meta.stamp_version < 2:
            rows = await self._synthesize_raw_lineage_pairs(
                source_urns, target_urns, lineage_edges, timeout=timeout,
            )
            reason = None
            if meta.regime == "unknown":
                reason = "unmaterialized"
            elif meta.regime == "boundary" and meta.stamp_version < 2:
                reason = "legacy_cells"
            return rows, [], False, reason

        from ..config.resilience import (
            AGGREGATED_EDGE_RESULT_CAP,
            AGGREGATED_SOURCE_URN_BATCH_SIZE,
        )
        try:
            containment = list(self._alias_rel_types(
                [t for t in (containment_edges or []) if t]
            ) or self._get_containment_edge_types())
        except Exception:
            containment = []
        if not containment:
            rows = await self._synthesize_raw_lineage_pairs(
                source_urns, target_urns, lineage_edges, timeout=timeout,
            )
            return rows, [], False, None
        c_pattern = "|".join(_sanitize_label(t) for t in containment)
        l_pattern = "|".join(_sanitize_label(t) for t in ltypes)
        cap = AGGREGATED_EDGE_RESULT_CAP
        batch = AGGREGATED_SOURCE_URN_BATCH_SIZE
        degraded = {"v": False}

        async def _run(cypher: str, params: Dict[str, Any]) -> list:
            try:
                res = await self._ro_query(cypher, params=params, timeout=timeout, op="agg.synth")
                return res.result_set or []
            except Exception as e:
                degraded["v"] = True
                logger.warning("On-demand lineage pair query failed: %s", e)
                return []

        async def _run_proj(cypher: str, params: Dict[str, Any]) -> list:
            try:
                res = await self._proj_ro_query(cypher, params=params, timeout=timeout, op="agg.synth_anchor")
                return res.result_set or []
            except Exception as e:
                degraded["v"] = True
                logger.warning("On-demand aggregated anchor query failed: %s", e)
                return []

        async def _profile(urns: List[str]) -> Dict[str, Tuple[bool, int]]:
            """urn → (is_container, containment depth). Leaf detection is
            a single-hop child-count probe; depth comes from the node's
            own stamped incident cells (depth-index seek). Nodes with no
            stamped cell get depth 0 — they cannot contribute mixed-depth
            derivation (no cells to derive from), which is exactly the
            correct degradation."""
            out: Dict[str, Tuple[bool, int]] = {}
            uniq = list(dict.fromkeys(u for u in urns if u))
            if not uniq:
                return out
            for label, bucket in await self._label_buckets(uniq):
                anchor = f"(n:{label})" if label else "(n)"
                for i in range(0, len(bucket), batch):
                    for row in await _run(
                        f"MATCH {anchor} WHERE n.urn IN $urns "
                        f"OPTIONAL MATCH (n)-[:{c_pattern}]->(ch) "
                        f"RETURN n.urn, count(ch)",
                        {"urns": bucket[i:i + batch]},
                    ):
                        if row and row[0]:
                            out[str(row[0])] = (int(row[1] or 0) > 0, 0)
            depths = await self._frontier_depths_from_stamps(uniq)
            for u, d in depths.items():
                if u in out:
                    out[u] = (out[u][0], int(d))
            return out

        async def _chain_resolve(
            far_urns: List[str], requested: List[str],
        ) -> Dict[str, List[str]]:
            """far urn → requested urns strictly ABOVE it (self excluded —
            exact matches are handled by callers directly).

            READ-THROUGH the ancestor-chain cache: a cache hit is free; a
            miss computes the chain (bounded to this call's far set) and
            caches it. The previous cache-ONLY read dropped the pair and
            flagged ``chain_cache_miss`` on every miss — and NOTHING on the
            browse path warmed the cache (only trace did; the materializer
            does not), so a browse-only user got a PERPETUAL
            chain_cache_miss that re-triggered a no-op re-materialization
            every few minutes. Read-through warms progressively: the first
            browse of a container set pays a bounded, one-time ancestor
            walk; every subsequent read hits the cache. This is NOT the old
            full-graph synthesis (10-26s) — it is bounded to the visible
            far-endpoints and cached."""
            req = set(requested)
            chains = await self._compute_and_store_ancestors_bulk(far_urns)
            out: Dict[str, List[str]] = {}
            for u, chain in chains.items():
                hits = [a for a in dict.fromkeys(chain or []) if a in req and a != u]
                if hits:
                    out[u] = hits
            return out

        rows: list = []
        mixed_rows: list = []

        if target_urns:
            src_prof = await _profile(source_urns)
            tgt_prof = await _profile(target_urns)
            src_leaves = [
                u for u in source_urns if not src_prof.get(u, (False, 0))[0]
            ]
            tgt_leaves = [
                u for u in target_urns if not tgt_prof.get(u, (False, 0))[0]
            ]
            src_containers = {
                u: src_prof[u][1] for u in source_urns
                if src_prof.get(u, (False, 0))[0]
            }
            tgt_containers = {
                u: tgt_prof[u][1] for u in target_urns
                if tgt_prof.get(u, (False, 0))[0]
            }
            tgt_set = set(target_urns)

            def _merge_rows(acc: Dict[Tuple[str, str], list],
                            x: str, y: str, weight, types) -> None:
                w = int(weight) if weight else 1
                tl = types if isinstance(types, list) else ([types] if types else [])
                cell = acc.get((x, y))
                if cell is None:
                    acc[(x, y)] = [x, y, w, list(tl)]
                else:
                    cell[2] += w
                    cell[3].extend(t for t in tl if t not in cell[3])

            # Q1 — requested LEAF sources: exact typed raw fan-out; far
            # endpoints matched exactly against the target set and/or
            # resolved upward via cached chains. No containment Cypher.
            leaf_acc: Dict[Tuple[str, str], list] = {}
            q1_far: list = []
            for x_label, x_bucket in await self._label_buckets(src_leaves):
                x_anchor = f"(x:{x_label})" if x_label else "(x)"
                for i in range(0, len(x_bucket), batch):
                    q1_far.extend(await _run(
                        f"MATCH {x_anchor}-[r:{l_pattern}]->(t) "
                        f"WHERE x.urn IN $xs "
                        f"RETURN x.urn, t.urn, count(r), "
                        f"collect(DISTINCT type(r)) LIMIT {cap}",
                        {"xs": x_bucket[i:i + batch]},
                    ))
            far_up = await _chain_resolve(
                [row[1] for row in q1_far if row and row[1]], target_urns)
            for row in q1_far:
                if not row or not row[0] or not row[1]:
                    continue
                x, t = str(row[0]), str(row[1])
                if t in tgt_set and x != t:
                    _merge_rows(leaf_acc, x, t, row[2], row[3])
                for y in far_up.get(t, ()):
                    if x != y:
                        _merge_rows(leaf_acc, x, y, row[2], row[3])

            # Q2 — requested LEAF targets: exact typed raw fan-in; sources
            # resolved upward to requested CONTAINERS only (leaf sources
            # were fully covered by Q1 — the two stay disjoint).
            if src_containers and tgt_leaves:
                q2_far: list = []
                for y_label, y_bucket in await self._label_buckets(tgt_leaves):
                    y_anchor = f"(y:{y_label})" if y_label else "(y)"
                    for i in range(0, len(y_bucket), batch):
                        q2_far.extend(await _run(
                            f"MATCH (s)-[r:{l_pattern}]->{y_anchor} "
                            f"WHERE y.urn IN $ys "
                            f"RETURN y.urn, s.urn, count(r), "
                            f"collect(DISTINCT type(r)) LIMIT {cap}",
                            {"ys": y_bucket[i:i + batch]},
                        ))
                src_up = await _chain_resolve(
                    [row[1] for row in q2_far if row and row[1]],
                    list(src_containers))
                for row in q2_far:
                    if not row or not row[0] or not row[1]:
                        continue
                    y, s = str(row[0]), str(row[1])
                    for x in src_up.get(s, ()):
                        if x != y:
                            _merge_rows(leaf_acc, x, y, row[2], row[3])
            rows = list(leaf_acc.values())

            # Q3 — mixed-DEPTH container pairs derived from stored cells
            # (depth-index-anchored), far endpoints resolved via chains.
            if src_containers and tgt_containers:
                mixed_rows = await self._mixed_depth_pairs(
                    src_containers, tgt_containers,
                    cap=cap, batch=batch,
                    run_proj=_run_proj, chain_resolve=_chain_resolve,
                )
        else:
            # Source-only mode: exact typed raw fan-out of requested leaf
            # sources (no target set to resolve upward against).
            src_prof = await _profile(source_urns)
            src_leaves = [
                u for u in source_urns if not src_prof.get(u, (False, 0))[0]
            ]
            for x_label, x_bucket in await self._label_buckets(src_leaves):
                x_anchor = f"(x:{x_label})" if x_label else "(x)"
                for i in range(0, len(x_bucket), batch):
                    rows.extend(await _run(
                        f"MATCH {x_anchor}-[r:{l_pattern}]->(t) "
                        f"WHERE x.urn IN $xs AND t.urn <> x.urn "
                        f"RETURN x.urn AS sUrn, t.urn AS tUrn, "
                        f"count(r) AS weight, "
                        f"collect(DISTINCT type(r)) AS types LIMIT {cap}",
                        {"xs": x_bucket[i:i + batch]},
                    ))

        # Chain resolution is now read-THROUGH (computes + caches on miss),
        # so container roll-up pairs always resolve — there is no
        # chain_cache_miss staleness and nothing to self-heal here. A true
        # sub-query failure is surfaced via ``degraded`` instead.
        return rows, mixed_rows, degraded["v"], None

    async def _mixed_depth_pairs(
        self,
        src_containers: Dict[str, int],
        tgt_containers: Dict[str, int],
        *,
        cap: int,
        batch: int,
        run_proj,
        chain_resolve,
    ) -> list:
        """Derive mixed-DEPTH container pairs (table→domain, domain→table)
        from the materialized canonical cells, keyed on the structural
        ``sourceDepth``/``targetDepth`` stamps — no ontology labels or
        type levels anywhere, so self-nesting ontologies derive
        correctly.

        For each direction: (1) anchor the FINER endpoint's stored
        :AGGREGATED cells at the anchor's own rank
        (``r.targetDepth <= r.sourceDepth`` for fan-out — depth-index-
        backed after WS2), (2) resolve the far endpoints STRICTLY upward
        via the Redis ancestor-chain cache in Python (the previous
        ``*1..hops`` Cypher walk is gone from the read path; a chain
        miss drops the pair and flags ``stale``), (3) join against the
        requested strictly-coarser far side and sum.

        The strictly-upward resolution keeps these sums DISJOINT from any
        directly-materialized canonical cell for the same pair — the
        caller must therefore ADD a derived row's weight to a
        materialized row, not drop it.

        Known bound (multi-parent diamonds only): a raw edge whose far
        endpoint sits under TWO stored reps that both resolve up to the
        same requested coarser node is summed once per rep — mixed-depth
        weights can overcount on such shapes in boundary regime. Cube
        regime (the default within budget) stores these pairs exactly.
        """
        cells: Dict[Tuple[str, str], list] = {}

        def _merge(x: str, y: str, weight, types) -> None:
            w = int(weight) if weight else 1
            tl = types if isinstance(types, list) else ([types] if types else [])
            cell = cells.get((x, y))
            if cell is None:
                cells[(x, y)] = [w, list(tl)]
            else:
                cell[0] += w
                cell[1].extend(t for t in tl if t not in cell[1])

        # Fan-out: requested source containers anchored on their stored
        # at-rank cells; far side resolved up to STRICTLY SHALLOWER
        # requested targets. Anchors grouped by depth so each group joins
        # only its coarser counterparts.
        depths = sorted({d for d in src_containers.values()})
        for dx in depths:
            xs = [u for u, d in src_containers.items() if d == dx]
            ys = [u for u, d in tgt_containers.items() if d < dx]
            if not xs or not ys:
                continue
            fanout = []
            for x_label, x_bucket in await self._label_buckets(xs):
                x_anchor = f"(x:{x_label})" if x_label else "(x)"
                for i in range(0, len(x_bucket), batch):
                    fanout.extend(await run_proj(
                        f"MATCH {x_anchor}-[r:AGGREGATED]->(t2) "
                        f"WHERE x.urn IN $xs AND r.targetDepth <= r.sourceDepth "
                        f"RETURN x.urn, t2.urn, r.weight, r.sourceEdgeTypes "
                        f"LIMIT {cap}",
                        {"xs": x_bucket[i:i + batch]},
                    ))
            up = await chain_resolve(
                [row[1] for row in fanout if row and row[1]], ys)
            for row in fanout:
                for y in up.get(row[1], ()):
                    _merge(row[0], y, row[2], row[3])

        # Fan-in mirror: requested target containers anchored; far side
        # resolved up to strictly shallower requested sources.
        depths = sorted({d for d in tgt_containers.values()})
        for dy in depths:
            ys = [u for u, d in tgt_containers.items() if d == dy]
            xs = [u for u, d in src_containers.items() if d < dy]
            if not xs or not ys:
                continue
            fanin = []
            for y_label, y_bucket in await self._label_buckets(ys):
                y_anchor = f"(y:{y_label})" if y_label else "(y)"
                for i in range(0, len(y_bucket), batch):
                    fanin.extend(await run_proj(
                        f"MATCH (s2)-[r:AGGREGATED]->{y_anchor} "
                        f"WHERE y.urn IN $ys AND r.sourceDepth <= r.targetDepth "
                        f"RETURN y.urn, s2.urn, r.weight, r.sourceEdgeTypes "
                        f"LIMIT {cap}",
                        {"ys": y_bucket[i:i + batch]},
                    ))
            up = await chain_resolve(
                [row[1] for row in fanin if row and row[1]], xs)
            for row in fanin:
                for x in up.get(row[1], ()):
                    _merge(x, row[0], row[2], row[3])

        return [[x, y, w, tl] for (x, y), (w, tl) in cells.items()]

    async def _synthesize_raw_lineage_pairs(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        lineage_edges: Optional[List[str]],
        *,
        timeout: Optional[float] = None,
    ) -> list:
        """Aggregate raw lineage edges between the requested URN sets into
        the same row shape as the AGGREGATED read (sUrn, tUrn, weight,
        types) — one row per (s, t) pair, weight = parallel-edge count.

        This is the read-side replacement for the leaf↔leaf mirror pairs
        the pipeline stopped materializing. Runs on the SOURCE graph
        (raw lineage lives there even in dedicated projection mode) with
        a URN-index-driven MATCH, grouped server-side.
        """
        from ..config.resilience import AGGREGATED_SOURCE_URN_BATCH_SIZE

        ltypes = self._alias_rel_types(
            [t for t in (lineage_edges or []) if t and t != "AGGREGATED"]
        )
        if not ltypes:
            return []

        # Anchors label-qualified per source bucket — an unlabeled
        # ``s.urn IN $list`` is a full scan on builds without a
        # label-less URN index; the "" bucket keeps the unlabeled form.
        def _cypher_for(label: str) -> str:
            anchor = f"(s:{label})" if label else "(s)"
            if target_urns:
                return (
                    f"MATCH {anchor}-[r]->(t) "
                    "WHERE s.urn IN $sourceUrns AND t.urn IN $targetUrns "
                    "AND type(r) IN $ltypes AND s.urn <> t.urn "
                    "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                    "count(r) AS weight, collect(DISTINCT type(r)) AS types"
                )
            return (
                f"MATCH {anchor}-[r]->(t) "
                "WHERE s.urn IN $sourceUrns "
                "AND type(r) IN $ltypes AND s.urn <> t.urn "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                "count(r) AS weight, collect(DISTINCT type(r)) AS types"
            )

        async def _run_batch(label: str, batch: List[str]) -> list:
            params: Dict[str, Any] = {"sourceUrns": batch, "ltypes": list(ltypes)}
            if target_urns:
                params["targetUrns"] = target_urns
            try:
                result = await self._ro_query(
                    _cypher_for(label), params=params, timeout=timeout,
                )
                return result.result_set or []
            except Exception as e:
                logger.warning(f"Raw lineage pair synthesis failed: {e}")
                return []

        batch_size = AGGREGATED_SOURCE_URN_BATCH_SIZE
        runs: List[Tuple[str, List[str]]] = []
        for label, bucket in await self._label_buckets(source_urns):
            for i in range(0, len(bucket), batch_size):
                runs.append((label, bucket[i:i + batch_size]))
        batch_results = await asyncio.gather(*[_run_batch(l, b) for l, b in runs])
        return [row for rows in batch_results for row in rows]

    def _rows_to_aggregated_result(
        self,
        rows: list,
        *,
        last_materialized_at: Optional[str] = None,
        degraded: bool = False,
        stale: bool = False,
        stale_reason: Optional[str] = None,
        stamp_version: Optional[int] = None,
        regime: Optional[str] = None,
    ) -> AggregatedEdgeResult:
        """Convert raw Cypher result rows into AggregatedEdgeResult."""
        from ..config.resilience import AGGREGATED_EDGE_RESULT_CAP
        aggregated = []
        total_edges = 0
        for row in rows:
            s_urn, t_urn, weight, types = row[0], row[1], row[2], row[3]
            w = int(weight) if weight else 1
            edge_types = types if isinstance(types, list) else [str(types)] if types else []
            aggregated.append(AggregatedEdgeInfo(
                id=f"agg-{s_urn}-{t_urn}",
                sourceUrn=s_urn,
                targetUrn=t_urn,
                edgeCount=w,
                edgeTypes=edge_types,
                confidence=1.0,
                sourceEdgeIds=[],
            ))
            total_edges += w
        return AggregatedEdgeResult(
            aggregatedEdges=aggregated,
            totalSourceEdges=total_edges,
            truncated=degraded or len(aggregated) >= AGGREGATED_EDGE_RESULT_CAP,
            lastMaterializedAt=last_materialized_at,
            stale=stale or bool(stale_reason),
            staleReason=stale_reason,
            stampVersion=stamp_version,
            regime=regime,
        )

    async def get_trace_lineage(
        self,
        urn: str,
        direction: str,
        depth: int,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> LineageResult:
        """
        Execute a targeted lineage trace using dynamic edge lists.
        1. Start at target URN.
        2. Traverse DOWN containment to find children (if any).
        3. Traverse ACROSS lineage edges (upstream/downstream).
        4. Traverse UP containment to find structural context.
        """
        await self._ensure_connected()
        
        # Per-source alignment (Task E): render the source's observed spellings so a
        # case-variant graph isn't missed by the case-sensitive patterns below.
        safe_containment = [_sanitize_label(t) for t in self._alias_rel_types(containment_edges)]
        safe_lineage = [_sanitize_label(t) for t in self._alias_rel_types(lineage_edges)]
        
        # If no lineage edges defined, return just the node
        if not safe_lineage:
            node = await self.get_node(urn)
            return LineageResult(
                nodes=[node] if node else [],
                edges=[],
                upstreamUrns=set(), 
                downstreamUrns=set(),
                totalCount=1 if node else 0,
                hasMore=False
            )

        # 1. Expand Scope: Target + Children
        # Find children using containment edges
        start_urns = {urn}
        if safe_containment:
            # Get children (depth 1 for now, or use *1.. if needed)
            cypher_kids = (
                f"MATCH (p)-[r]->(c) "
                f"WHERE p.urn = $urn AND type(r) IN $containment "
                f"RETURN c.urn"
            )
            res_kids = await self._ro_query(
                cypher_kids, 
                params={"urn": urn, "containment": safe_containment}
            )
            for row in (res_kids.result_set or []):
                start_urns.add(row[0])
        
        # 2. Trace Lineage
        collected_nodes: Dict[str, GraphNode] = {}
        collected_edges: Dict[str, GraphEdge] = {}
        
        upstream_urns = set()
        downstream_urns = set()
        
        if not start_urns:
             return LineageResult(nodes=[], edges=[], upstreamUrns=set(), downstreamUrns=set(), totalCount=0, hasMore=False)

        # Batched BFS: 1 Cypher query per depth level instead of 1 per node.
        # Each iteration processes the entire frontier at once.
        visited_lineage = set(start_urns)
        current_frontier = list(start_urns)

        for current_depth in range(depth):
            if not current_frontier:
                break

            next_frontier_upstream: List[str] = []
            next_frontier_downstream: List[str] = []

            # Build direction-specific batch queries
            dir_queries = []
            if direction in ["upstream", "both"]:
                # Find all nodes that flow INTO the current frontier
                cypher_up = (
                    "MATCH (src)-[r]->(tgt) "
                    "WHERE tgt.urn IN $frontier AND type(r) IN $lineage "
                    "RETURN src, r, tgt"
                )
                dir_queries.append(("upstream", cypher_up))
            if direction in ["downstream", "both"]:
                # Find all nodes that flow OUT of the current frontier
                cypher_down = (
                    "MATCH (src)-[r]->(tgt) "
                    "WHERE src.urn IN $frontier AND type(r) IN $lineage "
                    "RETURN src, r, tgt"
                )
                dir_queries.append(("downstream", cypher_down))

            for dir_label, cypher_q in dir_queries:
                res = await self._ro_query(
                    cypher_q,
                    params={"frontier": current_frontier, "lineage": safe_lineage}
                )

                for row in (res.result_set or []):
                    src_node_obj = self._extract_node_from_result(row[0])
                    edge_obj_raw = row[1]
                    tgt_node_obj = self._extract_node_from_result(row[2])

                    if not src_node_obj or not tgt_node_obj:
                        continue

                    r_type = getattr(edge_obj_raw, "relation", None) or getattr(edge_obj_raw, "type", None) or "UNKNOWN"
                    r_props = getattr(edge_obj_raw, "properties", {})

                    edge = _edge_from_row(src_node_obj.urn, tgt_node_obj.urn, r_type, r_props)

                    if edge.id not in collected_edges:
                        collected_edges[edge.id] = edge
                        collected_nodes[src_node_obj.urn] = src_node_obj
                        collected_nodes[tgt_node_obj.urn] = tgt_node_obj

                        if dir_label == "upstream":
                            neighbor = src_node_obj
                            if neighbor.urn not in visited_lineage:
                                visited_lineage.add(neighbor.urn)
                                upstream_urns.add(neighbor.urn)
                                next_frontier_upstream.append(neighbor.urn)
                        else:
                            neighbor = tgt_node_obj
                            if neighbor.urn not in visited_lineage:
                                visited_lineage.add(neighbor.urn)
                                downstream_urns.add(neighbor.urn)
                                next_frontier_downstream.append(neighbor.urn)

            # Merge frontiers for next depth level
            current_frontier = next_frontier_upstream + next_frontier_downstream

        # 3. Structural Context (Traverse UP)
        # For all collected nodes, find their parents/containers
        all_lineage_urns = list(collected_nodes.keys())
        if all_lineage_urns and safe_containment:
             # Find parents recursively or just immediate? 
             # Usually tracing up to Root is good. keyspace -> table -> column
             
             # Cypher to find ancestors:
             # MATCH (child)<-[r*1..5]-(parent) WHERE child.urn IN $urns AND type(r) IN $containment RETURN parent, r
             # Note: variable length relationship with type filter might be syntax sensitive in FalkorDB
             # MATCH (child)<-[r*1..5]-(parent) ...
             # We can just fetch all ancestors.
             
             # We can process in batches if many nodes
             batch_urns = all_lineage_urns # optimize if huge
             
             # We assume containment is child<-parent (parent IS SOURCE of CONTAINS edge)
             # So we match (parent)-[:CONTAINS]->(child)
             
             cypher_structure = (
                 f"MATCH (parent)-[r]->(child) "
                 f"WHERE child.urn IN $urns AND type(r) IN $containment "
                 f"RETURN parent, r, child"
             )
             
             # We might need to iterate this to go up multiple levels?
             # Or use *1..5
             # Let's try to get full hierarchy for the visible nodes.
             
             # For simpler implementation: Use a loop to climb up.
             # Or rely on get_ancestors if it wasn't one-by-one.
             
             # Let's do a single pass for immediate parents, then loop?
             # Actually, simpler: Just fetch all ancestors for these nodes.
             
             # Batched ancestor fetch — climb containment levels
             current_level_urns = all_lineage_urns
             seen_parents: Set[str] = set(collected_nodes.keys())
             for _ in range(5):  # up to 5 containment levels
                 if not current_level_urns:
                     break

                 res_struct = await self._ro_query(
                     cypher_structure,
                     params={"urns": current_level_urns, "containment": safe_containment}
                 )

                 next_level_urns = []

                 for row in (res_struct.result_set or []):
                     parent = self._extract_node_from_result(row[0])
                     r_raw = row[1]
                     child = self._extract_node_from_result(row[2])

                     if parent and child:
                         collected_nodes[child.urn] = child

                         r_type = getattr(r_raw, "relation", None) or getattr(r_raw, "type", None) or "UNKNOWN"
                         r_props = getattr(r_raw, "properties", {})

                         edge = _edge_from_row(parent.urn, child.urn, r_type, r_props)
                         collected_edges[edge.id] = edge

                         # Only add parent to next level if we haven't seen it before
                         if parent.urn not in seen_parents:
                             seen_parents.add(parent.urn)
                             collected_nodes[parent.urn] = parent
                             next_level_urns.append(parent.urn)

                 if not next_level_urns:
                     break
                 current_level_urns = next_level_urns

        # Ensure original urn is in collected nodes
        if urn not in collected_nodes:
            start_node = await self.get_node(urn)
            if start_node:
                collected_nodes[urn] = start_node

        return LineageResult(
            nodes=list(collected_nodes.values()),
            edges=list(collected_edges.values()),
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            totalCount=len(collected_nodes),
            hasMore=False
        )

    # ------------------------------------------------------------------ #
    # Trace v2 — Cypher-native, ontology-aware lineage                    #
    #                                                                     #
    # Filters AGGREGATED edges by node-level (s.level/t.level) at the    #
    # database layer. Per-hop set-based BFS orchestrated in Python — the  #
    # hot path is a single UNWIND $frontier MATCH per hop, capped by     #
    # LIMIT. Cost is proportional to result size, not graph size.        #
    #                                                                     #
    # Assumes ``in_source`` projection mode (the default): AGGREGATED    #
    # edges and source nodes live in the same graph, so the level filter #
    # can join on s.level/t.level. ``dedicated`` mode requires the       #
    # materializer to project node levels onto shadow nodes — out of     #
    # scope here.                                                         #
    # ------------------------------------------------------------------ #

    async def trace_at_level(
        self,
        urn: str,
        level: int,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        include_containment_edges: bool = False,
        include_inherited_lineage: bool = True,
    ) -> TraceResult:
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)

        # Normalize edge type lists to UPPERCASE — matches what type(r) returns
        # in FalkorDB and what set_containment_edge_types stores internally.
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = [t.upper() for t in (lineage_edge_types or [])] if lineage_edge_types else None
        # Per-source alignment (Task E): translate the uppercased declared types to THIS
        # graph's observed spellings so the case-sensitive :TYPE / type(r) IN patterns below
        # match a differently-cased graph. Identity for governed/canonical graphs.
        ctypes = self._alias_rel_types(ctypes)
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes

        # Focus node — needed for the response shape regardless of trace
        # outcome. Wave 1: the root-anchor walk is independent of the focus
        # payload, so run it CONCURRENTLY (optimistic — discarded when the
        # focus's level turns out unknown). The anchor phase used to be 5-7
        # strictly sequential round-trips; against a remote FalkorDB each
        # paid full RTT.
        root_anchor_task = None
        if level == 0 and ctypes:
            root_anchor_task = asyncio.ensure_future(
                self._resolve_root_anchor(urn, ctypes))
        try:
            focus_node = await self.get_node(urn)
        except Exception:
            if root_anchor_task is not None:
                root_anchor_task.cancel()
            raise
        focus_level = self._get_node_level(focus_node.entity_type) if focus_node else level
        focus_entity_type = str(focus_node.entity_type) if focus_node else "unknown"

        # Cold-start / drift observability: the probe at
        # _check_levels_backfilled logs once per digest when stamps are
        # missing or stale. We do NOT re-log here per trace — the probe's
        # one-time log is enough and per-request logging spams when many
        # traces run against the same provider.
        #
        # The trace path itself stays correct in either state: stamped
        # edges take the level-pair fast path; unstamped (or -1-stamped)
        # edges fall back to the label-scan path inside
        # _expand_aggregated_set.

        # 1. Resolve anchor at the requested level (climb containment if needed).
        #
        #    Skeleton-first (level=0) branches:
        #      (a) focus_level known + ctypes present → try root anchor.
        #          If found at level 0, anchor there. If found at level>0
        #          (orphan), anchor there and report fallbackLevel. If
        #          resolution fails, fall through to legacy resolver.
        #      (b) focus_level unknown (ontology doesn't declare a level
        #          for the focus's entity type, e.g. a generator-declared
        #          "layer") →
        #          skip root-anchor entirely. Anchor at the focus itself
        #          and signal effective_level=-1 so _expand_aggregated_set
        #          uses the peer-label fallback (same-label neighbours
        #          only). This is what stops layer→layer trace from
        #          spilling into attributes.
        fallback_level: Optional[int] = None
        effective_level = level
        if root_anchor_task is not None and (focus_level is None):
            # Optimistic wave-1 walk not needed on this branch.
            root_anchor_task.cancel()
        if level == 0 and ctypes and focus_level is not None:
            root_urn, root_level = await root_anchor_task
            if root_level == 0:
                anchor_urn = root_urn
            elif root_level > 0:
                anchor_urn = root_urn
                effective_level = root_level
                fallback_level = root_level
            else:
                anchor_urn = await self._resolve_anchor_at_level(urn, level, ctypes)
                if anchor_urn == urn and focus_level != 0:
                    effective_level = focus_level
                    fallback_level = focus_level
        elif level == 0 and focus_level is None:
            # Ontology has no declared level for the focus's entity type.
            # Anchor at the focus and rely on peer-label rollup downstream.
            anchor_urn = urn
            effective_level = -1
            fallback_level = -1
        else:
            anchor_urn = await self._resolve_anchor_at_level(urn, level, ctypes)

        # 2. Inherited-lineage fallback. Wave 2: the has-lineage existence
        # probe and the anchor node fetch are independent — gather them.
        is_inherited = False
        inherited_from = None
        if include_inherited_lineage:
            has_lineage, anchor_node = await asyncio.gather(
                self._has_aggregated_at_level(anchor_urn, effective_level, ltypes),
                self.get_node(anchor_urn) if anchor_urn != urn
                else _completed(focus_node),
            )
            if not has_lineage:
                parent = await self._find_ancestor_with_lineage(
                    anchor_urn, effective_level, ctypes, ltypes)
                if parent and parent != anchor_urn:
                    inherited_from = anchor_urn
                    anchor_urn = parent
                    is_inherited = True
                    anchor_node = await self.get_node(anchor_urn)
        else:
            anchor_node = (
                focus_node if anchor_urn == urn
                else await self.get_node(anchor_urn)
            )

        # 3. Seed BFS state
        nodes_by_urn: Dict[str, GraphNode] = {}
        if anchor_node:
            nodes_by_urn[anchor_urn] = anchor_node
        edges_by_id: Dict[str, GraphEdge] = {}
        upstream_urns: Set[str] = set()
        downstream_urns: Set[str] = set()
        visited: Set[str] = {anchor_urn}
        up_frontier: Set[str] = {anchor_urn} if upstream_depth > 0 else set()
        down_frontier: Set[str] = {anchor_urn} if downstream_depth > 0 else set()
        truncation_reason: Optional[str] = None
        # Per-source-URN contribution counts. After BFS, any source that hit
        # TRACE_DEGREE_CAP is a mega-node candidate — emitted in meta.megaNodes
        # so the UI can render a "+N more" chip and offer targeted re-expand.
        per_source_count: Dict[str, int] = {}

        # 4. Per-hop set-based expansion
        max_depth = max(upstream_depth, downstream_depth)
        for hop in range(max_depth):
            remaining_secs = deadline - time.monotonic()
            if remaining_secs <= 0:
                truncation_reason = "timeout"
                break
            if len(nodes_by_urn) >= max_nodes:
                truncation_reason = "max_nodes"
                break
            budget = max_nodes - len(nodes_by_urn)

            # Build frontier→label maps from already-fetched nodes. New
            # frontier members were hydrated by the previous hop's
            # `rec.get("node")` payload, so their entity_type is known
            # without an extra round-trip.
            up_labels = {
                u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                for u in up_frontier if u in nodes_by_urn
            }
            down_labels = {
                u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                for u in down_frontier if u in nodes_by_urn
            }

            # Per-hop wall-clock budget. Up to two directions run in
            # parallel, each issuing 1-2 sub-queries — splitting the
            # remaining budget across them lets a slow hop fail fast
            # rather than starving subsequent hops.
            hop_timeout_secs = max(0.6, min(1.5, remaining_secs / 2))

            tasks = []
            if hop < upstream_depth and up_frontier:
                tasks.append(("up", self._expand_aggregated_set(
                    list(up_frontier), up_labels, "incoming",
                    effective_level, ltypes, budget, hop_timeout_secs,
                    default_peer_label=focus_entity_type,
                )))
            if hop < downstream_depth and down_frontier:
                tasks.append(("down", self._expand_aggregated_set(
                    list(down_frontier), down_labels, "outgoing",
                    effective_level, ltypes, budget, hop_timeout_secs,
                    default_peer_label=focus_entity_type,
                )))
            if not tasks:
                break

            results = await asyncio.gather(
                *(t[1] for t in tasks), return_exceptions=True
            )

            new_up: Set[str] = set()
            new_down: Set[str] = set()
            for (direction, _), recs in zip(tasks, results):
                if isinstance(recs, Exception):
                    logger.warning("trace_at_level expand (%s) failed: %s", direction, recs)
                    continue
                for rec in recs:
                    edge_id = rec["edgeId"]
                    if edge_id not in edges_by_id:
                        # Use the actual relationship type — AGGREGATED for
                        # rolled-up lineage, or the raw lineage type
                        # (TRANSFORMS, FLOWS_TO, …) when tracing at fine-
                        # grained levels where lineage is not pre-aggregated.
                        actual_type = rec.get("edgeType") or "AGGREGATED"
                        edges_by_id[edge_id] = GraphEdge(
                            id=edge_id,
                            sourceUrn=rec["sourceUrn"],
                            targetUrn=rec["targetUrn"],
                            edgeType=actual_type,
                            properties={
                                "sourceEdgeTypes": rec.get("edgeTypes") or [actual_type],
                                "weight": rec.get("weight") or 1,
                            },
                        )
                        # Track aggregated edges per anchor (the frontier-side
                        # URN). Direction-aware: for upstream BFS the anchor
                        # is the target; for downstream it's the source.
                        if actual_type == "AGGREGATED":
                            anchor_for_count = (
                                rec["targetUrn"] if direction == "up"
                                else rec["sourceUrn"]
                            )
                            per_source_count[anchor_for_count] = (
                                per_source_count.get(anchor_for_count, 0) + 1
                            )
                    new_node = rec.get("node")
                    if new_node and new_node.urn not in nodes_by_urn:
                        nodes_by_urn[new_node.urn] = new_node
                    other_urn = rec["sourceUrn"] if direction == "up" else rec["targetUrn"]
                    if other_urn not in visited:
                        visited.add(other_urn)
                        if direction == "up":
                            new_up.add(other_urn)
                            upstream_urns.add(other_urn)
                        else:
                            new_down.add(other_urn)
                            downstream_urns.add(other_urn)

            up_frontier = new_up
            down_frontier = new_down
            if not up_frontier and not down_frontier:
                break

        # SAFETY NET: if skeleton-first (level=0) yielded zero lineage edges,
        # retry at the focus's own level (legacy "auto" peer-rollup). Two
        # paths trigger this:
        #   (a) focus_level known → retry at that int level
        #   (b) focus_level None (ontology missing the focus's level) →
        #       retry with level=-1 (sentinel meaning "no level filter,
        #       use peer-label fallback in _expand_aggregated_set")
        # The frontend safety-net memo: never return empty when the wire
        # had lineage to give. One retry; no recursion.
        remaining_after_bfs = deadline - time.monotonic()
        needs_retry = (
            not edges_by_id
            and level == 0
            and effective_level == 0
            and not is_inherited  # don't retry if inherited-fallback already moved us
            and (
                (focus_level is not None and focus_level != 0)
                or focus_level is None
            )
        )
        if needs_retry and remaining_after_bfs < 0.4 * (timeout_ms / 1000.0):
            # The retry re-runs the WHOLE BFS — without a floor it could
            # consume the tail of the budget and starve hydration, turning
            # a truncated-but-usable answer into a 504. Skip and report.
            logger.info(
                "trace: skipping focus-level retry for %s — only %.1fs of "
                "%.1fs budget left (<40%%)", urn, remaining_after_bfs,
                timeout_ms / 1000.0,
            )
            truncation_reason = truncation_reason or "timeout"
            needs_retry = False
        if needs_retry:
            retry_level = focus_level if focus_level is not None else -1
            logger.info(
                "trace: level=0 yielded no lineage for %s (focus_level=%s) — "
                "retrying at level=%s (peer-rollup)", urn, focus_level, retry_level,
            )
            effective_level = retry_level
            fallback_level = retry_level
            # Re-anchor at focus URN itself for peer rollup at focus level
            anchor_urn = urn
            anchor_node = focus_node
            if anchor_node:
                nodes_by_urn = {anchor_urn: anchor_node}
            else:
                nodes_by_urn = {}
            edges_by_id = {}
            upstream_urns = set()
            downstream_urns = set()
            visited = {anchor_urn}
            up_frontier = {anchor_urn} if upstream_depth > 0 else set()
            down_frontier = {anchor_urn} if downstream_depth > 0 else set()
            per_source_count = {}

            # Single retry pass — same loop body, but bounded (depth
            # additionally capped: a fine-level retry over a deep graph
            # multiplies per-hop waves against the leftover budget).
            for hop in range(min(max_depth, 5)):
                remaining_secs = deadline - time.monotonic()
                if remaining_secs <= 0:
                    truncation_reason = "timeout"
                    break
                if len(nodes_by_urn) >= max_nodes:
                    truncation_reason = "max_nodes"
                    break
                budget = max_nodes - len(nodes_by_urn)
                up_labels = {
                    u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                    for u in up_frontier if u in nodes_by_urn
                }
                down_labels = {
                    u: _sanitize_label(str(nodes_by_urn[u].entity_type))
                    for u in down_frontier if u in nodes_by_urn
                }
                hop_timeout_secs = max(0.6, min(1.5, remaining_secs / 2))
                tasks = []
                if hop < upstream_depth and up_frontier:
                    tasks.append(("up", self._expand_aggregated_set(
                        list(up_frontier), up_labels, "incoming",
                        effective_level, ltypes, budget, hop_timeout_secs,
                        default_peer_label=focus_entity_type,
                    )))
                if hop < downstream_depth and down_frontier:
                    tasks.append(("down", self._expand_aggregated_set(
                        list(down_frontier), down_labels, "outgoing",
                        effective_level, ltypes, budget, hop_timeout_secs,
                        default_peer_label=focus_entity_type,
                    )))
                if not tasks:
                    break
                results = await asyncio.gather(*(t[1] for t in tasks), return_exceptions=True)
                new_up: Set[str] = set()
                new_down: Set[str] = set()
                for (direction, _), recs in zip(tasks, results):
                    if isinstance(recs, Exception):
                        logger.warning("trace_at_level retry expand (%s) failed: %s", direction, recs)
                        continue
                    for rec in recs:
                        edge_id = rec["edgeId"]
                        if edge_id not in edges_by_id:
                            actual_type = rec.get("edgeType") or "AGGREGATED"
                            edges_by_id[edge_id] = GraphEdge(
                                id=edge_id,
                                sourceUrn=rec["sourceUrn"],
                                targetUrn=rec["targetUrn"],
                                edgeType=actual_type,
                                properties={
                                    "sourceEdgeTypes": rec.get("edgeTypes") or [actual_type],
                                    "weight": rec.get("weight") or 1,
                                },
                            )
                        new_node = rec.get("node")
                        if new_node and new_node.urn not in nodes_by_urn:
                            nodes_by_urn[new_node.urn] = new_node
                        other_urn = rec["sourceUrn"] if direction == "up" else rec["targetUrn"]
                        if other_urn not in visited:
                            visited.add(other_urn)
                            if direction == "up":
                                new_up.add(other_urn)
                                upstream_urns.add(other_urn)
                            else:
                                new_down.add(other_urn)
                                downstream_urns.add(other_urn)
                up_frontier = new_up
                down_frontier = new_down
                if not up_frontier and not down_frontier:
                    break

        # 5. ALWAYS hydrate the containment chain. A trace returns lineage URNs
        # at whatever level was requested (peer-level by default, finer levels
        # via expand). For the canvas to position those URNs in the layered
        # hierarchy it needs every containment ancestor (Dataset → Container →
        # Domain) AND the parent-child edges linking them. Without this the
        # frontend treats trace nodes as orphans, layer assignment can't place
        # them, and the user sees nothing — which is exactly the schemaField
        # trace bug. The `include_containment_edges` flag is intentionally
        # ignored here: hierarchy context is non-optional for trace responses.
        containment_edges_list: List[GraphEdge] = []
        if ctypes and nodes_by_urn and (deadline - time.monotonic()) < 2.0:
            # Not enough budget left to hydrate ancestors safely — return
            # the lineage skeleton as a truncated 200 (the FE tolerates a
            # missing chain via the ancestors_failed path) instead of
            # racing the middleware 504.
            truncation_reason = truncation_reason or "ancestors_failed"
        elif ctypes and nodes_by_urn:
            chains: Dict[str, List[str]] = {}
            try:
                chains = await self._compute_and_store_ancestors_bulk(
                    list(nodes_by_urn.keys()),
                )
            except Exception:
                # Lineage was already collected; surface the partial result
                # via truncationReason so the frontend safety-net renders
                # the lineage without the (now-missing) ancestor chain.
                truncation_reason = truncation_reason or "ancestors_failed"
            seen_anc: Set[str] = set()
            ancestor_urns: List[str] = []
            for chain in chains.values():
                for ancestor in chain or []:
                    if ancestor and ancestor not in seen_anc:
                        seen_anc.add(ancestor)
                        ancestor_urns.append(ancestor)
            new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
            if new_ancestors:
                ancestor_nodes = await self.get_nodes_batch(new_ancestors)
                for n in ancestor_nodes:
                    if n:
                        nodes_by_urn[n.urn] = n
            # Containment edges between every returned node — both lineage
            # participants and their hydrated ancestors. The chains just
            # computed are passed through so the pair derivation doesn't
            # re-fetch them (one Redis wave saved per trace).
            if len(nodes_by_urn) > 1:
                containment_edges_list = await self._fetch_containment_edges(
                    list(nodes_by_urn.keys()), ctypes, chains=chains,
                )

        # Mega-node detection: any anchor whose AGGREGATED contribution
        # exceeded the per-source degree cap is reported back to the
        # engine via a private attribute. Used by ContextEngine to fill
        # TraceMeta.megaNodes — the UI renders a "+N more" chip and
        # offers a targeted re-expand.
        mega_nodes_dicts: List[Dict[str, Any]] = []
        for source_urn, count in per_source_count.items():
            if count >= self.TRACE_DEGREE_CAP:
                direction_hint = (
                    "downstream" if source_urn in downstream_urns or source_urn == anchor_urn
                    else "upstream"
                )
                mega_nodes_dicts.append({
                    "urn": source_urn,
                    "shown": count,
                    "total": count,  # actual total unknown without extra round-trip
                    "direction": direction_hint,
                })
                if truncation_reason is None:
                    truncation_reason = "degree_cap"

        result = TraceResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            containmentEdges=containment_edges_list,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(
                urn=urn,
                level=focus_level if focus_level is not None else level,
                entityType=focus_entity_type,
            ),
            effectiveLevel=effective_level,
            isInherited=is_inherited,
            inheritedFromUrn=inherited_from,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
        )
        # Stash extras outside the pydantic schema for the engine to read.
        # `object.__setattr__` bypasses pydantic's __setattr__ guard so we
        # don't have to widen the public model just for transport.
        if mega_nodes_dicts:
            object.__setattr__(result, "_mega_nodes", mega_nodes_dicts)
        if fallback_level is not None:
            object.__setattr__(result, "_fallback_level", fallback_level)
        return result

    async def _hydrate_and_nest(
        self,
        urns: Set[str],
        ctypes: List[str],
        deadline: float,
        reason: Optional[str],
        containment_budget_s: Optional[float] = None,
    ) -> Tuple[Dict[str, GraphNode], List[GraphEdge], Optional[str]]:
        """Hydrate a walk's participants and ship the containment that nests
        them — the step BOTH closure paths share, so both inherit F18.

        Split out of ``trace_closure`` so the lazy coarse/drill walk cannot
        drift from it: the detailed hydration that distinguishes
        ``nodes_failed`` from ``nodes_partial``, the chains under their own
        floor-budgeted ``wait_for``, and the pair-fetch that synthesizes from
        those chains for anything it could not afford to ask about.

        ``containment_budget_s`` caps what the pair-fetch may spend on
        QUERIES; the default is the caller's whole residual deadline. The
        chains are the truth and the query only decorates real ids and types
        onto them, so a smaller budget costs fidelity, never coverage.

        Returns ``(nodes_by_urn, containment_edges, reason)``.
        """
        nodes_by_urn: Dict[str, GraphNode] = {}
        containment_edges_list: List[GraphEdge] = []
        buckets_failed = 0
        try:
            hydrated, buckets_failed = await self._get_nodes_batch_detailed(
                list(urns),
            )
            nodes_by_urn = {n.urn: n for n in hydrated if n}
        except Exception:
            reason = reason or "nodes_failed"
        if urns and not nodes_by_urn:
            # Nothing hydrated at all. Either every bucket failed or the walk's
            # urns have vanished from the graph; either way the response is not
            # the whole truth and must not claim to be.
            reason = reason or "nodes_failed"
        elif buckets_failed:
            # Some participants are missing and we KNOW why. Distinct from
            # `nodes_failed` so a client can say "partial" rather than "failed".
            reason = reason or "nodes_partial"

        # CONTAINMENT ALWAYS SHIPS (2026-08-21): this step used to short-
        # circuit into `ancestors_failed` whenever the walk had spent the
        # request deadline down to its last 2s — a BUDGET verdict dressed up
        # as a provider failure. At scale the walk ALWAYS spends that budget,
        # so the closure shipped its participants with containmentEdges=[]:
        # the canvas received thousands of rootless entities, nested nothing
        # and drew no chevrons. The step now always runs — the pair-fetch is
        # chunked with its own per-chunk timeout and synthesizes edges from
        # the ancestor chains when a chunk fails, so the chain is never
        # silently empty. `ancestors_failed` now means what it says: the
        # provider actually failed.
        if ctypes and nodes_by_urn:
            # The step is BUDGETED, not gated: whatever is left of the request
            # deadline bounds how long it may spend on queries, and the
            # pair-fetch synthesizes from the chains for anything it could not
            # afford to ask about. A spent budget therefore costs edge ids and
            # types, never the chain itself.
            #: Floor under the chains' own budget. Synthesis can replace a
            #: failed QUERY but not a missing CHAIN — with no chains there is
            #: nothing to synthesize from and containment ships empty, which
            #: is the precise bug this whole step exists to prevent. The
            #: cached path is a Redis pipeline read (sub-millisecond on a warm
            #: namespace), so a small floor buys the common case without
            #: reopening an unbounded tail.
            ANCESTORS_MIN_BUDGET_S = 1.0
            residual = max(0.0, deadline - time.monotonic())
            try:
                chains = await asyncio.wait_for(
                    self._compute_and_store_ancestors_bulk(
                        list(nodes_by_urn.keys()),
                    ),
                    timeout=max(residual, ANCESTORS_MIN_BUDGET_S),
                )
                seen_anc: Set[str] = set()
                ancestor_urns: List[str] = []
                for chain in chains.values():
                    for ancestor in chain or []:
                        if ancestor and ancestor not in seen_anc:
                            seen_anc.add(ancestor)
                            ancestor_urns.append(ancestor)
                new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
                if new_ancestors:
                    ancestor_nodes = await asyncio.wait_for(
                        self.get_nodes_batch(new_ancestors),
                        timeout=max(
                            deadline - time.monotonic(), ANCESTORS_MIN_BUDGET_S,
                        ),
                    )
                    for n in ancestor_nodes:
                        if n:
                            nodes_by_urn[n.urn] = n
                if len(nodes_by_urn) > 1:
                    containment_edges_list = await self._fetch_containment_edges(
                        list(nodes_by_urn.keys()), ctypes, chains=chains,
                        budget_secs=(
                            max(0.0, deadline - time.monotonic())
                            if containment_budget_s is None
                            else min(containment_budget_s, max(0.0, deadline - time.monotonic()))
                        ),
                    )
            except Exception:
                # A timeout on the chains IS a real failure of this step — we
                # have no chains, so there is nothing to synthesize from. Said
                # out loud, unlike the old budget guard which reported the same
                # word for a walk that had simply been busy.
                reason = reason or "ancestors_failed"
        return nodes_by_urn, containment_edges_list, reason

    async def trace_closure(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        seed_urns: Optional[List[str]] = None,
        exclude_urns: Optional[List[str]] = None,
        after_cursor: Optional[str] = None,
        seed_cursor: Optional[str] = None,
    ) -> TraceClosureResult:
        """Focus-scoped, regime-independent lineage closure — ONE step of a walk.

        Walks RAW lineage edges outward from the focus (upstream + downstream)
        as a bounded per-hop frontier BFS (``_expand_raw_lineage_set``),
        gathering exactly the leaves that participate in THIS focus's lineage —
        not its container's. Depends on NO ``:AGGREGATED`` cells, so it is
        correct at the finest grain even in boundary regime where leaf rollups
        are never materialised (the "trace disappears at the attribute level"
        bug). Always hydrates the containment ancestor chain so the canvas can
        nest the participants — containment is used to PLACE nodes, never as a
        lineage hop.

        Bounded like ``trace_at_level``: the engine deadline (< the middleware
        tier) makes it truncate to a 200 with a ``truncationReason`` rather than
        race a 504; ``max_nodes`` caps the working set. Python is a frontier
        cursor + a visited set (cycle-safe on any cyclic graph); every
        set-shaped step is one label-qualified index-seeking Cypher.

        The walk is SERVER-DRIVEN one step at a time — the client keeps the
        graph it has accumulated and asks for the next step — so three
        parameters describe where it already is:

        ``seed_urns``    start the hops from these known lineage participants
                         instead of deriving a seed from the focus. A walk
                         CONTINUATION: the client is expanding a frontier node,
                         not re-anchoring on the focus.
        ``exclude_urns`` nodes the client already holds. They are never
                         re-shipped in ``nodes``, but an EDGE into one still
                         is — that seam edge is what stitches this step onto
                         the graph the client already has. It says nothing
                         about where the walk may START: a node named in
                         ``seed_urns`` is walked from (and hydrated with the
                         rest of the working set) whether or not it is also
                         excluded, which is the only shape a real client
                         ever sends.
        ``after_cursor`` page ONE node's adjacency in ONE direction instead of
                         walking: the fallback for a hub with more lineage than
                         a hop can carry. ``e:<edge id>`` names the NEXT id to
                         consider, so ``e:0`` is from the start.

        ``frontierUp``/``frontierDown`` name the boundary nodes the walk did NOT
        finish — depth ran out, the ``max_nodes`` budget cut them off, or a page
        came back full — carrying the full-graph degree in that direction when
        it is known, so the canvas can offer "+N more" instead of presenting a
        bounded closure as the whole truth. A boundary node whose adjacency is
        already fully on screen is NOT frontier: it is an honest dead end, and
        saying otherwise puts a chip on a node with nothing behind it. An entry
        carries ``nextCursor`` when it can be RESUMED: the budget/deadline cut
        set pages from ``e:0``, a full page resumes past its last row, and a
        depth-exhausted entry gets none (re-root it with ``seed_urns``).
        """
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)

        # Normalize + per-graph case-align the declared rel-type sets (the
        # case-sensitive [:TYPE] / type(r) patterns need the graph's spelling).
        ltypes = [t.upper() for t in (lineage_edge_types or [])]
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes
        ctypes = self._alias_rel_types(ctypes) if ctypes else ctypes

        try:
            focus_node = await self.get_node(urn)
        except Exception:
            focus_node = None
        focus_level = self._get_node_level(focus_node.entity_type) if focus_node else None
        focus_entity_type = str(focus_node.entity_type) if focus_node else "unknown"
        focus_label = focus_entity_type if focus_node else ""

        edges_by_id: Dict[str, GraphEdge] = {}
        upstream_urns: Set[str] = set()
        downstream_urns: Set[str] = set()
        truncation_reason: Optional[str] = None
        excluded: Set[str] = set(exclude_urns or [])
        seed_truncated = False

        # Boundary bookkeeping, dict-as-ordered-set: ``cut_*`` = stopped by the
        # budget or the deadline, ``depth_*`` = stopped by the requested depth.
        # The dicts buy dedup and, for the per-row cut insertions, row order.
        # The ring folds below come from SETS, so those members land in hash
        # order — this is not a sorted or fully insertion-ordered frontier.
        cut_up: Dict[str, None] = {}
        cut_down: Dict[str, None] = {}
        depth_up: Dict[str, None] = {}
        depth_down: Dict[str, None] = {}
        paged_anchor: Optional[str] = None
        paged_cursor: Optional[str] = None

        def _record_edge(rec: Dict[str, Any]) -> None:
            eid = rec["edgeId"]
            if eid not in edges_by_id:
                edges_by_id[eid] = GraphEdge(
                    id=eid,
                    sourceUrn=rec["sourceUrn"],
                    targetUrn=rec["targetUrn"],
                    edgeType=rec["edgeType"],
                    properties={},
                )

        # Seed-page resume point ("s:<last-descendant-urn>"): set only by the
        # container-seed path when its keyset page capped; the hub-paging and
        # explicit-seed paths have no descendant pages of their own.
        next_seed_after: Optional[str] = None
        if after_cursor is not None:
            # ---- paging shape: one node, one direction, one page ----------
            # No seed walk and no BFS: the client is draining a single hub it
            # already has, so re-walking would re-ship everything around it.
            try:
                after_id = int(after_cursor[2:])
            except (TypeError, ValueError):
                # The endpoint guarantees ^e:\d+$; if something else arrives,
                # refuse rather than silently page from the start (which would
                # re-ship a page the client already holds).
                raise ValueError("invalid cursor")
            up = int(upstream_depth) > 0
            anchor_label = await self._get_cached_label(urn) or focus_label
            rows, last_edge_id = await self._page_raw_lineage_single(
                urn, anchor_label, "incoming" if up else "outgoing", ltypes,
                after_id, max_nodes, max(0.0, deadline - time.monotonic()),
            )
            # The anchor and the client's known set are "already visited" here,
            # exactly as in the BFS below: their edges still ship (that is the
            # seam), but the nodes are not re-shipped and are not re-attributed
            # to a direction the client already filed them under.
            known = excluded | {urn}
            discovered: Set[str] = {urn}
            for rec in rows:
                _record_edge(rec)
                other = rec.get("otherUrn")
                if not other or other in known:
                    continue
                discovered.add(other)
                (upstream_urns if up else downstream_urns).add(other)
                # A partner arrives here UNWALKED — the page read the ANCHOR's
                # adjacency, never this node's — which is exactly the shape of
                # a ring the last allowed hop discovered. So it is filed like
                # one: a depth-boundary candidate, probed below and kept only
                # if it has more than the client can see. Filing it nowhere
                # (the bug) shipped a partner with no frontier entry at all,
                # and a partner with no entry is stamped "the walk ends here".
                (depth_up if up else depth_down)[other] = None
            if len(rows) >= max_nodes:
                # A FULL page means there is more of this node's adjacency.
                # Its entry is kept whatever the probe says — here the cursor,
                # not the count, is the affordance.
                paged_anchor = urn
                (cut_up if up else cut_down)[urn] = None
                if last_edge_id is not None:
                    # A cursor names the NEXT id to consider, so resume one
                    # past the last row shipped.
                    paged_cursor = f"e:{last_edge_id + 1}"
        else:
            # ---- seed: the nodes the hops start from -----------------------
            if seed_urns:
                # A walk CONTINUATION. The caller already knows which nodes
                # carry the lineage it is expanding from, so the container seed
                # walk is deliberately skipped: re-deriving a seed from the
                # focus's containment would cost a round-trip and re-anchor the
                # walk on a focus the client has already moved past.
                # A SEED IS AN INSTRUCTION, NOT A CANDIDATE. ``exclude_urns``
                # says what must not be re-SHIPPED; it never says where the
                # walk may START. The two got conflated here, and the cost
                # was total: a client's seeds are BY CONSTRUCTION nodes it
                # already holds (the lineage leaves under the card whose ⊕
                # was clicked), so every seed was also excluded — and every
                # expand of a card whose CHILDREN carry the lineage, rather
                # than the card itself, walked from an empty seed and
                # returned nothing. Measured live on a 14-column table: 0
                # edges and 0 frontier entries, against 14 of each for the
                # identical request with the seeds kept out of the exclude
                # set. Every test in the live gate had carefully subtracted
                # its seeds from its excludes; the client never could.
                wanted = list(dict.fromkeys(seed_urns))
                labels = await self._resolve_urn_labels_bulk(wanted) if wanted else {}
                seed = [(u, labels.get(u) or "") for u in wanted]
                # AND A SEED THAT STANDS FOR FINER THINGS RESOLVES TO THEM.
                # Lineage lives at the leaves; a table carries none of its
                # own, its COLUMNS do. A client expanding a card it has not
                # opened yet holds none of those columns, so the only name
                # it can send is the card's — and taking that literally
                # walked a node with no lineage on it and returned an empty
                # hop set, no frontier, and no error. Reported live: the ⊕
                # on `int_clean_contacts_t2` shipped three nodes and zero
                # edges while the same table's eight columns each had an
                # upstream one hop away.
                #
                # This is the rule ``_collect_lineage_seed`` already applies
                # to the ANCHOR ("a container focus contributes nothing
                # directly — walk containment down to find who
                # participates"), applied to every seed, so the two paths
                # cannot disagree about what "start here" means.
                beneath, seed_capped = await self._descendant_lineage_seed(
                    wanted, labels, ltypes, ctypes,
                    max(1, max_nodes // 2),
                    max(0.6, min(1.5, deadline - time.monotonic())),
                )
                have = {u for u, _ in seed}
                seed += [(u, lbl) for u, lbl in beneath if u not in have]
            else:
                seed_timeout = max(0.6, min(1.5, deadline - time.monotonic()))
                # Reserve at least half the node budget for the WALK. A fat
                # container can have more lineage-bearing descendants than the
                # whole budget; seeding all of them leaves nothing to spend on
                # hops, and the client gets a board of nodes with no lineage on
                # it — the one thing a lineage view must never be.
                seed_limit = max(1, max_nodes // 2)
                # "s:<last-descendant-urn>" — the keyset resume point a capped
                # page shipped as seedCursor. Malformed cursors read as page 1.
                seed_after = (
                    seed_cursor[2:]
                    if seed_cursor and seed_cursor.startswith("s:") and len(seed_cursor) > 2
                    else None
                )
                seed, seed_capped, next_seed_after = await self._collect_lineage_seed(
                    urn, focus_label, ltypes, ctypes, seed_limit, seed_timeout,
                    after_urn=seed_after,
                )
            # A capped seed makes the response partial, but it must NOT stop the
            # walk: the flag is folded into truncation_reason at the return, not
            # here, because setting it now would fail the loop's
            # `not truncation_reason` guard and ship a nodes-without-edges board.
            seed_truncated = seed_capped

            seed_set = {u for u, _ in seed}
            seed_labels = {u: lbl for u, lbl in seed}

            # Excluded urns are pre-visited: never walked from, never
            # re-shipped — but an edge INTO one is still recorded below.
            visited: Set[str] = seed_set | {urn} | excluded
            discovered = seed_set | {urn}

            up_frontier: Set[str] = set(seed_set) if upstream_depth > 0 else set()
            down_frontier: Set[str] = set(seed_set) if downstream_depth > 0 else set()
            up_labels: Dict[str, str] = dict(seed_labels)
            down_labels: Dict[str, str] = dict(seed_labels)

            max_hops = max(int(upstream_depth), int(downstream_depth))
            hop = 0
            while (up_frontier or down_frontier) and hop < max_hops and not truncation_reason:
                hop += 1
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    truncation_reason = "timeout"
                    break
                hop_timeout = max(0.6, min(1.5, remaining / 2))
                # Ask for only what still fits under max_nodes: rows past the
                # budget get dropped below anyway, and their edges with them.
                hop_limit = max(1, max_nodes - len(discovered))
                # The excluded set NEVER filters the query, at any hop. It is
                # already pre-populated into `visited`, and rows are recorded
                # edge-FIRST/visited-second below, so an excluded node costs a
                # row and yields only its EDGE — the seam that stitches this
                # step onto the graph the client already holds.
                #
                # This used to be a DB-side `NOT o.urn IN $exclude` on hop 1,
                # on the reasoning that a hop-1 seam is always an edge the
                # client walked in on. It is not: on a DIAMOND (b→c, b→x,
                # x→c) the client holds b, c and x after one hop but has
                # never seen x→c, and a continuation seeded at c had that row
                # filtered away in the DB — lost for good, while a one-shot
                # depth-2 closure showed it plainly. Uniform semantics cost
                # hop-1 LIMIT budget on rows into already-known nodes; that
                # is the price of never losing an edge between two held nodes.
                directions: List[str] = []
                coros = []
                if up_frontier and hop <= upstream_depth:
                    directions.append("up")
                    coros.append(self._expand_raw_lineage_set(
                        list(up_frontier), up_labels, "incoming", ltypes,
                        hop_limit, hop_timeout,
                    ))
                elif up_frontier:
                    # Ran out of DEPTH, not of graph (asymmetric depths) — this
                    # ring is the upstream boundary, and the loop is about to
                    # forget it while the other direction keeps going.
                    depth_up.update(dict.fromkeys(up_frontier))
                if down_frontier and hop <= downstream_depth:
                    directions.append("down")
                    coros.append(self._expand_raw_lineage_set(
                        list(down_frontier), down_labels, "outgoing", ltypes,
                        hop_limit, hop_timeout,
                    ))
                elif down_frontier:
                    depth_down.update(dict.fromkeys(down_frontier))
                if not coros:
                    break

                results = await asyncio.gather(*coros)

                new_up: Set[str] = set()
                new_down: Set[str] = set()
                new_up_labels: Dict[str, str] = {}
                new_down_labels: Dict[str, str] = {}
                for direction, recs in zip(directions, results):
                    if len(recs) >= hop_limit:
                        # The hop hit its own LIMIT: rows were left on the
                        # floor and nothing tells us WHICH frontier node they
                        # belonged to, so the whole ring is a candidate. The
                        # probe drops the ones that turn out to be fully shown.
                        truncation_reason = "max_nodes"
                        ring = up_frontier if direction == "up" else down_frontier
                        cut = cut_up if direction == "up" else cut_down
                        cut.update(dict.fromkeys(ring))
                    for rec in recs:
                        other = rec.get("otherUrn")
                        is_new = bool(other) and other not in visited
                        if is_new and len(discovered) >= max_nodes:
                            # Budget check BEFORE recording anything: a node we
                            # cannot ship must not leave its edge behind, or the
                            # canvas draws an edge into nothing. What has more
                            # to give is the NEAR endpoint — and unlike the one
                            # we are dropping, it is on screen, so it is what
                            # the client can ask about.
                            truncation_reason = "max_nodes"
                            near = rec["targetUrn"] if direction == "up" else rec["sourceUrn"]
                            (cut_up if direction == "up" else cut_down)[near] = None
                            continue
                        # Edge FIRST, visited check second: an edge to an
                        # already-known node is the seam that joins this step to
                        # what the client already holds.
                        _record_edge(rec)
                        if not is_new:
                            continue
                        visited.add(other)
                        discovered.add(other)
                        lbl = rec.get("otherLabel") or ""
                        if direction == "up":
                            new_up.add(other)
                            upstream_urns.add(other)
                            new_up_labels[other] = lbl
                        else:
                            new_down.add(other)
                            downstream_urns.add(other)
                            new_down_labels[other] = lbl
                up_frontier, down_frontier = new_up, new_down
                up_labels, down_labels = new_up_labels, new_down_labels

            if truncation_reason in ("max_nodes", "timeout"):
                # Whatever we were about to expand (timeout) or had just
                # discovered (max_nodes) never got its hop.
                cut_up.update(dict.fromkeys(up_frontier))
                cut_down.update(dict.fromkeys(down_frontier))
            else:
                # Depth exhaustion: the ring that was still growing when the
                # last allowed hop finished. A ring that simply DRAINED is
                # empty here — a dead end, never a frontier.
                depth_up.update(dict.fromkeys(up_frontier))
                depth_down.update(dict.fromkeys(down_frontier))

        # ---- frontier: what the walk did not finish, and how much is left --
        candidates_up = list(dict.fromkeys([*depth_up, *cut_up]))
        candidates_down = list(dict.fromkeys([*depth_down, *cut_down]))
        frontier_up: List[TraceFrontierNode] = []
        frontier_down: List[TraceFrontierNode] = []
        if candidates_up or candidates_down:
            def _probe_slice(candidates: List[str]) -> List[str]:
                # A full page files a budget's worth of partners as candidates,
                # and they queue AHEAD of the anchor — enough to push the one
                # entry a draining client is actually reading past the cap. The
                # anchor goes first; everything else keeps candidate order.
                if paged_anchor is not None and paged_anchor in candidates:
                    rest = [u for u in candidates if u != paged_anchor]
                    # max(0, …): a cap of 0 means "do not probe", and a bare
                    # `cap - 1` would slice [:-1] — probing all but one.
                    return [paged_anchor, *rest[:max(0, CLOSURE_FRONTIER_PROBE_CAP - 1)]]
                return candidates[:CLOSURE_FRONTIER_PROBE_CAP]

            probe_up = _probe_slice(candidates_up)
            probe_down = _probe_slice(candidates_down)
            degrees: Dict[str, Dict[str, int]] = {}
            if (deadline - time.monotonic()) < 1.5:
                # Not enough budget for the probe wave. The frontier still
                # ships — unknown counts, not invented ones.
                probe_up, probe_down = [], []
            else:
                try:
                    degrees = await self.get_node_degrees(
                        list(dict.fromkeys([*probe_up, *probe_down])), ltypes,
                    )
                except Exception as exc:
                    logger.warning("trace_closure: frontier probe failed: %s", exc)

            shown_in: Dict[str, int] = defaultdict(int)
            shown_out: Dict[str, int] = defaultdict(int)
            for edge in edges_by_id.values():
                shown_out[edge.source_urn] += 1
                shown_in[edge.target_urn] += 1

            def _frontier(
                candidates: List[str], probed: Set[str], key: str,
                shown: Dict[str, int], cut: Dict[str, None],
            ) -> List[TraceFrontierNode]:
                out: List[TraceFrontierNode] = []
                for u in candidates:
                    total = (degrees.get(u) or {}).get(key) if u in probed else None
                    if u == paged_anchor:
                        out.append(TraceFrontierNode(
                            urn=u, totalCount=total, nextCursor=paged_cursor,
                        ))
                        continue
                    # A node the BUDGET or the DEADLINE cut off has a sound
                    # resume: page it from the start ("e:0" — a cursor names
                    # the next id to consider) and let the client's merge
                    # dedupe whatever it already holds. A node that merely ran
                    # out of DEPTH does not: nothing about it was left
                    # half-read, its affordance is a re-root via seedUrns, and
                    # a cursor there would promise a continuation that isn't.
                    cursor = "e:0" if u in cut else None
                    if total is None:
                        # Unprobed, probe failed, or the degree bucket failed —
                        # absence is UNKNOWN, never zero.
                        out.append(TraceFrontierNode(urn=u, nextCursor=cursor))
                    elif total > shown.get(u, 0):
                        out.append(TraceFrontierNode(
                            urn=u, totalCount=total, nextCursor=cursor,
                        ))
                    # else: everything this node has is already on screen.
                return out

            frontier_up = _frontier(candidates_up, set(probe_up), "in", shown_in, cut_up)
            frontier_down = _frontier(candidates_down, set(probe_down), "out", shown_out, cut_down)

        # Hydrate participant nodes, then their containment ancestor chains, so
        # the canvas can nest the closure. Guarded: on failure surface a
        # truncated-200 with the reason rather than dropping the lineage.
        #
        # `_get_nodes_batch_detailed` rather than `get_nodes_batch` because the
        # public form SWALLOWS per-bucket failures and returns a short list. A
        # total swallow used to be indistinguishable from "the walk found
        # nothing": `nodes_by_urn` came back empty, the containment step below
        # was skipped by its own `and nodes_by_urn` guard, and the response
        # shipped containmentEdges=[] with truncationReason NULL — a silent []
        # by a second route, after we had just closed the first one.
        nodes_by_urn, containment_edges_list, truncation_reason = await self._hydrate_and_nest(
            discovered, ctypes, deadline, truncation_reason,
        )

        # The seed cap, folded in at the end: the walk ran on what it had, and
        # the response still says out loud that it is partial.
        truncation_reason = truncation_reason or ("max_nodes" if seed_truncated else None)

        return TraceClosureResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            containmentEdges=containment_edges_list,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(
                urn=urn,
                level=focus_level if focus_level is not None else 0,
                entityType=focus_entity_type,
            ),
            effectiveLevel=focus_level if focus_level is not None else 0,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
            frontierUp=frontier_up,
            frontierDown=frontier_down,
            seedTruncated=seed_truncated,
            seedCursor=(f"s:{next_seed_after}" if next_seed_after else None),
        )

    async def _lineage_children_page(
        self,
        parent_urn: str,
        parent_label: str,
        lane_types: List[str],
        ctypes: List[str],
        after_urn: Optional[str],
        limit: int,
        timeout_secs: float,
    ) -> Tuple[List[Tuple[str, str]], Optional[str]]:
        """One keyset page of ``parent_urn``'s DIRECT containment children
        that carry lineage — the only children a trace has any business
        drawing.

        Two shapes, in order, because they answer two different graphs:

          1. the child carries a lineage edge ITSELF (raw or rollup). On an
             estate with a materialised :AGGREGATED lane this is the whole
             answer at every grain — a container with flow beneath it has a
             rollup ON IT, which is exactly what the lane is for.
          2. nothing did, so the child may still HOST the lineage further
             down (a rollup-less estate: Roots ⊃ Node ⊃ … ⊃ Node with the
             flow only at the leaves). Only then is the subtree probe worth
             its cost, and it runs with its own timeout: failing it degrades
             to "no contributing children", never to a failed trace.

        Ordered by urn so the page is a true keyset — ``after_urn``
        continues past the previous page's last child, SKIP-free.
        Returns ``(pairs, next_after)``; ``next_after`` is set only when the
        page came back FULL, which is the one thing that means "there are
        more" (a short page is the end).
        """
        if not ctypes or limit <= 0:
            return [], None

        ct_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        lane_alt = "|".join(_sanitize_label(t) for t in lane_types if t)
        if not ct_alt or not lane_alt:
            return [], None
        sl = _sanitize_label(parent_label) if parent_label else ""
        label_clause = f":{sl}" if sl else ""
        after_clause = "AND c.urn > $after " if after_urn else ""
        params: Dict[str, Any] = {"urn": parent_urn, "lim": limit}
        if after_urn:
            params["after"] = after_urn
        per_query = max(0.6, min(2.0, timeout_secs))

        rows: List[List[Any]] = []
        try:
            res = await self._ro_query(
                f"MATCH (p{label_clause} {{urn: $urn}})-[:{ct_alt}]->(c) "
                f"WHERE (c)-[:{lane_alt}]-() {after_clause}"
                "RETURN c.urn AS urn, labels(c)[0] AS label ORDER BY urn LIMIT $lim",
                params=params, timeout=per_query, op="trace.lazy_children",
            )
            rows = list(res.result_set or [])
        except Exception as exc:
            logger.warning("trace_closure_lazy: children page failed for %s: %s", parent_urn, exc)

        if not rows:
            hops = self._containment_hop_bound()
            try:
                res = await self._ro_query(
                    f"MATCH (p{label_clause} {{urn: $urn}})-[:{ct_alt}]->(c)-[:{ct_alt}*1..{hops}]->(d) "
                    f"WHERE (d)-[:{lane_alt}]-() {after_clause}"
                    "RETURN DISTINCT c.urn AS urn, labels(c)[0] AS label ORDER BY urn LIMIT $lim",
                    params=params, timeout=per_query, op="trace.lazy_children_deep",
                )
                rows = list(res.result_set or [])
            except Exception as exc:
                logger.warning(
                    "trace_closure_lazy: deep children page failed for %s: %s", parent_urn, exc,
                )
                rows = []

        pairs: List[Tuple[str, str]] = []
        seen: Set[str] = set()
        for row in rows:
            u = row[0]
            if not u or u in seen:
                continue
            seen.add(u)
            pairs.append((u, (row[1] if len(row) > 1 else None) or ""))
        next_after = pairs[-1][0] if len(rows) >= limit and pairs else None
        return pairs, next_after

    async def trace_closure_lazy(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        aggregated_edge_type: str,
        drill: bool,
        page_size: int,
        timeout_ms: int,
        after_cursor: Optional[str] = None,
        seed_cursor: Optional[str] = None,
    ) -> TraceClosureResult:
        """THE LAZY TRACE — one grain, one hop, no caps (user ruling
        2026-08-21: "no limits; lazy-loaded; fetch the upstream/downstream
        entity and their containments; expand lazily or on the fly").

        The fine closure walk fetches a focus's WHOLE leaf-grain lineage
        before the first paint. Measured on the 2.08M-node estate that is
        9.7 s and 2,004 participants for one attribute, and 5.9 s / 1,301
        for one container — with a 1,152-entry frontier still unfollowed.
        No amount of budget tuning fixes that: the closure of a real focus
        is simply bigger than a first paint. So the trace stops asking for
        it. It asks for what is on screen, and asks again when the reader
        opens something.

        ONE REQUEST SHAPE, TWO ANCHORS:

        ``drill=False`` (grain ``'coarse'`` — the FIRST PAINT). ``urn`` is
        the focus. Ships the focus, its containment chain, the
        lineage-carrying children directly inside it (so the R1 picture —
        the focus open over its own contents — needs no second request),
        and every partner ONE lineage hop from the focus, each with its
        own full ancestor chain. Partner GRAIN is whatever the lane
        offers: where the :AGGREGATED rollup lane has an edge on the focus
        the partner arrives at the rollup's grain WITH its weight; where it
        does not, the raw hop's endpoint arrives at leaf grain. A container
        focus with neither — the rollup-less pipeline estates — falls back
        to seeding from its lineage-bearing descendants, i.e. a raw depth-1
        closure around the focus subtree.

        ``drill=True`` (the reader opened a card). ``urn`` is that card.
        Same shape one containment step down: the card's lineage-carrying
        children, and the hop-1 lineage of THOSE children, so every wire
        into the card refines to the grain the reader just revealed. The
        far endpoints ship with their ancestor chains too — a wire whose
        other end the client cannot place is a wire it would have to drop
        (and would then miscount as "outside this view").

        NO CAPS ANYWHERE. ``page_size`` is a PAGE, not a budget:

          * more children than a page  → ``seedCursor='s:<last-child-urn>'``
            (keyset, SKIP-free — a deep page costs what the first one did);
          * more edges on an anchor than a page → that anchor is filed in
            ``frontierUp``/``frontierDown`` with ``nextCursor='e:0'``, the
            same resumable-hub contract ``trace_closure`` ships, and the
            driver pages it with ``afterCursor``.

        The driver follows both to exhaustion, so a 4,000-partner container
        is COMPLETE at its grain — just not in one response. The only
        ``truncationReason`` reachable here is ``'timeout'``; ``max_nodes``
        is not a concept on this path.

        EVERY PARTNER IS A FRONTIER. This walk asked one hop and no more,
        so what lies beyond a partner is genuinely unknown — each is filed
        as a depth-boundary entry (no cursor: the resume is a re-root, not
        a page) and the client reads its counts as floors ("1,203+"). No
        degree probe: on a hop-1 walk "everything this node has is already
        on screen" is a statement about the anchor's edges, never about the
        partner's, so probing it could only produce a confident lie.
        """
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)

        ltypes = [t.upper() for t in (lineage_edge_types or [])]
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes
        ctypes = self._alias_rel_types(ctypes) if ctypes else ctypes
        agg = (aggregated_edge_type or "AGGREGATED").upper()
        # ONE LANE, BOTH GRAINS. The engine strips :AGGREGATED out of the
        # lineage types on purpose — walking rollups as if they were hops
        # double-counts one flow once per grain above it. Here nothing is
        # WALKED past hop 1, so the two grains cannot compound: the rollup
        # is the coarse statement about the same hop, the client's grain
        # rule (traceWireLedger) decides which one gets drawn, and asking
        # for both in one query is what makes the partner arrive at the
        # grain the view can actually place.
        lane_types = [*ltypes] + ([agg] if agg not in ltypes else [])

        want_up = int(upstream_depth) > 0
        want_down = int(downstream_depth) > 0

        try:
            anchor_node = await self.get_node(urn)
        except Exception:
            anchor_node = None
        anchor_label = str(anchor_node.entity_type) if anchor_node else ""

        edges_by_id: Dict[str, GraphEdge] = {}
        upstream_urns: Set[str] = set()
        downstream_urns: Set[str] = set()
        truncation_reason: Optional[str] = None
        # Boundary bookkeeping, dict-as-ordered-set, exactly as in
        # ``trace_closure``: ``cut_*`` = a page came back full and can be
        # RESUMED, ``depth_*`` = unexplored beyond this walk's one hop.
        cut_up: Dict[str, None] = {}
        cut_down: Dict[str, None] = {}
        depth_up: Dict[str, None] = {}
        depth_down: Dict[str, None] = {}
        paged_anchor: Optional[str] = None
        paged_cursor: Optional[str] = None

        def _record(rec: Dict[str, Any]) -> None:
            eid = rec["edgeId"]
            if eid in edges_by_id:
                return
            # A ROLLUP WITHOUT ITS WEIGHT IS A LINE WITH NO NUMBER ON IT.
            # The client's grain rule reads `properties.weight` to decide
            # what a coarse wire still has left to say against the raw
            # detail beneath it; absent, every rollup would draw as "1".
            weight = rec.get("weight")
            edges_by_id[eid] = GraphEdge(
                id=eid,
                sourceUrn=rec["sourceUrn"],
                targetUrn=rec["targetUrn"],
                edgeType=rec["edgeType"],
                properties=({"weight": int(weight)} if isinstance(weight, (int, float)) else {}),
            )

        # ---- the card's own contents ----------------------------------
        # Skipped entirely on a cursor PAGE of one anchor's edges: that
        # request is draining a hub the client already has open.
        children: List[Tuple[str, str]] = []
        next_child_after: Optional[str] = None
        child_after = (
            seed_cursor[2:]
            if seed_cursor and seed_cursor.startswith("s:") and len(seed_cursor) > 2
            else None
        )
        if after_cursor is None:
            children, next_child_after = await self._lineage_children_page(
                urn, anchor_label, lane_types, ctypes, child_after,
                max(1, page_size), max(0.6, min(2.0, deadline - time.monotonic())),
            )

        # ---- who this walk asks about ---------------------------------
        # Coarse asks about the FOCUS's own hops; a drill asks about the
        # hops of the children it just revealed (the card's own hops are
        # already on screen — they are why it was worth opening).
        if after_cursor is not None:
            lineage_anchors: List[Tuple[str, str]] = [(urn, anchor_label)]
        elif drill:
            lineage_anchors = list(children)
        elif child_after is not None:
            # A coarse CHILDREN page. The focus's hops came with page one;
            # re-deriving them would re-ship a hub for nothing.
            lineage_anchors = []
        else:
            lineage_anchors = [(urn, anchor_label)]

        discovered: Set[str] = {urn} | {c for c, _ in children}

        # ---- hop 1 ----------------------------------------------------
        if lineage_anchors and lane_types:
            anchor_labels = {u: lbl for u, lbl in lineage_anchors}
            anchor_urns = [u for u, _ in lineage_anchors]
            hop_timeout = max(0.6, min(1.5, (deadline - time.monotonic()) / 2))
            if hop_timeout <= 0.6 and time.monotonic() >= deadline:
                truncation_reason = "timeout"

            if after_cursor is not None:
                # ---- resumable hub page: one node, one direction ------
                try:
                    after_id = int(after_cursor[2:])
                except (TypeError, ValueError):
                    raise ValueError("invalid cursor")
                rows, last_edge_id = await self._page_raw_lineage_single(
                    urn, anchor_label, "incoming" if want_up else "outgoing",
                    lane_types, after_id, max(1, page_size),
                    max(0.0, deadline - time.monotonic()),
                )
                for rec in rows:
                    _record(rec)
                    other = rec.get("otherUrn")
                    if not other or other == urn:
                        continue
                    discovered.add(other)
                    (upstream_urns if want_up else downstream_urns).add(other)
                    (depth_up if want_up else depth_down)[other] = None
                if len(rows) >= max(1, page_size):
                    paged_anchor = urn
                    (cut_up if want_up else cut_down)[urn] = None
                    if last_edge_id is not None:
                        paged_cursor = f"e:{last_edge_id + 1}"
            elif truncation_reason is None:
                anchor_set = set(anchor_urns)
                stopped_after: Optional[str] = None      # last anchor fully walked
                pending_rollups: List[Tuple[str, Dict[str, Any]]] = []
                for start in range(0, len(anchor_urns), CLOSURE_LAZY_ANCHOR_CHUNK):
                    # Rollups are held back for the depth rule below, so they
                    # have to be counted here or a rollup-heavy page never
                    # notices it is full.
                    if len(edges_by_id) + len(pending_rollups) >= CLOSURE_LAZY_EDGE_CEILING:
                        # The page is full. Its resume is the keyset cursor
                        # over the ANCHORS — one cursor, exact, and the next
                        # page starts strictly past the last one walked.
                        break
                    chunk = anchor_urns[start:start + CLOSURE_LAZY_ANCHOR_CHUNK]
                    chunk_limit = len(chunk) * CLOSURE_LAZY_EDGES_PER_ANCHOR
                    directions: List[str] = []
                    coros = []
                    if want_up:
                        directions.append("up")
                        coros.append(self._expand_raw_lineage_set(
                            chunk, anchor_labels, "incoming", lane_types,
                            chunk_limit, hop_timeout,
                        ))
                    if want_down:
                        directions.append("down")
                        coros.append(self._expand_raw_lineage_set(
                            chunk, anchor_labels, "outgoing", lane_types,
                            chunk_limit, hop_timeout,
                        ))
                    results = await asyncio.gather(*coros) if coros else []
                    for direction, recs in zip(directions, results):
                        if len(recs) >= chunk_limit:
                            # A MEGA-HUB. This chunk's rows were cut and
                            # nothing says which of its anchors lost them, so
                            # all of them — at most one chunk's worth — are
                            # offered as resumable ("e:0" pages one from the
                            # start; the client's merge dedupes the overlap).
                            # A cursor, never a truncation.
                            cut = cut_up if direction == "up" else cut_down
                            cut.update(dict.fromkeys(chunk))
                        for rec in recs:
                            other = rec.get("otherUrn")
                            # A ROLLUP UPHILL IS SOMEBODY ELSE'S LINEAGE.
                            # Rollups are materialised per containment-level
                            # PAIR, so a table carries :AGGREGATED edges to
                            # every database, application and domain its flow
                            # touches. Following those is what made a trace of
                            # one table "keep going and going across every
                            # ancestor" — the database's rollup summarises
                            # every table in it, not this one. Deferred here
                            # and resolved by depth below; raw hops are
                            # unaffected, being leaf-grain by nature.
                            if str(rec.get("edgeType") or "").upper() == agg:
                                pending_rollups.append((direction, rec))
                                continue
                            _record(rec)
                            if not other or other in anchor_set:
                                continue
                            discovered.add(other)
                            if direction == "up":
                                upstream_urns.add(other)
                                depth_up[other] = None
                            else:
                                downstream_urns.add(other)
                                depth_down[other] = None
                    stopped_after = chunk[-1]

                # ---- the rollups that point at this grain or finer --------
                # One chain lookup for the whole page (Redis-cached), then the
                # rule: keep a rollup only when the far endpoint sits at the
                # focus's containment depth or deeper. Same-grain rollups are
                # the coarse statement the reader asked for; the grain rule
                # retires them as raw evidence lands. Shallower ones are the
                # estate, and they are not this trace.
                if pending_rollups:
                    far = {r.get("otherUrn") for _, r in pending_rollups if r.get("otherUrn")}
                    try:
                        depths = await self._compute_and_store_ancestors_bulk([urn, *far])
                    except Exception:
                        depths = {}
                    focus_depth = len(depths.get(urn) or [])
                    for direction, rec in pending_rollups:
                        other = rec.get("otherUrn")
                        if other and len(depths.get(other) or []) < focus_depth:
                            continue
                        _record(rec)
                        if not other or other in anchor_set:
                            continue
                        discovered.add(other)
                        if direction == "up":
                            upstream_urns.add(other)
                            depth_up[other] = None
                        else:
                            downstream_urns.add(other)
                            depth_down[other] = None

                # The card's contents are walked in urn order, so an
                # unfinished page resumes exactly where it stopped. The
                # anchors it never reached do NOT ship: a child shipped
                # without its lineage is a row the reader would read as
                # "nothing flows here".
                if drill and stopped_after is not None and stopped_after != anchor_urns[-1]:
                    walked = set(anchor_urns[:anchor_urns.index(stopped_after) + 1])
                    discovered -= (anchor_set - walked)
                    next_child_after = stopped_after

        # ---- the rollup-less container focus ---------------------------
        # A container that carries no lineage of its own and has no rollup
        # standing in for it (the pipeline estates: Roots ⊃ Node, lineage
        # only at the leaves). Its flow lives on its DESCENDANTS, so seed
        # from those and take their hop — the raw depth-1 closure around
        # the focus subtree. Only for a coarse first page: a drill already
        # asks about children, and a cursor page is draining a known hub.
        if (
            not drill and after_cursor is None and child_after is None
            and not edges_by_id and ctypes and ltypes
            and truncation_reason is None
        ):
            seed, _seed_capped, _next = await self._collect_lineage_seed(
                urn, anchor_label, ltypes, ctypes, max(1, page_size),
                max(0.6, min(1.5, deadline - time.monotonic())),
            )
            seed = [(u, lbl) for u, lbl in seed if u != urn]
            if seed:
                seed_labels = {u: lbl for u, lbl in seed}
                seed_urns_list = [u for u, _ in seed]
                hop_timeout = max(0.6, min(1.5, (deadline - time.monotonic()) / 2))
                hop_limit = max(1, len(seed_urns_list)) * CLOSURE_LAZY_EDGES_PER_ANCHOR
                directions = []
                coros = []
                if want_up:
                    directions.append("up")
                    coros.append(self._expand_raw_lineage_set(
                        seed_urns_list, seed_labels, "incoming", ltypes,
                        hop_limit, hop_timeout,
                    ))
                if want_down:
                    directions.append("down")
                    coros.append(self._expand_raw_lineage_set(
                        seed_urns_list, seed_labels, "outgoing", ltypes,
                        hop_limit, hop_timeout,
                    ))
                results = await asyncio.gather(*coros) if coros else []
                seed_set = set(seed_urns_list)
                for direction, recs in zip(directions, results):
                    if len(recs) >= hop_limit:
                        cut = cut_up if direction == "up" else cut_down
                        cut.update(dict.fromkeys(seed_urns_list))
                    for rec in recs:
                        _record(rec)
                        other = rec.get("otherUrn")
                        if not other or other in seed_set or other == urn:
                            continue
                        discovered.add(other)
                        if direction == "up":
                            upstream_urns.add(other)
                            depth_up[other] = None
                        else:
                            downstream_urns.add(other)
                            depth_down[other] = None
                # A SEED THAT FOUND NOTHING IS NOT A RESULT. The seeds are a
                # search for where the focus's flow actually lives, not a
                # picture in their own right — shipping the ones with no hop
                # in the asked direction would put a wall of bare leaves on
                # a board whose answer is "nothing flows that way".
                endpoints = {e.source_urn for e in edges_by_id.values()}
                endpoints |= {e.target_urn for e in edges_by_id.values()}
                discovered |= (seed_set & endpoints)

        # ---- hydrate + place -------------------------------------------
        # THE SAME STEP THE EAGER WALK USES, so this path cannot drift from
        # F18: detailed hydration (nodes_failed vs nodes_partial), the chains
        # under their own floor-budgeted wait_for, and the pair-fetch that
        # synthesizes from those chains for anything it could not afford.
        #
        # BUDGETED FOR AN INTERACTIVE PAGE. The pair-fetch decorates each
        # chain link with the graph's real edge id and type through an
        # unlabeled `s.urn IN … AND t.urn IN …` — a full scan per 400-pair
        # chunk, MEASURED at 7,764 ms of a 7,764 ms drill on the 2.08M-node
        # estate. This path answers a click and is budgeted at ~300 ms;
        # nothing in the trace overlay reads a containment edge's id or type
        # (it nests by source/target and never writes the store), so the
        # decoration must never outbid the page. Under the cap the pair-fetch
        # synthesizes instead — the chains ARE the truth, so a small budget
        # costs fidelity, never coverage, and the edges say `synthesized`.
        nodes_by_urn, containment_edges_list, truncation_reason = await self._hydrate_and_nest(
            discovered, ctypes, deadline, truncation_reason,
            containment_budget_s=CLOSURE_LAZY_CONTAINMENT_BUDGET_S,
        )

        def _frontier(
            candidates: Dict[str, None], cut: Dict[str, None],
        ) -> List[TraceFrontierNode]:
            out: List[TraceFrontierNode] = []
            for u in dict.fromkeys([*cut, *candidates]):
                if u == paged_anchor:
                    out.append(TraceFrontierNode(urn=u, nextCursor=paged_cursor))
                    continue
                out.append(TraceFrontierNode(urn=u, nextCursor="e:0" if u in cut else None))
            return out

        return TraceClosureResult(
            nodes=list(nodes_by_urn.values()),
            edges=list(edges_by_id.values()),
            containmentEdges=containment_edges_list,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            focus=TraceFocus(
                urn=urn,
                level=0,
                entityType=(anchor_label or "unknown"),
            ),
            effectiveLevel=0,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
            frontierUp=_frontier(depth_up, cut_up),
            frontierDown=_frontier(depth_down, cut_down),
            # A FULL children page is not a truncation — it is a page with a
            # cursor on it. `seedTruncated` stays the honest flag it always
            # was ("there are more contents"), and the driver reads
            # `seedCursor` and asks again.
            seedTruncated=next_child_after is not None,
            seedCursor=(f"s:{next_child_after}" if next_child_after else None),
        )

    async def expand_aggregated(
        self,
        source_urn: str,
        target_urn: str,
        next_level: Optional[int],
        lineage_edge_types: List[str],
        containment_edge_types: List[str],
        max_nodes: int,
        timeout_ms: int,
        use_raw_edges: bool = False,
        include_containment_edges: bool = False,
        drill_anchor: Optional[str] = None,
    ) -> TraceResult:
        await self._ensure_connected()
        deadline = time.monotonic() + (timeout_ms / 1000.0)
        ctypes = [t.upper() for t in (containment_edge_types or [])]
        ltypes = [t.upper() for t in (lineage_edge_types or [])] if lineage_edge_types else None
        # Per-source alignment (Task E): translate the uppercased declared types to THIS
        # graph's observed spellings so the case-sensitive :TYPE / type(r) IN patterns below
        # match a differently-cased graph. Identity for governed/canonical graphs.
        ctypes = self._alias_rel_types(ctypes)
        ltypes = self._alias_rel_types(ltypes) if ltypes else ltypes

        # STRUCTURAL dispatch: when the expanded edge carries containment
        # depth stamps, the drill is one containment step below the pair —
        # each anchor's direct children, label-agnostic (self-nesting
        # ontologies drill at every depth; the caller's type-level
        # ``use_raw`` heuristic is ignored because it misclassifies on
        # degenerate level maps — the agg-first + empty→raw fallback in
        # _edges_between_sets already covers the finest grain). Edges
        # without stamps (pre-depth generations) keep the legacy
        # type-level descent.
        structural = False
        if ctypes:
            structural = (
                await self._edge_depth_stamps(source_urn, target_urn)
            ) is not None
        # No level to descend to is itself a request for the structural
        # drill. A caller that cannot name a level is not confused — a
        # type appearing at two containment depths (``Container`` inside
        # ``Container``) has no single ``hierarchy.level``, so there is
        # no number it could honestly send.
        if next_level is None:
            structural = True

        # Which anchor is being OPENED. Only that side descends; the
        # other contributes itself and everything beneath it.
        #
        # Stepping both sides in lockstep is why opening a Data Domain
        # against a Table five levels below returned nothing: the level
        # path filtered the Table side to types at the domain's next
        # level (it has none), and the structural path walked the Table
        # down to its columns. Either way the two sets could never meet,
        # and the caller was told "nothing here connects" about lineage
        # that plainly exists. The partner is the question, not another
        # thing to descend.
        if drill_anchor is not None and drill_anchor not in (source_urn, target_urn):
            drill_anchor = None

        # Single-query pair fetch: source + target descendants in one
        # UNION'd Cypher round-trip. Saves one planner pass and frees a
        # pool slot for the duration. Surfaces the (now-single) failure
        # mode via truncationReason rather than aborting the expand.
        truncation_reason: Optional[str] = None
        try:
            if structural:
                s_urns, t_urns = await self._collect_children_pair(
                    source_urn, target_urn, ctypes, max_nodes,
                    drill_anchor=drill_anchor,
                )
            else:
                s_urns, t_urns = await self._collect_descendants_pair_at_level(
                    source_urn, target_urn, next_level, ctypes, max_nodes,
                    drill_anchor=drill_anchor,
                )
        except Exception:
            s_urns, t_urns = [], []
            truncation_reason = "descendants_failed"

        if time.monotonic() > deadline:
            truncation_reason = truncation_reason or "timeout"

        # Step 3: edges between the two URN sets — set membership, not Cartesian
        edges: List[GraphEdge] = []
        node_urns_in_edges: Set[str] = set()
        if s_urns and t_urns and not truncation_reason:
            edges = await self._edges_between_sets(
                s_urns, t_urns, next_level, ltypes,
                use_raw=use_raw_edges and not structural, limit=max_nodes,
            )
            for e in edges:
                node_urns_in_edges.add(e.source_urn)
                node_urns_in_edges.add(e.target_urn)

        # Hydrate nodes for every URN that appears in the result
        all_urns = (set(s_urns) | set(t_urns)) & node_urns_in_edges if edges else (set(s_urns) | set(t_urns))
        # Cap to max_nodes — favour nodes that participate in edges
        if len(all_urns) > max_nodes:
            in_edges = list(node_urns_in_edges)[:max_nodes]
            all_urns = set(in_edges)
            truncation_reason = truncation_reason or "max_nodes"

        nodes = await self.get_nodes_batch(list(all_urns)) if all_urns else []
        nodes_by_urn = {n.urn: n for n in nodes if n}

        # Always hydrate containment ancestors + edges so the drilled-into
        # nodes can be positioned in the canvas hierarchy. See trace_at_level
        # for the rationale — the `include_containment_edges` flag is
        # intentionally ignored because hierarchy context is non-optional.
        containment_edges_list: List[GraphEdge] = []
        if ctypes and nodes_by_urn:
            try:
                ancestor_urns = await self._collect_ancestor_urns(
                    list(nodes_by_urn.keys()), ctypes,
                )
            except Exception:
                ancestor_urns = []
                truncation_reason = truncation_reason or "ancestors_failed"
            new_ancestors = [u for u in ancestor_urns if u not in nodes_by_urn]
            if new_ancestors:
                ancestor_nodes = await self.get_nodes_batch(new_ancestors)
                for n in ancestor_nodes:
                    if n:
                        nodes_by_urn[n.urn] = n
            if len(nodes_by_urn) > 1:
                containment_edges_list = await self._fetch_containment_edges(
                    list(nodes_by_urn.keys()), ctypes,
                )

        # Focus node for response — use the source anchor of the drill
        anchor_node = nodes_by_urn.get(source_urn)
        if anchor_node is None:
            anchor_node = await self.get_node(source_urn)
        focus_level_actual = (
            self._get_node_level(anchor_node.entity_type) if anchor_node else next_level
        )
        # The response model wants a concrete level. A structural drill
        # has none to report — the caller could not name one, which is
        # the whole reason it asked structurally — so fall back to the
        # anchor's own resolved level and finally to 0 rather than
        # failing validation on a `None` nobody asked to be meaningful.
        reported_level = focus_level_actual if focus_level_actual is not None else next_level
        if reported_level is None:
            reported_level = 0

        return TraceResult(
            nodes=list(nodes_by_urn.values()),
            edges=edges,
            containmentEdges=containment_edges_list,
            upstreamUrns=set(),
            downstreamUrns=set(),
            focus=TraceFocus(
                urn=source_urn,
                level=reported_level,
                entityType=str(anchor_node.entity_type) if anchor_node else "unknown",
            ),
            effectiveLevel=next_level if next_level is not None else reported_level,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=(truncation_reason is not None),
            truncationReason=truncation_reason,
        )

    # ---- trace v2 helpers ---------------------------------------------------

    async def _resolve_anchor_at_level(
        self, urn: str, level: int, ctypes: List[str],
    ) -> str:
        """Walk UP containment from ``urn`` to find the nearest ancestor whose
        entity type sits at ``level``. Returns ``urn`` itself when it's already
        at the target level or no qualifying ancestor exists.

        Cache-first: reads the ancestor chain from the Redis cache populated
        by aggregation (:func:`_get_ancestor_chain`) and resolves each
        ancestor's level via the in-process entity-type → level map. The
        URN → label cache (:func:`_get_cached_label`) typically already
        holds labels for chain URNs as a side effect of materialization /
        prior :func:`get_node` calls; any gaps are filled with a single
        batch ``WHERE n.urn IN $urns RETURN n.urn, labels(n)[0]`` round-
        trip (no variable-length walk, no path sort).

        Falls back to the legacy variable-length Cypher only when the
        cache produces no chain AND the focus is not already at the
        requested level — preserves correctness on cold graphs while the
        common case becomes a Redis HGET + a small Python loop.
        """
        if not ctypes:
            return urn
        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}

        # Step 1: is the focus itself at the target level?
        focus_label = await self._get_cached_label(urn)
        if focus_label and entity_levels.get(focus_label) == level:
            return urn

        # Step 2: walk the cached ancestor chain.
        try:
            chain = await self._get_ancestor_chain(urn)
        except Exception:
            chain = []

        if chain and entity_levels:
            # Resolve labels for chain URNs (cache + one batch top-up).
            labels: Dict[str, Optional[str]] = {}
            missing: List[str] = []
            for u in chain:
                cached = await self._get_cached_label(u)
                labels[u] = cached
                if not cached:
                    missing.append(u)
            if missing:
                try:
                    # _resolve_urn_labels_bulk bootstraps cache misses via
                    # per-observed-label index seeks (never an unlabeled
                    # full scan) and writes the cache back itself.
                    resolved_labels = await self._resolve_urn_labels_bulk(missing)
                    for u, lbl in resolved_labels.items():
                        if lbl:
                            labels[u] = lbl
                except Exception as exc:
                    logger.warning(
                        "trace_at_level: anchor label batch fetch failed: %s", exc,
                    )

            for ancestor_urn in chain:
                lbl = labels.get(ancestor_urn)
                if lbl and entity_levels.get(lbl) == level:
                    return ancestor_urn
            # Chain authoritatively walked to root without a match.
            return urn

        # Step 3: cold-cache fallback. Bound the variable-length walk by
        # max-known hierarchy depth (or 10 when the level map is empty)
        # and cap the Cypher with a tight ``:timeout`` so a slow planner
        # cannot consume the trace deadline here.
        types = self._types_at_level(level)
        if not types:
            return urn
        max_depth = max(len(entity_levels), 10) if entity_levels else 10
        # NB: path-uniqueness predicate was attempted here but removed —
        # FalkorDB's planner doesn't always accept nested list-comprehension
        # `size(...)` inside path-bound ALL(), and the legacy form was
        # already cycle-safe via bounded max_depth + try/except. Cycle
        # protection for the new skeleton-first path lives in
        # _resolve_root_anchor (which itself falls back on failure).
        anchor_label = await self._get_cached_label(urn)
        f_anchor = (
            f"(focus:{_sanitize_label(anchor_label)} {{urn: $urn}})"
            if anchor_label else "(focus {urn: $urn})"
        )
        c_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        cypher = (
            f"MATCH {f_anchor} "
            f"OPTIONAL MATCH path = (focus)<-[c:{c_alt}*0..{max_depth}]-(anc) "
            "WHERE labels(anc)[0] IN $types "
            "RETURN coalesce(anc.urn, focus.urn) AS anchorUrn "
            "ORDER BY length(path) ASC LIMIT 1"
        )
        try:
            result = await self._ro_query(
                cypher, params={"urn": urn, "types": types},
                timeout=1.5, op="trace.anchor_at_level",
            )
            rows = result.result_set or []
            if rows and rows[0]:
                return rows[0][0] or urn
        except Exception as exc:
            logger.warning("trace_at_level: anchor resolution fallback failed for %s: %s", urn, exc)
        return urn

    async def _has_aggregated_at_level(
        self, anchor_urn: str, level: int, ltypes: Optional[List[str]] = None,
    ) -> bool:
        """True iff the anchor has AT LEAST ONE lineage edge to a peer at
        the given level. Counts both AGGREGATED rollups AND raw lineage edges
        of any type listed in ``ltypes`` — without this, fine-grained focuses
        whose lineage is expressed as TRANSFORMS / FLOWS_TO / etc. would be
        misclassified as "no lineage", triggering the inherited-lineage
        fallback to climb to a coarser ancestor.
        """
        types = self._types_at_level(level)
        if not types:
            # If we can't tell which entity types belong to this level, assume
            # the focus has direct lineage so the inherited-lineage fallback
            # doesn't fire — that fallback only makes sense with type info.
            return True

        # Relationship types as a pattern ALTERNATION (AGGREGATED plus any
        # raw lineage types) so the existence probe never expands other
        # edge classes on hub anchors; the anchor itself is label-qualified
        # via the urn→label cache (urn-index seek, not an All-Node-Scan).
        rel_parts: List[str] = ["AGGREGATED"]
        if ltypes:
            rel_parts.extend(_sanitize_label(t) for t in ltypes if t)
        rel_alt = "|".join(dict.fromkeys(rel_parts))
        a_label = await self._get_cached_label(anchor_urn)
        a_anchor = (
            f"(a:{_sanitize_label(a_label)} {{urn: $anchor}})"
            if a_label else "(a {urn: $anchor})"
        )

        cypher = (
            f"MATCH {a_anchor}-[r:{rel_alt}]-(peer) "
            "WHERE labels(peer)[0] IN $types "
            "RETURN 1 LIMIT 1"
        )
        params: Dict[str, Any] = {"anchor": anchor_urn, "types": types}
        try:
            # Tight ``:timeout`` — this is an existence check on the
            # trace hot path; if FalkorDB can't decide in ~1s the
            # planner is doing something wrong and we'd rather
            # fail-open (skip the inherited-lineage fallback) than
            # block the whole trace.
            result = await self._proj_ro_query(cypher, params=params, timeout=1.0, op="trace.has_lineage")
            return bool(result.result_set)
        except Exception as exc:
            logger.warning("trace_at_level: has-lineage check failed for %s: %s", anchor_urn, exc)
            return True  # fail-open: skip the inherited-lineage fallback

    async def _find_ancestor_with_lineage(
        self, anchor_urn: str, level: int, ctypes: List[str],
        ltypes: Optional[List[str]] = None,
    ) -> Optional[str]:
        """Find the nearest ancestor of ``anchor_urn`` that (a) is at the
        target ``level`` and (b) has at least one lineage edge there.

        Folds the previous "fetch 5 candidates + 1-5 ``_has_aggregated_at_level``
        round-trips" pattern into a single Cypher: the inner pattern
        predicate ``(parent)-[:AGGREGATED|...]-()`` filters candidates by
        edge existence directly in the planner, returning only the
        nearest ancestor that qualifies.

        The pattern predicate doesn't constrain the peer's level — a node
        that has AGGREGATED edges is overwhelmingly to peers at the same
        level (the materialiser pairs ancestors level-for-level), and a
        false positive just means the subsequent BFS finds an empty set
        for that anchor, which is cheaper than 5 extra existence
        checks per trace.
        """
        if not ctypes:
            return None
        types = self._types_at_level(level)
        if not types:
            return None

        # Relationship-type alternation: AGGREGATED rollup plus any raw
        # lineage types the caller declared. Sanitized to keep the
        # dynamic pattern injection-safe.
        rel_parts: List[str] = ["AGGREGATED"]
        if ltypes:
            rel_parts.extend(_sanitize_label(t) for t in ltypes)
        rel_alt = "|".join(rel_parts)

        max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)

        # NB: path-uniqueness predicate removed — legacy form, bounded by
        # max_depth + try/except. See note in _resolve_anchor_at_level.
        # Anchor label-qualified (urn-index seek) and containment walk
        # expressed as a typed alternation so non-containment edges are
        # never expanded.
        c_alt = "|".join(_sanitize_label(t) for t in ctypes if t)
        a_label = await self._get_cached_label(anchor_urn)
        a_anchor = (
            f"(a:{_sanitize_label(a_label)} {{urn: $anchor}})"
            if a_label else "(a {urn: $anchor})"
        )
        cypher = (
            f"MATCH {a_anchor}"
            f"<-[c:{c_alt}*1..{max_depth}]-(parent) "
            "WHERE labels(parent)[0] IN $types "
            "WITH parent, length(c) AS depth "
            "ORDER BY depth ASC LIMIT 5 "
            f"WITH parent, depth WHERE (parent)-[:{rel_alt}]-() "
            "RETURN parent.urn AS urn "
            "ORDER BY depth ASC LIMIT 1"
        )
        params = {"anchor": anchor_urn, "types": types}
        try:
            result = await self._ro_query(cypher, params=params, timeout=1.5, op="trace.ancestor_with_lineage")
            rows = result.result_set or []
            if rows and rows[0] and rows[0][0]:
                return rows[0][0]
        except Exception as exc:
            logger.warning(
                "trace_at_level: find-ancestor-with-lineage failed for %s: %s",
                anchor_urn, exc,
            )
        return None

    async def _expand_aggregated_set(
        self,
        frontier: List[str],
        frontier_labels: Dict[str, str],
        direction: str,
        level: int,
        ltypes: Optional[List[str]],
        limit: int,
        timeout_secs: float,
        default_peer_label: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Per-hop expansion. Direction: 'incoming' (BFS upstream) or 'outgoing'
        (BFS downstream). Returns a list of dicts shaped for the BFS loop:
        {sourceUrn, targetUrn, edgeId, edgeType, edgeTypes, weight, node}.

        ``frontier_labels`` maps each URN to its entity-type label so each
        per-label sub-query can use the per-label ``(:Label).urn`` index for
        an index-seek instead of a full-graph property scan. URNs without a
        known label fall back to a label-less pattern (still correct, just
        slower).

        ``default_peer_label`` is the focus's sanitized entity-type label,
        used as the neighbour filter when no level-set and no per-bucket
        label can constrain the expansion. Without this, the query would
        walk to ANY neighbour and a Layer-focused trace would over-fetch
        into Attribute children (the original layered-lineage bug). Pass the
        focus's entity_type so peer-rollup always has a fallback.

        Sub-queries per label bucket per direction:

        * AGGREGATED rollup — rel-typed pattern ``[r:AGGREGATED]`` filtered
          by ``r.sourceLevel`` / ``r.targetLevel`` (the level-pair fast
          path stamped by the materialiser + backfilled by
          ``backfill_aggregated_levels.py``). When the level map is
          missing or the AGGREGATED edge-property index hasn't been
          created, falls back to ``labels(other)[0] IN $types`` — the
          legacy neighbour-label scan.
        * Raw lineage — rel-type alternation ``[r:LTYPE1|LTYPE2|...]`` when
          ``ltypes`` is set, so fine-grained traces (schemaField /
          column) still walk TRANSFORMS / FLOWS_TO etc. Raw edges are
          not level-stamped, so this branch keeps the label filter.

        Each sub-query carries a Cypher ``:timeout`` capped at
        ``timeout_secs`` so a single bad sub-query cannot consume the
        whole BFS budget — FalkorDB cancels it server-side and the BFS
        loop logs and moves on with what it already has.
        """
        if not frontier or limit <= 0:
            return []

        types = self._types_at_level(level)
        # When the entity-type level map is available, prefer the
        # level-pair filter on AGGREGATED edges. The materialiser stamps
        # ``r.sourceLevel``/``r.targetLevel`` on new edges; legacy edges
        # are covered by ``backfill_aggregated_levels.py``.
        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
        use_level_filter = bool(entity_levels) and level >= 0

        # STRUCTURAL peer rollup: when the stored cells carry containment
        # depth stamps, each frontier node's peers are the cells at ITS
        # OWN depth — `r.sourceDepth = r.targetDepth = depth(f)`. The
        # type-level filter is degenerate on self-nesting ontologies
        # (every container shares one type level, so it mixes every
        # granularity into one wave); depth buckets are exact on any
        # shape. Frontier nodes without a resolvable depth (no stamped
        # incident cell — e.g. leaves in boundary regime) keep the legacy
        # type/label filters.
        depth_by_urn: Dict[str, int] = {}
        try:
            meta = await self._aggregation_run_meta()
            if meta.stamp_version >= 2:
                depth_by_urn = await self._frontier_depths_from_stamps(frontier)
        except Exception as exc:
            logger.debug("frontier depth resolution failed: %s", exc)

        # Group frontier URNs by (entity-type label, stamped depth) so
        # each sub-query uses the per-label ``urn`` index AND the exact
        # depth cell filter. URNs without a known label go into the ""
        # bucket and use a label-less fallback pattern.
        by_label: Dict[Tuple[str, Optional[int]], List[str]] = {}
        for urn in frontier:
            lbl = frontier_labels.get(urn) or ""
            by_label.setdefault((lbl, depth_by_urn.get(urn)), []).append(urn)

        # Direction shapes: ``f`` is the frontier-side variable, ``other`` is
        # the neighbour we're expanding into. Edge orientation in the returned
        # record is always (sourceUrn -> targetUrn).
        if direction == "incoming":
            arrow_template = "<-[r{rel}]-"
            source_var, target_var = "other", "f"
        else:
            arrow_template = "-[r{rel}]->"
            source_var, target_var = "f", "other"

        def _build(rel_clause: str, *, where_parts: List[str], order_by_weight: bool) -> str:
            # WS1.5: Replace ``UNWIND $frontier AS u MATCH (f {urn:u})``
            # with ``MATCH (f) WHERE f.urn IN $frontier`` so the empty-
            # label bucket (URNs whose entity_type wasn't in
            # ``frontier_labels``) doesn't degenerate into N unlabeled
            # node scans. When F_LABEL substitutes to a real label, the
            # ``:Label(urn)`` index still drives the seek via the IN
            # predicate; when F_LABEL is empty, this still pays exactly
            # one scan rather than N.
            extended = ["f.urn IN $frontier"] + where_parts
            where = "WHERE " + " AND ".join(extended) + " "
            # For AGGREGATED edges, ORDER BY r.weight DESC ensures the
            # per-source LIMIT keeps the highest-confidence edges first
            # (top-N by edge count). Without it, a super-hub Domain would
            # truncate arbitrarily. Raw lineage edges don't have weight,
            # so we skip the ORDER BY in that branch.
            order = "ORDER BY weight DESC " if order_by_weight else ""
            return (
                f"MATCH (f{{F_LABEL}}){arrow_template.format(rel=rel_clause)}(other) "
                + where
                + f"WITH {source_var}.urn AS sourceUrn, {target_var}.urn AS targetUrn, "
                "id(r) AS edgeId, type(r) AS edgeType, "
                "COALESCE(r.sourceEdgeTypes, [type(r)]) AS edgeTypes, "
                "COALESCE(r.weight, 1) AS weight, other AS otherNode "
                + order
                + "RETURN sourceUrn, targetUrn, edgeId, edgeType, edgeTypes, weight, otherNode "
                "LIMIT $limit"
            )

        # Per-query timeout. The wrapper subtracts 500ms for the DB-side
        # cancel; clamp the floor at 0.6s so a tight remaining-budget still
        # gives FalkorDB a useful slice (~100ms).
        per_query_timeout = max(0.6, min(1.5, timeout_secs))

        # Sanitize the focus's entity-type once — used as the fallback
        # neighbour filter when a frontier bucket has no per-URN label
        # (because get_node returned None, entity_type wasn't populated,
        # or labels(n)[0] didn't match the upsert convention).
        sanitized_default_peer = (
            _sanitize_label(default_peer_label) if default_peer_label else ""
        )

        queries: List[tuple[str, Dict[str, Any]]] = []
        for (f_label, f_depth), urns in by_label.items():
            sanitized_self_label = _sanitize_label(f_label) if f_label else ""
            label_clause = f":{sanitized_self_label}" if sanitized_self_label else ""

            # Peer-rollup neighbour filter. Order of preference:
            #   1. Per-bucket frontier label (sanitized_self_label)
            #   2. Caller-supplied default (focus entity_type)
            # If NEITHER is set (and no depth bucket constrains the
            # cells), refuse to emit an unconstrained query — the legacy
            # "no filter at all" path is the over-fetch bug that pulled
            # Attributes into a Layer trace.
            effective_peer_label = sanitized_self_label or sanitized_default_peer
            peer_filter_clause: Optional[str] = None
            if effective_peer_label:
                peer_filter_clause = f"labels(other)[0] = '{effective_peer_label}'"
            elif f_depth is None:
                logger.warning(
                    "trace expand: no peer label for bucket=%r and no default — "
                    "skipping sub-query to avoid unconstrained over-fetch",
                    f_label,
                )
                # Skip this bucket entirely. Better to return zero edges
                # than to return every neighbour in the graph.
                continue

            # AGGREGATED branch. The DEPTH-pair filter is the primary
            # when this bucket's frontier depth is stamped (exact on any
            # graph shape); else the type-level fast path; else label
            # scan or peer fallback.
            agg_where: List[str] = []
            if f_depth is not None:
                agg_where.append(
                    "r.sourceDepth = $fDepth AND r.targetDepth = $fDepth"
                )
            elif use_level_filter:
                agg_where.append("r.sourceLevel = $level AND r.targetLevel = $level")
            elif types:
                agg_where.append("labels(other)[0] IN $types")
            elif peer_filter_clause:
                agg_where.append(peer_filter_clause)
            if ltypes:
                agg_where.append(
                    "(r.sourceEdgeTypes IS NULL "
                    "OR any(et IN r.sourceEdgeTypes WHERE et IN $ltypes))"
                )
            agg_cypher = _build(
                ":AGGREGATED", where_parts=agg_where, order_by_weight=True,
            ).replace("{F_LABEL}", label_clause)
            agg_params: Dict[str, Any] = {"frontier": urns, "limit": limit}
            if f_depth is not None:
                agg_params["fDepth"] = f_depth
            elif use_level_filter:
                agg_params["level"] = level
            elif types:
                agg_params["types"] = types
            if ltypes:
                agg_params["ltypes"] = ltypes
            queries.append((agg_cypher, agg_params))

            # Raw-lineage branch (only when ltypes provided). Raw edges
            # don't carry level/depth props, so this branch uses the
            # type-set filter, or peer-label fallback when types is
            # empty; a depth-only bucket with neither constraint skips
            # raw rather than over-fetch.
            if ltypes and (types or peer_filter_clause):
                rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
                raw_where: List[str] = []
                if types:
                    raw_where.append("labels(other)[0] IN $types")
                elif peer_filter_clause:
                    raw_where.append(peer_filter_clause)
                raw_cypher = _build(
                    f":{rel_alt}", where_parts=raw_where, order_by_weight=False,
                ).replace("{F_LABEL}", label_clause)
                raw_params: Dict[str, Any] = {"frontier": urns, "limit": limit}
                if types:
                    raw_params["types"] = types
                queries.append((raw_cypher, raw_params))

        if not queries:
            return []

        async def _run(c: str, p: Dict[str, Any]):
            try:
                return await self._proj_ro_query(
                    c, params=p, timeout=per_query_timeout, op="trace.expand",
                )
            except Exception as exc:
                logger.warning(
                    "trace_at_level: expand sub-query (%s) failed: %s",
                    direction, exc,
                )
                return None

        results = await asyncio.gather(*(_run(c, p) for c, p in queries))

        out: List[Dict[str, Any]] = []
        seen_edge_ids: Set[str] = set()
        for result in results:
            if result is None:
                continue
            for row in (result.result_set or []):
                try:
                    edge_type = str(row[3]) if row[3] is not None else "AGGREGATED"
                    eid = str(row[2]) if row[2] is not None else (
                        f"{edge_type.lower()}-{row[0]}-{row[1]}"
                    )
                    # Dedupe across the AGGREGATED + raw-lineage sub-queries:
                    # a raw lineage edge might also appear in the AGGREGATED
                    # rollup (sourceEdgeTypes contains its type). Keep first.
                    if eid in seen_edge_ids:
                        continue
                    seen_edge_ids.add(eid)
                    rec = {
                        "sourceUrn": row[0],
                        "targetUrn": row[1],
                        "edgeId": eid,
                        "edgeType": edge_type,
                        "edgeTypes": row[4] if isinstance(row[4], list) else (
                            [row[4]] if row[4] else [edge_type]
                        ),
                        "weight": int(row[5]) if row[5] is not None else 1,
                        "node": self._extract_node_from_result([row[6]]) if row[6] is not None else None,
                    }
                    out.append(rec)
                    if len(out) >= limit:
                        return out
                except Exception:
                    continue
        return out

    async def _expand_raw_lineage_set(
        self,
        frontier: List[str],
        frontier_labels: Dict[str, str],
        direction: str,
        ltypes: List[str],
        limit: int,
        timeout_secs: float,
    ) -> List[Dict[str, Any]]:
        """One BFS hop over RAW lineage edges — the regime-independent core of
        ``trace_closure``.

        Unlike ``_expand_aggregated_set`` this walks the DECLARED lineage
        rel-types directly (``[r:LTYPE1|LTYPE2|...]``) with NO neighbour
        label/level filter: focus scoping comes from starting at the focus and
        following its ACTUAL lineage, not from constraining peers. Reads the
        MAIN graph (raw edges live there, not the projection graph), so it is
        correct at the finest grain even in boundary regime where leaf rollups
        are never materialised.

        ``direction``: ``'incoming'`` walks upstream (``(f)<-[r]-(o)``),
        ``'outgoing'`` walks downstream (``(f)-[r]->(o)``). Each returned record
        is oriented source->target and carries ``otherUrn``/``otherLabel`` — the
        far (newly-discovered) endpoint and its entity-type label — so the
        caller seeds the next frontier ALREADY label-bucketed without a
        separate label round-trip.

        The frontier is bucketed by label so each sub-query uses the per-label
        ``(:Label).urn`` index (there is no label-less URN index; an unlabeled
        bucket pays one scan, still correct).

        There is deliberately NO exclude filter. The caller's already-known
        set is applied in Python AFTER the row is recorded, so an edge into a
        known node still ships while the node itself does not — see the note
        at the call site in ``trace_closure`` for the diamond this protects.
        """
        if not frontier or limit <= 0 or not ltypes:
            return []

        by_label: Dict[str, List[str]] = {}
        for urn in frontier:
            by_label.setdefault(frontier_labels.get(urn) or "", []).append(urn)

        if direction == "incoming":
            arrow = "<-[r:{rel}]-"
            source_var, target_var = "o", "f"
        else:
            arrow = "-[r:{rel}]->"
            source_var, target_var = "f", "o"
        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        per_query_timeout = max(0.6, min(1.5, timeout_secs))

        queries: List[Tuple[str, Dict[str, Any]]] = []
        for f_label, urns in by_label.items():
            sl = _sanitize_label(f_label) if f_label else ""
            label_clause = f":{sl}" if sl else ""
            where_clause = "WHERE f.urn IN $frontier "
            params: Dict[str, Any] = {"frontier": urns, "limit": limit}
            cypher = (
                f"MATCH (f{label_clause}){arrow.format(rel=rel_alt)}(o) "
                + where_clause
                + f"RETURN {source_var}.urn AS sourceUrn, {target_var}.urn AS targetUrn, "
                "id(r) AS edgeId, type(r) AS edgeType, "
                # The rollup lane's own count of the flows an :AGGREGATED
                # edge summarises. NULL on a raw hop; every existing caller
                # ignores it. The lazy trace is what draws with it — a
                # rollup wire without its weight is a line with no number
                # on it, which is the whole point of a coarse statement.
                "r.weight AS weight, "
                "o.urn AS otherUrn, labels(o)[0] AS otherLabel "
                "LIMIT $limit"
            )
            queries.append((cypher, params))

        async def _run(c: str, p: Dict[str, Any]):
            try:
                return await self._ro_query(
                    c, params=p, timeout=per_query_timeout, op="trace.closure_expand",
                )
            except Exception as exc:
                logger.warning(
                    "trace_closure: raw lineage expand (%s) failed: %s",
                    direction, exc,
                )
                return None

        results = await asyncio.gather(*(_run(c, p) for c, p in queries))

        out: List[Dict[str, Any]] = []
        seen_edge_ids: Set[str] = set()
        for result in results:
            if result is None:
                continue
            for row in (result.result_set or []):
                try:
                    eid = str(row[2]) if row[2] is not None else f"raw-{row[0]}-{row[1]}"
                    if eid in seen_edge_ids:
                        continue
                    seen_edge_ids.add(eid)
                    out.append({
                        "sourceUrn": row[0],
                        "targetUrn": row[1],
                        "edgeId": eid,
                        "edgeType": str(row[3]) if row[3] else ltypes[0],
                        "weight": row[4],
                        "otherUrn": row[5],
                        "otherLabel": row[6],
                    })
                    if len(out) >= limit:
                        return out
                except Exception:
                    continue
        return out

    async def _collect_lineage_seed(
        self,
        focus_urn: str,
        focus_label: str,
        ltypes: List[str],
        ctypes: List[str],
        cap: int,
        timeout_secs: float,
        after_urn: Optional[str] = None,
    ) -> Tuple[List[Tuple[str, str]], bool, Optional[str]]:
        """The nodes to START the closure BFS from.

        Lineage lives at the leaves, never on containers. A LEAF focus is its
        own seed. A CONTAINER focus (a Domain/Layer/Table with no lineage of
        its own) contributes nothing directly — so this is the ONE place
        containment flows DOWNWARD: walk containment down to find which
        descendants of the top-most node carry incident lineage, and seed from
        those. The closure BFS then shows only their LINEAGE hops; containment
        is never a hop. Bounded by ``cap`` (a container with more lineage
        leaves than that spills to the lazy/coarse path — handled by the
        caller's ``max_nodes`` truncation + cursor).

        Returns ``(seed, seed_capped, next_after)`` where ``seed`` is a list
        of ``(urn, entity_type_label)`` pairs (already label-bucketed for
        index-seeking sub-queries — no extra label lookup), ``seed_capped``
        is True when the descendants query returned exactly its ``cap``
        LIMIT (more lineage-bearing descendants may exist than were
        returned — the caller reports ``seedTruncated``), and ``next_after``
        is the LAST descendant urn of a capped page — the keyset resume
        point the caller wraps as ``seedCursor``. Descendants are ordered by
        urn (deterministic paging); ``after_urn`` continues past a previous
        page (the focus-self seed is first-page only).

        The caller's ``exclude_urns`` deliberately plays NO part here: it
        governs what is re-SHIPPED, never where the walk STARTS. Dropping a
        held node from the seed only means never re-deriving the hops it
        has not been asked about yet — see the ``wanted`` comment in
        ``trace_closure``, which is the same rule on the explicit-seed path.
        """
        if not ltypes:
            return [(focus_urn, focus_label)], False, None

        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        per_query_timeout = max(0.6, min(1.5, timeout_secs))
        sl = _sanitize_label(focus_label) if focus_label else ""
        label_clause = f":{sl}" if sl else ""

        # FalkorDB REJECTS the tempting single-round-trip form
        #     WITH [f] + collect(DISTINCT d) AS cands
        # (mixing a node alias with an aggregation) — it fails with
        #     "_AR_EXP_UpdateEntityIdx: Unable to locate a value with alias f"
        # VERIFIED against a live engine (a fake that string-matches Cypher
        # cannot catch this). So: two separately-valid queries, GATHERED, and
        # unioned in Python — a cursor role, not a filter:
        #   (1) does the focus itself carry lineage?         → LEAF focus
        #   (2) which containment descendants carry lineage? → CONTAINER focus
        # A seed-page CONTINUATION (after_urn) re-collects only descendants
        # past the keyset boundary; the focus-self seed belongs to page one.
        queries: List[Tuple[str, Dict[str, Any]]] = [] if after_urn else [(
            f"MATCH (f{label_clause} {{urn: $urn}}) WHERE (f)-[:{rel_alt}]-() "
            "RETURN f.urn AS urn, labels(f)[0] AS label",
            {"urn": focus_urn},
        )]
        descendants_idx = len(queries)
        if ctypes:
            ct_alt = "|".join(_sanitize_label(t) for t in ctypes)
            hops = self._containment_hop_bound()
            # ORDER BY urn makes the page deterministic and the keyset
            # (`d.urn > $after`) a true resume point — SKIP-free, so a deep
            # page costs the same as the first.
            after_clause = "AND d.urn > $after " if after_urn else ""
            queries.append((
                f"MATCH (f{label_clause} {{urn: $urn}})-[c:{ct_alt}*1..{hops}]->(d) "
                f"WHERE (d)-[:{rel_alt}]-() {after_clause}"
                "RETURN DISTINCT d.urn AS urn, labels(d)[0] AS label "
                "ORDER BY urn LIMIT $cap",
                {"urn": focus_urn, "cap": cap, **({"after": after_urn} if after_urn else {})},
            ))
        elif after_urn:
            # No containment types ⇒ no descendant pages exist to resume.
            return [], False, None

        async def _run_seed(c: str, prm: Dict[str, Any]):
            try:
                return await self._ro_query(
                    c, params=prm, timeout=per_query_timeout, op="trace.closure_seed",
                )
            except Exception as exc:
                logger.warning(
                    "trace_closure: seed query failed for %s: %s", focus_urn, exc,
                )
                return None

        results = await asyncio.gather(*(_run_seed(c, prm) for c, prm in queries))
        if all(r is None for r in results):
            # Every probe errored — degrade to the focus itself rather than
            # reporting "no lineage", which would be a lie. (A continuation
            # degrades to an EMPTY page instead: re-seeding the focus would
            # re-derive page one's hops under a page-two cursor.)
            if after_urn:
                return [], False, None
            return [(focus_urn, focus_label)], False, None

        seed_capped = False
        next_after: Optional[str] = None
        d_result = results[descendants_idx] if len(results) > descendants_idx else None
        if ctypes and d_result is not None:
            d_rows = d_result.result_set or []
            seed_capped = len(d_rows) == cap
            if seed_capped and d_rows:
                last = d_rows[-1][0]
                next_after = str(last) if last else None

        seed: List[Tuple[str, str]] = []
        seen: Set[str] = set()
        for result in results:
            if result is None:
                continue
            for row in (result.result_set or []):
                u = row[0]
                if not u or u in seen:
                    continue
                seen.add(u)
                seed.append((u, (row[1] if len(row) > 1 else None) or ""))
        return seed, seed_capped, next_after

    async def _descendant_lineage_seed(
        self,
        urns: List[str],
        labels: Dict[str, str],
        ltypes: List[str],
        ctypes: List[str],
        cap: int,
        timeout_secs: float,
    ) -> Tuple[List[Tuple[str, str]], bool]:
        """Which lineage-bearing entities live BENEATH these seeds.

        ``_collect_lineage_seed``'s containment-descent, asked of a SET
        rather than of one anchor: a walk continuation names the cards the
        reader clicked, and a card that holds finer things carries no
        lineage of its own — its columns do. Seeds that ARE leaves simply
        contribute nothing here (a leaf has no containment children), so
        the caller can hand over its whole seed list without sorting them
        first.

        Bucketed by label for the per-label ``(:Label).urn`` index, the
        same way ``_expand_raw_lineage_set`` buckets its frontier (there is
        no label-less URN index; an unlabeled bucket pays one scan, still
        correct). Returns ``(pairs, capped)`` — ``capped`` when a bucket
        came back exactly at its LIMIT, which the caller reports as
        ``seedTruncated``. Failures degrade to "nothing beneath" rather
        than aborting the walk: the literal seeds still walk.
        """
        if not urns or not ltypes or not ctypes or cap <= 0:
            return [], False

        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        ct_alt = "|".join(_sanitize_label(t) for t in ctypes)
        hops = self._containment_hop_bound()
        per_query_timeout = max(0.6, min(1.5, timeout_secs))

        by_label: Dict[str, List[str]] = {}
        for u in urns:
            by_label.setdefault(labels.get(u) or "", []).append(u)

        async def _run(f_label: str, bucket: List[str]):
            sl = _sanitize_label(f_label) if f_label else ""
            label_clause = f":{sl}" if sl else ""
            cypher = (
                f"MATCH (f{label_clause})-[c:{ct_alt}*1..{hops}]->(d) "
                f"WHERE f.urn IN $seeds AND (d)-[:{rel_alt}]-() "
                "RETURN DISTINCT d.urn AS urn, labels(d)[0] AS label LIMIT $cap"
            )
            try:
                return await self._ro_query(
                    cypher, params={"seeds": bucket, "cap": cap},
                    timeout=per_query_timeout, op="trace.closure_seed",
                )
            except Exception as exc:
                logger.warning(
                    "trace_closure: descendant seed query failed: %s", exc,
                )
                return None

        results = await asyncio.gather(
            *(_run(lbl, bucket) for lbl, bucket in by_label.items())
        )

        pairs: List[Tuple[str, str]] = []
        seen: Set[str] = set()
        capped = False
        for result in results:
            if result is None:
                continue
            rows = result.result_set or []
            if len(rows) == cap:
                capped = True
            for row in rows:
                u = row[0]
                if not u or u in seen:
                    continue
                seen.add(u)
                pairs.append((u, (row[1] if len(row) > 1 else None) or ""))
        return pairs, capped

    async def _page_raw_lineage_single(
        self,
        urn: str,
        label: str,
        direction: str,
        ltypes: List[str],
        after_id: Optional[int],
        limit: int,
        timeout: float,
    ) -> Tuple[List[Dict[str, Any]], Optional[int]]:
        """Cursor page over ONE node's raw-lineage adjacency in ONE
        direction — the lazy/coarse fallback for a single frontier node
        whose full hop would blow the BFS budget, paired with
        ``_expand_raw_lineage_set``'s batched hop.

        Stable-ordered by ``id(r)``. ``after_id`` is INCLUSIVE — "the next
        edge id to consider", not "the last one you saw" — so ``0`` means
        from the start and the caller's next cursor is ``last_edge_id + 1``.
        The exclusive form could not express "from the start" at all: the
        wire grammar is ``^e:\\d+$``, so the only available start was
        ``e:0``, which silently skipped the edge with ``id(r) == 0``. Row
        dicts use the SAME keys as ``_expand_raw_lineage_set`` rows so
        callers can share processing code between the batched and
        single-node paths.

        ``label`` falsy falls back to an unlabeled anchor match — a
        single-node scan, so the missing per-label index is an accepted
        cost here (unlike the frontier-wide bucketing in the sibling
        helpers, where an unlabeled bucket would pay that cost per URN).
        """
        if not ltypes or limit <= 0:
            return [], None

        after = 0 if after_id is None else after_id
        sl = _sanitize_label(label) if label else ""
        label_clause = f":{sl}" if sl else ""
        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)

        if direction == "incoming":
            arrow = f"<-[r:{rel_alt}]-"
            source_expr, target_expr = "o.urn", "f.urn"
        else:
            arrow = f"-[r:{rel_alt}]->"
            source_expr, target_expr = "f.urn", "o.urn"

        cypher = (
            f"MATCH (f{label_clause} {{urn: $urn}}){arrow}(o) "
            "WHERE id(r) >= $after "
            f"RETURN id(r) AS edgeId, {source_expr} AS sourceUrn, {target_expr} AS targetUrn, "
            "type(r) AS edgeType, r.weight AS weight, "
            "o.urn AS otherUrn, labels(o)[0] AS otherLabel "
            "ORDER BY id(r) "
            "LIMIT $limit"
        )
        # Per-query bound, same as the sibling walk helpers — deliberately
        # NOT the caller's whole remaining budget. Keeping every individual
        # page query small is what lets the closure's overall deadline
        # degrade to a truncated (200) response instead of one runaway
        # query eating the whole request; a single label-qualified anchor
        # page at LIMIT <= 2000 fits comfortably inside this bound.
        per_query_timeout = max(0.6, min(1.5, timeout))
        try:
            result = await self._ro_query(
                cypher, params={"urn": urn, "after": after, "limit": limit},
                timeout=per_query_timeout, op="trace.closure_page",
            )
        except Exception as exc:
            logger.warning(
                "trace_closure: page query failed for %s (%s): %s", urn, direction, exc,
            )
            return [], None

        rows: List[Dict[str, Any]] = []
        last_edge_id: Optional[int] = None
        for row in (result.result_set or []):
            try:
                raw_eid = row[0]
                eid_int = int(raw_eid) if raw_eid is not None else None
                rows.append({
                    "sourceUrn": row[1],
                    "targetUrn": row[2],
                    "edgeId": str(raw_eid) if raw_eid is not None else f"raw-{row[1]}-{row[2]}",
                    "edgeType": str(row[3]) if row[3] else ltypes[0],
                    "weight": row[4],
                    "otherUrn": row[5],
                    "otherLabel": row[6],
                })
                if eid_int is not None:
                    last_edge_id = eid_int
            except Exception:
                continue
        return rows, last_edge_id

    async def _collect_ancestor_urns(
        self, urns: List[str], ctypes: List[str],
    ) -> List[str]:
        """Collect ALL containment ancestors of the given URNs.

        Foundational for trace responses: a trace returns lineage URNs at
        whatever level the user picked (e.g. column-level schemaFields), but
        the canvas needs the full ancestor chain (Dataset → Container →
        Domain) to position those URNs in the layered hierarchy. Without
        this, the trace nodes render as orphans or get filtered out by layer
        assignment.

        Reads from the Redis ancestor-chain cache populated by aggregation
        (:func:`_get_ancestor_chain` / :func:`_compute_and_store_ancestors_bulk`).
        On cache miss the bulk helper falls back to a per-URN typed Cypher
        with concurrency 4, then back-fills the cache for future trace
        requests. This replaces the previous single ``UNWIND $urns ...
        <-[c*1..10]-(ancestor)`` query that re-walked containment on every
        trace and was the second-biggest CPU consumer after the BFS itself.

        Raises on hard failure (Redis + Cypher both unavailable) so the
        caller can surface ``truncationReason="ancestors_failed"`` instead
        of silently dropping the containment chain (which produces canvas
        orphans).
        """
        if not urns or not ctypes:
            return []
        try:
            chains = await self._compute_and_store_ancestors_bulk(list(urns))
        except Exception as exc:
            logger.warning(
                "trace_at_level: ancestor collection failed for %d urns: %s",
                len(urns), exc,
            )
            raise

        # ``_compute_and_store_ancestors_bulk`` returns a {urn: chain} map.
        # Flatten + dedupe while preserving first-seen order so any caller
        # that depends on parent-before-grandparent ordering still gets it.
        seen: Set[str] = set()
        out: List[str] = []
        for chain in chains.values():
            for ancestor in chain or []:
                if ancestor and ancestor not in seen:
                    seen.add(ancestor)
                    out.append(ancestor)
        return out

    async def _edge_depth_stamps(
        self, source_urn: str, target_urn: str,
    ) -> Optional[Tuple[int, int]]:
        """The expanded :AGGREGATED edge's own containment-depth stamps
        (sourceDepth, targetDepth), or None when the edge is missing or
        pre-dates the depth-stamp generation — the structural-drill
        dispatch signal."""
        try:
            res = await self._proj_ro_query(
                "MATCH (s)-[r:AGGREGATED]->(t) "
                "WHERE s.urn = $s AND t.urn = $t "
                "AND r.sourceDepth IS NOT NULL AND r.targetDepth IS NOT NULL "
                "RETURN r.sourceDepth, r.targetDepth LIMIT 1",
                params={"s": source_urn, "t": target_urn},
            )
            rows = res.result_set or []
            if rows and rows[0] and rows[0][0] is not None and rows[0][1] is not None:
                return int(rows[0][0]), int(rows[0][1])
        except Exception as exc:
            logger.debug("edge depth-stamp read failed: %s", exc)
        return None

    async def _frontier_depths_from_stamps(
        self, urns: List[str],
    ) -> Dict[str, int]:
        """urn → containment depth, read from any stamped incident
        :AGGREGATED cell (two bounded relation-anchored queries — no
        containment walk). Nodes with no stamped incident cell are
        absent; callers fall back to type/label filters for those."""
        out: Dict[str, int] = {}

        async def _probe(cypher: str, bucket: List[str], key: str) -> list:
            try:
                res = await self._proj_ro_query(
                    cypher, params={"urns": bucket}, op="trace.frontier_depths",
                )
                return res.result_set or []
            except Exception as exc:
                logger.debug("frontier depth-stamp read (%s) failed: %s", key, exc)
                return []

        # Both directions × all label buckets GATHERED — these ran
        # strictly sequentially before (2 round-trips per bucket per hop,
        # each paying full RTT against a remote FalkorDB).
        tasks = []
        for f_label, bucket in await self._label_buckets(urns):
            f_anchor = f"(f:{f_label})" if f_label else "(f)"
            tasks.append(_probe(
                f"MATCH {f_anchor}-[r:AGGREGATED]->() "
                "WHERE f.urn IN $urns AND r.sourceDepth IS NOT NULL "
                "RETURN f.urn, max(r.sourceDepth)", bucket, "out"))
            tasks.append(_probe(
                f"MATCH ()-[r:AGGREGATED]->{f_anchor} "
                "WHERE f.urn IN $urns AND r.targetDepth IS NOT NULL "
                "RETURN f.urn, max(r.targetDepth)", bucket, "in"))
        for rows in await asyncio.gather(*tasks):
            for row in rows:
                if row and row[0] is not None and row[1] is not None:
                    u, d = str(row[0]), int(row[1])
                    if out.get(u, -1) < d:
                        out[u] = d
        return out

    async def _collect_children_pair(
        self,
        source_urn: str,
        target_urn: str,
        ctypes: List[str],
        limit: int,
        drill_anchor: Optional[str] = None,
    ) -> Tuple[List[str], List[str]]:
        """STRUCTURAL drill: DIRECT containment children — one step below
        the expanded pair. Label-agnostic, so self-nesting ontologies
        drill correctly at every depth; on aligned type-structured trees
        the children ARE the next type level, so behavior is unchanged.

        ``drill_anchor`` names the side being OPENED. Only it descends;
        the other contributes itself plus its whole subtree, so anchors
        at very different depths can still meet. Without it both sides
        advance from their own depth (ragged pairs included), which is
        the historical behaviour and correct only for a pair that was
        already aligned.

        Either way a childless side falls back to the anchor itself."""
        if drill_anchor is not None:
            partner = target_urn if drill_anchor == source_urn else source_urn
            depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
            cypher = (
                # The opened side — one containment step down.
                "MATCH (a {urn: $drill})-[c]->(child) "
                "WHERE type(c) IN $ctypes "
                "WITH DISTINCT child.urn AS urn "
                "LIMIT $limit "
                "RETURN 'd' AS side, collect(urn) AS urns "
                "UNION "
                # The partner — itself...
                "MATCH (b {urn: $partner}) "
                "RETURN 'p' AS side, [b.urn] AS urns "
                "UNION "
                # ...and everything beneath it, at any depth.
                f"MATCH (b {{urn: $partner}})-[c*1..{depth}]->(sub) "
                "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
                "WITH DISTINCT sub.urn AS urn "
                "LIMIT $limit "
                "RETURN 'p' AS side, collect(urn) AS urns"
            )
            result = await self._ro_query(
                cypher,
                params={"drill": drill_anchor, "partner": partner,
                        "ctypes": ctypes, "limit": limit},
                op="trace.children_drill",
                timeout=2.0,
            )
            drilled: List[str] = []
            partner_side: List[str] = []
            for row in (result.result_set or []):
                if not row or len(row) < 2:
                    continue
                urns = [u for u in (row[1] if isinstance(row[1], list) else []) if u]
                if row[0] == 'd':
                    drilled.extend(urns)
                elif row[0] == 'p':
                    partner_side.extend(urns)
            drilled = list(dict.fromkeys(drilled)) or [drill_anchor]
            partner_side = list(dict.fromkeys(partner_side)) or [partner]
            return (drilled, partner_side) if drill_anchor == source_urn else (partner_side, drilled)

        cypher = (
            "MATCH (a {urn: $source})-[c]->(child) "
            "WHERE type(c) IN $ctypes "
            "WITH DISTINCT child.urn AS urn "
            "LIMIT $limit "
            "RETURN 's' AS side, collect(urn) AS urns "
            "UNION "
            "MATCH (b {urn: $target})-[c]->(child) "
            "WHERE type(c) IN $ctypes "
            "WITH DISTINCT child.urn AS urn "
            "LIMIT $limit "
            "RETURN 't' AS side, collect(urn) AS urns"
        )
        result = await self._ro_query(
            cypher,
            params={"source": source_urn, "target": target_urn,
                    "ctypes": ctypes, "limit": limit},
            op="trace.children_pair",
            timeout=2.0,
        )
        s_urns: List[str] = []
        t_urns: List[str] = []
        for row in (result.result_set or []):
            if not row or len(row) < 2:
                continue
            urns = [u for u in (row[1] if isinstance(row[1], list) else []) if u]
            if row[0] == 's':
                s_urns.extend(urns)
            elif row[0] == 't':
                t_urns.extend(urns)
        return (
            list(dict.fromkeys(s_urns)) or [source_urn],
            list(dict.fromkeys(t_urns)) or [target_urn],
        )

    async def _collect_descendants_pair_at_level(
        self,
        source_urn: str,
        target_urn: str,
        target_level: int,
        ctypes: List[str],
        limit: int,
        drill_anchor: Optional[str] = None,
    ) -> Tuple[List[str], List[str]]:
        """Collect descendants of both anchors in a SINGLE Cypher round-trip.

        LEGACY (type-level) path — used only when the expanded edge has
        no depth stamps (``expand_aggregated`` dispatches stamped edges
        to ``_collect_children_pair`` instead). Bounded depth-10
        containment descent; per-anchor row LIMIT applied before
        ``collect()`` so the slice form (which previously tripped
        FalkorDB's "expected List or Null but was Edge" planner error) is
        never used.

        Returns ``(source_urns, target_urns)``. Either side may be empty if
        the anchor's label does not match ``target_level``'s type set.
        """
        # ``drill_anchor`` names the side being OPENED. Only it is
        # level-filtered; the partner contributes itself and its whole
        # subtree. Level-filtering BOTH is what empties the partner side
        # whenever it sits finer than the level asked for — a Table has
        # no descendants at a Domain's next level, so ``t_urns`` came
        # back empty and the expand reported "nothing connects" about
        # lineage that exists.
        if drill_anchor is not None:
            return await self._collect_level_and_subtree(
                drill_anchor,
                target_urn if drill_anchor == source_urn else source_urn,
                target_level, ctypes, limit,
                drilled_is_source=drill_anchor == source_urn,
            )
        types = self._types_at_level(target_level)
        if not types:
            # Nothing declared at that level. Returning empty here made
            # the expand report "nothing connects" about a level the
            # ONTOLOGY could not describe — a statement about our type
            # map, dressed up as a statement about the data. Each anchor
            # stands for itself instead, so the edge query still runs.
            return [source_urn], [target_urn]

        if not ctypes:
            # Empty containment — descendants of each anchor reduce to
            # the anchor itself, but only if its label matches.
            cypher = (
                "MATCH (a {urn: $source}) WHERE labels(a)[0] IN $types "
                "RETURN 's' AS side, [a.urn] AS urns "
                "UNION "
                "MATCH (b {urn: $target}) WHERE labels(b)[0] IN $types "
                "RETURN 't' AS side, [b.urn] AS urns"
            )
            params: Dict[str, Any] = {
                "source": source_urn, "target": target_urn, "types": types,
            }
        else:
            # UNION over per-anchor branches — same `WITH DISTINCT … LIMIT`
            # streaming pattern as the single-anchor helper used to (A1) so
            # the per-side `$limit` applies before ``collect()`` and the
            # path-alias never enters a slice context. One round-trip
            # instead of the prior two.
            #
            # Variable-length bound = max ontology depth (floor 10) so
            # very deep ontologies aren't truncated and shallow ones
            # don't pay for unused depth.
            #
            # NB: anchor-itself + descendants are split into two UNION
            # branches per side because FalkorDB's planner intermittently
            # rejects `[c*0..N]` with "expected List or Null but was Edge"
            # — using `[c*1..N]` (minimum one hop) avoids the zero-length
            # edge case. The anchor itself is matched directly without
            # any traversal. This is the same fix shape used elsewhere
            # in this module (e.g. _find_ancestor_with_lineage at L5142).
            max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
            cypher = (
                # Source — anchor itself
                "MATCH (a {urn: $source}) "
                "WHERE labels(a)[0] IN $types "
                "RETURN 's' AS side, [a.urn] AS urns "
                "UNION "
                # Source — descendants via 1..N containment hops
                f"MATCH (a {{urn: $source}})-[c*1..{max_depth}]->(child) "
                "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
                "  AND labels(child)[0] IN $types "
                "WITH DISTINCT child.urn AS urn "
                "LIMIT $limit "
                "RETURN 's' AS side, collect(urn) AS urns "
                "UNION "
                # Target — anchor itself
                "MATCH (b {urn: $target}) "
                "WHERE labels(b)[0] IN $types "
                "RETURN 't' AS side, [b.urn] AS urns "
                "UNION "
                # Target — descendants via 1..N containment hops
                f"MATCH (b {{urn: $target}})-[c*1..{max_depth}]->(child) "
                "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
                "  AND labels(child)[0] IN $types "
                "WITH DISTINCT child.urn AS urn "
                "LIMIT $limit "
                "RETURN 't' AS side, collect(urn) AS urns"
            )
            params = {
                "source": source_urn, "target": target_urn,
                "ctypes": ctypes, "types": types, "limit": limit,
            }
        try:
            result = await self._ro_query(cypher, params=params, timeout=2.0)
        except Exception as exc:
            logger.warning(
                "trace_at_level: descendant pair collection failed for (%s, %s): %s",
                source_urn, target_urn, exc,
            )
            raise

        # Accumulate per side — the UNION returns 2 rows per side (anchor +
        # descendants) so overwriting would lose half the URNs.
        s_set: Set[str] = set()
        t_set: Set[str] = set()
        for row in (result.result_set or []):
            if not row or len(row) < 2:
                continue
            side = row[0]
            urns = row[1] if isinstance(row[1], list) else []
            urn_list = [u for u in urns if u]
            if side == 's':
                s_set.update(urn_list)
            elif side == 't':
                t_set.update(urn_list)
        # An anchor that matched nothing falls back to ITSELF, mirroring
        # ``_collect_children_pair``. Without this a side could come back
        # empty and short-circuit the whole expand to zero edges — the
        # asymmetry between these two helpers was itself a bug.
        return (list(s_set) or [source_urn], list(t_set) or [target_urn])

    async def _collect_level_and_subtree(
        self,
        drilled_urn: str,
        partner_urn: str,
        target_level: int,
        ctypes: List[str],
        limit: int,
        *,
        drilled_is_source: bool,
    ) -> Tuple[List[str], List[str]]:
        """One side descends to ``target_level``; the other contributes
        itself plus its whole subtree, unfiltered. See the dispatch in
        ``_collect_descendants_pair_at_level`` for why."""
        types = self._types_at_level(target_level)
        max_depth = max(len(getattr(self, "_entity_type_levels", {}) or {}), 10)
        parts = [
            # The opened side — anchor itself when it already sits at the level
            "MATCH (a {urn: $drill}) WHERE labels(a)[0] IN $types "
            "RETURN 'd' AS side, [a.urn] AS urns",
            # ...and its descendants at that level
            f"MATCH (a {{urn: $drill}})-[c*1..{max_depth}]->(child) "
            "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
            "  AND labels(child)[0] IN $types "
            "WITH DISTINCT child.urn AS urn LIMIT $limit "
            "RETURN 'd' AS side, collect(urn) AS urns",
            # The partner — itself
            "MATCH (b {urn: $partner}) RETURN 'p' AS side, [b.urn] AS urns",
            # ...and everything beneath it, at any depth, any label
            f"MATCH (b {{urn: $partner}})-[c*1..{max_depth}]->(sub) "
            "WHERE ALL(rel IN c WHERE type(rel) IN $ctypes) "
            "WITH DISTINCT sub.urn AS urn LIMIT $limit "
            "RETURN 'p' AS side, collect(urn) AS urns",
        ]
        if not types:
            # Nothing declared at that level — the opened side still
            # contributes itself, so the expand degrades to "does this
            # container connect at all" rather than to silence.
            parts = [
                "MATCH (a {urn: $drill}) RETURN 'd' AS side, [a.urn] AS urns",
                *parts[2:],
            ]
        if not ctypes:
            parts = [p for p in parts if "*1.." not in p]
        result = await self._ro_query(
            " UNION ".join(parts),
            params={"drill": drilled_urn, "partner": partner_urn,
                    "ctypes": ctypes, "types": types, "limit": limit},
            op="trace.level_and_subtree",
            timeout=2.0,
        )
        d_set: Set[str] = set()
        p_set: Set[str] = set()
        for row in (result.result_set or []):
            if not row or len(row) < 2:
                continue
            urns = [u for u in (row[1] if isinstance(row[1], list) else []) if u]
            (d_set if row[0] == 'd' else p_set).update(urns)
        drilled = list(d_set) or [drilled_urn]
        partner = list(p_set) or [partner_urn]
        return (drilled, partner) if drilled_is_source else (partner, drilled)

    async def _edges_between_sets(
        self, s_urns: List[str], t_urns: List[str], level: int,
        ltypes: Optional[List[str]], use_raw: bool, limit: int,
    ) -> List[GraphEdge]:
        """Fetch edges between two URN sets — set membership, not Cartesian.

        ``use_raw=True`` reads raw lineage edges (for finest level where
        AGGREGATED == raw). Otherwise reads AGGREGATED.
        """
        if not s_urns or not t_urns:
            return []

        edges = await self._edges_between_sets_once(
            s_urns, t_urns, ltypes, use_raw=use_raw, limit=limit,
        )
        if not edges and not use_raw and ltypes:
            # The AGGREGATED read found nothing between these sets. Under
            # the same-level materialization boundary, leaf-adjacent
            # levels have NO stored cells — and the ``use_raw`` decision
            # upstream compares against the ontology-wide finest level,
            # which misclassifies when the resolved ontology mixes
            # entity families of different depths. Raw lineage is the
            # ground truth at fine grain; falling back costs one indexed
            # query and only ever fires on an empty result.
            edges = await self._edges_between_sets_once(
                s_urns, t_urns, ltypes, use_raw=True, limit=limit,
            )
        return edges

    async def _edges_between_sets_once(
        self, s_urns: List[str], t_urns: List[str],
        ltypes: Optional[List[str]], use_raw: bool, limit: int,
    ) -> List[GraphEdge]:
        # Rewritten away from ``UNWIND $sUrns AS srcUrn MATCH (s {urn:
        # srcUrn})`` because the inner unlabeled MATCH does a node scan
        # PER UNWIND iteration when the unlabeled URN index is absent —
        # exactly the antipattern that took down aggregation. The
        # ``WHERE s.urn IN $sUrns AND t.urn IN $tUrns`` form is ONE
        # scan/seek total, regardless of |sUrns|. See plan Phase 1.5.
        if use_raw:
            # Raw lineage edges by type — caller passes ltypes (lineage types)
            ltypes_eff = ltypes or []
            if not ltypes_eff:
                return []
            cypher = (
                "MATCH (s)-[r]->(t) "
                "WHERE s.urn IN $sUrns AND t.urn IN $tUrns "
                "  AND type(r) IN $ltypes "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, type(r) AS edgeType, "
                "id(r) AS edgeId, properties(r) AS props "
                "LIMIT $limit"
            )
            params = {"sUrns": s_urns, "tUrns": t_urns, "ltypes": ltypes_eff, "limit": limit}
            graph_query = self._ro_query
        else:
            cypher = (
                "MATCH (s)-[r:AGGREGATED]->(t) "
                "WHERE s.urn IN $sUrns AND t.urn IN $tUrns "
                + ("AND any(et IN r.sourceEdgeTypes WHERE et IN $ltypes) " if ltypes else "")
                + "RETURN s.urn AS sUrn, t.urn AS tUrn, 'AGGREGATED' AS edgeType, "
                "id(r) AS edgeId, "
                "{sourceEdgeTypes: r.sourceEdgeTypes, weight: r.weight} AS props "
                "LIMIT $limit"
            )
            params = {"sUrns": s_urns, "tUrns": t_urns, "limit": limit}
            if ltypes:
                params["ltypes"] = ltypes
            graph_query = self._proj_ro_query

        try:
            result = await graph_query(cypher, params=params)
        except Exception as exc:
            logger.warning("expand_aggregated: edge fetch failed: %s", exc)
            return []

        out: List[GraphEdge] = []
        seen_ids: Set[str] = set()
        for row in (result.result_set or []):
            try:
                edge_id = str(row[3]) if row[3] is not None else f"{row[2]}-{row[0]}-{row[1]}"
                if edge_id in seen_ids:
                    continue
                seen_ids.add(edge_id)
                props = row[4] if isinstance(row[4], dict) else {}
                out.append(GraphEdge(
                    id=edge_id,
                    sourceUrn=row[0],
                    targetUrn=row[1],
                    edgeType=str(row[2]),
                    properties=props or {},
                ))
            except Exception:
                continue
        return out

    async def _fetch_containment_edges(
        self, urns: List[str], ctypes: List[str],
        chains: Optional[Dict[str, List[str]]] = None,
        budget_secs: Optional[float] = None,
    ) -> List[GraphEdge]:
        """Containment edges where both endpoints are in ``urns``.

        Pair-list driven: builds the parent→child pairs we expect to exist
        from the cached ancestor chains (already populated by aggregation
        + the earlier :func:`_collect_ancestor_urns` call in
        :func:`trace_at_level`). Then issues ONE rel-typed Cypher to
        resolve the real edge type + id per pair.

        Replaces the previous ``UNWIND $urns ... MATCH (s)-[r]->(t)
        WHERE t.urn IN $urns AND type(r) IN $ctypes`` which scanned every
        outgoing edge from every URN before filtering — quadratic on
        wide trace results and a major contributor to the 8s timeout on
        100k-node graphs.

        Cold-cache fallback uses the same rel-typed alternation pattern
        so it's still faster than the legacy form.
        """
        if not urns or not ctypes:
            return []

        fetch_started = time.monotonic()
        rel_alt = "|".join(_sanitize_label(c) for c in ctypes)
        urn_set = set(urns)

        # Build (parent, child) pair candidates from cached chains —
        # reusing the caller's just-computed map when provided.
        if chains is None:
            try:
                chains = await self._compute_and_store_ancestors_bulk(list(urns))
            except Exception:
                chains = {}

        pairs: Set[tuple] = set()
        for child_urn, chain in (chains or {}).items():
            prev = child_urn
            for ancestor in chain or []:
                if ancestor in urn_set and prev in urn_set:
                    pairs.add((ancestor, prev))
                prev = ancestor

        # Rewritten away from the ``UNWIND … MATCH (s {urn: …})`` form
        # for the same reason as ``_edges_between_sets``: the inner
        # unlabeled MATCH scans per-iteration without an unlabeled URN
        # index. ``WHERE s.urn IN $sUrns AND t.urn IN $tUrns`` runs one
        # scan/seek for the whole batch. The pair-bounded branch
        # post-filters Cartesian results down to the requested pairs.
        if pairs:
            # CHUNKED + NEVER-EMPTY (2026-08-20): one set×set query over a
            # full-walk's ~2,000 pairs on a 1.2M-node graph blew the 2s
            # timeout and the exception path silently returned [] — the
            # trace shipped participants WITHOUT the containment that
            # placement/nesting need ("completely disjointed" on the big
            # estates, while the Lens's small per-click pair sets fit the
            # budget). Pairs now resolve in bounded chunks, and any chunk
            # that still fails SYNTHESIZES its edges straight from the
            # ancestor chains — the chains are the truth; the query only
            # decorates real ids/types onto them.
            all_pairs = sorted(pairs)
            out: List[GraphEdge] = []
            CHUNK_PAIRS = 400
            CHUNK_TIMEOUT_S = 2.0
            #: Stop querying after this many chunks fail back-to-back. Once the
            #: graph is refusing pair queries at this size the next chunk is
            #: overwhelmingly likely to refuse too, and each attempt costs a
            #: FULL timeout — 5 doomed chunks measured at 7.5s of a 11.1s
            #: closure on the 2.08M-node estate. Synthesis needs no query, so
            #: giving up on the QUERY never costs an edge.
            MAX_CONSECUTIVE_FAILURES = 2
            consecutive_failures = 0
            budget_spent = False

            def _synthesize(pair_list) -> None:
                """Edges straight from the ancestor chains.

                Marked ``synthesized`` because these are NOT the graph's own
                edges: the id is derived, and ``edgeType`` is a guess
                (``ctypes[0]``) that is only right when the source has a single
                containment type. Consumers that merge trace output into a
                mutable canvas must not treat one as a real, addressable edge.
                """
                for s_urn, t_urn in pair_list:
                    out.append(GraphEdge(
                        id=f"containment:{s_urn}>{t_urn}",
                        sourceUrn=s_urn, targetUrn=t_urn,
                        edgeType=ctypes[0],
                        properties={"synthesized": True},
                    ))

            # LABEL-ANCHORED (F12, 2026-08-21): the pair query used to match
            # `(s)-[r:REL]->(t)` with BOTH ends unlabeled, so FalkorDB had no
            # index to seek — this build has no label-less URN index, and an
            # unlabeled `WHERE urn IN $list` anchor is a full node/relation
            # scan with per-row IN-list membership (see `_label_buckets`, which
            # documents the same 4-9s-per-query finding from the aggregation
            # read path). On the 2.08M-node estate that scan WAS the cost:
            # 7.7s of a 7.8s drill, and it is what made the chunks time out
            # and fall through to synthesis. Every ontology label carries a URN
            # index, so the pairs are grouped by the (source label, target
            # label) they actually connect and each group is asked with its
            # anchors labelled — an index seek on both ends. Real containment
            # only ever links a handful of label pairs (Roots->Node, Node->Node;
            # layer->object, object->group, group->attribute, group->group), so
            # this is a few queries, never label-squared.
            #
            # A urn whose label will not resolve keeps the unlabeled pattern —
            # correctness first — but only for that bounded residue.
            #
            # Checked BEFORE resolving anything: a caller that has already
            # spent its budget is not going to issue a single pair query, and
            # label resolution is itself a round trip (a Redis pipeline read at
            # best, a bulk Cypher on a cold namespace). Synthesize and go.
            if budget_secs is not None and (
                (budget_secs - (time.monotonic() - fetch_started)) <= CHUNK_TIMEOUT_S
            ):
                logger.info(
                    "trace: containment pair-fetch has no budget for %d pairs "
                    "— synthesizing all of them", len(all_pairs),
                )
                _synthesize(all_pairs)
                return out

            try:
                pair_labels = await self._resolve_urn_labels_bulk(
                    sorted({u for pr in all_pairs for u in pr}),
                )
            except Exception as exc:
                logger.debug(
                    "containment pair-fetch: label resolution failed (%s) — "
                    "unlabeled anchors for this batch", exc,
                )
                pair_labels = {}

            grouped: Dict[Tuple[str, str], List[Tuple[str, str]]] = {}
            for s_urn, t_urn in all_pairs:
                key = (
                    _sanitize_label(pair_labels.get(s_urn) or "") or "",
                    _sanitize_label(pair_labels.get(t_urn) or "") or "",
                )
                grouped.setdefault(key, []).append((s_urn, t_urn))

            # One unit of work = one (label pair, <=CHUNK_PAIRS) slice. The
            # chunking, the residual budget and the give-up-after-N-failures
            # rules below are unchanged — they just count these units now.
            units: List[Tuple[Tuple[str, str], List[Tuple[str, str]]]] = []
            for key in sorted(grouped):
                group = grouped[key]
                for i in range(0, len(group), CHUNK_PAIRS):
                    units.append((key, group[i:i + CHUNK_PAIRS]))

            done_pairs = 0
            for (s_label, t_label), chunk in units:

                # RESIDUAL BUDGET (2026-08-21 ruling): the caller's remaining
                # deadline bounds how long this step may spend QUERYING. When
                # it runs out — or the graph has refused twice running — every
                # remaining pair is synthesized instead. The chain is the
                # truth; the query only decorates real ids/types onto it, so a
                # hard cap costs fidelity, never coverage. This is what
                # replaces the old `deadline < 2.0 -> ancestors_failed` bail,
                # which spent the same budget and shipped NOTHING.
                if budget_secs is not None and not budget_spent:
                    if (budget_secs - (time.monotonic() - fetch_started)) <= CHUNK_TIMEOUT_S:
                        budget_spent = True
                        logger.info(
                            "trace: containment pair-fetch out of budget after "
                            "%d/%d pairs — synthesizing the remainder",
                            done_pairs, len(all_pairs),
                        )
                if budget_spent or consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    _synthesize(chunk)
                    done_pairs += len(chunk)
                    continue

                chunk_set: Set[Tuple[str, str]] = set(chunk)
                s_urns = sorted({s for s, _ in chunk})
                t_urns = sorted({t for _, t in chunk})
                s_anchor = f"(s:{s_label})" if s_label else "(s)"
                t_anchor = f"(t:{t_label})" if t_label else "(t)"
                cypher = (
                    f"MATCH {s_anchor}-[r:{rel_alt}]->{t_anchor} "
                    "WHERE s.urn IN $sUrns AND t.urn IN $tUrns "
                    "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                    "type(r) AS edgeType, id(r) AS edgeId"
                )
                resolved: Set[Tuple[str, str]] = set()
                chunk_failed = False
                try:
                    result = await self._ro_query(
                        cypher,
                        params={"sUrns": s_urns, "tUrns": t_urns},
                        timeout=CHUNK_TIMEOUT_S,
                    )
                    for row in (result.result_set or []):
                        if (row[0], row[1]) not in chunk_set:
                            continue
                        resolved.add((row[0], row[1]))
                        out.append(GraphEdge(
                            id=str(row[3]), sourceUrn=row[0], targetUrn=row[1],
                            edgeType=str(row[2]), properties={},
                        ))
                    consecutive_failures = 0
                except Exception as exc:
                    chunk_failed = True
                    consecutive_failures += 1
                    logger.warning(
                        "trace: containment pair-fetch chunk failed "
                        "(%d pairs, %s->%s) — synthesizing from chains: %s",
                        len(chunk), s_label or "<unlabeled>",
                        t_label or "<unlabeled>", exc,
                    )
                done_pairs += len(chunk)

                # A chunk that SUCCEEDED is authoritative: a pair it did not
                # return is a pair the graph does not have (a stale cached
                # chain, or a link whose type is outside `ctypes`), and
                # inventing it here would put an edge on the canvas that the
                # graph denies. Only a FAILED chunk falls back to the chains.
                if chunk_failed:
                    _synthesize([pr for pr in chunk if pr not in resolved])
            return out
        else:
            # Cold-cache fallback. Still rel-typed (avoids the OR-on-type
            # full edge scan of the legacy query).
            cypher = (
                f"MATCH (s)-[r:{rel_alt}]->(t) "
                "WHERE s.urn IN $urns AND t.urn IN $urns "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                "type(r) AS edgeType, id(r) AS edgeId"
            )
            try:
                result = await self._ro_query(
                    cypher, params={"urns": list(urns)}, timeout=2.0,
                )
            except Exception as exc:
                logger.warning(
                    "trace_at_level: containment edge fallback fetch failed: %s",
                    exc,
                )
                return []

        # Cold-cache fallback only — the pair-bounded branch returns above and
        # post-filters per chunk. (The `allowed_pairs` guard that used to sit
        # here was inert: this path only ever ran with it set to None.)
        out: List[GraphEdge] = []
        for row in (result.result_set or []):
            try:
                out.append(GraphEdge(
                    id=str(row[3]),
                    sourceUrn=row[0],
                    targetUrn=row[1],
                    edgeType=str(row[2]),
                    properties={},
                ))
            except Exception:
                continue
        return out

    async def get_nodes_batch(self, urns: List[str]) -> List[GraphNode]:
        """Bulk node fetch by URN — see :func:`_get_nodes_batch_detailed`.

        Keeps the lossy list-only shape every existing caller expects. Callers
        that must tell "the graph has no such nodes" from "a bucket query
        failed" call the detailed form instead.
        """
        nodes, _failed = await self._get_nodes_batch_detailed(urns)
        return nodes

    async def _get_nodes_batch_detailed(
        self, urns: List[str],
    ) -> Tuple[List[GraphNode], int]:
        """Bulk node fetch by URN, plus how many label buckets FAILED.

        The failure count is the half `get_nodes_batch` throws away. A bucket
        that raises is caught per bucket so one bad label cannot lose the whole
        batch — but that also means a short result is indistinguishable from a
        graph that genuinely has fewer nodes, and `trace_closure` was reading a
        total swallow as "walk found nothing" and shipping an empty containment
        tree with no truncation reason at all.

        Used by trace v2 to hydrate nodes after BFS AND by advanced search's
        batched ancestor hydration (W1.1c).

        Uses the longer ``FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS`` (15s
        default) rather than the generic 5s read timeout because a
        single batch may carry hundreds of URNs from a large search
        page; the IN-list scan on a million-node graph is the same
        cost class as the children-fetch this timeout was tuned for.
        """
        if not urns:
            return [], 0
        from ..config.resilience import FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS

        # Per-label urn-index seeks via the warmed urn→label cache; the
        # unlabeled IN-list form survives only for the unresolved-label
        # residue bucket (this build has no label-less URN index — the
        # unlabeled anchor is a full node scan).
        #
        # childCount is COMPUTED here when containment types are configured
        # (2026-08-20): trace-shipped nodes used to rely on the denormalised
        # `childCount` property alone, which import paths don't always stamp
        # — a self-nesting Node⊃Node⊃Node estate then rendered its trace-
        # merged children CHEVRON-LESS (no expand affordance, deeper levels
        # unreachable). Browse computes the count live; the batch hydration
        # every trace path uses must agree with it.
        try:
            _ct_for_count = self._get_containment_edge_types() or []
        except ProviderConfigurationError:
            # See get_node: unconfigured is the only expected failure here.
            _ct_for_count = []
        ctypes_for_count = [_sanitize_label(t) for t in _ct_for_count if t]
        ct_alt_count = "|".join(ctypes_for_count)

        buckets_failed = 0

        async def _fetch(label: str, bucket: List[str]) -> list:
            anchor = f"(n:{label})" if label else "(n)"
            if ct_alt_count:
                cy = (
                    f"MATCH {anchor} WHERE n.urn IN $urns "
                    f"OPTIONAL MATCH (n)-[:{ct_alt_count}]->(child) "
                    "RETURN n, count(child) as childCount"
                )
            else:
                cy = f"MATCH {anchor} WHERE n.urn IN $urns RETURN n"
            try:
                res = await self._ro_query(
                    cy,
                    params={"urns": bucket},
                    timeout=FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS,
                    op="nodes.batch",
                )
                return res.result_set or []
            except Exception as exc:
                nonlocal buckets_failed
                buckets_failed += 1
                logger.warning("get_nodes_batch bucket failed: %s", exc)
                return []

        try:
            all_buckets = await self._label_buckets(urns)
            rows_per_bucket = await asyncio.gather(*[
                _fetch(label, bucket) for label, bucket in all_buckets
            ])
        except Exception as exc:
            logger.warning("get_nodes_batch failed: %s", exc)
            return [], max(1, buckets_failed)
        out: List[GraphNode] = []
        for rows in rows_per_bucket:
            for row in rows:
                child_count = None
                if ct_alt_count and isinstance(row, (list, tuple)) and len(row) >= 2:
                    node = self._extract_node_from_result([row[0]])
                    child_count = row[1]
                else:
                    node = self._extract_node_from_result(row)
                if not node:
                    continue
                if child_count is not None:
                    node.child_count = int(child_count)
                    if node.properties is not None:
                        node.properties['childCount'] = int(child_count)
                out.append(node)
        return out, buckets_failed

    # Schema-level caches are persisted in Postgres by the stats service;
    # this in-memory Redis layer is just a short-term memoization for
    # repeated calls within a polling interval. Default 300s (5 min) —
    # matches the stats service poll interval. Set to 0 to disable.
    _SCHEMA_CACHE_TTL = int(os.getenv("FALKORDB_SCHEMA_CACHE_TTL", "300"))

    async def get_stats(self, bypass_cache: bool = False) -> Dict[str, Any]:
        """Node/edge counts + per-type breakdowns (two grouped scans).

        ``bypass_cache=True`` skips the Redis cache READ but still
        writes-through on success — for refresh paths (the insights
        counts poll) that must never persist pre-aged cached counts as
        fresh, while still priming the cache for other callers.
        """
        await self._ensure_connected()

        # Check Redis cache (best-effort; Postgres is the source of truth)
        cache_key = f"{self._cache_ns}:stats_cache"
        if self._SCHEMA_CACHE_TTL > 0 and not bypass_cache:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    return json.loads(cached)
            except Exception:
                pass

        # Empty / never-created graphs raise "Invalid graph operation on
        # empty key" on GRAPH.RO_QUERY — a valid 0-node / 0-edge state, not
        # an outage. Tolerate it so discovery reports the asset as empty
        # rather than the whole provider as down.
        entity_type_counts: Dict[str, Any] = {}
        node_count = 0
        edge_type_counts: Dict[str, Any] = {}
        edge_count = 0
        # The node/edge count scans are O(nodes)+O(edges) — on a million-edge
        # graph they exceed the 5s read default and the stats refresh fails
        # (then the asset shows stale). Give them a dedicated, generous
        # timeout so a cache-miss scan can complete and warm {graph}:stats_cache.
        _stats_q_timeout = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))
        try:
            # Optimize: Combine node counting with type aggregation
            type_res = await self._ro_query(
                "MATCH (n) RETURN labels(n)[0] AS lbl, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (type_res.result_set or []):
                lbl = row[0] or "unknown"
                cnt = row[1]
                entity_type_counts[lbl] = cnt
                node_count += cnt

            # Optimize: Combine edge counting with type aggregation
            edge_type_res = await self._ro_query(
                "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (edge_type_res.result_set or []):
                t = row[0] or "UNKNOWN"
                cnt = row[1]
                edge_type_counts[t] = cnt
                edge_count += cnt
        except Exception as exc:
            if not await self._is_verified_missing_graph(exc):
                raise
            logger.info(
                "get_stats on %s: graph key does not exist yet (empty graph) "
                "— returning zero stats.", self._graph_name,
            )
            entity_type_counts, node_count = {}, 0
            edge_type_counts, edge_count = {}, 0

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }

        if self._SCHEMA_CACHE_TTL > 0:
            try:
                await self._redis.setex(cache_key, self._SCHEMA_CACHE_TTL, json.dumps(result))
            except Exception:
                pass

        return result

    async def get_counts_fast(self) -> Optional[Dict[str, Any]]:
        """Same payload as :meth:`get_stats`, without scanning the graph.

        FalkorDB's ``reduce_count`` optimization answers ``count()`` over an
        unfiltered pattern from the label/relation matrix counters — the plan
        is ``Results / Project`` with no scan operator at all. Projecting
        ``labels(n)[0]`` or ``type(r)`` alongside the count is what loses it,
        which is exactly what ``get_stats`` does and why its two queries cost
        ~514ms on a 500k-node / 850k-edge graph where this costs ~1.3ms.

        So the per-type breakdown comes from the schema catalogue
        (``db.labels()`` / ``db.relationshipTypes()``, both O(#types)) plus one
        constant-time count each. **Never add a projection to these queries.**

        Cost is ``4 + labels + types`` round trips and is therefore constant in
        the SIZE of the graph but linear in the size of its SCHEMA — the exact
        inverse of ``get_stats``. On a small graph with a wide schema the two
        converge; the win is on the large graphs that forced the 900s poll
        interval in the first place.

        Returns ``None`` — not an error — when the counts cannot be trusted,
        so the caller falls back to :meth:`get_stats`. That happens when the
        label counts sum ABOVE the node total, which means multi-label nodes:
        per-label counting then double-counts relative to ``labels(n)[0]``
        semantics. Our own writers are single-label by construction
        (``MERGE (n:{label} {urn: …})``) but an external loader need not be.
        """
        await self._ensure_connected()

        async def _count(cypher: str) -> int:
            res = await self._ro_query_tolerant(cypher, op="probe.count")
            rows = res.result_set or []
            return int(rows[0][0] or 0) if rows and rows[0] else 0

        async def _catalogue(cypher: str) -> List[str]:
            res = await self._ro_query_tolerant(cypher, op="probe.catalogue")
            return [row[0] for row in (res.result_set or []) if row and row[0]]

        labels = await _catalogue(
            "CALL db.labels() YIELD label RETURN label"
        )
        rel_types = await _catalogue(
            "CALL db.relationshipTypes() YIELD relationshipType "
            "RETURN relationshipType"
        )
        node_count = await _count("MATCH (n) RETURN count(n)")
        edge_count = await _count("MATCH ()-[r]->() RETURN count(r)")

        # Zero-count buckets are DROPPED, not reported. The catalogue keeps
        # listing a label/type after its last row is deleted, where get_stats
        # simply returns no row for it — and a {"Ghost": 0} key hashes
        # differently from an absent one, so keeping it would read as drift on
        # the first probe of every graph that ever deleted a type.
        entity_type_counts: Dict[str, Any] = {}
        for label in labels:
            safe = str(label).replace("`", "")
            count = await _count(f"MATCH (n:`{safe}`) RETURN count(n)")
            if count:
                entity_type_counts[label] = count

        edge_type_counts: Dict[str, Any] = {}
        for rel_type in rel_types:
            safe = str(rel_type).replace("`", "")
            count = await _count(f"MATCH ()-[r:`{safe}`]->() RETURN count(r)")
            if count:
                edge_type_counts[rel_type] = count

        label_sum = sum(entity_type_counts.values())
        if label_sum > node_count:
            logger.info(
                "get_counts_fast on %s: label counts sum to %d over %d nodes "
                "(multi-label graph) — deferring to the full scan",
                self._graph_name, label_sum, node_count,
            )
            return None
        if label_sum < node_count:
            # Unlabelled nodes: invisible to per-label counts, and get_stats
            # buckets them under `labels(n)[0] or "unknown"`. Deriving the
            # remainder reproduces that bucket exactly.
            entity_type_counts["unknown"] = node_count - label_sum

        # An edge carries exactly one type, so unlike nodes there is no honest
        # remainder to attribute. A disagreement means the catalogue is not
        # describing this graph; refuse rather than report a wrong shape.
        if sum(edge_type_counts.values()) != edge_count:
            logger.info(
                "get_counts_fast on %s: edge-type counts sum to %d over %d "
                "edges — deferring to the full scan",
                self._graph_name, sum(edge_type_counts.values()), edge_count,
            )
            return None

        result = {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "entityTypeCounts": entity_type_counts,
            "edgeTypeCounts": edge_type_counts,
        }
        # Same payload get_stats would have produced, so priming its cache
        # keeps the two from disagreeing for the TTL.
        await self.prime_stats_cache(result)
        return result

    async def prime_stats_cache(self, stats: Dict[str, Any]) -> None:
        """Write-through prime of the ``{graph}:stats_cache`` Redis key.

        Called by the insights collector after a poll derives fresh
        counts (from ``get_schema_stats``), so subsequent ``get_stats``
        callers — per-asset discovery, web-tier data-source stats —
        serve poll-fresh values instead of re-scanning. Best-effort.
        """
        if self._SCHEMA_CACHE_TTL <= 0:
            return
        await self._ensure_connected()
        try:
            await self._redis.setex(
                f"{self._cache_ns}:stats_cache",
                self._SCHEMA_CACHE_TTL,
                json.dumps(stats),
            )
        except Exception:
            pass

    async def get_schema_stats(self) -> GraphSchemaStats:
        await self._ensure_connected()
        
        entity_stats = []
        total_nodes = 0
        edge_stats = []
        total_edges = 0
        # Empty / never-created graph → valid empty schema, not an outage.
        _stats_q_timeout = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))
        try:
            # Single query: counts + samples per label using collect() with slicing
            type_res = await self._ro_query(
                "MATCH (n) "
                "WITH labels(n)[0] AS lbl, n.displayName AS name "
                "WITH lbl, count(*) AS c, collect(name)[0..3] AS samples "
                "RETURN lbl, c, samples",
                timeout=_stats_q_timeout,
            )
            for row in (type_res.result_set or []):
                lbl = row[0] or "unknown"
                if str(lbl).startswith("_"):
                    # System-internal labels (_AggMeta run metadata,
                    # _Projection scaffolding) — not user entity types;
                    # surfacing them puts phantom types in the ontology
                    # wizard.
                    continue
                cnt = row[1]
                samples = [s for s in (row[2] or []) if s]
                total_nodes += cnt
                entity_stats.append(EntityTypeSummary(id=lbl, name=lbl, count=cnt, sampleNames=samples))

            edge_type_res = await self._ro_query(
                "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
                timeout=_stats_q_timeout,
            )
            for row in (edge_type_res.result_set or []):
                t = row[0] or "UNKNOWN"
                cnt = row[1]
                edge_stats.append(EdgeTypeSummary(id=t, name=t, count=cnt))
                total_edges += cnt
        except Exception as exc:
            if not await self._is_verified_missing_graph(exc):
                raise
            logger.info(
                "get_schema_stats on %s: graph key does not exist yet "
                "(empty graph) — returning empty schema.", self._graph_name,
            )
            return GraphSchemaStats(
                totalNodes=0, totalEdges=0,
                entityTypeStats=[], edgeTypeStats=[], tagStats=[],
            )

        # Tag stats — a full node scan like the two above; give it the
        # same generous stats budget (it previously ran on the default
        # connection timeout and was the silent killer on large graphs).
        try:
            tag_res = await self._ro_query(
                "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags <> '[]' RETURN n.tags",
                timeout=_stats_q_timeout,
            )
            tag_counts: Dict[str, int] = {}
            tag_types: Dict[str, Set[str]] = {}
            for row in (tag_res.result_set or []):
                tags_raw = row[0]
                try:
                    tags = json.loads(tags_raw) if isinstance(tags_raw, str) else (tags_raw or [])
                except Exception:
                    continue
                for tag in tags:
                    tag_counts[tag] = tag_counts.get(tag, 0) + 1
                    if tag not in tag_types:
                        tag_types[tag] = set()
                    tag_types[tag].add("entity")
            tag_stats = [TagSummary(tag=t, count=c, entityTypes=list(tag_types.get(t, {"entity"}))) for t, c in tag_counts.items()]
        except Exception as e:
            logger.warning(f"Failed to fetch tag stats: {e}")
            tag_stats = []

        return GraphSchemaStats(
            totalNodes=total_nodes,
            totalEdges=total_edges,
            entityTypeStats=entity_stats,
            edgeTypeStats=edge_stats,
            tagStats=tag_stats,
        )

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """
        Build ontology metadata including containment and lineage roles.
        Optimized to use Cypher aggregations instead of full scans.
        Cached in Redis with 60s TTL — ontology rarely changes.
        """
        await self._ensure_connected()

        cache_key = f"{self._cache_ns}:ontology_cache"
        if self._SCHEMA_CACHE_TTL > 0:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    cached_meta = OntologyMetadata(**json.loads(cached))
                    # Keep the sync case-fold floor (_alias_rel_types) warm even
                    # on a cache hit: the metadata's edge-type keys ARE the
                    # observed physical spellings, so trace/top-level resolve
                    # declared→physical correctly without re-probing the graph.
                    self._observed_rel_types = set(cached_meta.edge_type_metadata or {})
                    return cached_meta
            except Exception:
                pass

        # Introspection must NOT depend on containment having been injected.
        # ``_resolve_ontology`` calls this method BEFORE ``_inject_resolved`` on a
        # fresh provider, and ``_get_containment_edge_types`` raises when the set
        # isn't configured yet. Letting that raise here aborts the whole
        # introspection (observed vocabulary discovery below), which leaves the
        # per-source case-alias map empty on the FIRST resolve — so declared
        # UPPER_SNAKE types get injected verbatim into case-sensitive Cypher and
        # match nothing (a flat hierarchy on a freshly-onboarded data source).
        # Containment here is only a classification hint for the observed types;
        # treat "not configured yet" as empty and let the rest run.
        try:
            containment = list(self._get_containment_edge_types())
        except ProviderConfigurationError:
            containment = []
        containment_upper = {t.upper() for t in containment}
        
        # 1. Determine Lineage Types
        # db.relationshipTypes() reads the graph schema catalog — O(#types),
        # no edge scan. The DISTINCT type(r) scan (O(#edges): ~1s per million
        # edges, and this runs on every ontology-cache miss) remains only as
        # a fallback for engines without the procedure. The catalog can list
        # types whose last edge was deleted — harmless here: downstream
        # classification treats the list as "observed vocabulary" and a
        # stale entry simply classifies an absent type.
        all_types: List[str] = []
        try:
            type_res = await self._ro_query_tolerant(
                "CALL db.relationshipTypes() YIELD relationshipType "
                "RETURN relationshipType",
                op="ontology.reltypes",
            )
            all_types = [row[0] for row in (type_res.result_set or []) if row and row[0]]
        except Exception as exc:
            logger.debug("db.relationshipTypes() unavailable (%s) — falling back to edge scan", exc)
        if not all_types:
            type_res = await self._ro_query_tolerant(
                "MATCH ()-[r]->() RETURN DISTINCT type(r)", op="ontology.edge_scan",
            )
            all_types = [row[0] for row in (type_res.result_set or [])]

        # Feed the sync case-fold floor (_alias_rel_types) the observed
        # vocabulary discovered here (catalog ∪ edge-scan fallback), so every
        # read-path consumer resolves declared→physical case variants without
        # depending on the injected per-source alias map being non-empty.
        self._observed_rel_types = {str(t) for t in all_types if t}

        # Use ontology-resolved edge metadata if available, otherwise fall back to heuristics
        resolved_meta = getattr(self, "_resolved_edge_metadata", None)
        resolved_lineage = getattr(self, "_resolved_lineage_types", None)

        if resolved_meta is not None and resolved_lineage is not None:
            # Ontology-driven classification
            lineage_types = [t for t in all_types if t.upper() in resolved_lineage]
        else:
            # Heuristic fallback (pre-ontology or no ontology)
            config_lineage = os.getenv("LINEAGE_EDGE_TYPES", "").strip()
            if config_lineage:
                lineage_types = [t.strip() for t in config_lineage.split(",") if t.strip()]
            else:
                config_metadata = os.getenv("METADATA_EDGE_TYPES", "").strip()
                metadata_types = {t.strip().upper() for t in config_metadata.split(",") if t.strip()} if config_metadata else set()
                lineage_types = []
                for t in all_types:
                    if t.upper() not in containment_upper and t.upper() not in metadata_types and t.upper() != "AGGREGATED":
                        lineage_types.append(t)

        lineage_upper = {t.upper() for t in lineage_types}

        # 2. Build Edge Metadata
        edge_type_metadata: Dict[str, EdgeTypeMetadata] = {}
        for et in all_types:
            et_upper = et.upper()
            is_containment = et_upper in containment_upper
            is_lineage = et_upper in lineage_upper

            # Prefer resolved ontology metadata for direction/category
            if resolved_meta and et_upper in resolved_meta:
                meta = resolved_meta[et_upper]
                direction = meta.get("direction", "bidirectional") if isinstance(meta, dict) else getattr(meta, "direction", "bidirectional")
                category = meta.get("category", "association") if isinstance(meta, dict) else getattr(meta, "category", "association")
            elif is_containment:
                category = "structural"
                direction = "parent-to-child"
            elif is_lineage:
                category = "flow"
                direction = "source-to-target"
            else:
                category = "association"
                direction = "bidirectional"

            edge_type_metadata[et] = EdgeTypeMetadata(
                isContainment=is_containment,
                isLineage=is_lineage,
                direction=direction,
                category=category,
                description=f"{category} relationship: {et}",
            )

        # 3. Build Entity Hierarchy
        # Query containment relationships directly
        hierarchy_cypher = (
            "MATCH (p)-[r]->(c) "
            "WHERE type(r) IN $containment "
            "RETURN DISTINCT labels(p)[0], labels(c)[0], type(r)"
        )
        hierarchy_res = await self._ro_query_tolerant(
            hierarchy_cypher,
            params={"containment": containment}
        )
        
        entity_type_hierarchy: Dict[str, EntityTypeHierarchy] = {}
        found_parent_types = set()
        found_child_types = set()
        
        for row in (hierarchy_res.result_set or []):
            p_type, c_type, r_type = row[0], row[1], row[2]
            if not p_type or not c_type: continue
            
            # Normalize for direction
            meta = edge_type_metadata.get(r_type)
            if meta and meta.direction == "child-to-parent":
                parent_t, child_t = c_type, p_type
            else:
                parent_t, child_t = p_type, c_type
                
            if parent_t not in entity_type_hierarchy:
                entity_type_hierarchy[parent_t] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
            if child_t not in entity_type_hierarchy:
                entity_type_hierarchy[child_t] = EntityTypeHierarchy(canContain=[], canBeContainedBy=[])
                
            if child_t not in entity_type_hierarchy[parent_t].can_contain:
                entity_type_hierarchy[parent_t].can_contain.append(child_t)
            if parent_t not in entity_type_hierarchy[child_t].can_be_contained_by:
                entity_type_hierarchy[child_t].can_be_contained_by.append(parent_t)
                
            found_parent_types.add(parent_t)
            found_child_types.add(child_t)

        root_entity_types = list(found_parent_types - found_child_types)

        result = OntologyMetadata(
            containmentEdgeTypes=containment,
            lineageEdgeTypes=lineage_types,
            edgeTypeMetadata=edge_type_metadata,
            entityTypeHierarchy=entity_type_hierarchy,
            rootEntityTypes=root_entity_types,
        )

        if self._SCHEMA_CACHE_TTL > 0:
            try:
                await self._redis.setex(cache_key, self._SCHEMA_CACHE_TTL, result.model_dump_json())
            except Exception:
                pass

        return result

    async def get_node_degrees(
        self, urns: List[str], edge_types: Optional[List[str]] = None,
    ) -> Dict[str, Dict[str, int]]:
        """TOTAL lineage degree (in/out) per URN over the FULL graph.

        The canvas subtracts its loaded (internal) degree from these
        totals to derive how much lineage lies OUTSIDE the current
        view's scope — the "no lineage" vs "lineage outside this view"
        distinction for curated subset views. Per-node adjacency
        aggregates (never a set-membership XOR over all edges), with
        label-bucketed URN seeks so no bucket falls back to a full node
        scan.

        Semantics: a URN ABSENT from the result is UNKNOWN (its bucket's
        query failed) — callers must not treat absence as zero. URNs in
        a successfully-queried bucket that simply have no edges are
        explicitly zero-filled.
        """
        out: Dict[str, Dict[str, int]] = {}
        if not urns:
            return out
        await self._ensure_connected()
        rel_alt = "|".join(_sanitize_label(t) for t in (edge_types or []) if t)
        rel_frag = f":{rel_alt}" if rel_alt else ""
        for label, bucket_urns in await self._label_buckets(urns):
            lbl_frag = f":{label}" if label else ""
            bucket_ok = True
            counts: Dict[str, Dict[str, int]] = {}
            for direction, pattern in (
                ("out", f"(n{lbl_frag})-[r{rel_frag}]->()"),
                ("in", f"(n{lbl_frag})<-[r{rel_frag}]-()"),
            ):
                cypher = (
                    f"MATCH {pattern} WHERE n.urn IN $urns "
                    "RETURN n.urn AS urn, count(r) AS c"
                )
                try:
                    result = await self._ro_query(
                        cypher, params={"urns": bucket_urns}, timeout=2.0,
                        op="node_degrees",
                    )
                except Exception as exc:
                    logger.warning(
                        "get_node_degrees %s failed (%d urns, label=%r): %s",
                        direction, len(bucket_urns), label, exc,
                    )
                    bucket_ok = False
                    break
                for row in (result.result_set or []):
                    counts.setdefault(str(row[0]), {"in": 0, "out": 0})[direction] = int(row[1] or 0)
            if not bucket_ok:
                continue  # absent = unknown, never zero
            for urn in bucket_urns:
                out[urn] = counts.get(urn, {"in": 0, "out": 0})
        return out

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        await self._ensure_connected()
        if property_name in ("entityType", "entitytype"):
            res = await self._ro_query("MATCH (n) RETURN DISTINCT labels(n)[0] AS lbl")
            return [row[0] for row in (res.result_set or []) if row[0]]
        if property_name == "tags":
            res = await self._ro_query("MATCH (n) RETURN n.tags")
            seen = set()
            for row in (res.result_set or []):
                raw = row[0]
                try:
                    tags = json.loads(raw) if isinstance(raw, str) else (raw or [])
                    for t in tags:
                        seen.add(t)
                except Exception:
                    pass
            return list(seen)
        safe_prop = "".join(c for c in property_name if c.isalnum() or c == "_") or "urn"
        try:
            res = await self._ro_query(
                f"MATCH (n) WHERE n.{safe_prop} IS NOT NULL RETURN DISTINCT n.{safe_prop} AS v LIMIT 100"
            )
            return [row[0] for row in (res.result_set or [])]
        except Exception:
            return []

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """Get ancestors using pre-computed Redis chain (2 calls: 1 Redis + 1 Cypher)."""
        await self._ensure_connected()
        chain = await self._get_ancestor_chain(urn)
        chain = chain[offset : offset + limit]
        if not chain:
            return []
        nodes = await self.get_nodes(NodeQuery(urns=chain, limit=len(chain), include_child_count=False))
        # Preserve containment order (parent → grandparent → ...)
        urn_to_node = {n.urn: n for n in nodes}
        return [urn_to_node[u] for u in chain if u in urn_to_node]

    async def get_descendants(
        self,
        urn: str,
        depth: int = 5,
        entity_types: Optional[List[str]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[GraphNode]:
        """Single Cypher query to fetch descendants instead of per-node BFS."""
        await self._ensure_connected()
        containment = list(self._get_containment_edge_types())
        if not containment:
            # No containment types — flat graph, no descendants
            return []
        containment_cypher = "|".join([_sanitize_label(t) for t in containment])

        conditions = ["root.urn = $urn"]
        params: Dict[str, Any] = {"urn": urn, "skip": offset, "lim": limit}

        if entity_types:
            types = [t.value if hasattr(t, "value") else str(t) for t in entity_types]
            params["entityTypes"] = types
            conditions.append("labels(desc)[0] IN $entityTypes")

        where = " AND ".join(conditions)
        cypher = (
            f"MATCH (root)-[:{containment_cypher}*1..{depth}]->(desc) "
            f"WHERE {where} "
            f"RETURN DISTINCT desc "
            f"SKIP $skip LIMIT $lim"
        )

        result = await self._ro_query(cypher, params=params)
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n:
                nodes.append(n)
        return nodes

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        await self._ensure_connected()
        tag_pattern = json.dumps(tag)
        result = await self._ro_query(
            "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags CONTAINS $tag RETURN n SKIP $skip LIMIT $limit",
            params={"tag": tag_pattern, "skip": offset, "limit": limit},
        )
        nodes = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row)
            if n and tag in (n.tags or []):
                nodes.append(n)
        return nodes

    async def get_nodes_by_layer(
        self, layer_id: str, limit: int = 100, offset: int = 0,
        sort_direction: str = "asc", cursor: Optional[str] = None,
    ) -> List[GraphNode]:
        """Nodes with `layerAssignment = layer_id`, ordered by (displayName, urn)
        in `sort_direction`, with keyset-cursor pagination (offset fallback).

        Label-anchored UNION over the indexed label set (same pattern as
        `get_top_level_or_orphan_nodes`) so the label-scoped `layerAssignment`
        index serves the filter — a bare `MATCH (n)` cannot use label-scoped
        indexes and full-scans. Falls back to the bare match when no ontology
        vocabulary has been applied (pre-ontology graphs); a case-drifted
        physical label outside the vocabulary is, by construction, not in the
        union (mirrors the top-level path's coverage tradeoff).
        """
        await self._ensure_connected()
        sort_direction = _validate_sort_direction(sort_direction)
        from backend.app.providers.index_policy import indexed_labels

        params: Dict[str, Any] = {"lid": layer_id, "limit": int(limit)}
        cmp = "<" if sort_direction == "desc" else ">"
        dir_kw = "DESC" if sort_direction == "desc" else "ASC"

        filters = ["n.layerAssignment = $lid"]
        skip_clause = ""
        if cursor:
            cursor_name, cursor_urn = _decode_keyset_cursor(str(cursor), sort_direction)
            params["cursorName"] = cursor_name
            if cursor_urn:
                params["cursorUrn"] = cursor_urn
                filters.append(
                    f"(n.displayName {cmp} $cursorName "
                    f"OR (n.displayName = $cursorName AND n.urn {cmp} $cursorUrn))"
                )
            else:
                filters.append(f"n.displayName {cmp} $cursorName")  # legacy cursor
        else:
            params["skip"] = int(offset)
            skip_clause = " SKIP $skip"

        where = " WHERE " + " AND ".join(filters)
        order = f" ORDER BY n.displayName {dir_kw}, n.urn {dir_kw}"

        vocabulary = getattr(self, "_indexed_entity_type_ids", None)
        if vocabulary:
            branches = " UNION ".join(
                f"MATCH (n:{_sanitize_label(label)}){where} RETURN n"
                for label in indexed_labels(vocabulary)
            )
            cypher = "CALL { " + branches + " }" + f" WITH n{order}{skip_clause} LIMIT $limit RETURN n"
        else:
            cypher = f"MATCH (n){where} WITH n{order}{skip_clause} LIMIT $limit RETURN n"

        result = await self._ro_query(cypher, params=params, op="nodes.byLayer")
        nodes: List[GraphNode] = []
        for row in (result.result_set or []):
            n = self._extract_node_from_result(row[0] if isinstance(row, (list, tuple)) else row)
            if n:
                nodes.append(n)
        # Defensive re-sort (same rationale as the other keyset readers).
        return _keyset_sort(nodes, sort_direction)

    # TTL for the observed-casing maps below. Long enough to amortize the
    # vocabulary probe across a bulk load's many calls; short enough that
    # an out-of-band writer's new spelling is picked up quickly.
    _TYPE_CASING_TTL_S = 60.0

    async def _type_casing_maps(self) -> Tuple[Dict[str, str], Dict[str, str]]:
        """``casefold(name) → observed spelling`` for relationship types and
        labels, TTL-cached per provider instance. Newly-written spellings are
        added to the cached maps by ``_consistent_casing`` so consistency
        holds across calls inside the TTL window. Probe failure ⇒ empty maps
        (write-as-given) — casing consistency must never block a write."""
        now = time.monotonic()
        cached = getattr(self, "_casing_maps_cache", None)
        if cached is not None and now - cached[0] < self._TYPE_CASING_TTL_S:
            return cached[1], cached[2]
        rels: Dict[str, str] = {}
        labels: Dict[str, str] = {}
        try:
            res = await self._ro_query("CALL db.relationshipTypes()")
            for row in (res.result_set or []):
                if row and row[0]:
                    rels.setdefault(str(row[0]).casefold(), str(row[0]))
            res = await self._ro_query("CALL db.labels()")
            for row in (res.result_set or []):
                if row and row[0]:
                    labels.setdefault(str(row[0]).casefold(), str(row[0]))
        except Exception as exc:
            logger.debug(
                "type-casing vocabulary probe failed (%s) — writing types "
                "as given this window", exc,
            )
        self._casing_maps_cache = (now, rels, labels)
        return rels, labels

    @staticmethod
    def _consistent_casing(name: str, fold_map: Dict[str, str]) -> str:
        """The graph's canonical spelling for ``name``: an already-observed
        case-fold variant wins (FalkorDB matches types/labels case-
        sensitively — a second casing fragments one logical type across two
        relation matrices, and a differently-cased label makes MERGE mint a
        DUPLICATE of an existing urn node); a genuinely new spelling is
        recorded and becomes canonical for subsequent writes."""
        got = fold_map.get(name.casefold())
        if got is not None:
            return got
        fold_map[name.casefold()] = name
        return name

    async def _bulk_write_batch(self, cypher: str, params: dict, *, what: str) -> None:
        """Execute ONE bulk-load write batch, waiting out a FalkorDB restart/loading instead
        of dropping it.

        This is the line between a resumable multi-million-row load and silently losing data.
        A large load can OOM-restart the server (or trip an AOF rewrite); it comes back in a
        LOADING state that rejects writes for many seconds while it replays its dataset into
        memory. The old code caught that error, logged "batch failed", and moved on — so every
        batch during the reload window was dropped while the caller still saw success. Here we
        instead POLL until the server is ready and retry the SAME batch, and RAISE once the wait
        budget is spent so the caller fails loudly with an accurate progress count. Real errors
        (bad cypher, constraint) are never retried — they raise immediately."""
        try:
            max_wait = float(os.getenv("FALKORDB_LOAD_MAX_WAIT_S", "900"))   # a big graph can take minutes to reload
        except ValueError:
            max_wait = 900.0
        try:
            delay = float(os.getenv("FALKORDB_LOAD_RETRY_BASE_S", "0.5"))
        except ValueError:
            delay = 0.5
        waited = 0.0
        attempt = 0
        while True:
            attempt += 1
            try:
                await self._query(cypher, params=params)
                if attempt > 1:
                    logger.info(
                        "FalkorDB %s: %s written after waiting %.0fs for the server to come back.",
                        self._graph_name, what, waited,
                    )
                return
            except Exception as exc:
                # ProviderUnavailable covers ProviderLoading (its subclass). Anything else that
                # is a transient connection / redis-loading error is also worth waiting out.
                from backend.common.adapters import ProviderUnavailable
                recoverable = (
                    isinstance(exc, ProviderUnavailable)
                    or _is_loading_error(exc)
                    or _is_transient_connection_error(exc)
                )
                if not recoverable or waited >= max_wait:
                    logger.error(
                        "FalkorDB %s: %s could not be written (%s) after %.0fs — aborting the "
                        "load instead of dropping the batch.",
                        self._graph_name, what, type(exc).__name__, waited,
                    )
                    raise
                await asyncio.sleep(delay)
                waited += delay
                delay = min(delay * 1.5, 5.0)
                try:
                    await self._ensure_connected()   # rebuild the handle a restart invalidated
                except Exception:
                    pass                             # the next _query re-attempts the connection

    async def save_custom_graph(
        self, nodes: List[GraphNode], edges: List[GraphEdge],
        endpoint_labels: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Batch-save nodes and edges using UNWIND for bulk writes.

        Groups nodes by label (entity type) so each UNWIND+MERGE targets
        a single label — enabling index-assisted lookups. Turns N individual
        queries into ceil(N/batch_size) queries per label.

        Edges are likewise grouped by (relationship type, source label, target
        label) so the endpoint MATCH carries a label and hits the per-label urn
        index (``Node By Index Scan``) instead of an ``All Node Scan`` — the
        difference between ~180k and ~90 edges/s on a large graph. Endpoint
        labels are resolved from the nodes saved in THIS call plus the optional
        ``endpoint_labels`` (urn→entityType) the caller supplies for edges whose
        endpoints were saved in a previous call (the importer's separate node/
        edge passes). An endpoint with no known label falls back to a label-less
        MATCH (correct, just unindexed) — never a dropped edge.

        ``FALKORDB_SAVE_BATCH_SIZE`` tunes the UNWIND batch size (default
        2000, clamped 100-10000): larger batches amortize parse/plan
        overhead on multi-million-row initial loads; smaller ones bound
        single-query time on constrained instances.
        """
        await self._ensure_connected()
        try:
            batch_size = max(100, min(10000, int(os.getenv("FALKORDB_SAVE_BATCH_SIZE", "2000"))))
        except ValueError:
            batch_size = 2000

        # Observed-casing maps: everything this call CREATES is written in
        # the graph's existing casing (or mints the canonical one) so one
        # logical type/label never fragments across case variants.
        rel_casing, label_casing = await self._type_casing_maps()

        # Group nodes by label for label-specific MERGE
        nodes_by_label: Dict[str, list] = defaultdict(list)
        for node in nodes:
            label = self._consistent_casing(
                _sanitize_label(str(node.entity_type)), label_casing,
            )
            native_props, residual_blob = _split_user_properties(node.properties)
            nodes_by_label[label].append({
                "urn": node.urn,
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "nativeProps": native_props,
                "propertiesRaw": residual_blob,
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "childCount": node.child_count or 0,
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
                "level": self._get_node_level(node.entity_type),
                "searchableText": _compute_searchable_text(
                    node.display_name, node.qualified_name,
                    node.description, native_props,
                ),
            })

        # Ensure per-label URN indexes BEFORE the writes: node MERGE and
        # edge MATCH both look up by urn, and without the index each row
        # is a label scan. Once per provider instance — CREATE INDEX is
        # idempotent but there's no point re-issuing DDL per chunk.
        if nodes_by_label and not getattr(self, "_save_indices_ensured", False):
            try:
                await self.ensure_indices(list(nodes_by_label.keys()))
                self._save_indices_ensured = True
            except Exception as exc:
                logger.warning(
                    "save_custom_graph: ensure_indices failed (continuing; "
                    "writes will be slower without URN indexes): %s", exc,
                )

        # Bulk-cache urn→label mappings
        label_mapping = {}
        for label, items in nodes_by_label.items():
            for item in items:
                label_mapping[item["urn"]] = label
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                try:
                    # Notes on the SET / REMOVE shape:
                    # - `n += item.nativeProps` merges user-supplied scalar
                    #   properties as real node fields. Merge semantics —
                    #   keys that disappear across upserts are NOT removed
                    #   (delete via an explicit op if needed). This matches
                    #   how every other reserved field is upserted here.
                    # - `n.propertiesRaw` always written (always a string,
                    #   "{}" when empty) so we don't need a separate REMOVE
                    #   round-trip when the residual goes empty.
                    # - `REMOVE n.properties` strips the legacy blob on
                    #   every write so the read-path transitional code
                    #   becomes dead weight as soon as a node is touched.
                    # - `n.level = coalesce(item.level, n.level)` keeps the
                    #   pre-refactor semantics: if the engine hasn't
                    #   injected the entity-type→level map yet (seed-from-
                    #   file before ontology resolution), level stays as-is.
                    await self._bulk_write_batch(
                        f"UNWIND $batch AS item "
                        f"MERGE (n:{label} {{urn: item.urn}}) "
                        f"SET n.displayName = item.displayName, "
                        f"n.qualifiedName = item.qualifiedName, "
                        f"n.description = item.description, "
                        f"n.tags = item.tags, "
                        f"n.layerAssignment = item.layerAssignment, "
                        f"n.childCount = item.childCount, "
                        f"n.sourceSystem = item.sourceSystem, "
                        f"n.lastSyncedAt = item.lastSyncedAt, "
                        f"n.propertiesRaw = item.propertiesRaw, "
                        f"n.level = coalesce(item.level, n.level), "
                        f"n.searchableText = item.searchableText, "
                        f"n += item.nativeProps "
                        f"REMOVE n.properties",
                        {"batch": batch},
                        what=f"node batch :{label}",
                    )
                except Exception as e:
                    logger.error(f"Node merge failed for label {label}: {e}")
                    raise
        await self._cache_urn_labels_bulk(label_mapping)

        # urn → label for endpoint MATCH: same-call nodes (authoritative) over
        # the caller-supplied map (endpoints saved in a prior call). Resolve ONLY the
        # endpoints referenced by THIS call's edges — ``endpoint_labels`` can be the whole
        # graph (millions of urns), so iterating/sanitizing all of it per call is O(graph)
        # per batch (~1.4s/10k-chunk at 2M nodes → ~11min of pure Python for a 5M-edge
        # load). A small value cache avoids re-sanitizing the handful of distinct labels.
        referenced = {u for e in edges for u in (e.source_urn, e.target_urn)}
        urn_label: Dict[str, str] = {}
        _san_cache: Dict[str, str] = {}
        for urn in referenced:
            lbl = label_mapping.get(urn)          # already sanitized (same-call node)
            if lbl is None and endpoint_labels:
                raw = endpoint_labels.get(urn)
                if raw is not None:
                    lbl = _san_cache.get(raw)
                    if lbl is None:
                        lbl = _sanitize_label(str(raw))
                        _san_cache[raw] = lbl
            if lbl is not None:
                urn_label[urn] = lbl

        # Endpoints still unknown (edges into nodes saved in a prior call
        # with no caller-supplied label): resolve through the urn→label
        # cache / graph in one bulk pass so they hit the indexed MATCH
        # too; anything unresolvable keeps the label-less fallback below.
        unknown = list(referenced - set(urn_label))
        if unknown:
            try:
                resolved = await self._resolve_urn_labels_bulk(unknown)
                urn_label.update(
                    {u: lbl for u, lbl in resolved.items() if lbl}
                )
            except Exception as exc:
                logger.warning(
                    "save_custom_graph: bulk urn→label resolve failed (%s) — "
                    "%d endpoint(s) fall back to unlabeled matches",
                    exc, len(unknown),
                )

        # Group edges by (relationship type, source label, target label) so each
        # UNWIND's endpoint MATCH is label-qualified (index-eligible). A None label
        # means "unknown endpoint" → label-less MATCH (correct, unindexed fallback).
        edges_grouped: Dict[tuple, list] = defaultdict(list)
        for edge in edges:
            rel_type = self._consistent_casing(
                _sanitize_label(str(edge.edge_type)), rel_casing,
            )
            key = (rel_type, urn_label.get(edge.source_urn), urn_label.get(edge.target_urn))
            edges_grouped[key].append({
                "src": edge.source_urn,
                "tgt": edge.target_urn,
                "eid": edge.id,
                "conf": edge.confidence,
                "props": json.dumps(edge.properties),
            })

        for (rel_type, src_label, tgt_label), items in edges_grouped.items():
            a_pat = f"(a:{src_label} {{urn: item.src}})" if src_label else "(a {urn: item.src})"
            b_pat = f"(b:{tgt_label} {{urn: item.tgt}})" if tgt_label else "(b {urn: item.tgt})"
            for i in range(0, len(items), batch_size):
                batch = items[i : i + batch_size]
                await self._bulk_write_batch(
                    f"UNWIND $batch AS item "
                    f"MATCH {a_pat} "
                    f"MATCH {b_pat} "
                    f"MERGE (a)-[r:{rel_type}]->(b) "
                    f"SET r.id = item.eid, r.confidence = item.conf, "
                    f"r.properties = item.props",
                    {"batch": batch},
                    what=f"edge batch :{rel_type}",
                )

        return True

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        await self._ensure_connected()
        try:
            rel_casing, label_casing = await self._type_casing_maps()
            label = self._consistent_casing(
                _sanitize_label(str(node.entity_type)), label_casing,
            )
            native_props, residual_blob = _split_user_properties(node.properties)
            # Reserved fields go into the merge map alongside native user
            # props — `SET n += $p` writes them all in one pass. The native
            # user props sit at the top level of the map (they ARE the new
            # node fields); the legacy blob is stripped via REMOVE.
            params: Dict[str, Any] = {
                "displayName": node.display_name or "",
                "qualifiedName": node.qualified_name or "",
                "description": node.description or "",
                "propertiesRaw": residual_blob,
                "tags": json.dumps(node.tags or []),
                "layerAssignment": node.layer_assignment or "",
                "sourceSystem": node.source_system or "",
                "lastSyncedAt": node.last_synced_at or "",
                "searchableText": _compute_searchable_text(
                    node.display_name, node.qualified_name,
                    node.description, native_props,
                ),
            }
            if node.child_count is not None:
                params["childCount"] = node.child_count
            # Only include level when the engine has injected the mapping;
            # otherwise omit the key so SET n += $p doesn't overwrite an
            # existing level with null.
            level = self._get_node_level(node.entity_type)
            if level is not None:
                params["level"] = level
            # Merge native user props on top — they become real node
            # fields. Reserved-key collisions were already dropped by
            # _split_user_properties so this is safe.
            params.update(native_props)
            await self._query(
                f"MERGE (n:{label} {{urn: $urn}}) SET n += $p REMOVE n.properties",
                params={"urn": node.urn, "p": params},
            )
            await self._cache_urn_label(node.urn, label)
            if containment_edge:
                rel_type = self._consistent_casing(
                    _sanitize_label(str(containment_edge.edge_type)), rel_casing,
                )
                await self._query(
                    f"""
                    MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}})
                    MERGE (a)-[r:{rel_type}]->(b)
                    SET r.id = $eid, r.confidence = $conf, r.properties = $props
                    """,
                    params={
                        "src": containment_edge.source_urn,
                        "tgt": containment_edge.target_urn,
                        "eid": containment_edge.id,
                        "conf": containment_edge.confidence,
                        # Write r.properties like every other edge writer — it was omitted here, so a
                        # containment edge created with properties lost them until the next rebuild.
                        "props": json.dumps(containment_edge.properties or {}),
                    },
                )
            return True
        except Exception as e:
            logger.error(f"create_node failed: {e}")
            return False

    async def create_edge(self, edge: GraphEdge) -> bool:
        """Create a single edge in FalkorDB."""
        await self._ensure_connected()
        try:
            rel_casing, _ = await self._type_casing_maps()
            rel_type = self._consistent_casing(
                _sanitize_label(str(edge.edge_type)), rel_casing,
            )
            await self._query(
                f"MATCH (a {{urn: $src}}) MATCH (b {{urn: $tgt}}) "
                f"MERGE (a)-[r:{rel_type}]->(b) "
                f"SET r.id = $eid, r.confidence = $conf, r.properties = $props",
                params={
                    "src": edge.source_urn,
                    "tgt": edge.target_urn,
                    "eid": edge.id,
                    # Pass confidence through RAW (may be None) — matching save_custom_graph, the
                    # projector reseed, and create_node's containment edge. `edge.confidence or 1.0`
                    # silently rewrote a legitimate 0.0 (and None) to 1.0, fabricating a value the
                    # rebuild round-trip would then treat as real.
                    "conf": edge.confidence,
                    "props": json.dumps(edge.properties or {}),
                },
            )
            return True
        except Exception as e:
            logger.error(f"create_edge failed: {e}")
            return False

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        """Update edge properties by edge ID."""
        await self._ensure_connected()
        try:
            result = await self._query(
                "MATCH (a)-[r]->(b) WHERE r.id = $eid "
                "SET r.properties = $props "
                "RETURN a.urn, b.urn, type(r), properties(r)",
                params={"eid": edge_id, "props": json.dumps(properties)},
            )
            if not result.result_set:
                return None
            row = result.result_set[0]
            return _edge_from_row(row[0], row[1], row[2], row[3] or {})
        except Exception as e:
            logger.error(f"update_edge failed: {e}")
            return None

    async def delete_edge(self, edge_id: str) -> bool:
        """Delete an edge by its ID property."""
        await self._ensure_connected()
        try:
            result = await self._query(
                "MATCH ()-[r]->() WHERE r.id = $eid DELETE r RETURN count(r)",
                params={"eid": edge_id},
            )
            if result.result_set and result.result_set[0][0] > 0:
                return True
            return False
        except Exception as e:
            logger.error(f"delete_edge failed: {e}")
            return False

    # ------------------------------------------------------------------ #
    # ProviderRegistry lifecycle helpers                                   #
    # ------------------------------------------------------------------ #

    async def list_graphs(self) -> list:
        """Return all graph keys on this FalkorDB instance via GRAPH.LIST.

        Raises on connection / auth / timeout failure so the discovery
        worker can stamp ``last_error`` and the UI can surface a
        reachable-failure reason (e.g. "tcp_refused: localhost:6379")
        instead of an empty list that the user can't distinguish from
        "no graphs exist". Only an empty result is normalised to ``[]``.
        """
        await self._ensure_connected()
        # On a CLUSTER, self._db is pinned to ONE node and a node only holds the
        # graph keys in its own slots — a single-node GRAPH.LIST silently
        # UNDER-reports (insights discovery would show a partial asset list). Fan
        # out over every primary and union, exactly as list_graph_keys_for_config
        # does for the registry path.
        if self._conn_cfg is not None and self._conn_cfg.mode == "cluster":
            from backend.app.providers.falkordb_connection import (
                list_graph_keys_for_config,
            )
            keys = await asyncio.wait_for(
                list_graph_keys_for_config(self._conn_cfg),
                timeout=self._READ_TIMEOUT,
            )
            return sorted(keys)
        # GRAPH.LIST is a one-off Redis-protocol command on the FalkorDB
        # client (not Cypher, not the TimeoutRedis proxy) so it has no
        # natural wrapper.  Bound it inline at the read-query timeout to
        # honour the per-operation deadline contract.
        result = await asyncio.wait_for(
            self._db.execute_command("GRAPH.LIST"),
            timeout=self._READ_TIMEOUT,
        )
        return list(result) if result else []

    async def close(self) -> None:
        """Release both connection pools held by this provider."""
        # Pool teardown still hits the network (graceful socket close) so it
        # qualifies under the per-operation deadline contract.  Use the
        # short init/teardown timeout — a stuck shutdown should fail fast,
        # not block the event loop forever.
        _close_timeout = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))

        # P1.7 — cancel any in-flight reconcile task FIRST so it doesn't
        # keep using the pool we're about to close. Without this:
        #   - shutdown can stall (reconcile holds a Redis connection that
        #     keeps the pool's aclose() waiting)
        #   - on eviction-then-rebuild, two reconcile tasks can race on
        #     the same FalkorDB graph (idempotent CREATE INDEX is fine,
        #     but the warnings spam logs)
        reconcile_task = getattr(self, "_reconcile_task", None)
        if reconcile_task is not None and not reconcile_task.done():
            reconcile_task.cancel()
            try:
                await asyncio.wait_for(reconcile_task, timeout=0.5)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception as exc:
                logger.warning(
                    "FalkorDB reconcile task raised on close: %s", exc,
                )
        # Reset so a re-instantiated provider can schedule a fresh
        # reconcile without colliding with the cancelled one.
        self._reconcile_task = None
        self._reconcile_started = False

        try:
            if hasattr(self, "_redis") and self._redis is not None:
                await asyncio.wait_for(self._redis.aclose(), timeout=_close_timeout)
            if self._redis_pool is not None:
                await asyncio.wait_for(self._redis_pool.aclose(), timeout=_close_timeout)
            # Close the graph CLIENTS as well as the pinned pools: in cluster mode
            # the client is a RedisCluster owning a pool per node, so closing
            # self._pool alone leaked every node pool. _proj_db is self._db outside
            # cluster mode, where the second close is a harmless no-op.
            from backend.app.providers.falkordb_connection import aclose_graph_client

            await asyncio.wait_for(
                aclose_graph_client(self._db, self._pool), timeout=_close_timeout,
            )
            if self._proj_db is not None:
                await asyncio.wait_for(
                    aclose_graph_client(self._proj_db, self._proj_pool),
                    timeout=_close_timeout,
                )
        except Exception as exc:
            logger.warning("Error closing FalkorDB pools: %s", exc)
        finally:
            self._graph = None
            self._proj_graph = None
            self._pool = None
            self._proj_pool = None
            self._redis_pool = None
            self._redis = None
            self._db = None
            self._proj_db = None

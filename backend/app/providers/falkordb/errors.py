"""Connection/cluster error classifiers.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (lines 257-415 as of the package move). Matches
exceptions by name or message rather than isinstance where the underlying
client library is optional at import time, so this module has no hard
dependency on ``redis`` beyond the try/except imports below.
"""
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

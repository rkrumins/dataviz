"""
GraphCache — Redis-backed read-side cache for hot graph endpoints.

The two endpoints `/children-with-edges` and `/edges/aggregated` carry
the bulk of the read load. Each invocation issues a Cypher / GQL query
against FalkorDB or Spanner. Under 100 concurrent users opening the
same view, those endpoints fire identical queries against a graph
provider whose Cypher thread is single-threaded — the documented cause
of 300-400% CPU spikes that lock up the app for everyone.

GraphCache wraps the provider call with two layers of protection:

1. **Redis response cache** keyed by (workspace, data_source, gen,
   endpoint, params_hash). First request computes; the next N within
   the TTL window read from Redis. `gen` is a per-(workspace, ds)
   counter bumped on every write — old cache entries become unreachable
   on the next read and TTL-expire on their own. This sidesteps the
   "two hard problems" of surgical invalidation.

2. **In-process singleflight** keyed by the same cache key. When 50
   concurrent requests inside the same pod ask for the same children,
   only one calls the provider; the rest await the shared Future. This
   protects the provider during the cold-cache window — the moment
   right after a gen bump, after pod start, or after key expiry.

Cross-process singleflight via Redis lease is a Phase 1 spike and
NOT included here. The in-process variant covers same-pod fan-out;
cache-miss compute fan-out is additionally bounded per (provider,
graph) by ``ProviderManager.acquire_provider_slot`` (default 8),
wired around the ``compute`` callables at the endpoint layer in
``graph.py::_bounded_compute`` — per pod, not cross-pod. The
combination is sufficient for the multi-tenant 100-user target
without paying the 1-2 RTT cost of a distributed lock on every
cache miss.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, TypeVar

from pydantic import BaseModel
from redis import asyncio as aioredis
from redis.exceptions import RedisError

from backend.app.services.aggregation.redis_client import get_redis
from backend.common.adapters import ProviderUnavailable

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_KEY_PREFIX = "graphcache:v1"
_GEN_PREFIX = "graphcache:gen"


# ─── env-safe parsing ──────────────────────────────────────────────────
#
# Every cache TTL + size knob below is operator-tunable, but a typo or
# accidental zero/negative in production would either pin entries
# forever (TTL=0 -> Redis SETEX with 0 is rejected; or in our case it
# silently never expires under some interpreters) or instant-evict
# everything. Both modes degrade the system. Routing every env read
# through ``_clamped_int_env`` means an out-of-range override clamps
# to a documented safe bound and logs a WARNING — the app keeps
# running with a sane value instead of breaking on a deploy-time
# config mistake.

def _clamped_int_env(
    name: str, default: int, *, lo: int, hi: int,
) -> int:
    """Parse ``os.getenv(name)`` as an int, falling back to ``default``
    when missing / non-numeric, and clamping to ``[lo, hi]`` otherwise.
    Out-of-range values log at WARNING — they're a deploy-time mistake
    worth surfacing in startup logs."""
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        parsed = int(raw)
    except ValueError:
        logger.warning(
            "graph_cache: %s=%r is not an integer; falling back to default %d",
            name, raw, default,
        )
        return default
    if parsed < lo:
        logger.warning(
            "graph_cache: %s=%d is below safe minimum %d; clamping up",
            name, parsed, lo,
        )
        return lo
    if parsed > hi:
        logger.warning(
            "graph_cache: %s=%d is above safe maximum %d; clamping down",
            name, parsed, hi,
        )
        return hi
    return parsed
# Last-known-good snapshot, gen-less so it survives ``bump_generation``.
# Used only on the stale-fallback path when ``compute()`` raises a
# transient provider error.
_LKG_PREFIX = "graphcache:lkg:v1"

# Per-endpoint TTLs (seconds). Each is operator-tunable inside a safe
# range so a bad env value (typo, zero, huge) can't break the cache.
# Bounds rationale:
#   * lo = 1s — anything shorter is effectively no-cache and would
#     trigger thundering-herd compute on every render.
#   * hi = 1 hour — beyond this, ``bump_generation`` on writes is the
#     only invalidation lever and operators would lose all ability to
#     see fresh data without restarting.
_TTL_LO, _TTL_HI = 1, 3600

_DEFAULT_CHILDREN_TTL = _clamped_int_env("GRAPH_CACHE_CHILDREN_TTL_S", 30, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_AGGREGATED_TTL = _clamped_int_env("GRAPH_CACHE_AGGREGATED_TTL_S", 60, lo=_TTL_LO, hi=_TTL_HI)
# Trace responses are large and expensive; 60s catches repeat navigation
# inside the lineage preview drawer without serving stale data for long.
# The same gen counter (bumped on writes) invalidates trace entries.
_DEFAULT_TRACE_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_TTL_S", 60, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_TRACE_EXPAND_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_EXPAND_TTL_S", 60, lo=_TTL_LO, hi=_TTL_HI)
# Top-level nodes change only when a write inside the workspace shuffles
# containment — gen counter bumps invalidate. Small payloads, hot path.
_DEFAULT_TOP_LEVEL_TTL = _clamped_int_env("GRAPH_CACHE_TOP_LEVEL_TTL_S", 60, lo=_TTL_LO, hi=_TTL_HI)
# Layer assignment is deterministic for a given (ws, ds, request body)
# and touches the same node/edge set as a trace. 60s matches /trace.
_DEFAULT_LAYER_ASSIGNMENT_TTL = _clamped_int_env("GRAPH_CACHE_LAYER_ASSIGNMENT_TTL_S", 60, lo=_TTL_LO, hi=_TTL_HI)
# Short TTL for empty/404 results — absorbs herds asking for the same
# missing URN without committing to caching nonsense for long. Floor of
# 5s keeps the herd-absorption property; ceiling of 5min limits damage
# when a transient miss is overcached.
_NEGATIVE_TTL = _clamped_int_env("GRAPH_CACHE_NEGATIVE_TTL_S", 5, lo=5, hi=300)

# Last-known-good snapshot TTL. The LKG snapshot is the gen-less mirror
# of every successful compute, used as the stale-fallback source when
# the provider is unavailable or times out. 1 day is enough to keep the
# UI responsive across a same-day outage without pinning Redis memory
# for outliers; longer outages are operational problems. Set to 0 to
# disable the LKG mirror entirely (compute failures will then propagate).
# Bounds: 0 (disabled) or [60s, 30d].
_LKG_TTL_RAW = _clamped_int_env("GRAPH_CACHE_LKG_TTL_S", 86400, lo=0, hi=2_592_000)
# 0 means "disabled" — keep it as 0; otherwise clamp the lower bound up
# so a tiny value doesn't make LKG functionally useless.
_LKG_TTL = _LKG_TTL_RAW if _LKG_TTL_RAW == 0 else max(_LKG_TTL_RAW, 60)

# Per-payload size cap. A single response larger than this is logged
# and dropped rather than cached — a 5 MB aggregated-edge dump shouldn't
# crowd out a thousand normal 5 KB entries. Applies to both primary and
# LKG writes. Set to 0 to disable the cap (do not recommend in prod).
# Bounds: 0 (disabled) or [4 KB, 64 MB]. The 64 MB ceiling matches
# Redis's default string-value soft limit.
_MAX_PAYLOAD_BYTES_RAW = _clamped_int_env(
    "GRAPH_CACHE_MAX_PAYLOAD_BYTES", 1_048_576, lo=0, hi=67_108_864,
)
_MAX_PAYLOAD_BYTES = (
    _MAX_PAYLOAD_BYTES_RAW if _MAX_PAYLOAD_BYTES_RAW == 0
    else max(_MAX_PAYLOAD_BYTES_RAW, 4_096)
)

# Per-endpoint kill switches. Default ON: these two endpoints carry the
# bulk of FalkorDB Cypher-thread contention; with the cache off every
# concurrent user issues a duplicate query. Ops can disable per-endpoint
# via env var if a regression is observed.
def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "1" if default else "0").strip().lower()
    return raw in ("1", "true", "yes", "on")

ENDPOINT_CHILDREN = "children-with-edges"
ENDPOINT_AGGREGATED = "aggregated"
ENDPOINT_TRACE = "trace"
ENDPOINT_TRACE_EXPAND = "trace-expand"
ENDPOINT_TOP_LEVEL = "top-level"
ENDPOINT_LAYER_ASSIGNMENT = "layer-assignment"

_ENABLED_ENDPOINTS = {
    ENDPOINT_CHILDREN: _flag("GRAPH_CACHE_ENABLED_CHILDREN", default=True),
    ENDPOINT_AGGREGATED: _flag("GRAPH_CACHE_ENABLED_AGGREGATED", default=True),
    ENDPOINT_TRACE: _flag("GRAPH_CACHE_ENABLED_TRACE", default=True),
    ENDPOINT_TRACE_EXPAND: _flag("GRAPH_CACHE_ENABLED_TRACE_EXPAND", default=True),
    ENDPOINT_TOP_LEVEL: _flag("GRAPH_CACHE_ENABLED_TOP_LEVEL", default=True),
    ENDPOINT_LAYER_ASSIGNMENT: _flag("GRAPH_CACHE_ENABLED_LAYER_ASSIGNMENT", default=True),
}


@dataclass(frozen=True)
class _SingleflightOutcome:
    """Internal sentinel passed through the in-process singleflight Future.

    Wraps the computed value alongside a ``served_stale`` flag so
    *followers* awaiting on ``asyncio.shield(existing)`` learn the
    leader took the stale-fallback path and can invoke their OWN
    ``on_stale`` callback. Without this wrapper only the leader's HTTP
    response carries ``X-Cache-Status: stale-fallback``; followers would
    silently return stale data and the frontend banner would misfire
    on every concurrent request after the first.
    """
    value: Any
    served_stale: bool


@dataclass(frozen=True)
class CacheScope:
    """Identifies the (workspace, data_source) the cache entry belongs to.

    workspace_id is required — multi-tenant correctness depends on it.
    data_source_id is optional because some workspaces have a default
    data source resolved server-side; we coerce missing to the literal
    empty string so the key is stable across requests that omit it.
    branch_id scopes the entry to a draft so a draft read can never be
    served to main (or vice-versa); empty string = main.
    """
    workspace_id: str
    data_source_id: str = ""
    branch_id: str = ""


class GraphCache:
    """Singleton cache wrapper. Get the instance via `get_graph_cache()`."""

    def __init__(self, redis: aioredis.Redis) -> None:
        self._redis = redis
        # In-process singleflight: key → Future holding the computed result.
        # Concurrent callers awaiting an in-flight future read the same
        # answer with no extra provider work.
        self._inflight: dict[str, asyncio.Future[Any]] = {}

    # ─── Public surface ───────────────────────────────────────────────

    def is_enabled(self, endpoint: str) -> bool:
        """Per-endpoint feature flag check. Cheap; no Redis I/O."""
        return _ENABLED_ENDPOINTS.get(endpoint, False)

    async def get_or_compute(
        self,
        scope: CacheScope,
        endpoint: str,
        params: dict[str, Any],
        compute: Callable[[], Awaitable[T]],
        model_cls: type[T],
        ttl_seconds: Optional[int] = None,
        on_stale: Optional[Callable[[], None]] = None,
    ) -> T:
        """Fetch from cache, falling back to `compute()` on miss.

        The result of `compute()` MUST be a Pydantic v2 model instance
        (we serialize via `model_dump_json` for stable, schema-aware
        round-tripping). On any Redis error we fall through to direct
        provider compute — the cache must never become a hard dependency.

        Stale-on-error: if ``compute()`` raises ``ProviderUnavailable``
        (breaker open / load-shed) or ``asyncio.TimeoutError`` (per-op
        deadline fired), the last-known-good snapshot is served instead
        when one is available. ``on_stale`` is invoked when this fallback
        fires so the caller can flag the response (e.g. set an
        ``X-Cache-Status: stale-fallback`` header). The fallback path
        does NOT engage on logical errors (validation, 4xx) — those
        propagate immediately because they don't represent provider
        unavailability.
        """
        if not self.is_enabled(endpoint):
            return await compute()

        try:
            gen = await self._get_generation(scope)
            cache_key = _build_key(scope, gen, endpoint, params)
        except RedisError as exc:
            logger.warning("graph_cache: gen read failed (%s); bypassing cache", exc)
            return await compute()

        # ── 1. Redis cache lookup ─────────────────────────────────────
        try:
            cached = await self._redis.get(cache_key)
        except RedisError as exc:
            logger.warning("graph_cache: GET failed (%s); bypassing cache", exc)
            return await compute()

        if cached is not None:
            try:
                return model_cls.model_validate_json(cached)
            except Exception as exc:
                # Bad payload (schema drift?) — log and treat as miss. The
                # offending key will be overwritten by the compute below.
                logger.warning(
                    "graph_cache: deserialize failed for %s (%s); recomputing",
                    cache_key, exc,
                )

        # ── 2. In-process singleflight ────────────────────────────────
        # Coalesce concurrent callers in this pod. Outside-pod fan-out is
        # bounded by the provider semaphore, so this is sufficient at our
        # current scale. The future carries a ``_SingleflightOutcome`` so
        # followers learn whether the leader served the stale-fallback
        # path and can fire their own ``on_stale`` callback.
        existing = self._inflight.get(cache_key)
        if existing is not None:
            try:
                outcome: _SingleflightOutcome = await asyncio.shield(existing)
                if outcome.served_stale and on_stale is not None:
                    try:
                        on_stale()
                    except Exception as cb_exc:  # pragma: no cover
                        logger.warning("graph_cache: on_stale callback raised: %s", cb_exc)
                return outcome.value
            except Exception:
                # Leader failed — fall through to recompute below.
                pass

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[_SingleflightOutcome] = loop.create_future()
        self._inflight[cache_key] = fut
        try:
            result = await compute()
            await self._set(cache_key, result, ttl_seconds, endpoint)
            await self._set_lkg(scope, endpoint, params, result)
            if not fut.done():
                fut.set_result(_SingleflightOutcome(value=result, served_stale=False))
            return result
        except (ProviderUnavailable, asyncio.TimeoutError) as exc:
            # Provider can't answer right now. Fall through to the
            # last-known-good snapshot if we have one — better to show
            # users slightly stale data with a banner than a hard error.
            stale = await self._get_lkg(scope, endpoint, params, model_cls)
            if stale is not None:
                logger.info(
                    "graph_cache: serving stale LKG for %s/%s after %s",
                    endpoint, scope, type(exc).__name__,
                )
                if on_stale is not None:
                    try:
                        on_stale()
                    except Exception as cb_exc:  # pragma: no cover
                        logger.warning("graph_cache: on_stale callback raised: %s", cb_exc)
                if not fut.done():
                    # served_stale=True so followers awaiting via
                    # ``shield(existing)`` invoke their own on_stale.
                    fut.set_result(_SingleflightOutcome(value=stale, served_stale=True))
                return stale
            # No fallback available — propagate.
            if not fut.done():
                fut.set_exception(exc)
            raise
        except Exception as exc:
            if not fut.done():
                fut.set_exception(exc)
            raise
        finally:
            self._inflight.pop(cache_key, None)

    async def bump_generation(self, scope: CacheScope) -> None:
        """Invalidate every cached entry under `scope` by bumping the
        per-scope generation counter. Old keys become unreachable on the
        next read and TTL-expire on their own — no SCAN/DEL needed.

        Safe to call from a write path even with the cache feature flag
        off; INCR on a non-existent key just starts it at 1.
        """
        try:
            await self._redis.incr(_gen_key(scope))
        except RedisError as exc:
            logger.warning(
                "graph_cache: generation bump failed for %s (%s); "
                "stale entries may persist until TTL expiry",
                scope, exc,
            )

    async def purge_lkg(self, scope: CacheScope, endpoint: str) -> int:
        """Delete the last-known-good entries for ``scope`` + ``endpoint``
        (every branch). LKG keys deliberately SURVIVE ``bump_generation``
        — they are the outage fallback — so an event that rewrites the
        underlying data (an aggregation run completing) must purge them
        explicitly, or degraded reads keep serving pre-run answers for
        up to the LKG TTL after the graph changed. Bounded SCAN, never
        KEYS."""
        pattern = (
            f"{_LKG_PREFIX}:{scope.workspace_id}:{scope.data_source_id}"
            f":*:{endpoint}:*"
        )
        removed = 0
        try:
            cursor = 0
            while True:
                cursor, keys = await self._redis.scan(
                    cursor=cursor, match=pattern, count=500,
                )
                if keys:
                    removed += int(await self._redis.delete(*keys) or 0)
                if not cursor:
                    break
        except RedisError as exc:
            logger.warning(
                "graph_cache: LKG purge failed for %s/%s (%s); stale "
                "last-known-good entries may persist until TTL expiry",
                scope, endpoint, exc,
            )
        return removed

    # ─── Internals ────────────────────────────────────────────────────

    async def _get_generation(self, scope: CacheScope) -> int:
        """Read the current generation counter for `scope`. Returns 0
        when never set (which yields a stable initial key)."""
        raw = await self._redis.get(_gen_key(scope))
        if raw is None:
            return 0
        try:
            return int(raw)
        except (TypeError, ValueError):
            # Garbage in the counter slot — treat as fresh epoch. Don't
            # try to repair: write paths will overwrite via INCR.
            return 0

    async def _set(
        self,
        cache_key: str,
        result: BaseModel,
        ttl_seconds: Optional[int],
        endpoint: str,
    ) -> None:
        """Serialize and persist `result`. Failures are swallowed — the
        compute already succeeded, so failing the response on a write
        error would be a self-inflicted regression."""
        ttl = _resolve_ttl(ttl_seconds, endpoint)
        if _is_empty_result(result):
            ttl = _NEGATIVE_TTL
        try:
            payload = result.model_dump_json(by_alias=True)
            if _MAX_PAYLOAD_BYTES > 0 and len(payload) > _MAX_PAYLOAD_BYTES:
                logger.warning(
                    "graph_cache: payload_too_large endpoint=%s key=%s size=%d cap=%d (skipping cache write)",
                    endpoint, cache_key, len(payload), _MAX_PAYLOAD_BYTES,
                )
                return
            await self._redis.set(cache_key, payload, ex=ttl)
        except (RedisError, Exception) as exc:
            logger.warning("graph_cache: SET failed (%s)", exc)

    async def _set_lkg(
        self,
        scope: CacheScope,
        endpoint: str,
        params: dict[str, Any],
        result: BaseModel,
    ) -> None:
        """Mirror a successful compute into the gen-less LKG snapshot.

        Skipped for empty results — a transient empty answer must not
        pin "empty" as the stale fallback during a future outage. Skipped
        when ``_LKG_TTL`` is 0 (operator-disabled). Failures are
        swallowed for the same reason as ``_set``.
        """
        if _LKG_TTL <= 0:
            return
        if _is_empty_result(result):
            return
        try:
            payload = result.model_dump_json(by_alias=True)
            if _MAX_PAYLOAD_BYTES > 0 and len(payload) > _MAX_PAYLOAD_BYTES:
                # Already logged at WARNING in _set for the primary key;
                # the LKG mirror is dropped silently to avoid double-noise.
                return
            await self._redis.set(_build_lkg_key(scope, endpoint, params), payload, ex=_LKG_TTL)
        except (RedisError, Exception) as exc:
            logger.warning("graph_cache: LKG SET failed (%s)", exc)

    async def _get_lkg(
        self,
        scope: CacheScope,
        endpoint: str,
        params: dict[str, Any],
        model_cls: type[T],
    ) -> Optional[T]:
        """Read the gen-less LKG snapshot. Returns ``None`` on miss,
        bad payload, disabled LKG, or Redis error — the caller treats
        ``None`` as "no fallback available" and re-raises the original
        provider exception."""
        if _LKG_TTL <= 0:
            return None
        try:
            raw = await self._redis.get(_build_lkg_key(scope, endpoint, params))
        except RedisError as exc:
            logger.warning("graph_cache: LKG GET failed (%s)", exc)
            return None
        if raw is None:
            return None
        try:
            return model_cls.model_validate_json(raw)
        except Exception as exc:
            logger.warning("graph_cache: LKG deserialize failed (%s)", exc)
            return None


# ─── Module-level helpers ──────────────────────────────────────────────

def _gen_key(scope: CacheScope) -> str:
    return f"{_GEN_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}"


def _build_key(scope: CacheScope, gen: int, endpoint: str, params: dict[str, Any]) -> str:
    """Build a cache key. We hash params (not raw-include them) so the
    key length is bounded — `params` for /edges/aggregated can carry
    thousands of source URNs."""
    digest = hashlib.sha1(
        json.dumps(params, sort_keys=True, default=str).encode("utf-8"),
    ).hexdigest()
    return f"{_KEY_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}:{gen}:{endpoint}:{digest}"


def _build_lkg_key(scope: CacheScope, endpoint: str, params: dict[str, Any]) -> str:
    """Last-known-good key: identical to the primary key shape minus
    the generation component, so the LKG survives ``bump_generation``
    invalidations. Same params hash so a write to the primary cache
    always has a matching LKG slot."""
    digest = hashlib.sha1(
        json.dumps(params, sort_keys=True, default=str).encode("utf-8"),
    ).hexdigest()
    return f"{_LKG_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}:{endpoint}:{digest}"


def _resolve_ttl(explicit: Optional[int], endpoint: str) -> int:
    if explicit is not None:
        return explicit
    if endpoint == ENDPOINT_CHILDREN:
        return _DEFAULT_CHILDREN_TTL
    if endpoint == ENDPOINT_AGGREGATED:
        return _DEFAULT_AGGREGATED_TTL
    if endpoint == ENDPOINT_TRACE:
        return _DEFAULT_TRACE_TTL
    if endpoint == ENDPOINT_TRACE_EXPAND:
        return _DEFAULT_TRACE_EXPAND_TTL
    if endpoint == ENDPOINT_TOP_LEVEL:
        return _DEFAULT_TOP_LEVEL_TTL
    if endpoint == ENDPOINT_LAYER_ASSIGNMENT:
        return _DEFAULT_LAYER_ASSIGNMENT_TTL
    return _DEFAULT_CHILDREN_TTL


def _is_empty_result(result: BaseModel) -> bool:
    """Detect "empty" responses worth caching only briefly. Currently:
    a ChildrenWithEdgesResult with no children, an AggregatedEdgeResult
    with no aggregated edges, or a TraceResult with no nodes. Returning
    True shortens the TTL to the negative-cache window so a transient
    miss doesn't pin the empty answer for 30-60s."""
    children = getattr(result, "children", None)
    if isinstance(children, list) and len(children) == 0:
        return True
    aggregated = getattr(result, "aggregated_edges", None)
    if isinstance(aggregated, list) and len(aggregated) == 0:
        return True
    # TraceResult: nodes list. An empty trace ("focus URN found nothing")
    # is a transient state we don't want to pin under TTL.
    nodes = getattr(result, "nodes", None)
    if isinstance(nodes, list) and len(nodes) == 0:
        return True
    return False


async def invalidate_aggregated_reads(
    workspace_id: str, data_source_id: str,
) -> None:
    """THE invalidation choke point for the :AGGREGATED read caches.

    Call after ANY event that changes what the aggregated endpoints
    should answer — an aggregation run completing (or dying mid-write),
    a purge, a skip. Bumps the scoped generation (unreaches every
    primary entry) AND purges the last-known-good entries — LKG keys
    survive generation bumps by design (they are the outage fallback),
    which is exactly how a purge stayed invisible: the primary entries
    expired in 60s but every degraded read kept serving the pre-purge
    LKG answer for up to its TTL. Best-effort: never raises.
    """
    if not workspace_id or not data_source_id:
        return
    try:
        cache = get_graph_cache()
        scope = CacheScope(
            workspace_id=str(workspace_id),
            data_source_id=str(data_source_id),
            branch_id="",
        )
        await cache.bump_generation(scope)
        removed = await cache.purge_lkg(scope, ENDPOINT_AGGREGATED)
        logger.info(
            "aggregated-read caches invalidated for %s/%s (%d LKG purged)",
            workspace_id, data_source_id, removed,
        )
    except Exception as exc:
        logger.warning(
            "aggregated-read cache invalidation failed for %s/%s: %s",
            workspace_id, data_source_id, exc,
        )


# ─── Singleton accessor ────────────────────────────────────────────────

_cache: Optional[GraphCache] = None


def get_graph_cache() -> GraphCache:
    """Return the process-wide GraphCache. Lazy-initialised on first use
    so test code can patch `get_redis()` before this fires."""
    global _cache
    if _cache is None:
        _cache = GraphCache(get_redis())
    return _cache


def reset_graph_cache_for_tests() -> None:
    """Drop the singleton so a fresh fixture can install its own."""
    global _cache
    _cache = None

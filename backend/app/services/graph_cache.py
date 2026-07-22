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
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, Sequence, TypeVar

from pydantic import BaseModel
from redis import asyncio as aioredis
from redis.exceptions import RedisError

from backend.app.services.aggregation.redis_client import get_redis
from backend.common.adapters import ProviderUnavailable

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_KEY_PREFIX = "graphcache:v1"
_GEN_PREFIX = "graphcache:gen"
# Cache-as-of stamp: the ISO timestamp of the last generation bump for a
# scope — the OPS Freshness Cockpit's "as of" signal for cached reads.
# Written alongside the generation counter in bump_generation(s); read via
# get_cache_as_of(). Best-effort, same fail-open conventions as the rest
# of this module.
_GENAT_PREFIX = "graphcache:genat"


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
#
# The long defaults below (5-15 min, up from 30-60s) are SAFE ONLY
# BECAUSE every APP write path bumps the per-scope generation counter
# (``bump_generation`` from ``_invalidate_cache`` on node/edge/draft
# writes, merges, projection, purge) — a bumped generation makes every
# prior cache key unreachable immediately, so a long TTL never serves
# past an edit. The freshness win: a canvas gesture (bootstrap/expand/
# children/aggregated) repeats the exact same request until the next
# write, so a 15-min TTL turns every repeat into a Redis hit instead of
# a FalkorDB round-trip — which is also the main relief valve against
# the read-saturation cascade (fewer cache misses = fewer chances to
# peg FalkorDB's worker threads).
# CAVEAT: writes that BYPASS the app (redis-cli, a direct GRAPH.QUERY,
# an external ingest not routed through the write endpoints) do NOT
# bump the generation and will be masked for up to the TTL. Route bulk
# mutations through the app, or bump the generation manually.
_TTL_LO, _TTL_HI = 1, 3600

_DEFAULT_CHILDREN_TTL = _clamped_int_env("GRAPH_CACHE_CHILDREN_TTL_S", 900, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_AGGREGATED_TTL = _clamped_int_env("GRAPH_CACHE_AGGREGATED_TTL_S", 900, lo=_TTL_LO, hi=_TTL_HI)
# Trace responses are large and expensive; 60s catches repeat navigation
# inside the lineage preview drawer without serving stale data for long.
# The same gen counter (bumped on writes) invalidates trace entries.
_DEFAULT_TRACE_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_TRACE_EXPAND_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_EXPAND_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
# Top-level nodes change only when a write inside the workspace shuffles
# containment — gen counter bumps invalidate. Small payloads, hot path.
_DEFAULT_TOP_LEVEL_TTL = _clamped_int_env("GRAPH_CACHE_TOP_LEVEL_TTL_S", 600, lo=_TTL_LO, hi=_TTL_HI)
# Layer assignment is deterministic for a given (ws, ds, request body)
# and touches the same node/edge set as a trace. 60s matches /trace.
_DEFAULT_LAYER_ASSIGNMENT_TTL = _clamped_int_env("GRAPH_CACHE_LAYER_ASSIGNMENT_TTL_S", 900, lo=_TTL_LO, hi=_TTL_HI)
# Batched canvas contract (open/expand). These compose top-level +
# aggregated + children into one entry; a canvas gesture repeats the
# exact same request until a write bumps the generation, so a longer
# TTL amortises the whole bootstrap/expand cost. gen-bump keeps them
# fresh on edits.
_DEFAULT_CANVAS_BOOTSTRAP_TTL = _clamped_int_env("GRAPH_CACHE_CANVAS_BOOTSTRAP_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_CANVAS_EXPAND_TTL = _clamped_int_env("GRAPH_CACHE_CANVAS_EXPAND_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
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
# Key namespace for the top-level *total count* side-cache (a bare int,
# not a response payload). Not in _ENABLED_ENDPOINTS — it shares the
# ENDPOINT_TOP_LEVEL feature flag.
ENDPOINT_TOP_LEVEL_COUNT = "top-level-count"
ENDPOINT_LAYER_ASSIGNMENT = "layer-assignment"
ENDPOINT_CANVAS_BOOTSTRAP = "canvas-bootstrap"
ENDPOINT_CANVAS_EXPAND = "canvas-expand"
ENDPOINT_EDGES_BETWEEN = "edges-between"
ENDPOINT_NODES_QUERY = "nodes-query"

_ENABLED_ENDPOINTS = {
    ENDPOINT_CHILDREN: _flag("GRAPH_CACHE_ENABLED_CHILDREN", default=True),
    ENDPOINT_AGGREGATED: _flag("GRAPH_CACHE_ENABLED_AGGREGATED", default=True),
    ENDPOINT_TRACE: _flag("GRAPH_CACHE_ENABLED_TRACE", default=True),
    ENDPOINT_TRACE_EXPAND: _flag("GRAPH_CACHE_ENABLED_TRACE_EXPAND", default=True),
    ENDPOINT_TOP_LEVEL: _flag("GRAPH_CACHE_ENABLED_TOP_LEVEL", default=True),
    ENDPOINT_LAYER_ASSIGNMENT: _flag("GRAPH_CACHE_ENABLED_LAYER_ASSIGNMENT", default=True),
    ENDPOINT_CANVAS_BOOTSTRAP: _flag("GRAPH_CACHE_ENABLED_CANVAS_BOOTSTRAP", default=True),
    ENDPOINT_CANVAS_EXPAND: _flag("GRAPH_CACHE_ENABLED_CANVAS_EXPAND", default=True),
    ENDPOINT_EDGES_BETWEEN: _flag("GRAPH_CACHE_ENABLED_EDGES_BETWEEN", default=True),
    ENDPOINT_NODES_QUERY: _flag("GRAPH_CACHE_ENABLED_NODES_QUERY", default=True),
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

    graph_ns identifies the PHYSICAL FalkorDB graph (host:port:graph_name,
    hashed — see ``graph_ns_hash``) behind this data source, mirroring the
    provider content caches' own ``_cache_ns`` (falkordb_provider.py). A
    data source id is stable even when re-pointed to a different physical
    graph; without graph_ns, a re-point could serve a stale response cached
    under the old graph until the next write's generation bump. Optional
    and defaulted to "" (unknown/unresolvable) so the many call sites that
    build a CacheScope with no live engine/provider (service-layer
    invalidation, tests) stay valid — see ``_build_key``/``_build_lkg_key``
    for how "" degrades to today's ds-only key shape.
    """
    workspace_id: str
    data_source_id: str = ""
    branch_id: str = ""
    graph_ns: str = ""


class GraphCache:
    """Singleton cache wrapper. Get the instance via `get_graph_cache()`."""

    def __init__(
        self, redis: aioredis.Redis, cache_redis: Optional[aioredis.Redis] = None,
    ) -> None:
        # Durable, shared client — COORDINATION only: the generation
        # counter, the genat cache-as-of stamp, and the aggstale markers.
        # Never the CACHE role — this repo's agg:members ledger-corruption
        # lesson: eviction of a lossy cache Redis must not lose
        # coordination state (spec §10b).
        self._coord_redis = redis
        # Response-cache PAYLOADS + LKG snapshots. Resolved by the caller
        # via the CACHE role (REDIS_CACHE_*) with a fallback to the shared
        # client baked in — so when no dedicated client is supplied (every
        # existing call site/test), this is the SAME client as
        # ``_coord_redis`` and behavior is byte-identical to today's
        # single-client cache.
        self._cache_redis = cache_redis if cache_redis is not None else redis
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
            cached = await self._cache_redis.get(cache_key)
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

    async def get_top_level_count(
        self, scope: CacheScope, params: dict[str, Any],
    ) -> Optional[int]:
        """Read the cached top-level total count for ``scope`` + filter
        ``params``. Keyed WITHOUT cursor/limit so every page of the same
        filtered listing reuses one count; generation-keyed so write-path
        ``bump_generation`` invalidates it for free. Best-effort: any
        Redis error reads as a miss."""
        if not self.is_enabled(ENDPOINT_TOP_LEVEL):
            return None
        try:
            gen = await self._get_generation(scope)
            raw = await self._cache_redis.get(
                _build_key(scope, gen, ENDPOINT_TOP_LEVEL_COUNT, params)
            )
            return int(raw) if raw is not None else None
        except (RedisError, TypeError, ValueError) as exc:
            logger.warning("graph_cache: top-level count read failed (%s)", exc)
            return None

    async def set_top_level_count(
        self, scope: CacheScope, params: dict[str, Any], value: int,
    ) -> None:
        """Store a successfully computed top-level total count. Same TTL
        as the top-level response cache. Best-effort no-op on error."""
        if not self.is_enabled(ENDPOINT_TOP_LEVEL):
            return
        try:
            gen = await self._get_generation(scope)
            await self._cache_redis.set(
                _build_key(scope, gen, ENDPOINT_TOP_LEVEL_COUNT, params),
                str(int(value)),
                ex=_DEFAULT_TOP_LEVEL_TTL,
            )
        except (RedisError, TypeError, ValueError) as exc:
            logger.warning("graph_cache: top-level count write failed (%s)", exc)

    async def bump_generation(self, scope: CacheScope) -> None:
        """Invalidate every cached entry under `scope` by bumping the
        per-scope generation counter. Old keys become unreachable on the
        next read and TTL-expire on their own — no SCAN/DEL needed.

        Safe to call from a write path even with the cache feature flag
        off; INCR on a non-existent key just starts it at 1.
        """
        try:
            await self._coord_redis.incr(_gen_key(scope))
            await self._coord_redis.set(
                _genat_key(scope), datetime.now(timezone.utc).isoformat(),
            )
        except RedisError as exc:
            logger.warning(
                "graph_cache: generation bump failed for %s (%s); "
                "stale entries may persist until TTL expiry",
                scope, exc,
            )

    async def bump_generations(self, scopes: Sequence[CacheScope]) -> None:
        """Bulk :meth:`bump_generation` — one pipelined round-trip for many
        scopes. Ontology writers (publish/update/import…) invalidate every
        assigned data source at once; N awaited INCRs made that O(N) in
        Redis round-trips (the publish 30s-hang bug)."""
        if not scopes:
            return
        try:
            pipe = self._coord_redis.pipeline(transaction=False)
            now_iso = datetime.now(timezone.utc).isoformat()
            for scope in scopes:
                pipe.incr(_gen_key(scope))
                pipe.set(_genat_key(scope), now_iso)
            await pipe.execute()
        except RedisError as exc:
            logger.warning(
                "graph_cache: bulk generation bump failed for %d scopes (%s); "
                "stale entries may persist until TTL expiry",
                len(scopes), exc,
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
                cursor, keys = await self._cache_redis.scan(
                    cursor=cursor, match=pattern, count=500,
                )
                if keys:
                    removed += int(await self._cache_redis.delete(*keys) or 0)
                if not cursor:
                    break
        except RedisError as exc:
            logger.warning(
                "graph_cache: LKG purge failed for %s/%s (%s); stale "
                "last-known-good entries may persist until TTL expiry",
                scope, endpoint, exc,
            )
        return removed

    async def purge_lkg_scope(
        self, scope: CacheScope, *, exclude_endpoint: Optional[str] = None,
    ) -> int:
        """Delete the last-known-good entries for ``scope`` across EVERY
        endpoint (every branch) — the hierarchy-invalidation counterpart to
        :meth:`purge_lkg`, which is scoped to one endpoint. ``exclude_endpoint``
        carves out one endpoint's LKG (the aggregated mirror, kept as the
        stale-while-revalidate fallback until its own rebuild completes).
        Bounded SCAN, never KEYS."""
        pattern = f"{_LKG_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:*"
        removed = 0
        try:
            cursor = 0
            while True:
                cursor, keys = await self._cache_redis.scan(
                    cursor=cursor, match=pattern, count=500,
                )
                if exclude_endpoint is not None:
                    keys = [k for k in keys if f":{exclude_endpoint}:" not in k]
                if keys:
                    removed += int(await self._cache_redis.delete(*keys) or 0)
                if not cursor:
                    break
        except RedisError as exc:
            logger.warning(
                "graph_cache: LKG scope purge failed for %s (%s); stale "
                "last-known-good entries may persist until TTL expiry",
                scope, exc,
            )
        return removed

    # ─── Internals ────────────────────────────────────────────────────

    async def _get_generation(self, scope: CacheScope) -> int:
        """Read the current generation counter for `scope`. Returns 0
        when never set (which yields a stable initial key)."""
        raw = await self._coord_redis.get(_gen_key(scope))
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
        elif _is_incomplete_result(result):
            ttl = _NEGATIVE_TTL
        try:
            payload = result.model_dump_json(by_alias=True)
            if _MAX_PAYLOAD_BYTES > 0 and len(payload) > _MAX_PAYLOAD_BYTES:
                logger.warning(
                    "graph_cache: payload_too_large endpoint=%s key=%s size=%d cap=%d (dropping stale entry + skipping cache write)",
                    endpoint, cache_key, len(payload), _MAX_PAYLOAD_BYTES,
                )
                await self._cache_redis.delete(cache_key)
                return
            await self._cache_redis.set(cache_key, payload, ex=ttl)
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
        for incomplete (truncated/stale) results — a degraded snapshot
        must not become the outage fallback either. Skipped when
        ``_LKG_TTL`` is 0 (operator-disabled). Failures are swallowed for
        the same reason as ``_set``.
        """
        if _LKG_TTL <= 0:
            return
        if _is_empty_result(result):
            return
        if _is_incomplete_result(result):
            return
        try:
            payload = result.model_dump_json(by_alias=True)
            if _MAX_PAYLOAD_BYTES > 0 and len(payload) > _MAX_PAYLOAD_BYTES:
                # Already logged at WARNING in _set for the primary key;
                # the stale mirror is dropped here deliberately (log-silent
                # to avoid double-noise) — an outage fallback that no
                # longer matches reality is worse than none.
                await self._cache_redis.delete(_build_lkg_key(scope, endpoint, params))
                return
            await self._cache_redis.set(_build_lkg_key(scope, endpoint, params), payload, ex=_LKG_TTL)
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
            raw = await self._cache_redis.get(_build_lkg_key(scope, endpoint, params))
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
    # Deliberately NOT graph_ns-scoped: invalidation is by gen-bump (this
    # key) + prefix SCAN (purge_lkg), both of which must cover every
    # physical-graph variant of a (ws, ds) — a re-point's stale entries
    # under the OLD graph_ns still need to die on the next write. Only the
    # exact read/write key (_build_key/_build_lkg_key) needs graph_ns, to
    # stop a re-point from serving the wrong graph's cached response
    # before the next gen-bump.
    return f"{_GEN_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}"


def _genat_key(scope: CacheScope) -> str:
    # (ws, ds)-scoped coordination, same rationale as _gen_key above.
    return f"{_GENAT_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}"


def graph_ns_hash(physical_graph_id: str) -> str:
    """Hash a physical-graph identity (``host:port:graph_name``) into a
    bounded cache-key segment for ``CacheScope.graph_ns``. Mirrors the
    provider content caches' ``_cache_ns`` identity triple
    (falkordb_provider.py) but hashed + truncated to keep the key bounded,
    same rationale as the params digest below. The ONE place this hashing
    happens — callers that resolve the (host, port, graph_name) triple
    (e.g. the endpoint layer's ``_cache_scope``) pass the raw string here
    rather than hashing it themselves."""
    return hashlib.sha1(physical_graph_id.encode("utf-8")).hexdigest()[:16]


def _build_key(scope: CacheScope, gen: int, endpoint: str, params: dict[str, Any]) -> str:
    """Build a cache key. We hash params (not raw-include them) so the
    key length is bounded — `params` for /edges/aggregated can carry
    thousands of source URNs.

    ``graph_ns`` (when resolved) is appended as a trailing segment so the
    same (workspace, data_source, branch, gen) can never collide across
    two distinct physical FalkorDB graphs — see CacheScope's docstring.
    Appending after the digest (rather than inserting earlier) keeps
    ``count_cache_keys_by_endpoint``'s fixed-index endpoint parse intact,
    and means graph_ns="" (unresolved/legacy callers) produces EXACTLY
    today's key — full back-compat.
    """
    digest = hashlib.sha1(
        json.dumps(params, sort_keys=True, default=str).encode("utf-8"),
    ).hexdigest()
    key = f"{_KEY_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}:{gen}:{endpoint}:{digest}"
    if scope.graph_ns:
        key = f"{key}:{scope.graph_ns}"
    return key


def _build_lkg_key(scope: CacheScope, endpoint: str, params: dict[str, Any]) -> str:
    """Last-known-good key: identical to the primary key shape minus
    the generation component, so the LKG survives ``bump_generation``
    invalidations. Same params hash so a write to the primary cache
    always has a matching LKG slot. ``graph_ns`` handling mirrors
    ``_build_key`` (trailing segment, "" = today's exact shape)."""
    digest = hashlib.sha1(
        json.dumps(params, sort_keys=True, default=str).encode("utf-8"),
    ).hexdigest()
    key = f"{_LKG_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}:{endpoint}:{digest}"
    if scope.graph_ns:
        key = f"{key}:{scope.graph_ns}"
    return key


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
    if endpoint == ENDPOINT_CANVAS_BOOTSTRAP:
        return _DEFAULT_CANVAS_BOOTSTRAP_TTL
    if endpoint == ENDPOINT_CANVAS_EXPAND:
        return _DEFAULT_CANVAS_EXPAND_TTL
    if endpoint in (ENDPOINT_EDGES_BETWEEN, ENDPOINT_NODES_QUERY):
        # Hydration reads — same gen-bump invalidation, same freshness as
        # children; a canvas re-open repeats the identical URN set.
        return _DEFAULT_CHILDREN_TTL
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


def _is_incomplete_result(result: BaseModel) -> bool:
    """Truncated/degraded/stale results must not be pinned for the full
    TTL as if they were complete — cache them only for the negative
    window. Checks the result itself and its nested AggregatedEdgeResult
    payloads: ``aggregated`` (canvas bootstrap) and ``aggregated_delta``
    (canvas expand)."""
    for obj in (
        result,
        getattr(result, "aggregated", None),
        getattr(result, "aggregated_delta", None),
    ):
        if obj is not None and (getattr(obj, "truncated", False) or getattr(obj, "stale", False)):
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


async def invalidate_hierarchy_reads(
    workspace_id: str, data_source_id: str,
) -> Optional[int]:
    """Invalidate the hierarchy read caches (children, top-level, trace,
    layer-assignment, canvas, …) after an event that changed the
    underlying graph — e.g. an external load that wrote FalkorDB directly,
    bypassing the app's own write paths and their per-write generation
    bumps.

    Bumps the scope-wide generation, which makes every endpoint's primary
    cache entries unreachable; hierarchy endpoints read the live graph on
    a miss, so they converge on the very next read. The aggregated LKG
    mirror is deliberately KEPT (not purged here) — mid-rebuild it still
    matches the live overlay and is the best degraded-read answer
    available; :func:`invalidate_aggregated_reads` purges it once the
    aggregation rebuild completes. Best-effort: never raises.

    Returns the non-aggregated LKG entry count purged, or ``None`` if
    skipped (missing ids) or the invalidation itself failed — callers
    that need to know whether the generation bump actually happened
    (e.g. audit recording) can treat ``None`` as "didn't run".
    """
    if not workspace_id or not data_source_id:
        return None
    try:
        cache = get_graph_cache()
        scope = CacheScope(
            workspace_id=str(workspace_id),
            data_source_id=str(data_source_id),
            branch_id="",
        )
        await cache.bump_generation(scope)
        removed = await cache.purge_lkg_scope(scope, exclude_endpoint=ENDPOINT_AGGREGATED)
        logger.info(
            "hierarchy-read caches invalidated for %s/%s (%d non-aggregated LKG purged)",
            workspace_id, data_source_id, removed,
        )
        return removed
    except Exception as exc:
        logger.warning(
            "hierarchy-read cache invalidation failed for %s/%s: %s",
            workspace_id, data_source_id, exc,
        )
        return None


# ─── Stale-source marker (stale-while-revalidate flag) ─────────────────

_STALE_PREFIX = "aggstale:v1"      # key: aggstale:v1:{ws}:{ds}; value = reason string
_STALE_TTL_S = 7 * 86400           # backstop only; cleared explicitly on job.completed


def _stale_key(workspace_id: str, data_source_id: str) -> str:
    return f"{_STALE_PREFIX}:{workspace_id}:{data_source_id}"


async def mark_source_stale(
    workspace_id: str, data_source_id: str, reason: str = "source_changed",
) -> None:
    """Set the stale-while-revalidate flag for a data source: its
    underlying graph changed and a rebuild is queued. Read by the
    aggregated/canvas read paths post-cache, so even a cached hit gets
    flagged as stale to the caller. Cleared by the aggregation event
    listener on ``job.completed``. ``_STALE_TTL_S`` is a backstop only —
    a dropped completion event doesn't strand the flag forever.
    Best-effort: never raises."""
    ws, ds = str(workspace_id), str(data_source_id)
    if not ws or not ds:
        return
    try:
        cache = get_graph_cache()
        await cache._coord_redis.set(_stale_key(ws, ds), reason, ex=_STALE_TTL_S)
    except Exception as exc:
        logger.warning(
            "graph_cache: mark_source_stale failed for %s/%s: %s", ws, ds, exc,
        )


async def clear_source_stale(workspace_id: str, data_source_id: str) -> None:
    """Clear the stale-while-revalidate flag once the queued rebuild
    completes. Best-effort: never raises."""
    ws, ds = str(workspace_id), str(data_source_id)
    if not ws or not ds:
        return
    try:
        cache = get_graph_cache()
        await cache._coord_redis.delete(_stale_key(ws, ds))
    except Exception as exc:
        logger.warning(
            "graph_cache: clear_source_stale failed for %s/%s: %s", ws, ds, exc,
        )


async def get_source_stale_reason(
    workspace_id: str, data_source_id: str,
) -> Optional[str]:
    """Read the stale-while-revalidate reason for a data source. Returns
    ``None`` when not stale, on empty ids, or on any Redis error — this
    runs on the read path post-cache, so a Redis hiccup must degrade to
    "not stale" rather than blocking the response. Best-effort: never
    raises."""
    ws, ds = str(workspace_id), str(data_source_id)
    if not ws or not ds:
        return None
    try:
        cache = get_graph_cache()
        return await cache._coord_redis.get(_stale_key(ws, ds))
    except Exception as exc:
        logger.warning(
            "graph_cache: get_source_stale_reason failed for %s/%s: %s", ws, ds, exc,
        )
        return None


async def get_cache_as_of(
    workspace_id: str, data_source_id: str, branch_id: str = "",
) -> Optional[str]:
    """Read the cache-as-of stamp — the ISO timestamp of the last
    ``bump_generation``/``bump_generations`` call for this scope. Returns
    ``None`` on empty ids, cache miss, or any Redis error; this is a
    best-effort freshness signal for the OPS Freshness Cockpit, never a
    hard dependency."""
    ws, ds = str(workspace_id), str(data_source_id)
    if not ws or not ds:
        return None
    try:
        cache = get_graph_cache()
        scope = CacheScope(workspace_id=ws, data_source_id=ds, branch_id=str(branch_id))
        return await cache._coord_redis.get(_genat_key(scope))
    except Exception as exc:
        logger.warning(
            "graph_cache: get_cache_as_of failed for %s/%s: %s", ws, ds, exc,
        )
        return None


async def read_freshness_signals(
    pairs: list[tuple[str, str]],
) -> dict[tuple[str, str], tuple[Optional[int], Optional[str], Optional[str]]]:
    """Batch-read the freshness signals for many ``(workspace_id,
    data_source_id)`` pairs in ONE Redis pipeline — the fleet freshness
    view's only cache round-trip. For each pair it reads the cache
    generation counter, the cache-as-of stamp, and the stale-source
    marker reason.

    Returns a dict keyed by ``(str(ws), str(ds))`` → ``(generation,
    cache_as_of, stale_reason)``; any missing/unparseable value is
    ``None``. Best-effort: on any Redis error every requested pair maps to
    ``(None, None, None)`` so callers degrade to "freshness unknown"
    rather than failing. Follows graph_cache conventions: ``str()``
    coercion, empty-id guards, never raises."""
    clean = [(str(ws), str(ds)) for ws, ds in pairs if ws and ds]
    result: dict[tuple[str, str], tuple[Optional[int], Optional[str], Optional[str]]] = {
        pair: (None, None, None) for pair in clean
    }
    if not clean:
        return result
    try:
        cache = get_graph_cache()
        pipe = cache._coord_redis.pipeline(transaction=False)
        for ws, ds in clean:
            scope = CacheScope(workspace_id=ws, data_source_id=ds, branch_id="")
            pipe.get(_gen_key(scope))
            pipe.get(_genat_key(scope))
            pipe.get(_stale_key(ws, ds))
        raw = await pipe.execute()
    except Exception as exc:
        logger.warning(
            "graph_cache: read_freshness_signals failed for %d pairs: %s",
            len(clean), exc,
        )
        return result
    for idx, pair in enumerate(clean):
        gen_raw, genat_raw, stale_raw = raw[idx * 3: idx * 3 + 3]
        try:
            gen = int(gen_raw) if gen_raw is not None else None
        except (TypeError, ValueError):
            gen = None
        result[pair] = (gen, genat_raw, stale_raw)
    return result


async def read_lkg_stats(
    workspace_id: str, data_source_id: str,
) -> tuple[Optional[int], Optional[int]]:
    """Count the last-known-good cache entries for one source and the age
    of the oldest, via ONE bounded SCAN over
    ``graphcache:lkg:v1:{ws}:{ds}:*`` then ONE pipelined TTL read.

    Returns ``(lkg_count, oldest_age_secs)``; either is ``None`` on empty
    ids or any Redis error, and ``lkg_count`` is 0 (with ``None`` age)
    when the source has no LKG entries. Per-source only — never called on
    the fleet path. Best-effort: never raises."""
    ws, ds = str(workspace_id), str(data_source_id)
    if not ws or not ds:
        return (None, None)
    try:
        cache = get_graph_cache()
        pattern = f"{_LKG_PREFIX}:{ws}:{ds}:*"
        keys: list[str] = []
        cursor = 0
        while True:
            cursor, batch = await cache._cache_redis.scan(
                cursor=cursor, match=pattern, count=500,
            )
            keys.extend(batch)
            if not cursor:
                break
        if not keys:
            return (0, None)
        pipe = cache._cache_redis.pipeline(transaction=False)
        for key in keys:
            pipe.ttl(key)
        ttls = await pipe.execute()
        # age(oldest) = LKG_TTL − min(remaining TTL); keys without a TTL
        # (-1) or already gone (-2) are ignored for the age computation.
        remaining = [int(t) for t in ttls if t is not None and int(t) >= 0]
        oldest_age: Optional[int] = None
        if remaining and _LKG_TTL > 0:
            oldest_age = max(0, _LKG_TTL - min(remaining))
        return (len(keys), oldest_age)
    except Exception as exc:
        logger.warning(
            "graph_cache: read_lkg_stats failed for %s/%s: %s", ws, ds, exc,
        )
        return (None, None)


async def count_cache_keys_by_endpoint(
    workspace_id: str, data_source_id: str, branch_id: str = "",
) -> Optional[dict[str, int]]:
    """Bounded SCAN over the CURRENT-generation primary cache keys for a
    source, tallied by endpoint segment (index 6 of
    ``graphcache:v1:{ws}:{ds}:{branch}:{gen}:{endpoint}:{digest}``).
    Reads the current generation first so the SCAN pattern locks to it —
    stale-generation and LKG keys (a different prefix) never match.

    Returns ``{}`` when nothing is cached (distinct from ``None`` = a
    Redis error/disabled cache), ``None`` on empty ids (no SCAN issued).
    Per-source only — never called on the fleet path. Best-effort: never
    raises."""
    ws, ds, branch = str(workspace_id), str(data_source_id), str(branch_id)
    if not ws or not ds:
        return None
    try:
        cache = get_graph_cache()
        scope = CacheScope(workspace_id=ws, data_source_id=ds, branch_id=branch)
        gen = await cache._get_generation(scope)
        pattern = f"{_KEY_PREFIX}:{ws}:{ds}:{branch}:{gen}:*"
        tally: dict[str, int] = {}
        cursor = 0
        while True:
            cursor, keys = await cache._cache_redis.scan(
                cursor=cursor, match=pattern, count=500,
            )
            for key in keys:
                parts = key.split(":")
                if len(parts) > 6:
                    tally[parts[6]] = tally.get(parts[6], 0) + 1
            if not cursor:
                break
        return tally
    except Exception as exc:
        logger.warning(
            "graph_cache: count_cache_keys_by_endpoint failed for %s/%s: %s",
            ws, ds, exc,
        )
        return None


async def list_stale_sources() -> list[tuple[str, str]]:
    """List every ``(workspace_id, data_source_id)`` pair currently
    marked stale — read by the scheduler reconciler to re-signal sources
    whose rebuild was deferred by the cooldown throttle or left stale by
    a failed rebuild. Bounded SCAN, never KEYS. Malformed keys (wrong
    segment count) are skipped. Best-effort: returns ``[]`` on any
    Redis error."""
    pairs: list[tuple[str, str]] = []
    try:
        cache = get_graph_cache()
        pattern = f"{_STALE_PREFIX}:*"
        cursor = 0
        while True:
            cursor, keys = await cache._coord_redis.scan(
                cursor=cursor, match=pattern, count=500,
            )
            for key in keys:
                rest = key[len(_STALE_PREFIX) + 1:]
                parts = rest.split(":")
                if len(parts) != 2 or not parts[0] or not parts[1]:
                    logger.warning(
                        "graph_cache: skipping malformed stale key %r", key,
                    )
                    continue
                pairs.append((parts[0], parts[1]))
            if not cursor:
                break
    except Exception as exc:
        logger.warning("graph_cache: list_stale_sources failed: %s", exc)
        return []
    return pairs


async def bump_aggregated_generations(scopes) -> None:
    """Bulk, pipelined generation bump for many ``(workspace_id,
    data_source_id)`` pairs — the SYNCHRONOUS half of
    :func:`invalidate_aggregated_reads` for ontology writers that fan out to
    every assigned source. LKG purges (SCAN sweeps) are the caller's deferred
    half — see :func:`purge_aggregated_lkg`. Best-effort: never raises."""
    pairs = [(str(ws), str(ds)) for ws, ds in scopes if ws and ds]
    if not pairs:
        return
    try:
        cache = get_graph_cache()
        await cache.bump_generations([
            CacheScope(workspace_id=ws, data_source_id=ds, branch_id="")
            for ws, ds in pairs
        ])
    except Exception as exc:
        logger.warning(
            "bulk aggregated-read generation bump failed for %d scopes: %s",
            len(pairs), exc,
        )


async def purge_aggregated_lkg(scopes) -> None:
    """Purge the LKG fallback entries for many scopes — the DEFERRED half of
    ontology-writer invalidation (each purge is a Redis SCAN sweep, so this
    runs post-response via BackgroundTasks). LKG entries only serve
    degraded-fallback reads and TTL-expire anyway, so a lost run is bounded.
    Best-effort: never raises."""
    for ws, ds in scopes:
        if not ws or not ds:
            continue
        try:
            cache = get_graph_cache()
            scope = CacheScope(
                workspace_id=str(ws), data_source_id=str(ds), branch_id="",
            )
            removed = await cache.purge_lkg(scope, ENDPOINT_AGGREGATED)
            logger.info(
                "aggregated-read LKG purged for %s/%s (%d entries)",
                ws, ds, removed,
            )
        except Exception as exc:
            logger.warning(
                "aggregated-read LKG purge failed for %s/%s: %s", ws, ds, exc,
            )


# ─── Singleton accessor ────────────────────────────────────────────────

_cache: Optional[GraphCache] = None


def _resolve_cache_role_client() -> Optional[aioredis.Redis]:
    """Resolve the global CACHE-role Redis client for response-cache
    payloads + LKG snapshots (``REDIS_CACHE_*``, falling back to the
    legacy ``CACHE_REDIS_URL`` — see ``resolve_redis_config``/
    ``falkordb_connection.build_cache_client``).

    No per-provider ``cacheConnection`` override here: this resolves the
    fleet-wide default only, since graph_cache has no single provider to
    key off of; routing a provider's own cache override into graph_cache
    is a documented follow-up (spec §10a note).

    Returns ``None`` when the role isn't configured, or when resolution
    itself fails for any reason — best-effort, same as every other
    contract in this module: the caller falls back to the shared/durable
    client so dev and unconfigured deployments see no behavior change.
    """
    try:
        from backend.common.adapters.redis_endpoint import (
            RedisRole, build_redis_client, resolve_redis_config,
        )
        cfg = resolve_redis_config(RedisRole.CACHE)
        if not cfg.is_configured:
            return None
        return build_redis_client(cfg)
    except Exception as exc:
        logger.warning(
            "graph_cache: CACHE-role Redis resolution failed (%s); "
            "response-cache payloads will use the shared Redis client",
            exc,
        )
        return None


def get_graph_cache() -> GraphCache:
    """Return the process-wide GraphCache. Lazy-initialised on first use
    so test code can patch `get_redis()` before this fires."""
    global _cache
    if _cache is None:
        _cache = GraphCache(get_redis(), _resolve_cache_role_client())
    return _cache


def reset_graph_cache_for_tests() -> None:
    """Drop the singleton so a fresh fixture can install its own."""
    global _cache
    _cache = None

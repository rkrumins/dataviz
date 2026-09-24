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
graph) by ``ProviderManager.acquire_provider_slot`` (default 8) and
then by ``ProviderManager.fleet_slot``, wired around the ``compute``
callables at the endpoint layer in ``graph.py::_bounded_compute``.
The first is per process; the second is one Redis-counted number for
the whole fleet, which is what actually holds concurrent Cypher to
what the store can execute. It costs one round trip on a MISS only —
never on a hit — and fails open, so the bus staying a soft dependency
of the read path is preserved.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, Sequence, Tuple, TypeVar

from pydantic import BaseModel
from redis import asyncio as aioredis
from redis.exceptions import RedisError

from backend.app.services.aggregation.redis_client import get_redis
from backend.common.adapters import (
    ProviderBusy, ProviderLoading, ProviderUnavailable,
)

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
#: When a compute was last stored (see :func:`_builtat_key`). Value is
#: ``"<iso>|<generation>"`` so one read answers both "when was this cache
#: last built" and "which version is being served".
_BUILTAT_PREFIX = "graphcache:builtat:v1"


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
# Marks a key whose answer exceeded the payload cap and was therefore not
# stored. See ``_mark_oversized``.
_OVERSIZED_PREFIX = "graphcache:big:v1"

# Per-endpoint TTLs (seconds). Each is operator-tunable inside a safe
# range so a bad env value (typo, zero, huge) can't break the cache.
# Bounds rationale:
#   * lo = 1s — anything shorter is effectively no-cache and would
#     trigger thundering-herd compute on every render.
#   * hi = 24 hours. This used to be 1 hour, on the reasoning that beyond
#     it ``bump_generation`` is the only invalidation lever. That reasoning
#     had it backwards: the gen bump IS the invalidation lever, and it is
#     event-driven, so a TTL is not what keeps data fresh — it is only what
#     throws cache away on a clock. An aggregation run completing, failing
#     mid-write, being purged or skipped all reach
#     ``invalidate_aggregated_reads`` -> gen bump (event_listener.py:247),
#     and every app write path bumps too. For an EXTERNAL graph with no
#     branch and no in-app writes — the common case — the aggregation event
#     is the only thing that changes the answer, and it invalidates.
#     Kept finite so a deployment whose writes genuinely bypass the app
#     still converges without a restart.
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
_TTL_LO, _TTL_HI = 1, 86_400

_DEFAULT_CHILDREN_TTL = _clamped_int_env("GRAPH_CACHE_CHILDREN_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_AGGREGATED_TTL = _clamped_int_env("GRAPH_CACHE_AGGREGATED_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
# Trace responses are large and expensive; 60s catches repeat navigation
# inside the lineage preview drawer without serving stale data for long.
# The same gen counter (bumped on writes) invalidates trace entries.
_DEFAULT_TRACE_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_TRACE_EXPAND_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_EXPAND_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_TRACE_CLOSURE_TTL = _clamped_int_env("GRAPH_CACHE_TRACE_CLOSURE_TTL_S", 300, lo=_TTL_LO, hi=_TTL_HI)
# Top-level nodes change only when a write inside the workspace shuffles
# containment — gen counter bumps invalidate. Small payloads, hot path.
_DEFAULT_TOP_LEVEL_TTL = _clamped_int_env("GRAPH_CACHE_TOP_LEVEL_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
# Layer assignment is deterministic for a given (ws, ds, request body)
# and touches the same node/edge set as a trace. 60s matches /trace.
_DEFAULT_LAYER_ASSIGNMENT_TTL = _clamped_int_env("GRAPH_CACHE_LAYER_ASSIGNMENT_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
# Batched canvas contract (open/expand). These compose top-level +
# aggregated + children into one entry; a canvas gesture repeats the
# exact same request until a write bumps the generation, so a longer
# TTL amortises the whole bootstrap/expand cost. gen-bump keeps them
# fresh on edits.
_DEFAULT_CANVAS_BOOTSTRAP_TTL = _clamped_int_env("GRAPH_CACHE_CANVAS_BOOTSTRAP_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
_DEFAULT_CANVAS_EXPAND_TTL = _clamped_int_env("GRAPH_CACHE_CANVAS_EXPAND_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
# Lineage bridges: a view re-opening asks for exactly the same member set, and
# the answer only changes when the graph does — which bumps the generation.
_DEFAULT_LINEAGE_BRIDGES_TTL = _clamped_int_env("GRAPH_CACHE_LINEAGE_BRIDGES_TTL_S", 3600, lo=_TTL_LO, hi=_TTL_HI)
# Short TTL for DEGRADED results — an answer the provider gave up part way
# through, which a retry may well improve on. Absorbs the herd asking for it
# again without committing to caching a partial answer for long. Floor of
# 5s keeps the herd-absorption property; ceiling of 5min limits damage
# when a transient miss is overcached. An EMPTY answer is not degraded and
# does not take this window — see :func:`_is_empty_result`.
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

#: Separates an LKG entry's generation stamp from its payload.
#: ``model_dump_json`` never emits a raw newline — one inside a string value
#: is escaped — so splitting on the first cannot cut into the payload.
_LKG_STAMP_SEP = "\n"
#: Separates the generation from the epoch seconds inside that stamp, so a
#: promotion can ask how old the mirror is as well as whether it is current.
_LKG_STAMP_AT = "@"

#: Payload size at which deserialization moves to a worker thread. Below it
#: the hop costs more than the parse; above it the parse stalls the loop for
#: longer than any request should tolerate. See :func:`_deserialize`.
_DESERIALIZE_OFFLOAD_BYTES = 131_072

#: On a miss, promote a generation-matched mirror back to the primary key
#: instead of recomputing an answer the generation says has not changed.
#: Off restores "every expiry is a full recompute".
_PROMOTE_UNCHANGED = os.getenv("GRAPH_CACHE_PROMOTE_UNCHANGED", "1") != "0"

# Per-payload size cap. A single response larger than this is logged
# and dropped rather than cached — one huge dump shouldn't crowd out a
# thousand normal 5 KB entries. Applies to both primary and LKG writes.
# Set to 0 to disable the cap (do not recommend in prod).
# Bounds: 0 (disabled) or [4 KB, 64 MB]. The 64 MB ceiling matches
# Redis's default string-value soft limit.
#
# 4 MiB, not the original 1 MiB: at 1 MiB the biggest views — precisely
# the ones whose queries cost the most and whose users wait longest —
# were never cached, so every concurrent open recomputed the same
# multi-second scan on FalkorDB's query threads. The eviction policy is
# volatile-lru and every entry carries a TTL, so an oversized entry that
# does crowd the cache is evicted rather than pinning memory.
_MAX_PAYLOAD_BYTES_RAW = _clamped_int_env(
    "GRAPH_CACHE_MAX_PAYLOAD_BYTES", 4_194_304, lo=0, hi=67_108_864,
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
ENDPOINT_TRACE_CLOSURE = "trace-closure"
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
ENDPOINT_NODES_DEGREE = "nodes-degree"
# Lineage bridges — a curated view's virtual hops and one hop's hidden steps.
# RAW lineage only, so deliberately NOT in _ROLLUP_ENDPOINTS: a rollup rebuild
# changes nothing these answer; any real write bumps the content generation.
ENDPOINT_LINEAGE_BRIDGES = "lineage-bridges"
ENDPOINT_LINEAGE_BRIDGE_PATH = "lineage-bridge-path"

_ENABLED_ENDPOINTS = {
    ENDPOINT_CHILDREN: _flag("GRAPH_CACHE_ENABLED_CHILDREN", default=True),
    ENDPOINT_AGGREGATED: _flag("GRAPH_CACHE_ENABLED_AGGREGATED", default=True),
    ENDPOINT_TRACE: _flag("GRAPH_CACHE_ENABLED_TRACE", default=True),
    ENDPOINT_TRACE_EXPAND: _flag("GRAPH_CACHE_ENABLED_TRACE_EXPAND", default=True),
    ENDPOINT_TRACE_CLOSURE: _flag("GRAPH_CACHE_ENABLED_TRACE_CLOSURE", default=True),
    ENDPOINT_TOP_LEVEL: _flag("GRAPH_CACHE_ENABLED_TOP_LEVEL", default=True),
    ENDPOINT_LAYER_ASSIGNMENT: _flag("GRAPH_CACHE_ENABLED_LAYER_ASSIGNMENT", default=True),
    ENDPOINT_CANVAS_BOOTSTRAP: _flag("GRAPH_CACHE_ENABLED_CANVAS_BOOTSTRAP", default=True),
    ENDPOINT_CANVAS_EXPAND: _flag("GRAPH_CACHE_ENABLED_CANVAS_EXPAND", default=True),
    ENDPOINT_EDGES_BETWEEN: _flag("GRAPH_CACHE_ENABLED_EDGES_BETWEEN", default=True),
    ENDPOINT_NODES_QUERY: _flag("GRAPH_CACHE_ENABLED_NODES_QUERY", default=True),
    ENDPOINT_NODES_DEGREE: _flag("GRAPH_CACHE_ENABLED_NODES_DEGREE", default=True),
    ENDPOINT_LINEAGE_BRIDGES: _flag("GRAPH_CACHE_ENABLED_LINEAGE_BRIDGES", default=True),
    ENDPOINT_LINEAGE_BRIDGE_PATH: _flag("GRAPH_CACHE_ENABLED_LINEAGE_BRIDGE_PATH", default=True),
}

#: The endpoints whose answer is read out of the ``:AGGREGATED`` rollup layer,
#: and therefore the only ones a rebuild of that layer has to invalidate. They
#: carry the rollup counter in their cache key on top of the content counter
#: every endpoint carries; see :func:`_gen_key`. ``trace-closure`` is here for
#: its ``grain=coarse`` page only (``trace_closure_coarse`` reads incident
#: rollup cells) — the fine walk reads raw lineage, but both grains share one
#: endpoint namespace, so the endpoint is scoped to the stricter of the two.
_ROLLUP_ENDPOINTS = frozenset({
    ENDPOINT_AGGREGATED,
    ENDPOINT_TRACE,
    ENDPOINT_TRACE_EXPAND,
    ENDPOINT_TRACE_CLOSURE,
    ENDPOINT_CANVAS_BOOTSTRAP,
    ENDPOINT_CANVAS_EXPAND,
})


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


def _swallow_if_unobserved(fut: "asyncio.Future") -> None:
    """Mark a failed singleflight future retrieved if nobody attached to it.

    Setting an exception on a future no follower awaits makes asyncio log
    "Future exception was never retrieved" when it is collected — noise that
    looks like a leak during exactly the incident someone is reading logs for.
    Calling ``exception()`` on the done future counts as retrieval.
    """
    def _retrieve(f: "asyncio.Future") -> None:
        if not f.cancelled():
            f.exception()

    fut.add_done_callback(_retrieve)


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
        expected_compute_s: Optional[float] = None,
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

        ``expected_compute_s`` is the wall clock this endpoint's compute is
        budgeted for. It sizes the cross-process follower wait — see
        :func:`_follower_deadline`. Callers that name no budget keep the flat
        default, which is how every call site behaved before.
        """
        if not self.is_enabled(endpoint):
            _stats_recorder.record(self, scope, endpoint, "bypass")
            return await compute()

        try:
            gen = await self._get_generation(scope, endpoint)
            cache_key = _build_key(scope, gen, endpoint, params)
        except RedisError as exc:
            logger.warning("graph_cache: gen read failed (%s); bypassing cache", exc)
            _stats_recorder.record(self, scope, endpoint, "bypass")
            return await compute()

        # ── 1. Redis cache lookup ─────────────────────────────────────
        try:
            cached = await self._cache_redis.get(cache_key)
        except RedisError as exc:
            logger.warning("graph_cache: GET failed (%s); bypassing cache", exc)
            _stats_recorder.record(self, scope, endpoint, "bypass")
            return await compute()

        if cached is not None:
            try:
                value = await _deserialize(model_cls, cached)
                _stats_recorder.record(self, scope, endpoint, "hit")
                return value
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
                # A follower rode the leader's compute rather than issuing its
                # own — from the store's point of view that is work avoided,
                # which is what the ratio is measuring.
                _stats_recorder.record(
                    self, scope, endpoint,
                    "stale" if outcome.served_stale else "hit",
                )
                return outcome.value
            except (ProviderBusy, ProviderLoading):
                # FLOW CONTROL, not a failure to retry. The leader was shed so
                # the store could serve someone else, or it is still warming.
                # Recomputing here is precisely the load the shed refused —
                # and a shed key is a key WITH followers, so falling through
                # turns one refusal into N concurrent computes on the same
                # key. Every follower gets the leader's answer and retries on
                # its own Retry-After, as the client already knows how to do.
                raise
            except Exception:
                # The leader failed for a reason a retry might survive — fall
                # through and compute below.
                pass

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[_SingleflightOutcome] = loop.create_future()
        self._inflight[cache_key] = fut
        leader_token: Optional[str] = None
        renewer: Optional[asyncio.Task] = None
        try:
            # An answer this key cannot store is not a key worth coordinating
            # on: the mirror was dropped with it, and an election would make
            # eleven followers wait out a deadline for a write that is never
            # coming, then compute anyway — strictly worse than no cache.
            oversized = await self._is_oversized(cache_key)

            # ── 3. Nothing has changed: promote the mirror ────────────
            # An expiry is not evidence that the answer moved. Every write
            # bumps the generation, so a generation that has not moved means
            # a recompute would return the same bytes — and the mirror
            # already holds them. Reading one small key beats spending ten
            # seconds of a shard's threads to be told the same thing.
            if _PROMOTE_UNCHANGED and not oversized:
                warm = await self._promote_mirror(
                    scope, endpoint, params, model_cls,
                    gen=gen, cache_key=cache_key, ttl_seconds=ttl_seconds,
                )
                if warm is not None:
                    if not fut.done():
                        fut.set_result(
                            _SingleflightOutcome(value=warm, served_stale=False),
                        )
                    # A hit: no provider work, no wait, and the generation
                    # says it is the current answer.
                    _stats_recorder.record(self, scope, endpoint, "hit")
                    return warm

            # ── 4. Cross-process singleflight ─────────────────────────
            # We are this pod's leader for the key. Twelve pod-leaders on a
            # cold view means twelve identical computes unless they agree on
            # one, so stand for election through the bus. Losing is the good
            # case: watch for the winner's answer instead of repeating its
            # work. Every failure here — no bus, a dead leader, a wait that
            # expires — ends in computing it ourselves, which is the
            # behaviour that existed before any of this.
            if not oversized:
                leader_token = await self._stand_for_election(cache_key)
                watch_until = time.monotonic() + _follower_deadline(expected_compute_s)
                while leader_token is None:
                    peer = await self._await_leader(
                        cache_key, model_cls,
                        deadline_s=watch_until - time.monotonic(),
                    )
                    if peer is not None:
                        if not fut.done():
                            fut.set_result(
                                _SingleflightOutcome(value=peer, served_stale=False),
                            )
                        # Work the fleet did not have to do twice.
                        _stats_recorder.record(self, scope, endpoint, "hit")
                        return peer
                    # No answer means the leader is GONE — it releases its
                    # election in a ``finally`` and its lock expires when it
                    # dies, and ``_await_leader`` returns as soon as it sees
                    # that. Stand again rather than compute: otherwise one
                    # dead leader turns every follower watching it into a
                    # duplicate compute, which is the stampede the election
                    # exists to prevent. Whoever wins succeeds it; the rest
                    # watch the successor for what is left of the wait.
                    leader_token = await self._stand_for_election(cache_key)
                    if time.monotonic() >= watch_until:
                        break               # waited long enough: compute
                if leader_token is not None:
                    renewer = self._start_leader_renewal(cache_key, leader_token)

            result = await compute()
            # Serialize ONCE, and off the loop. These two writes each used to
            # call ``model_dump_json`` on the full payload inline, so every
            # cache fill blocked the worker's event loop twice — stalling every
            # other request on it, for every other data source, in proportion
            # to the biggest response any one of them returned.
            payload = await asyncio.to_thread(result.model_dump_json, by_alias=True)
            stored = await self._set(
                cache_key, result, ttl_seconds, endpoint,
                payload=payload, scope=scope,
            )
            await self._set_lkg(scope, endpoint, params, result, gen, payload=payload)
            if stored == "stored":
                # Only when something actually landed: an answer that was
                # dropped for being over the payload cap must not read as a
                # cache that was just built.
                await self._note_built(scope, endpoint, ttl_seconds, gen)
            if not fut.done():
                fut.set_result(_SingleflightOutcome(value=result, served_stale=False))
            _stats_recorder.record(self, scope, endpoint, "miss")
            if stored == "too_large":
                # The read was a miss and is counted as one; this says why
                # the NEXT identical read will be too.
                _stats_recorder.record(self, scope, endpoint, "too_large")
                await self._mark_oversized(cache_key, ttl_seconds, endpoint)
            return result
        except (ProviderBusy, ProviderLoading) as exc:
            # NOT an inability to answer, and both subclass ProviderUnavailable
            # so the clause below would otherwise swallow them.
            #
            # ProviderBusy is flow control: the request was SHED so the store
            # could serve someone else, and the client is expected to retry in
            # place after Retry-After. ProviderLoading is a store still reading
            # its dataset in — seconds to minutes, and it will answer.
            # Converting either into a 200 carrying a snapshot up to a day old
            # hides the one fact the client needs to act on, and makes the
            # shed-early path unreachable on every cached endpoint: the canvas
            # never retries, because as far as it can tell it got an answer.
            #
            # The future MUST be resolved before re-raising. Followers attach
            # with ``await asyncio.shield(existing)``, and shield means their
            # own cancellation does not end that await — a future nobody
            # completes strands every one of them until its request tier
            # fires. Shedding is exactly when a cache key has followers (a
            # cold-cache stampede is what the gate sheds), so leaving this out
            # turns one shed request into a pile of hung ones.
            if not fut.done():
                fut.set_exception(exc)
                _swallow_if_unobserved(fut)
            raise
        except (ProviderUnavailable, asyncio.TimeoutError) as exc:
            # Provider genuinely can't answer right now (unreachable, failing
            # over, or one operation past its deadline). Fall through to the
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
                _stats_recorder.record(self, scope, endpoint, "stale")
                return stale
            # No fallback available — propagate.
            if not fut.done():
                fut.set_exception(exc)
                _swallow_if_unobserved(fut)
            raise
        except Exception as exc:
            if not fut.done():
                fut.set_exception(exc)
                _swallow_if_unobserved(fut)
            raise
        finally:
            self._inflight.pop(cache_key, None)
            # Hand leadership back at once rather than making the next caller
            # wait out the TTL — including when we failed, so the retry is
            # free to try instead of watching a leader that has gone.
            await self._step_down(cache_key, leader_token, renewer)

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
            gen = await self._get_generation(scope, ENDPOINT_TOP_LEVEL_COUNT)
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
            gen = await self._get_generation(scope, ENDPOINT_TOP_LEVEL_COUNT)
            await self._cache_redis.set(
                _build_key(scope, gen, ENDPOINT_TOP_LEVEL_COUNT, params),
                str(int(value)),
                ex=_DEFAULT_TOP_LEVEL_TTL,
            )
        except (RedisError, TypeError, ValueError) as exc:
            logger.warning("graph_cache: top-level count write failed (%s)", exc)

    async def bump_generation(self, scope: CacheScope) -> None:
        """Invalidate every cached entry under `scope` by bumping the
        per-scope CONTENT generation counter. Old keys become unreachable on
        the next read and TTL-expire on their own — no SCAN/DEL needed.

        The content counter is in the key of every endpoint, so this is the
        superset bump: use it for anything that changes nodes, edges,
        identity or mapping. A rebuild of the ``:AGGREGATED`` layer alone
        wants :meth:`bump_rollup_generation` instead, which reaches only the
        endpoints that read it.

        Safe to call from a write path even with the cache feature flag
        off; INCR on a non-existent key just starts it at 1.
        """
        await self._bump_one(_gen_key(scope), scope)

    async def bump_rollup_generation(self, scope: CacheScope) -> None:
        """Invalidate the cached entries that READ the ``:AGGREGATED`` layer,
        and only those, by bumping the per-scope rollup counter.

        A rollup rebuild does not move a single node, edge or containment
        relationship, so invalidating the hierarchy endpoints along with it
        threw away the cache that makes 300 concurrent users possible, on
        every completed run. See :func:`_gen_key` for the two counters."""
        await self._bump_one(_rollup_gen_key(scope), scope)

    async def _bump_one(self, gen_key: str, scope: CacheScope) -> None:
        try:
            await self._coord_redis.incr(gen_key)
            await self._coord_redis.set(
                _genat_key(scope), datetime.now(timezone.utc).isoformat(),
            )
            await self._drop_built(scope)
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
        await self._bump_many(scopes, _gen_key)

    async def bump_rollup_generations(self, scopes: Sequence[CacheScope]) -> None:
        """Bulk :meth:`bump_rollup_generation`, same one round-trip shape."""
        await self._bump_many(scopes, _rollup_gen_key)

    async def _bump_many(
        self, scopes: Sequence[CacheScope], key_fn: Callable[[CacheScope], str],
    ) -> None:
        if not scopes:
            return
        try:
            pipe = self._coord_redis.pipeline(transaction=False)
            now_iso = datetime.now(timezone.utc).isoformat()
            for scope in scopes:
                pipe.incr(key_fn(scope))
                pipe.set(_genat_key(scope), now_iso)
            await self._drop_built(*scopes)
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

    async def _stand_for_election(self, cache_key: str) -> Optional[str]:
        """Try to become the one process in the fleet that computes this key.

        Returns our token when we won, or None when someone else holds it.
        A bus that cannot answer returns a token too: failing open means
        everyone computes, which is exactly the behaviour without this.

        Deliberately on the CACHE role, not the coordination role. Losing this
        key costs one duplicate compute and nothing else, which is the
        definition of cache-role state — the coordination client is reserved
        for the generation counter and the markers, whose loss corrupts
        rather than merely wastes.
        """
        if not _LEADER_ENABLED:
            return "disabled"
        token = uuid.uuid4().hex
        try:
            won = await self._cache_redis.set(
                f"{_LEADER_PREFIX}:{cache_key}", token, nx=True, px=_LEADER_TTL_MS,
            )
        except Exception as exc:                    # noqa: BLE001 — never a hard dep
            logger.debug("graph_cache: leader election unavailable (%s)", exc)
            return token
        return token if won else None

    def _start_leader_renewal(
        self, cache_key: str, token: str,
    ) -> Optional[asyncio.Task]:
        """Keep our election alive for as long as we are actually computing.

        The lock's TTL has two jobs that pull in opposite directions: it must
        outlive the slowest legitimate compute, or a slow leader loses its
        election mid-read and a second process starts the same work; and it
        must be short, or a leader that CRASHED strands its followers for the
        whole of it. A TTL long enough for the second-slowest read also minted
        a brand-new duplicate leader every time it lapsed under a read that
        was still running.

        Renewing settles both: the TTL is short enough to detect a dead leader
        quickly, and a live leader extends it for as long as it lives. The
        refresh is token-checked, so a leader whose lock already lapsed and
        was taken cannot extend the successor's.
        """
        if not _LEADER_ENABLED or token == "disabled":
            return None

        async def _renew() -> None:
            lock_key = f"{_LEADER_PREFIX}:{cache_key}"
            while True:
                await asyncio.sleep(_LEADER_RENEW_S)
                try:
                    held = await self._cache_redis.eval(
                        _RENEW_LEADER_LUA, 1, lock_key, token, str(_LEADER_TTL_MS),
                    )
                except Exception as exc:            # noqa: BLE001 — never a hard dep
                    logger.debug("graph_cache: leader renewal failed (%s)", exc)
                    return
                if not held:
                    # Someone else holds it now; stop touching their key.
                    return

        try:
            return asyncio.get_running_loop().create_task(_renew())
        except RuntimeError:                        # pragma: no cover — no loop
            return None

    async def _step_down(
        self,
        cache_key: str,
        token: Optional[str],
        renewer: Optional[asyncio.Task] = None,
    ) -> None:
        """Release our election so the next caller computes immediately rather
        than waiting out the TTL. Only ever releases OUR token: the TTL may
        have expired and passed leadership on while we were still working."""
        if renewer is not None:
            renewer.cancel()
        if not token or token == "disabled":
            return
        try:
            await self._cache_redis.eval(
                _RELEASE_LEADER_LUA, 1, f"{_LEADER_PREFIX}:{cache_key}", token,
            )
        except Exception as exc:                    # noqa: BLE001 — the TTL cleans up
            logger.debug("graph_cache: leader release failed (%s)", exc)

    async def _await_leader(
        self, cache_key: str, model_cls: type[T], *, deadline_s: float,
    ) -> Optional[T]:
        """Watch for the leader's answer. The value if it lands in time, else
        None and the caller computes its own.

        Polling, not pub/sub, on purpose: one read of one small key is cheap
        and has no subscription to leak, no reconnect to handle, and no
        ordering to get wrong.

        Both keys are read in ONE round trip, and the interval backs off. The
        answer and the election are two different questions — "is it done" and
        "is anyone still working on it" — and the loop needs both every
        iteration, so asking sequentially made a contended key cost two round
        trips per poll per follower. At 50ms across eleven followers that was
        ~440 reads/second on one key, spent to learn nothing eleven times
        over. 50ms still covers the case worth covering (a leader that
        finishes quickly), and a compute that is going to take thirty seconds
        does not need to be asked about twenty times a second.
        """
        lock_key = f"{_LEADER_PREFIX}:{cache_key}"
        started = time.monotonic()
        while True:
            waited = time.monotonic() - started
            if waited >= deadline_s:
                return None
            await asyncio.sleep(_poll_interval(waited))
            try:
                cached, lock = await asyncio.gather(
                    self._cache_redis.get(cache_key),
                    self._cache_redis.get(lock_key),
                )
                if cached is None:
                    # Nothing yet. Either the leader is still working, or it
                    # finished without an answer — shed, failed, died. The
                    # leader releases its election in a ``finally``, so a
                    # missing lock means there is no longer anyone to wait
                    # for, and sitting out the rest of the deadline would
                    # turn ONE refusal into a wait for every follower. Read
                    # the key once more before giving up: the leader may have
                    # written and stepped down between the two reads above.
                    if lock is not None:
                        continue
                    cached = await self._cache_redis.get(cache_key)
                    if cached is None:
                        return None
            except Exception:                       # noqa: BLE001 — go compute
                return None
            try:
                return await _deserialize(model_cls, cached)
            except Exception:                       # noqa: BLE001 — treat as a miss
                return None

    # ─── Internals ────────────────────────────────────────────────────

    async def _get_generation(
        self, scope: CacheScope, endpoint: Optional[str] = None,
    ) -> str:
        """The generation component of `endpoint`'s cache key for `scope`.

        The content counter alone for most endpoints; ``content.rollup`` for
        the ones that read the ``:AGGREGATED`` layer, both counters read in
        one round trip. Concatenated, never combined arithmetically: two
        independent monotonic counters can reach the same sum from different
        places, and a cache key that repeats is a cache key that serves an
        answer a write already invalidated.

        A counter that was never set reads as 0 (a stable initial key), and so
        does garbage in the slot — don't try to repair it, the write paths
        overwrite via INCR.
        """
        if endpoint not in _ROLLUP_ENDPOINTS:
            return str(_as_generation(await self._coord_redis.get(_gen_key(scope))))
        content, rollup = await asyncio.gather(
            self._coord_redis.get(_gen_key(scope)),
            self._coord_redis.get(_rollup_gen_key(scope)),
        )
        return f"{_as_generation(content)}.{_as_generation(rollup)}"

    async def _is_oversized(self, cache_key: str) -> bool:
        """Has this key's answer just been refused for exceeding the payload
        cap? Best-effort: an unreachable marker reads as "no"."""
        if _MAX_PAYLOAD_BYTES <= 0:
            return False
        try:
            return await self._cache_redis.get(_oversized_key(cache_key)) is not None
        except Exception:                           # noqa: BLE001 — never a hard dep
            return False

    async def _mark_oversized(
        self, cache_key: str, ttl_seconds: Optional[int], endpoint: str,
    ) -> None:
        """Record that this key's answer does not fit, for as long as the
        answer would have been cached.

        Without it the key keeps every cost of being cached and provides none
        of the benefit: eleven followers elect a leader and wait out a
        deadline for a write that was already refused, then all compute
        anyway. The marker is a few bytes and expires with the TTL the answer
        would have had, so an endpoint that stops overflowing recovers on its
        own."""
        try:
            await self._cache_redis.set(
                _oversized_key(cache_key), "1",
                ex=_resolve_ttl(ttl_seconds, endpoint),
            )
        except Exception as exc:                    # noqa: BLE001 — never a hard dep
            logger.debug("graph_cache: oversized marker write failed (%s)", exc)

    async def _drop_built(self, *scopes: CacheScope) -> None:
        """Forget the built-at stamp for these scopes: the generation just
        moved, so every entry it described is unreachable.

        Without this the stamp outlives what it claims by up to a full TTL —
        an hour on the children/aggregated/top-level/canvas endpoints — and
        the row says "Cached · built 40 minutes ago" over a scope with zero
        reachable entries. That is the same lie the stamp was added to
        remove, merely bounded.

        It also removes the need to compare versions at all: a stamp that
        only survives while its generation does IS "built at the version
        being served". Best-effort and on the CACHE client, where the stamp
        lives; a bump that cannot reach it degrades to the old behaviour
        (a stamp expiring on its own TTL) rather than failing the write
        path that invalidated.
        """
        if not scopes:
            return
        try:
            pipe = self._cache_redis.pipeline(transaction=False)
            for scope in scopes:
                pipe.delete(_builtat_key(scope))
            await pipe.execute()
        except Exception as exc:  # noqa: BLE001 — never fail an invalidation
            logger.debug("graph_cache: built-at drop failed: %s", exc)

    async def _note_built(
        self, scope: CacheScope, endpoint: str,
        ttl_seconds: Optional[int], generation: str,
    ) -> None:
        """Record that a compute was stored for this scope, and at which
        generation. Best-effort: a stamp is never worth failing a read that
        has already succeeded.

        The TTL is the entry's own, so the stamp expires with the answers it
        describes rather than outliving them — "built 20 minutes ago" stops
        being said the moment nothing built 20 minutes ago is still there.
        """
        key = _builtat_key(scope)
        value = f"{datetime.now(timezone.utc).isoformat()}|{generation}"
        ttl = _resolve_ttl(ttl_seconds, endpoint)
        try:
            # Never SHORTEN the stamp. One key covers every endpoint of a
            # scope, and their TTLs differ by an order of magnitude — so a
            # single 300s trace read used to rewrite the stamp of a source
            # holding an hour of aggregated entries, which then vanished five
            # minutes later and left the row reading "nothing warm stored"
            # over a cache with fifty-five minutes left in it.
            #
            # KEEPTTL writes the value without touching the expiry; EXPIRE GT
            # then raises it only when this entry outlives what is already
            # recorded. Two commands, one round trip, and the stamp ends up
            # carrying the longest-lived thing it describes.
            pipe = self._cache_redis.pipeline(transaction=False)
            pipe.set(key, value, keepttl=True)
            pipe.expire(key, ttl, gt=True)
            await pipe.execute()
        except Exception as exc:  # noqa: BLE001 — telemetry, never a read
            # KEEPTTL needs Redis 6.0 and EXPIRE GT needs 7.0. Anything older,
            # or any other failure, falls back to the plain write: the stamp
            # is then this endpoint's TTL, which is the behaviour before this
            # refinement and still bounded.
            logger.debug("graph_cache: built-at stamp (keepttl) failed: %s", exc)
            try:
                await self._cache_redis.set(key, value, ex=ttl)
            except Exception as exc2:  # noqa: BLE001
                logger.debug("graph_cache: built-at stamp failed: %s", exc2)

    async def _set(
        self,
        cache_key: str,
        result: BaseModel,
        ttl_seconds: Optional[int],
        endpoint: str,
        payload: Optional[str] = None,
        scope: Optional[CacheScope] = None,
    ) -> str:
        """Persist `result`, serializing it only if the caller has not already
        (see the single off-loop serialization in ``get_or_compute``). Failures
        are swallowed — the compute already succeeded, so failing the response
        on a write error would be a self-inflicted regression.

        Returns ``"too_large"`` when the answer exceeded the payload cap and
        was therefore NOT stored, else ``"stored"``. The caller counts the
        first case, because an endpoint whose answers never fit is
        indistinguishable from a broken cache unless something says so."""
        ttl = _resolve_ttl(ttl_seconds, endpoint)
        if _is_incomplete_result(result):
            ttl = _NEGATIVE_TTL
        try:
            if payload is None:
                payload = result.model_dump_json(by_alias=True)
            # Before the cap decides anything: the size of an answer that was
            # REFUSED is the one most worth knowing, and it is in hand here.
            if scope is not None:
                _stats_recorder.record_size(self, scope, endpoint, len(payload))
            if _MAX_PAYLOAD_BYTES > 0 and len(payload) > _MAX_PAYLOAD_BYTES:
                logger.warning(
                    "graph_cache: payload_too_large endpoint=%s key=%s size=%d cap=%d (dropping stale entry + skipping cache write)",
                    endpoint, cache_key, len(payload), _MAX_PAYLOAD_BYTES,
                )
                await self._cache_redis.delete(cache_key)
                return "too_large"
            await self._cache_redis.set(cache_key, payload, ex=ttl)
        except (RedisError, Exception) as exc:
            logger.warning("graph_cache: SET failed (%s)", exc)
        return "stored"

    async def _set_lkg(
        self,
        scope: CacheScope,
        endpoint: str,
        params: dict[str, Any],
        result: BaseModel,
        gen: str,
        payload: Optional[str] = None,
    ) -> None:
        """Mirror a successful compute into the gen-less LKG snapshot.

        Stamped with the generation it was computed at — the SAME component
        the primary key carries, both counters and all, or ``_promote_mirror``
        compares a content counter against a ``content.rollup`` pair and
        silently never matches again. The key has to stay gen-less so the
        mirror survives an invalidation and can still be the outage fallback —
        but a reader that cares whether the mirror is CURRENT needs to know,
        and the stamp is how it asks. See ``_promote_mirror``.

        Skipped for empty results — a transient empty answer must not
        pin "empty" as the stale fallback during a future outage. Skipped
        for incomplete (truncated/stale) results — a degraded snapshot
        must not become the outage fallback either. Skipped when
        ``_LKG_TTL`` is 0 (operator-disabled). Failures are swallowed for
        the same reason as ``_set``.

        The empty rule now lives HERE and nowhere else: an empty answer keeps
        the full TTL on the primary key (see :func:`_is_empty_result`) and is
        still kept out of the mirror. The asymmetry is deliberate and the two
        keys answer different questions. The primary key answers "what is true
        now", and an empty answer is true now and stays true until the
        generation moves. The mirror answers "what do we show when the store
        cannot be reached", and there "no lineage between these containers"
        is indistinguishable to the reader from real data — so an outage
        would quietly present an empty graph as fact.
        The cost of keeping it out is that such a key recomputes once its
        TTL expires instead of being promoted, which is the behaviour
        every endpoint had before promotion existed.
        """
        if _LKG_TTL <= 0:
            return
        if _is_empty_result(result):
            return
        if _is_incomplete_result(result):
            return
        try:
            if payload is None:
                payload = result.model_dump_json(by_alias=True)
            if _MAX_PAYLOAD_BYTES > 0 and len(payload) > _MAX_PAYLOAD_BYTES:
                # Already logged at WARNING in _set for the primary key;
                # the stale mirror is dropped here deliberately (log-silent
                # to avoid double-noise) — an outage fallback that no
                # longer matches reality is worse than none.
                await self._cache_redis.delete(_build_lkg_key(scope, endpoint, params))
                return
            await self._cache_redis.set(
                _build_lkg_key(scope, endpoint, params),
                f"{gen}{_LKG_STAMP_AT}{int(time.time())}{_LKG_STAMP_SEP}{payload}",
                ex=_LKG_TTL,
            )
        except (RedisError, Exception) as exc:
            logger.warning("graph_cache: LKG SET failed (%s)", exc)

    async def _read_lkg(
        self,
        scope: CacheScope,
        endpoint: str,
        params: dict[str, Any],
        *,
        at_generation: Optional[str] = None,
        max_age_s: Optional[int] = None,
    ) -> Optional[str]:
        """The raw mirrored payload, or ``None``.

        ``at_generation`` asks for it ONLY if it was computed at that
        generation — i.e. nothing has written to the source since. An entry
        written before the stamp existed has no generation to compare, so it
        answers no; the next real compute rewrites it stamped.

        ``max_age_s`` additionally refuses one older than that. The generation
        is the only thing standing between a promotion and an answer from
        another era, so an invalidation that never arrived — a write path that
        forgot its bump, a Redis blip during one — has nothing else to stop it
        for the whole LKG TTL. An age bound turns that from a day of silently
        wrong answers into hours.
        """
        if _LKG_TTL <= 0:
            return None
        try:
            raw = await self._cache_redis.get(_build_lkg_key(scope, endpoint, params))
        except RedisError as exc:
            logger.warning("graph_cache: LKG GET failed (%s)", exc)
            return None
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode()
        stamp, sep, body = raw.partition(_LKG_STAMP_SEP)
        written_at, written_ts = _parse_lkg_stamp(stamp) if sep else (None, None)
        if written_at is None:                      # not a stamp — legacy entry
            body = raw
        if at_generation is not None and written_at != at_generation:
            return None
        if (
            max_age_s is not None
            and written_ts is not None
            and time.time() - written_ts > max_age_s
        ):
            return None
        return body

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
        provider exception. Deliberately ignores the generation stamp: when
        the provider cannot answer at all, an out-of-date snapshot still
        beats an error."""
        body = await self._read_lkg(scope, endpoint, params)
        if body is None:
            return None
        try:
            return model_cls.model_validate_json(body)
        except Exception as exc:
            logger.warning("graph_cache: LKG deserialize failed (%s)", exc)
            return None

    async def _promote_mirror(
        self,
        scope: CacheScope,
        endpoint: str,
        params: dict[str, Any],
        model_cls: type[T],
        *,
        gen: str,
        cache_key: str,
        ttl_seconds: Optional[int],
    ) -> Optional[T]:
        """Serve an expired entry's mirror when the generation says the
        answer has not changed, and put it back under the primary key.

        The generation is the platform's own record that something was
        written; the TTL is a backstop against drift it cannot see. When the
        generation has not moved, a recompute returns the identical bytes —
        so the expiry costs a user ten seconds to be told the same thing.
        The mirror already holds those bytes.

        The mirror's OWN expiry is not extended, so no answer can outlive
        ``GRAPH_CACHE_LKG_TTL_S`` from when it was actually computed, however
        many times it is promoted. Promotion is bounded tighter still — twice
        the endpoint's TTL — because the generation is the ONLY thing between
        this path and an answer from another era, and a bump that never
        arrived leaves nothing else to catch it. Past that the answer is
        recomputed once, the way every expiry used to be. That is the bound on
        un-notified drift.
        """
        try:
            body = await self._read_lkg(
                scope, endpoint, params, at_generation=gen,
                max_age_s=_resolve_ttl(ttl_seconds, endpoint) * 2,
            )
            if body is None:
                return None
            warm = await _deserialize(model_cls, body)
        except Exception as exc:                    # noqa: BLE001 — see below
            # This read sits on the HAPPY path: before the promotion existed,
            # the mirror was only ever read after compute had already failed,
            # so anything the cache client raised could only make a failing
            # request fail differently. Now it runs before every compute, and
            # the cache must never become a hard dependency — the rule this
            # method's own module states and the whole design rests on. Any
            # failure here means no promotion and the compute below, which is
            # exactly the behaviour without it.
            logger.warning("graph_cache: mirror read failed (%s)", exc)
            return None
        # No ``scope``: the size histogram counts answers as COMPUTED, and
        # these bytes were already measured when they were. A promotion
        # re-storing them is not a second answer of that size.
        await self._set(cache_key, warm, ttl_seconds, endpoint, payload=body)
        # A promotion IS a fill: the bytes now under the primary key were put
        # there just now, which is what "built" claims. Without this the stamp
        # went blank for the whole window between the primary entry expiring
        # and a real recompute — so a cache serving promoted hits on every key
        # rendered "Not cached / nothing warm stored", on exactly the steady
        # read pattern the stamp was added to describe. The promotion only
        # fires when the mirror's stamp matches ``gen``, so recording it keeps
        # the generation honest.
        await self._note_built(scope, endpoint, ttl_seconds, gen)
        return warm


# ─── Module-level helpers ──────────────────────────────────────────────

def _gen_key(scope: CacheScope) -> str:
    """The CONTENT generation counter: nodes, edges, identity, mapping.

    In the key of every endpoint, so bumping it is the superset invalidation
    every write path can reach for without a judgement call about which reads
    its write could have moved.

    Deliberately NOT graph_ns-scoped: invalidation is by gen-bump (this
    key) + prefix SCAN (purge_lkg), both of which must cover every
    physical-graph variant of a (ws, ds) — a re-point's stale entries
    under the OLD graph_ns still need to die on the next write. Only the
    exact read/write key (_build_key/_build_lkg_key) needs graph_ns, to
    stop a re-point from serving the wrong graph's cached response
    before the next gen-bump.

    Deliberately NOT branch-scoped either, for the same reason in the other
    direction: both invalidation helpers build ``branch_id=""``, so a
    branch in the counter key meant a main-side rebuild never invalidated a
    single draft's cached reads. One counter for every branch of a source
    over-invalidates a draft on a main-side write, which costs a recompute;
    the alternative is enumerating live branches at every write, which costs
    correctness the moment the enumeration misses one.
    """
    return f"{_GEN_PREFIX}:{scope.workspace_id}:{scope.data_source_id}"


def _rollup_gen_key(scope: CacheScope) -> str:
    """The ROLLUP generation counter: the ``:AGGREGATED`` layer only.

    In the key of ``_ROLLUP_ENDPOINTS`` alone. One counter for both used to
    mean every completed rebuild — which rewrites rollup cells and nothing
    else — threw away children-with-edges, top-level, layer-assignment,
    edges-between and nodes-query too, on a fleet whose entire read capacity
    is six query threads per shard and whose cache is the only reason 300
    concurrent users fit inside it.

    Same scoping rationale as :func:`_gen_key`: (ws, ds) only.
    """
    return f"{_GEN_PREFIX}:rollup:{scope.workspace_id}:{scope.data_source_id}"


def _as_generation(raw: Any) -> int:
    """One counter's value: 0 when never set or unreadable."""
    if raw is None:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _parse_lkg_stamp(stamp: str) -> tuple[Optional[str], Optional[int]]:
    """An LKG entry's ``{generation}@{epoch}`` stamp, or ``(None, None)`` for
    an entry written before stamps existed (its payload is the whole value).

    The generation is compared as the OPAQUE STRING the key carries, never
    parsed back into numbers: it is one component built from two counters,
    and the only question asked of it is whether it is the same one.
    """
    token, _, written = stamp.partition(_LKG_STAMP_AT)
    if not token or any(not part.isdigit() for part in token.split(".")):
        return None, None
    return token, int(written) if written.isdigit() else None


async def _deserialize(model_cls: type[T], raw: Any) -> T:
    """Parse a cached payload, off the event loop when it is big enough to
    matter.

    The WRITE path was moved off-loop deliberately (see ``get_or_compute``);
    the read path runs far more often and was left inline. Payloads are
    allowed up to ``GRAPH_CACHE_MAX_PAYLOAD_BYTES`` (4 MiB), and a 4 MiB
    ``model_validate_json`` is 100-300ms during which NOTHING else on that
    worker runs — every other request, every other data source. The bytes are
    already in hand, so the threshold costs a ``len()``: small payloads (the
    overwhelming majority) skip the hop and pay nothing for it.
    """
    if len(raw) >= _DESERIALIZE_OFFLOAD_BYTES:
        return await asyncio.to_thread(model_cls.model_validate_json, raw)
    return model_cls.model_validate_json(raw)


def _genat_key(scope: CacheScope) -> str:
    # (ws, ds)-scoped coordination, same rationale as _gen_key above.
    return f"{_GENAT_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}"


def _builtat_key(scope: CacheScope) -> str:
    """When a compute was last STORED for this scope, and at which generation.

    The counterpart to :func:`_genat_key`, which records the opposite event.
    ``genat`` moves on every ``bump_generation`` — an INVALIDATION — and
    nothing else, so on its own it can only ever answer "when was this cache
    last thrown away". The cockpit rendered it under the word "updated",
    which reads as the reverse of what it is.

    Deliberately on the CACHE Redis, beside the entries, and written with the
    same TTL as the entry that produced it: the stamp then shares their fate.
    A Redis that was wiped or evicted loses the stamp too, so "last built"
    cannot outlive the thing it describes and claim a warm cache over an
    empty one.
    """
    return f"{_BUILTAT_PREFIX}:{scope.workspace_id}:{scope.data_source_id}:{scope.branch_id}"


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


def _oversized_key(cache_key: str) -> str:
    return f"{_OVERSIZED_PREFIX}:{cache_key}"


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
    if endpoint == ENDPOINT_TRACE_CLOSURE:
        return _DEFAULT_TRACE_CLOSURE_TTL
    if endpoint == ENDPOINT_TOP_LEVEL:
        return _DEFAULT_TOP_LEVEL_TTL
    if endpoint == ENDPOINT_LAYER_ASSIGNMENT:
        return _DEFAULT_LAYER_ASSIGNMENT_TTL
    if endpoint == ENDPOINT_CANVAS_BOOTSTRAP:
        return _DEFAULT_CANVAS_BOOTSTRAP_TTL
    if endpoint == ENDPOINT_CANVAS_EXPAND:
        return _DEFAULT_CANVAS_EXPAND_TTL
    if endpoint in (ENDPOINT_LINEAGE_BRIDGES, ENDPOINT_LINEAGE_BRIDGE_PATH):
        return _DEFAULT_LINEAGE_BRIDGES_TTL
    if endpoint in (ENDPOINT_EDGES_BETWEEN, ENDPOINT_NODES_QUERY):
        # Hydration reads — same gen-bump invalidation, same freshness as
        # children; a canvas re-open repeats the identical URN set.
        return _DEFAULT_CHILDREN_TTL
    return _DEFAULT_CHILDREN_TTL


def _is_empty_result(result: BaseModel) -> bool:
    """Detect "empty" responses — a ChildrenWithEdgesResult with no children,
    a TraceResult with no nodes, an aggregated result with no edges.

    Asked ONLY by ``_set_lkg``, which keeps an empty answer out of the outage
    mirror: "no children here" is indistinguishable to a reader from real
    data, so an unreachable store would quietly present an empty graph as
    fact.

    It no longer shortens the primary key's TTL, for any endpoint. That rule
    was written for the aggregated endpoint alone and then exempted it, which
    left the argument applying to everything except the one endpoint it was
    made about. The argument is the generation: an empty answer is the
    CORRECT answer for this generation, and every path that could make it
    untrue bumps the generation, which unreaches the entry outright. What the
    five-second window cost meanwhile was real — an empty leaf-container
    expand and an empty type-ahead search, which is an O(N) label scan on the
    shard, were both recomputed every five seconds for an answer that had not
    changed and could not change unnoticed.

    This is the same argument ``_is_incomplete_result`` already makes for a
    truncated answer: deterministic for (graph, request), invalidated by
    the generation, so it keeps the full TTL. A DEGRADED answer still takes
    the short window — that one is not reproducible, and a retry may do
    better.
    """
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


def _has_unprobed_frontier(result: BaseModel) -> bool:
    """A closure whose degree probe never ran.

    ``trace_closure`` drops the probe wave when the deadline is close, and
    logs-and-continues when it fails. Both leave the frontier shipped with
    ``totalCount=None`` on every entry — honest ("unknown", never zero"),
    but it is the DEGRADED form of the answer: the lens can only draw a
    countless chevron where it would otherwise say "+8 more". Pinning that
    for the full TTL makes one slow moment the workspace's answer for five
    minutes, and writing it to LKG makes it the answer for an outage.

    Only when EVERY entry across a non-empty frontier is countless — a
    partial probe (cap, or a single failed degree bucket) is a complete
    enough answer, and the walk itself is unaffected either way.
    """
    up = getattr(result, "frontier_up", None)
    down = getattr(result, "frontier_down", None)
    if up is None and down is None:
        return False
    entries = [*(up or []), *(down or [])]
    return bool(entries) and all(getattr(e, "total_count", None) is None for e in entries)


#: Cut reasons that make a result a PURE FUNCTION of (graph, request): the
#: same request returns the same rows and the same cursor, so the answer is
#: complete for what was asked and keeps the full TTL. Every other reason the
#: walk reports — timeout, seed/nodes/ancestors/descendants failed — means the
#: read gave up, and a retry may do better.
_DETERMINISTIC_CUTS = frozenset({"max_nodes", "degree_cap", "orphan", "truncated"})


def _is_incomplete_result(result: BaseModel) -> bool:
    """True only when the answer might be DIFFERENT if computed again.

    This decides between the full TTL and ``_NEGATIVE_TTL`` (5s), and the
    distinction that matters is determinism, not perfection:

    * A DEGRADED answer is one the provider gave up on — the read ladder
      returned the prefix it had, a degree probe was dropped for the
      deadline. Recomputing may well produce more. Pinning it for an hour
      makes one slow moment the workspace's answer for an hour, and writing
      it to last-known-good makes it the answer for an outage. Negative TTL.

    * A STALE answer is complete and correct for the graph as it stands; only
      the rollup is behind. Recomputing returns the identical bytes. The
      client is already told (``aggstale`` marker, ``CanvasFreshness``), and
      the rebuild's completion bumps the generation, which invalidates it for
      real. Caching it briefly buys nothing and costs a recompute.

    * A TRUNCATED answer hit a cap. It is a pure function of (graph,
      request): the same request returns the same rows and the same cursor.
      Full TTL for the same reason a closure page cut by ``max_nodes`` always
      kept it.

    Treating stale and truncated as degraded created a feedback loop with no
    hysteresis: saturation produces truncation, truncation dropped that
    scope's TTL 720-fold and stopped writing its fallback, and the resulting
    misses produced more saturation. On a large graph — where truncation is
    the normal case, not the exception — it meant the cache could never hold
    at all.
    """
    for obj in (
        result,
        getattr(result, "aggregated", None),
        getattr(result, "aggregated_delta", None),
    ):
        if obj is None:
            continue
        # The read ladder gave up part way and said so.
        if getattr(obj, "degraded_detail", None):
            return True
        # A cut whose REASON is a failure, not a cap. The closure walk reports
        # failures ahead of max_nodes precisely so this is distinguishable.
        if getattr(obj, "truncated", False):
            reason = getattr(obj, "truncation_reason", None)
            if reason is not None and reason not in _DETERMINISTIC_CUTS:
                return True
    return _has_unprobed_frontier(result)


async def invalidate_aggregated_reads(
    workspace_id: str, data_source_id: str, identity_stamped: int = 0,
) -> None:
    """THE invalidation choke point for the :AGGREGATED read caches.

    Call after ANY event that changes what the aggregated endpoints
    should answer — an aggregation run completing (or dying mid-write),
    a purge, a skip. Bumps the ROLLUP generation (unreaches every primary
    entry of the endpoints that read the rollup) AND purges the
    last-known-good entries — LKG keys survive generation bumps by design
    (they are the outage fallback), which is exactly how a purge stayed
    invisible: the primary entries expired in 60s but every degraded read
    kept serving the pre-purge LKG answer for up to its TTL.

    The rollup counter, not the content one, because a rebuild rewrites
    rollup cells and moves no node, edge or containment relationship — and
    this fires on every completed rebuild, on a fleet where the cache is the
    only thing that makes 300 concurrent users fit inside six query threads
    per shard.

    ``identity_stamped`` is the ONE exception and the hook that makes the
    split safe: a rollup run also calls ``stamp_identity_urns``, which writes
    ``urn``/``displayName`` onto the nodes — hierarchy CONTENT, which every
    endpoint reads. It is fill-only and reports how many nodes it stamped, so
    a non-zero count (and only a non-zero count) additionally bumps the
    content counter. The default of 0 keeps today's behaviour for callers
    that do not yet pass it.

    Best-effort: never raises.
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
        await cache.bump_rollup_generation(scope)
        if identity_stamped:
            await cache.bump_generation(scope)
        removed = await cache.purge_lkg(scope, ENDPOINT_AGGREGATED)
        logger.info(
            "aggregated-read caches invalidated for %s/%s (%d LKG purged, "
            "%d identity urns stamped)",
            workspace_id, data_source_id, removed, identity_stamped,
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


# ─── Hit-rate telemetry ────────────────────────────────────────────────
#
# The cache was the largest lever on read capacity and the only thing nobody
# could see. "Is it hitting?" was answered by reading TTL constants and
# inferring — which is how a view that cached for 5 seconds instead of an hour
# went unnoticed. These counters make the answer observable per data source
# and per endpoint.
#
# Shape: one HASH per (workspace, data source) per time bucket, fields
# "{endpoint}:{outcome}". Bucketed so the answer is a RATE over a window
# rather than a lifetime total that flattens every incident into noise, and
# TTL'd so a deleted source stops costing memory on its own.

# ─── Cross-process singleflight ────────────────────────────────────────
#
# The in-process singleflight collapses concurrent callers within ONE worker.
# The fleet runs 3 pods x 4 gunicorn workers = 12 processes, so a cold view
# opened by twelve people produced twelve identical computes — and on a
# million-node graph each of those is ~55 Cypher against the six query threads
# of one shard replica. Eleven of the twelve were pure waste, and they were
# the load that made the twelfth slow.
#
# So the pod-leaders elect a fleet-leader through the bus: one SET NX. The
# winner computes; the losers watch the cache key for its answer and take it.
# Every part of this fails OPEN — a bus that is down, a leader that dies, a
# wait that expires all end in "compute it yourself", which is exactly the
# behaviour that existed before.

_LEADER_PREFIX = "graphcache:lead:v1"

def _leader_ttl_ms() -> int:
    """How long one leader may hold the election WITHOUT renewing it.

    Short on purpose now that a live leader refreshes it (see
    ``_start_leader_renewal``). It used to have to outlive the slowest
    legitimate compute, which made it the detection time for a leader that
    CRASHED — and worse, an un-renewed lock under a compute that was still
    running lapsed and minted a brand-new duplicate leader every time it did.
    With renewal the two requirements come apart: 15s is how long a dead
    leader can strand its followers, and a live one holds its election for as
    long as it needs.
    """
    raw = _clamped_int_env("GRAPH_CACHE_LEADER_TTL_S", 15, lo=5, hi=600)
    return raw * 1000


_LEADER_TTL_MS = _leader_ttl_ms()
#: How often a live leader refreshes its election. A third of the TTL, so two
#: consecutive refreshes can be lost without the lock lapsing under a leader
#: that is still working.
_LEADER_RENEW_S = max(1.0, (_LEADER_TTL_MS / 1000.0) / 3.0)
#: How long a follower watches for the leader's answer when the caller names
#: no compute budget. Callers that name one derive the wait from it — see
#: :func:`_follower_deadline`, and ``GRAPH_CACHE_LEADER_WAIT_S`` below, which
#: an operator can set to clamp the derived value back down.
_LEADER_WAIT_S = float(_clamped_int_env("GRAPH_CACHE_LEADER_WAIT_S", 10, lo=1, hi=600))
#: True only when an operator actually set the knob. The flat 10s default is
#: not a ceiling anyone chose — it is the value that made the election a
#: latency tax on every endpoint it guards (see :func:`_follower_deadline`) —
#: so it must not clamp the derived wait, while a deliberate override must.
_LEADER_WAIT_IS_OPERATOR_SET = bool(os.getenv("GRAPH_CACHE_LEADER_WAIT_S"))
#: Base poll interval while watching. A read of one small key.
_LEADER_POLL_S = 0.05
#: Kill switch. Off falls straight back to per-process computes.
_LEADER_ENABLED = os.getenv("GRAPH_CACHE_CROSS_PROCESS_SINGLEFLIGHT", "1") != "0"

#: Release only our own election, never a successor's — the TTL may have
#: expired and handed leadership on while we were still working.
_RELEASE_LEADER_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""

#: Extend only our own election, for the same reason and with the same shape:
#: a leader whose lock already lapsed and was taken must not push out the
#: successor's.
_RENEW_LEADER_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
"""


def _follower_deadline(expected_compute_s: Optional[float]) -> float:
    """How long a follower watches the leader before computing its own.

    Derived from the compute it is waiting on, because a flat wait shorter
    than that compute is not an election at all. At 10s against the 36s
    aggregated read budget, every one of the eleven losing pod-leaders gave
    up and computed anyway — 10s LATE, landing on the shard while the
    leader's queries were still in flight. That is the election's full
    latency cost, none of its collapse, and a load-stacking amplifier on top.

    The 20% is for the round trips either side of the compute. Callers pass
    the endpoint's own budget, which is the request's budget, so the derived
    wait stays inside the tier above it by construction.
    """
    if not expected_compute_s or expected_compute_s <= 0:
        return _LEADER_WAIT_S
    deadline = expected_compute_s * 1.2
    if _LEADER_WAIT_IS_OPERATOR_SET:
        return min(deadline, _LEADER_WAIT_S)
    return deadline


def _poll_interval(waited: float) -> float:
    """Back the watch off as the wait goes on.

    The first second is where a fast leader lands, and is worth 50ms. After
    that the follower is waiting on a multi-second graph read, and asking
    twenty times a second only spends the store's capacity on the answer to
    "not yet" — across eleven followers on one contended key, hundreds of
    reads a second of it.
    """
    if waited < 1.0:
        return _LEADER_POLL_S
    if waited < 5.0:
        return _LEADER_POLL_S * 5
    return _LEADER_POLL_S * 10


_STATS_PREFIX = "graphcache:stats:v1"
#: Width of one counter bucket. Five minutes is fine enough to see a cache go
#: cold during an incident and coarse enough that a busy fleet writes few keys.
_STATS_BUCKET_S = 300
#: How many buckets are kept. Two hours of history at the width above.
_STATS_BUCKETS_KEPT = 24
_STATS_TTL_S = _STATS_BUCKET_S * _STATS_BUCKETS_KEPT

#: The outcomes worth telling apart. ``stale`` is a hit that served the
#: last-known-good snapshot — it kept the user moving but it is NOT the cache
#: working as intended, so it never counts toward the hit ratio.
CACHE_OUTCOMES = ("hit", "miss", "stale", "bypass", "too_large")

#: Serialized answer sizes, bucketed. ``too_large`` already says WHETHER an
#: answer fit under ``_MAX_PAYLOAD_BYTES``; nothing said by how much, which is
#: the number any decision about widening what an endpoint returns turns on —
#: an answer that grows past the cap is deleted and never cached at all, so a
#: change that looks like a cache-key improvement can silently stop an
#: endpoint caching. Upper bound per bucket, in bytes; anything above the last
#: one lands in ``over``.
_SIZE_BUCKETS: Tuple[Tuple[int, str], ...] = (
    (64 * 1024, "64k"),
    (256 * 1024, "256k"),
    (1024 * 1024, "1m"),
    (4 * 1024 * 1024, "4m"),
)
SIZE_BUCKET_LABELS = tuple(label for _, label in _SIZE_BUCKETS) + ("over",)


def _size_bucket(nbytes: int) -> str:
    for upper, label in _SIZE_BUCKETS:
        if nbytes <= upper:
            return label
    return "over"


def _stats_key(workspace_id: str, data_source_id: str, bucket: int) -> str:
    return f"{_STATS_PREFIX}:{workspace_id}:{data_source_id or '-'}:{bucket}"


def _current_bucket() -> int:
    return int(time.time()) // _STATS_BUCKET_S


#: How long counts sit in process before they are flushed. The window the
#: numbers describe is five minutes wide, so a second of lag is invisible in
#: the answer and turns a per-read task into one batch for a whole fleet's
#: worth of reads.
_STATS_FLUSH_S = 1.0
#: Hard bound on the pending map — one entry per (bucket key, field), so it is
#: already small; this stops a bus that has been down for hours from growing
#: it without limit. Telemetry may be lost, never memory.
_STATS_MAX_PENDING = 10_000


def _cache_metric(name: str, **labels: str) -> None:
    """Emit, and never let emitting fail a read."""
    try:
        from backend.app.jobs.metrics import increment

        increment(name, **labels)
    except Exception:  # noqa: BLE001 — a counter is never worth a request
        pass


class _CacheStatsRecorder:
    """Fire-and-forget counter writes. Never delays or fails a request.

    Aggregated in process and flushed in batches, because the per-read version
    was one asyncio task per cached read doing TWO sequential commands on the
    coordination Redis — the client the whole design reserves for state whose
    loss corrupts rather than merely wastes. At the read rates this cache
    exists to serve, telemetry about the cache was a larger share of that
    client's traffic than everything it is actually for, in an unbounded task
    set. Counts are summed here and written once per flush as one pipelined
    batch per bucket key.
    """

    def __init__(self) -> None:
        # (bucket key, "endpoint:outcome") -> count
        self._pending: dict[tuple[str, str], int] = {}
        self._flusher: Optional[asyncio.Task] = None

    def record(self, cache: "GraphCache", scope: CacheScope,
               endpoint: str, outcome: str) -> None:
        if outcome not in CACHE_OUTCOMES or not scope.workspace_id:
            return
        # Also on the scrape, without the tenant. The Redis counters below
        # are per (workspace, source) and answer "is THIS source's cache
        # working"; the fleet's hit rate — the number that says whether 300
        # users are being served from cache at all — had no series anywhere.
        # Endpoint and outcome only: a workspace label would put a tenant
        # list in the scrape and multiply the cardinality by the tenancy.
        _cache_metric("graph_cache_reads_total", endpoint=endpoint, outcome=outcome)
        bucket = _current_bucket()
        field = (
            _stats_key(scope.workspace_id, scope.data_source_id, bucket),
            f"{endpoint}:{outcome}",
        )
        # …and the same count against the workspace ROLLUP key.
        #
        # ``read_cache_stats`` without a data source reads _stats_key(ws, None,
        # bucket), which resolves to the "-" slot — and nothing wrote it,
        # because every real read carries a data source. So the one surface in
        # the product that answers "how much read load is the cache actually
        # absorbing" — CacheHealthCard on Admin → Graph store — returned all
        # zeros and an empty endpoint map until an operator drilled into a
        # single source, which reads as "no traffic" rather than "wrong key".
        # One extra field per flush batch, on a map that is already keyed by
        # (key, field), so it costs one HINCRBY in the same pipeline.
        rollup = (_stats_key(scope.workspace_id, "", bucket), f"{endpoint}:{outcome}")
        # The bound covers BOTH fields. Counting only the per-source one let
        # the rollup grow past _STATS_MAX_PENDING while the bus was down,
        # which is the unbounded map this cap exists to prevent.
        for entry in (field, rollup):
            self._add(entry, 1)
        self._arm(cache)

    def record_size(self, cache: "GraphCache", scope: CacheScope,
                    endpoint: str, nbytes: int) -> None:
        """How big one computed answer serialized to, whether or not it fit.

        Rides the same pending map and the same flush, so it costs no extra
        round trip: three more HINCRBY fields in a batch that is already
        keyed by (bucket key, field)."""
        if not scope.workspace_id or nbytes < 0:
            return
        bucket = _current_bucket()
        label = _size_bucket(nbytes)
        for key in (
            _stats_key(scope.workspace_id, scope.data_source_id, bucket),
            _stats_key(scope.workspace_id, "", bucket),
        ):
            self._add((key, f"{endpoint}:sz:{label}"), 1)
            self._add((key, f"{endpoint}:szsum"), nbytes)
            self._add((key, f"{endpoint}:szn"), 1)
        self._arm(cache)

    def _add(self, entry: tuple, amount: int) -> None:
        """One pending count, under the bound. A map that grows while the bus
        is down is the leak ``_STATS_MAX_PENDING`` exists to prevent."""
        if entry not in self._pending and len(self._pending) >= _STATS_MAX_PENDING:
            return
        self._pending[entry] = self._pending.get(entry, 0) + amount

    def _arm(self, cache: "GraphCache") -> None:
        if self._flusher is None or self._flusher.done():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:                   # pragma: no cover — no loop
                return
            self._flusher = loop.create_task(self._run(cache))

    async def _run(self, cache: "GraphCache") -> None:
        """One task for the process, not one per read. Ends when there is
        nothing left to write, and ``record`` starts another."""
        while self._pending:
            await asyncio.sleep(_STATS_FLUSH_S)
            await self.flush(cache)

    async def flush(self, cache: "GraphCache") -> None:
        """Write every pending count as one pipelined batch per bucket key.

        The counts are taken out of the map FIRST: a flush that raises has
        already dropped them, which is the right trade for telemetry — the
        alternative is retrying counters into a bus that is failing, forever.
        """
        pending, self._pending = self._pending, {}
        if not pending:
            return
        by_key: dict[str, dict[str, int]] = {}
        for (key, field), count in pending.items():
            by_key.setdefault(key, {})[field] = count
        try:
            pipe = cache._coord_redis.pipeline(transaction=False)
            for key, fields in by_key.items():
                for field, count in fields.items():
                    pipe.hincrby(key, field, count)
                pipe.expire(key, _STATS_TTL_S)
            await pipe.execute()
        except Exception:                          # noqa: BLE001 — telemetry
            pass


_stats_recorder = _CacheStatsRecorder()


async def read_cache_stats(
    workspace_id: str,
    data_source_id: Optional[str] = None,
    *,
    buckets: int = _STATS_BUCKETS_KEPT,
) -> dict[str, Any]:
    """Hit ratio for a workspace (or one data source) over the recent window.

    Returns per-endpoint counts plus a total. ``hit_ratio`` counts only real
    hits: a stale-fallback kept the user moving but the provider still could
    not answer, and folding it in would make an outage look like a cache win.

    ``too_large`` rides alongside rather than inside the ratio. It counts
    computes whose answer exceeded ``GRAPH_CACHE_MAX_PAYLOAD_BYTES`` and
    were therefore never stored — the read was a miss and is counted as
    one, but WHY every repeat of it also misses is a fact about the cap,
    not about the cache working. Without it a capped endpoint reads as a
    flat 0% with nothing to point at.
    Empty rather than raising when the bus is unavailable — this is telemetry.
    """
    out: dict[str, Any] = {"endpoints": {}, "totals": {o: 0 for o in CACHE_OUTCOMES}}
    sizes: dict[str, dict[str, int]] = {}

    def _size_row(endpoint: str) -> dict[str, int]:
        return sizes.setdefault(
            endpoint, {**{b: 0 for b in SIZE_BUCKET_LABELS}, "sum": 0, "n": 0},
        )

    if not workspace_id:
        return out
    try:
        cache = get_graph_cache()
        now = _current_bucket()
        keys = [
            _stats_key(workspace_id, data_source_id or "", now - i)
            for i in range(max(1, min(buckets, _STATS_BUCKETS_KEPT)))
        ]
        pipe = cache._coord_redis.pipeline(transaction=False)
        for key in keys:
            pipe.hgetall(key)
        for entry in await pipe.execute():
            for field, count in (entry or {}).items():
                field = field.decode() if isinstance(field, bytes) else str(field)
                endpoint, _, outcome = field.rpartition(":")
                if endpoint.endswith(":sz"):
                    _size_row(endpoint[:-3])[outcome] += int(count)
                    continue
                if outcome in ("szsum", "szn"):
                    _size_row(endpoint)[outcome[2:]] += int(count)
                    continue
                if outcome not in CACHE_OUTCOMES:
                    continue
                row = out["endpoints"].setdefault(
                    endpoint, {o: 0 for o in CACHE_OUTCOMES},
                )
                row[outcome] += int(count)
                out["totals"][outcome] += int(count)
    except Exception as exc:                       # noqa: BLE001 — telemetry
        logger.debug("graph_cache: stats read failed: %s", exc)
        return out

    def _ratio(row: dict[str, int]) -> Optional[float]:
        served = row["hit"] + row["miss"] + row["stale"]
        return round(row["hit"] / served, 4) if served else None

    for row in out["endpoints"].values():
        row["hit_ratio"] = _ratio(row)
    out["totals"]["hit_ratio"] = _ratio(out["totals"])

    # How big the answers actually are, per endpoint. ``over`` is the count
    # that never reached the cache at all: the entry is deleted and the
    # compute repeats on every read.
    total_sizes = {**{b: 0 for b in SIZE_BUCKET_LABELS}, "sum": 0, "n": 0}
    for endpoint, row in sizes.items():
        samples = row["n"]
        if endpoint not in out["endpoints"]:
            # Sizes without counts: the bucket keys rolled over between the
            # two writes. An endpoint row with no reads still beats dropping
            # the measurement.
            out["endpoints"][endpoint] = {
                **{o: 0 for o in CACHE_OUTCOMES}, "hit_ratio": None,
            }
        out["endpoints"][endpoint]["payload"] = {
            "buckets": {b: row[b] for b in SIZE_BUCKET_LABELS},
            "samples": samples,
            "mean_bytes": round(row["sum"] / samples) if samples else None,
        }
        for field in (*SIZE_BUCKET_LABELS, "sum", "n"):
            total_sizes[field] += row[field]
    out["totals"]["payload"] = {
        "buckets": {b: total_sizes[b] for b in SIZE_BUCKET_LABELS},
        "samples": total_sizes["n"],
        "mean_bytes": (
            round(total_sizes["sum"] / total_sizes["n"]) if total_sizes["n"] else None
        ),
    }
    out["payload_cap_bytes"] = _MAX_PAYLOAD_BYTES
    out["window_seconds"] = _STATS_BUCKET_S * min(buckets, _STATS_BUCKETS_KEPT)
    return out


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
) -> dict[tuple[str, str], tuple[Optional[int], Optional[str], Optional[str], Optional[str]]]:
    """Batch-read the freshness signals for many ``(workspace_id,
    data_source_id)`` pairs — the fleet freshness view's only cache round
    trip. Four signals, and three of them answer DIFFERENT questions that
    were previously collapsed into one word on screen:

    * ``generation`` — which version of this source's cache is being served.
      It is part of every cache key, so a reader either gets an answer built
      at this number or computes a new one.
    * ``cache_as_of`` — when the cache was last INVALIDATED (the last
      ``bump_generation``). Not when it was last filled; nothing writes this
      key on a cache write.
    * ``built_at`` — when a compute was last STORED, and at which
      generation. Lives on the CACHE Redis with the entries and carries
      their TTL, so it disappears when they do rather than claiming a warm
      cache over an empty one.
    * ``stale_reason`` — the stale-while-revalidate marker.

    Two pipelines because the two stamps deliberately live on different
    instances, and they fail independently: a cache-Redis outage loses
    ``built_at`` (correctly — it also means there are no entries) without
    costing the coordination signals.

    Returns a dict keyed by ``(str(ws), str(ds))``; any missing or
    unparseable value is ``None``. Best-effort throughout: never raises."""
    clean = [(str(ws), str(ds)) for ws, ds in pairs if ws and ds]
    result: dict[
        tuple[str, str],
        tuple[Optional[int], Optional[str], Optional[str], Optional[str]],
    ] = {pair: (None, None, None, None) for pair in clean}
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
    built: list[Optional[str]] = [None] * len(clean)
    try:
        cache = get_graph_cache()
        bpipe = cache._cache_redis.pipeline(transaction=False)
        for ws, ds in clean:
            bpipe.get(_builtat_key(
                CacheScope(workspace_id=ws, data_source_id=ds, branch_id=""),
            ))
        built = list(await bpipe.execute())
    except Exception as exc:
        logger.warning(
            "graph_cache: read_freshness_signals built-at leg failed for %d "
            "pairs: %s", len(clean), exc,
        )
    for idx, pair in enumerate(clean):
        gen_raw, genat_raw, stale_raw = raw[idx * 3: idx * 3 + 3]
        try:
            gen = int(gen_raw) if gen_raw is not None else None
        except (TypeError, ValueError):
            gen = None
        result[pair] = (gen, genat_raw, stale_raw, built[idx] if idx < len(built) else None)
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
    Reads the current generation first so the SCAN patterns lock to it —
    stale-generation and LKG keys (a different prefix) never match.

    Two patterns because the generation segment has two shapes: the content
    counter alone, and ``content.rollup`` for the endpoints that read the
    rollup layer. Both are ONE segment, so the endpoint's index is the same
    in either.

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
        tally: dict[str, int] = {}
        for pattern in (
            f"{_KEY_PREFIX}:{ws}:{ds}:{branch}:{gen}:*",
            f"{_KEY_PREFIX}:{ws}:{ds}:{branch}:{gen}.*",
        ):
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
    half — see :func:`purge_aggregated_lkg`.

    The CONTENT counter, unlike :func:`invalidate_aggregated_reads`: its
    callers are the ontology and node-identity writers, and an alias map or a
    display-name rule changes what the hierarchy endpoints answer too, not
    just the rollup. Content is in every endpoint's key, so this reaches the
    aggregated reads as well. Best-effort: never raises."""
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


#: Fleet-wide read-your-own-writes, the coordination half.
#:
#: The provider's settle pin is per-process, and the fleet is a dozen
#: processes — so eleven read-backs in twelve carried no pin, went to a
#: replica, and (because the write had just bumped the generation, making the
#: read-back a guaranteed miss) had whatever the replica said written back
#: under the new generation with an hour's TTL, for every user on every pod.
#:
#: The stamp lives on the COORDINATION client, beside the generation counter
#: it exists to keep honest, not on the cache-payload client: losing it
#: silently returns the fleet to the per-process behaviour, which is the thing
#: being fixed. A boolean with a TTL rather than a timestamp, because pod
#: clocks do not agree and this question does not need them to.
_WROTE_PREFIX = "graphcache:wrote:v1"


def _wrote_key(graph_key: str) -> str:
    return f"{_WROTE_PREFIX}:{graph_key}"


#: Neither call may delay the path it sits on. The stamp rides a write and
#: the probe rides a read, and a coordination bus that is slow must cost the
#: fleet its read-your-own-writes pin rather than its latency — the pin is a
#: correctness nicety over a window measured in seconds, and blocking a read
#: on it would trade a rare stale answer for a routine slow one.
_FLEET_STAMP_BUDGET_S = 0.25


async def _note_fleet_write(graph_key: str) -> None:
    """Mark ``graph_key`` as just written, fleet-wide. Never raises and never
    waits: the provider falls back to its local pin, which is the behaviour
    that existed before this."""
    try:
        ttl = max(1, int(_settle_window_secs()))
        async with asyncio.timeout(_FLEET_STAMP_BUDGET_S):
            await get_graph_cache()._coord_redis.set(
                _wrote_key(graph_key), "1", ex=ttl,
            )
    except Exception as exc:                      # noqa: BLE001 — fail open
        logger.debug("graph_cache: fleet write stamp failed (%s)", exc)


async def _fleet_wrote_recently(graph_key: str) -> bool:
    """True while any process in the fleet has written ``graph_key`` inside
    the settle window. False on any error or delay — the read then follows
    the local pin alone, exactly as it did before."""
    try:
        async with asyncio.timeout(_FLEET_STAMP_BUDGET_S):
            return bool(
                await get_graph_cache()._coord_redis.exists(_wrote_key(graph_key))
            )
    except Exception as exc:                      # noqa: BLE001 — fail open
        logger.debug("graph_cache: fleet write probe failed (%s)", exc)
        return False


def _settle_window_secs() -> float:
    """Read the provider's own window rather than keeping a second copy of
    it: a deployment that lengthens the settle window must lengthen the stamp
    with it, or the pin expires before the window it implements."""
    try:
        from backend.app.providers.falkordb_provider import _REPLICA_READ_SETTLE_S

        return float(_REPLICA_READ_SETTLE_S)
    except Exception:                             # noqa: BLE001
        return 10.0


_fleet_stamps_installed = False


def install_fleet_write_stamps() -> None:
    """Hand the provider the two callables. Idempotent.

    Installed from :func:`get_graph_cache` rather than from an application
    startup hook, deliberately: the pin has to be live in every process that
    can serve a read of a graph somebody just wrote, and that is not only the
    web tier — it is every gunicorn worker, and anything else that resolves
    the cache. Hanging it off the singleton means no process can acquire the
    cache without it."""
    global _fleet_stamps_installed
    if _fleet_stamps_installed:
        return
    _fleet_stamps_installed = True
    try:
        from backend.app.providers.falkordb_provider import set_fleet_write_stamps

        set_fleet_write_stamps(_note_fleet_write, _fleet_wrote_recently)
        logger.info(
            "graph_cache: fleet-wide read-your-own-writes pin installed "
            "(window %.0fs)", _settle_window_secs(),
        )
    except Exception as exc:                      # noqa: BLE001 — never fatal
        logger.warning(
            "graph_cache: could not install the fleet write pin (%s); "
            "read-your-own-writes stays per-process", exc,
        )


def get_graph_cache() -> GraphCache:
    """Return the process-wide GraphCache. Lazy-initialised on first use
    so test code can patch `get_redis()` before this fires."""
    global _cache
    if _cache is None:
        _cache = GraphCache(get_redis(), _resolve_cache_role_client())
        install_fleet_write_stamps()
    return _cache


def reset_graph_cache_for_tests() -> None:
    """Drop the singleton so a fresh fixture can install its own."""
    global _cache, _fleet_stamps_installed
    _cache = None
    _fleet_stamps_installed = False

"""Cache pre-warmer for top-level + 1-level-down navigation entry points.

POST-COMMIT TRIGGER (P2.1.4):
The collector and worker cooperate via the ``defer_warm`` / ``fire_deferred_warm``
pair to avoid the race documented in the review: the collector cannot
fire ``schedule_warm`` directly because the worker hasn't committed the
DB session yet, and the warmer opens its own readonly session which
would race the commit (worse against a read replica). Instead the
collector calls ``defer_warm`` to stash the warm request on a
``contextvars.ContextVar``, and the worker calls ``fire_deferred_warm``
*after* ``session.commit()`` succeeds. The ContextVar makes this
safe under asyncio task switching (per-task state, not module-global).

Fired post-stats-poll for each data source. Fills the GraphCache for the
three endpoints a user hits the moment they open a data source:

    /nodes/top-level                — the entry list
    /edges/aggregated               — rollup between top-level URNs
    /nodes/{urn}/children-with-edges — top-level + their first N children

The warm function uses the same ``GraphCache.get_or_compute`` path as the
HTTP handlers, so the cache key shape is guaranteed to match — the first
user request after a warm cycle is a cache hit. Compute calls go through
the ContextEngine (same as a real request), so per-op timeouts,
circuit-breakers, and load-shed signals apply identically.

Bounds:
- Per-DS lock (Redis SET NX) prevents two replicas warming the same DS
- Outer wall-clock timeout (``CACHE_PREWARM_DS_TIMEOUT_SECS``)
- Per-step exception isolation — ProviderUnavailable/TimeoutError aborts
  further steps for *that DS only*
- Size gate — DS with ``node_count > CACHE_PREWARM_MAX_NODE_COUNT`` are
  skipped (the navigation-entry-point assumption doesn't hold at scale)
- Fan-out caps — ``TOP_LEVEL_LIMIT``, ``CHILDREN_FANOUT``,
  ``ONE_DOWN_FANOUT`` (all env-tunable)
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
from dataclasses import dataclass, field
from typing import Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import PoolRole, get_session_factory
from backend.app.models.graph import AggregatedEdgeRequest, ChildrenWithEdgesResult, TopLevelNodesResult
from backend.app.models.graph import AggregatedEdgeResult
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.aggregation.redis_client import get_redis
from backend.app.services.context_engine import ContextEngine
from backend.app.services.graph_cache import (
    CacheScope,
    ENDPOINT_AGGREGATED,
    ENDPOINT_CHILDREN,
    ENDPOINT_TOP_LEVEL,
    get_graph_cache,
)
from backend.common.adapters import ProviderUnavailable

logger = logging.getLogger(__name__)


# ── env-tunable knobs ──────────────────────────────────────────────────

def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name, "1" if default else "0").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _clamped_int(name: str, default: int, *, lo: int, hi: int) -> int:
    """Read an int env var, fall back on bad input, clamp out-of-range
    to ``[lo, hi]`` with a WARNING. Same shape as ``graph_cache._clamped_int_env``."""
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        parsed = int(raw)
    except ValueError:
        logger.warning(
            "cache_warmer: %s=%r is not an integer; falling back to default %d",
            name, raw, default,
        )
        return default
    if parsed < lo:
        logger.warning("cache_warmer: %s=%d below safe min %d; clamping up", name, parsed, lo)
        return lo
    if parsed > hi:
        logger.warning("cache_warmer: %s=%d above safe max %d; clamping down", name, parsed, hi)
        return hi
    return parsed


def _clamped_float(name: str, default: float, *, lo: float, hi: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        parsed = float(raw)
    except ValueError:
        logger.warning(
            "cache_warmer: %s=%r is not a number; falling back to default %.1f",
            name, raw, default,
        )
        return default
    if parsed < lo:
        logger.warning("cache_warmer: %s=%.2f below safe min %.2f; clamping up", name, parsed, lo)
        return lo
    if parsed > hi:
        logger.warning("cache_warmer: %s=%.2f above safe max %.2f; clamping down", name, parsed, hi)
        return hi
    return parsed


# Master switch. When OFF, ``warm_data_source`` is a no-op so the stats
# worker's post-poll hook can stay wired unconditionally.
CACHE_PREWARM_ENABLED: bool = _flag("CACHE_PREWARM_ENABLED", default=True)

# Top-level page size requested during warm. Bounds: 1 (anything less
# is useless) up to 500 (covers the largest realistic top-level set
# without inviting unbounded fan-out).
TOP_LEVEL_LIMIT: int = _clamped_int("CACHE_PREWARM_TOP_LEVEL_LIMIT", 50, lo=1, hi=500)

# How many top-level URNs we expand into their direct children. Bounds
# the worst-case provider load per warm cycle. Max 200 caps the worst
# case at ~200 children calls per DS per cycle.
CHILDREN_FANOUT: int = _clamped_int("CACHE_PREWARM_CHILDREN_FANOUT", 20, lo=0, hi=200)

# Whether to run step 4 (warm children of children, "one level down")
# at all. Off by default after the review found this step to be the
# dominant load cost with the lowest reactive-hit-rate payoff. Operators
# can enable per-deployment once measured hit-rate data justifies the
# extra fan-out.
ENABLE_ONE_DOWN: bool = _flag("CACHE_PREWARM_ENABLE_ONE_DOWN", default=False)

# For each warmed top-level URN, how many of its direct children we then
# warm one level further (when ``ENABLE_ONE_DOWN`` is on). 0 also
# disables the pass even when the flag is on.
ONE_DOWN_FANOUT: int = _clamped_int("CACHE_PREWARM_ONE_DOWN_FANOUT", 10, lo=0, hi=100)

# Skip pre-warming for graphs above this node count. Bounds: at least
# 1k (smaller is meaningless), at most 100M (anything bigger is a
# different system).
MAX_NODE_COUNT: int = _clamped_int(
    "CACHE_PREWARM_MAX_NODE_COUNT", 500_000, lo=1_000, hi=100_000_000,
)

# Outer wall-clock budget for one warm cycle. 5s floor so we never
# punish a fast cycle with a sub-second deadline; 10min ceiling because
# anything longer is doing different work.
DS_TIMEOUT_SECS: float = _clamped_float(
    "CACHE_PREWARM_DS_TIMEOUT_SECS", 60.0, lo=5.0, hi=600.0,
)

# Lock TTL must always exceed ``DS_TIMEOUT_SECS`` so an in-flight warm
# doesn't have its lock expire under itself, and must be short enough
# that a crashed pod doesn't pin the lock for too long. Floor enforces
# the warm-fits-inside invariant.
_LOCK_TTL_SECS: int = _clamped_int(
    "CACHE_PREWARM_LOCK_TTL_SECS",
    max(int(DS_TIMEOUT_SECS) + 30, 90),
    lo=max(int(DS_TIMEOUT_SECS) + 5, 30),
    hi=1800,
)
_LOCK_PREFIX = "cache_warm:lock"

# Process-wide cap on concurrent warm cycles. Without this, 50 stats
# polls completing in the same 30s window each spawn their own
# ``schedule_warm`` task and FalkorDB's single-threaded Cypher path is
# hit by hundreds of concurrent queries. The semaphore caps in-flight
# warms across all data sources for one process; the per-DS Redis
# SET-NX lock still deduplicates across replicas. Bounds: 1..32.
GLOBAL_CONCURRENCY: int = _clamped_int(
    "CACHE_PREWARM_GLOBAL_CONCURRENCY", 4, lo=1, hi=32,
)
_global_warm_semaphore: asyncio.Semaphore = asyncio.Semaphore(GLOBAL_CONCURRENCY)

# Random jitter window applied when ``schedule_warm`` is called. Without
# jitter, 50 stats polls completing in the same second all fire warm
# immediately and saturate the semaphore. With ±N seconds of jitter the
# warms spread evenly over the cycle. Bounds: 0..120s.
JITTER_SECS: float = _clamped_float(
    "CACHE_PREWARM_JITTER_SECS", 30.0, lo=0.0, hi=120.0,
)


@dataclass
class WarmResult:
    """Lightweight report for callers/tests."""
    skipped_reason: Optional[str] = None
    top_level_filled: bool = False
    aggregated_filled: bool = False
    children_filled: int = 0
    one_down_filled: int = 0
    errors: list[str] = field(default_factory=list)


async def warm_data_source(
    *,
    ws_id: str,
    ds_id: str,
    node_count: int = 0,
    session: Optional[AsyncSession] = None,
) -> WarmResult:
    """Pre-warm the GraphCache for ``(ws_id, ds_id)``.

    ``node_count`` is the stats-service-tracked node count for this DS;
    used as the size gate. Pass 0 if unknown — the gate then admits the
    DS (best-effort).

    ``session`` is optional. The post-poll hook in collector fires this
    fire-and-forget, so a fresh session is opened here. Tests pass in
    a mock session to avoid the factory.

    Never raises. Errors are logged + collected into ``WarmResult.errors``.
    """
    result = WarmResult()
    if not CACHE_PREWARM_ENABLED:
        result.skipped_reason = "feature_flag_off"
        return result
    if MAX_NODE_COUNT > 0 and node_count > MAX_NODE_COUNT:
        result.skipped_reason = f"node_count_{node_count}_over_cap_{MAX_NODE_COUNT}"
        return result

    # Global concurrency cap — bounds total in-flight warms across all
    # data sources for this process. Acquired BEFORE the Redis lock so
    # we don't hold the lock while waiting for a semaphore slot.
    async with _global_warm_semaphore:
        return await _warm_data_source_locked(
            ws_id=ws_id, ds_id=ds_id,
            session=session, result=result,
        )


async def _warm_data_source_locked(
    *,
    ws_id: str,
    ds_id: str,
    session: Optional[AsyncSession],
    result: WarmResult,
) -> WarmResult:
    """Inner body of ``warm_data_source`` — runs under the global
    semaphore. Split out so the semaphore acquisition is the *only*
    work that happens before the per-DS lock contention."""
    redis = get_redis()
    lock_key = f"{_LOCK_PREFIX}:{ws_id}:{ds_id}"
    # SET NX with TTL — atomic acquisition with auto-release on crash.
    acquired = False
    try:
        acquired = bool(await redis.set(lock_key, "1", nx=True, ex=_LOCK_TTL_SECS))
    except Exception as exc:  # pragma: no cover — broker outage
        result.skipped_reason = f"lock_acquire_failed:{type(exc).__name__}"
        return result
    if not acquired:
        result.skipped_reason = "lock_held_elsewhere"
        return result

    try:
        if session is not None:
            await asyncio.wait_for(
                _warm_steps(ws_id=ws_id, ds_id=ds_id, session=session, result=result),
                timeout=DS_TIMEOUT_SECS,
            )
        else:
            # Fire-and-forget path: open our own readonly session.
            factory = get_session_factory(PoolRole.READONLY)
            async with factory() as own_session:
                await asyncio.wait_for(
                    _warm_steps(ws_id=ws_id, ds_id=ds_id, session=own_session, result=result),
                    timeout=DS_TIMEOUT_SECS,
                )
    except asyncio.TimeoutError:
        result.errors.append(f"timeout_after_{DS_TIMEOUT_SECS}s")
        logger.info("cache_warmer: ws=%s ds=%s exceeded %.0fs budget", ws_id, ds_id, DS_TIMEOUT_SECS)
    finally:
        try:
            await redis.delete(lock_key)
        except Exception:  # pragma: no cover
            pass

    logger.info(
        "cache_warmer: ws=%s ds=%s top_level=%s aggregated=%s children=%d one_down=%d errors=%d",
        ws_id, ds_id,
        result.top_level_filled, result.aggregated_filled,
        result.children_filled, result.one_down_filled,
        len(result.errors),
    )
    return result


async def _warm_steps(
    *,
    ws_id: str,
    ds_id: str,
    session: AsyncSession,
    result: WarmResult,
) -> None:
    """Inner warm sequence. Each step is independent failure-wise but
    later steps depend on earlier output, so a failed step short-circuits
    the remaining steps for this DS."""
    try:
        engine = await ContextEngine.for_workspace(
            ws_id, provider_registry, session, data_source_id=ds_id,
        )
    except Exception as exc:
        result.errors.append(f"engine_resolve:{type(exc).__name__}")
        return

    scope = CacheScope(workspace_id=ws_id, data_source_id=ds_id)
    cache = get_graph_cache()

    # ── 1. top-level nodes ────────────────────────────────────────────
    top_level: Optional[TopLevelNodesResult] = None
    try:
        top_level = await cache.get_or_compute(
            scope=scope,
            endpoint=ENDPOINT_TOP_LEVEL,
            params={
                "entityTypes": None,
                "searchQuery": None,
                "limit": TOP_LEVEL_LIMIT,
                "cursor": None,
                "includeChildCount": True,
            },
            compute=lambda: engine.get_top_level_or_orphan_nodes(
                entity_types=None,
                search_query=None,
                limit=TOP_LEVEL_LIMIT,
                cursor=None,
                include_child_count=True,
            ),
            model_cls=TopLevelNodesResult,
        )
        result.top_level_filled = True
    except (ProviderUnavailable, asyncio.TimeoutError) as exc:
        result.errors.append(f"top_level:{type(exc).__name__}")
        return
    except Exception as exc:
        result.errors.append(f"top_level:{type(exc).__name__}:{exc}")
        return

    top_urns = [n.urn for n in (top_level.nodes if top_level else [])]
    if not top_urns:
        return  # empty DS — nothing else to warm

    # ── 2. aggregated edges between top-level URNs ────────────────────
    try:
        agg_req = AggregatedEdgeRequest(sourceUrns=sorted(top_urns))
        await cache.get_or_compute(
            scope=scope,
            endpoint=ENDPOINT_AGGREGATED,
            params={
                "sourceUrns": sorted(top_urns),
                "targetUrns": None,
                "granularity": None,
                "includeEdgeTypes": None,
                "lineageEdgeTypes": None,
                "containmentEdgeTypes": None,
            },
            compute=lambda: engine.get_aggregated_edges(agg_req),
            model_cls=AggregatedEdgeResult,
        )
        result.aggregated_filled = True
    except (ProviderUnavailable, asyncio.TimeoutError) as exc:
        result.errors.append(f"aggregated:{type(exc).__name__}")
        # Don't return — children warm is still useful even if aggregated failed.
    except Exception as exc:
        result.errors.append(f"aggregated:{type(exc).__name__}:{exc}")

    # ── 3. children for each top-level URN (capped) ───────────────────
    one_down_urns: list[str] = []
    for urn in top_urns[:CHILDREN_FANOUT]:
        try:
            children_result = await cache.get_or_compute(
                scope=scope,
                endpoint=ENDPOINT_CHILDREN,
                params=_default_children_params(urn),
                compute=lambda u=urn: engine.get_children_with_edges(
                    u,
                    edge_types=None,
                    lineage_edge_types=None,
                    search_query=None,
                    limit=100,
                    offset=0,
                    include_lineage_edges=True,
                    sort_property="displayName",
                    cursor=None,
                ),
                model_cls=ChildrenWithEdgesResult,
            )
            result.children_filled += 1
            for child in children_result.children[:ONE_DOWN_FANOUT]:
                one_down_urns.append(child.urn)
        except (ProviderUnavailable, asyncio.TimeoutError) as exc:
            result.errors.append(f"children:{urn}:{type(exc).__name__}")
            return  # provider going bad — stop adding load
        except Exception as exc:
            result.errors.append(f"children:{urn}:{type(exc).__name__}:{exc}")

    # ── 4. children for 1-level-down URNs ─────────────────────────────
    # Opt-in: this step is the dominant load cost in the warm cycle and
    # the lowest reactive-hit-rate payoff. Off by default; enable via
    # ``CACHE_PREWARM_ENABLE_ONE_DOWN=true`` once measured data justifies.
    if not ENABLE_ONE_DOWN:
        return
    for urn in one_down_urns[:CHILDREN_FANOUT * ONE_DOWN_FANOUT]:
        try:
            await cache.get_or_compute(
                scope=scope,
                endpoint=ENDPOINT_CHILDREN,
                params=_default_children_params(urn),
                compute=lambda u=urn: engine.get_children_with_edges(
                    u,
                    edge_types=None,
                    lineage_edge_types=None,
                    search_query=None,
                    limit=100,
                    offset=0,
                    include_lineage_edges=True,
                    sort_property="displayName",
                    cursor=None,
                ),
                model_cls=ChildrenWithEdgesResult,
            )
            result.one_down_filled += 1
        except (ProviderUnavailable, asyncio.TimeoutError) as exc:
            result.errors.append(f"one_down:{urn}:{type(exc).__name__}")
            return
        except Exception as exc:
            result.errors.append(f"one_down:{urn}:{type(exc).__name__}:{exc}")


# ── post-commit defer/fire pair (P2.1.4) ──────────────────────────────
#
# Collector handlers run inside the worker's session, BEFORE the worker
# commits. The warmer needs to read post-commit state (and would
# otherwise race the commit against a readonly replica). To bridge this
# without changing the dispatcher signature, the collector calls
# ``defer_warm(...)`` which stashes the request on a per-task
# ``ContextVar``. After ``session.commit()`` succeeds, the worker calls
# ``fire_deferred_warm()`` which reads-and-clears the ContextVar and
# schedules the warm via the existing ``schedule_warm`` path.

_deferred_warm: contextvars.ContextVar[Optional[Tuple[str, str, int]]] = (
    contextvars.ContextVar("_deferred_warm", default=None)
)


def defer_warm(ws_id: str, ds_id: str, node_count: int = 0) -> None:
    """Stash a warm request to be fired by ``fire_deferred_warm`` after
    the enclosing DB session commits. Per-task via ContextVar so two
    concurrent jobs cannot stomp each other's requests."""
    _deferred_warm.set((ws_id, ds_id, node_count))


def fire_deferred_warm() -> Optional[asyncio.Task]:
    """Read-and-clear the deferred warm slot for this task and schedule
    the warmer if one was set. Called from worker.py immediately AFTER
    ``await session.commit()``. Returns the scheduled task (or None) for
    test observability."""
    pending = _deferred_warm.get()
    if pending is None:
        return None
    _deferred_warm.set(None)
    ws_id, ds_id, node_count = pending
    return schedule_warm(ws_id=ws_id, ds_id=ds_id, node_count=node_count)


# ── fire-and-forget scheduling ────────────────────────────────────────

# Held strong references to in-flight warm tasks so the event loop's
# garbage collector doesn't drop them mid-run. The set is module-level
# (one per process); each task removes itself on completion.
_active_warm_tasks: set[asyncio.Task] = set()


def schedule_warm(ws_id: str, ds_id: str, node_count: int = 0) -> Optional[asyncio.Task]:
    """Schedule a warm cycle for ``(ws_id, ds_id)`` without awaiting it.

    Intended for the post-stats-poll hook: stats commits its job, then
    triggers a warm that runs concurrently with the next stats poll. The
    returned task is tracked so it isn't GC'd mid-flight; callers don't
    need to hold the reference.

    A uniform random jitter in ``[0, JITTER_SECS]`` is added before the
    warm starts so 50 stats polls completing in the same second don't
    all fire warms at once (the global concurrency semaphore caps
    in-flight, but jitter spreads the arrival distribution so we
    actually use the semaphore window instead of queueing instantly).

    Returns ``None`` when the feature flag is off — collector code can
    call this unconditionally without branching.
    """
    if not CACHE_PREWARM_ENABLED:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — only called from async ctx
        return None

    async def _delayed_warm() -> WarmResult:
        if JITTER_SECS > 0:
            import random
            await asyncio.sleep(random.uniform(0.0, JITTER_SECS))
        return await warm_data_source(ws_id=ws_id, ds_id=ds_id, node_count=node_count)

    task = loop.create_task(
        _delayed_warm(),
        name=f"cache-warm:{ws_id}:{ds_id}",
    )
    _active_warm_tasks.add(task)
    task.add_done_callback(_on_warm_done)
    return task


def _on_warm_done(task: asyncio.Task) -> None:
    _active_warm_tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:  # pragma: no cover — warm_data_source catches its own
        logger.warning("cache_warmer: task crashed with %s", exc)


def _default_children_params(urn: str) -> dict:
    """Params shape matching the most common GET /children-with-edges
    call from the UI. MUST stay in sync with the handler in
    backend/app/api/v1/endpoints/graph.py — the cache key is built from
    this dict and the handler's, so a divergence means the warmed entry
    never matches a real user request."""
    return {
        "urn": urn,
        "edgeTypes": None,
        "lineageEdgeTypes": None,
        "searchQuery": None,
        "sortProperty": "displayName",
        "limit": 100,
        "offset": 0,
        "cursor": None,
        "includeLineageEdges": True,
    }

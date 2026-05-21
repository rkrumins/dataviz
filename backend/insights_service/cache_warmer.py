"""Cache pre-warmer for top-level + 1-level-down navigation entry points.

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
import logging
import os
from dataclasses import dataclass, field
from typing import Optional

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


# Master switch. When OFF, ``warm_data_source`` is a no-op so the stats
# worker's post-poll hook can stay wired unconditionally.
CACHE_PREWARM_ENABLED: bool = _flag("CACHE_PREWARM_ENABLED", default=True)

# Top-level page size requested during warm. Default 50 covers the common
# "DS has < 50 top-level entities" case in one cache entry.
TOP_LEVEL_LIMIT: int = int(os.getenv("CACHE_PREWARM_TOP_LEVEL_LIMIT", "50"))

# How many top-level URNs we expand into their direct children. Bounds
# the worst-case provider load per warm cycle.
CHILDREN_FANOUT: int = int(os.getenv("CACHE_PREWARM_CHILDREN_FANOUT", "20"))

# For each warmed top-level URN, how many of its direct children we then
# warm one level further. Total worst-case requests:
# ``TOP_LEVEL_LIMIT(1) + CHILDREN_FANOUT(N) + ONE_DOWN_FANOUT*N``.
ONE_DOWN_FANOUT: int = int(os.getenv("CACHE_PREWARM_ONE_DOWN_FANOUT", "10"))

# Skip pre-warming for graphs above this node count. Pre-warming a
# 10M-node graph would burn FalkorDB time for marginal hit-rate gain
# (the user's navigation entry is unpredictable at that scale).
MAX_NODE_COUNT: int = int(os.getenv("CACHE_PREWARM_MAX_NODE_COUNT", "500000"))

# Outer wall-clock budget for one warm cycle. Inner per-op timeouts are
# inherited from the engine/provider path.
DS_TIMEOUT_SECS: float = float(os.getenv("CACHE_PREWARM_DS_TIMEOUT_SECS", "60"))

# Lock TTL: long enough that a slow warm doesn't release before it's
# finished, short enough that a crashed warmer doesn't pin the lock.
_LOCK_TTL_SECS: int = int(os.getenv("CACHE_PREWARM_LOCK_TTL_SECS", "300"))
_LOCK_PREFIX = "cache_warm:lock"


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

    Returns ``None`` when the feature flag is off — collector code can
    call this unconditionally without branching.
    """
    if not CACHE_PREWARM_ENABLED:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — only called from async ctx
        return None

    task = loop.create_task(
        warm_data_source(ws_id=ws_id, ds_id=ds_id, node_count=node_count),
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

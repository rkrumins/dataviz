"""Task 6: post-cache staleness overlay on ``/edges/aggregated`` and the
canvas bootstrap/expand endpoints.

The Redis stale-source marker (set by ``signal_source_changed``, cleared by
the event listener on ``job.completed``) means "this source's data changed;
a rebuild is queued/running". While it's set, aggregated lineage served
from cache — or the not-yet-rebuilt ``:AGGREGATED`` overlay — is honestly
stale even though the payload's own ``stale``/``staleReason`` fields are
structural only and don't know about it. These endpoints overlay the
marker onto the response AFTER the cache layer returns it, so cached hits
get flagged too, without ever baking ``stale=true`` into the cached bytes.

Each fake engine below carries a real ``_workspace_id``/``_data_source_id``
so ``_cache_scope`` returns a real scope and the endpoints take the
GraphCache path (not the scope-less bypass) — that's the path the overlay
sits after. ``get_graph_cache`` is patched to a fresh always-miss cache per
test so ``get_or_compute`` deterministically runs ``compute()``;
``get_source_stale_reason`` is patched directly per test since these tests
exercise the overlay logic in graph.py/canvas.py, not graph_cache's own
Redis plumbing (covered in test_graph_cache.py).
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import Response

from backend.app.api.v1.endpoints import canvas as canvas_module
from backend.app.api.v1.endpoints import graph as graph_module
from backend.app.models.canvas import CanvasExpandRequest
from backend.app.models.graph import AggregatedEdgeRequest, AggregatedEdgeResult
from backend.app.services.graph_cache import GraphCache
from backend.common.models.graph import ChildrenWithEdgesResult, GraphNode


def _make_redis() -> AsyncMock:
    """Always-miss Redis stand-in (same shape as test_graph_cache.py's
    fixture) — get_or_compute runs compute() and "persists" via the mocked
    set/incr; uninvolved in the overlay assertions."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.incr = AsyncMock(return_value=1)
    return redis


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    """Every test gets its own always-miss GraphCache so get_or_compute
    exercises compute() deterministically, decoupled from the marker read."""
    monkeypatch.setattr(graph_module, "get_graph_cache", lambda: GraphCache(_make_redis()))
    monkeypatch.setattr(canvas_module, "get_graph_cache", lambda: GraphCache(_make_redis()))


def _agg(**kw) -> AggregatedEdgeResult:
    return AggregatedEdgeResult(aggregatedEdges=[], totalSourceEdges=0, **kw)


class _FakeAggregatedEngine:
    """Minimal ContextEngine stand-in with a real workspace scope so
    `_cache_scope` returns a CacheScope (not None)."""

    def __init__(self, result: AggregatedEdgeResult):
        self._workspace_id = "ws1"
        self._data_source_id = "ds1"
        self._branch_id = ""
        self.provider = object()
        self._result = result

    async def get_aggregated_edges(self, request):
        return self._result


# ── /edges/aggregated (R4.1-3) ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_aggregated_overlay_flags_stale_when_marker_set(monkeypatch):
    monkeypatch.setattr(
        graph_module, "get_source_stale_reason",
        AsyncMock(return_value="source_changed"),
    )
    engine = _FakeAggregatedEngine(_agg())  # fresh/complete underlying result
    result = await graph_module.get_aggregated_edges(
        Response(), AggregatedEdgeRequest(sourceUrns=["a"]), engine,
    )
    assert result.stale is True
    assert result.stale_reason == "source_changed"


@pytest.mark.asyncio
async def test_aggregated_overlay_noop_when_marker_unset(monkeypatch):
    monkeypatch.setattr(
        graph_module, "get_source_stale_reason",
        AsyncMock(return_value=None),
    )
    engine = _FakeAggregatedEngine(_agg())
    result = await graph_module.get_aggregated_edges(
        Response(), AggregatedEdgeRequest(sourceUrns=["a"]), engine,
    )
    assert result.stale is False
    assert result.stale_reason is None


@pytest.mark.asyncio
async def test_aggregated_overlay_preserves_existing_stale_reason(monkeypatch):
    monkeypatch.setattr(
        graph_module, "get_source_stale_reason",
        AsyncMock(return_value="source_changed"),
    )
    engine = _FakeAggregatedEngine(_agg(stale=True, staleReason="degraded"))
    result = await graph_module.get_aggregated_edges(
        Response(), AggregatedEdgeRequest(sourceUrns=["a"]), engine,
    )
    assert result.stale is True
    assert result.stale_reason == "degraded"  # untouched — guard held


# ── canvas (R4.4) ────────────────────────────────────────────────────────


class _FakeCanvasExpandEngine:
    """Same workspace-scoped shape as `_FakeAggregatedEngine`, sized for
    canvas_expand's compute() (children + fan-out/fan-in aggregated)."""

    def __init__(self, children, agg: AggregatedEdgeResult):
        self._workspace_id = "ws1"
        self._data_source_id = "ds1"
        self._branch_id = ""
        self.provider = object()
        self._children = children
        self._agg = agg

    async def get_children_with_edges(self, urn, **kw):
        return ChildrenWithEdgesResult(
            children=self._children, containmentEdges=[], lineageEdges=[],
            totalChildren=len(self._children), hasMore=False,
        )

    async def get_aggregated_edges(self, request):
        return self._agg


@pytest.mark.asyncio
async def test_canvas_expand_overlay_flags_composed_freshness(monkeypatch):
    monkeypatch.setattr(
        canvas_module, "get_source_stale_reason",
        AsyncMock(return_value="source_changed"),
    )
    children = [GraphNode(urn="urn:c1", displayName="c1", entityType="Node")]
    engine = _FakeCanvasExpandEngine(children=children, agg=_agg())
    result = await canvas_module.canvas_expand(
        Response(),
        CanvasExpandRequest(parentUrn="urn:parent", visibleUrns=["urn:x"]),
        engine,
    )
    assert result.freshness.stale is True
    assert result.freshness.stale_reason == "source_changed"
    assert result.aggregated_delta.stale is True
    assert result.aggregated_delta.stale_reason == "source_changed"

"""Trace read-path round-trip discipline (WS4): the engine budget sits under
the middleware tier (truncated-200 always beats the 504), depth defaults are
sane, ancestor hydration is bucket-GATHERED with no membership queries, chain
maps pass through to containment-edge derivation, and the focus-level retry
respects the remaining budget instead of re-running a full BFS into the
deadline.
"""
import asyncio
import time

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── config invariants ────────────────────────────────────────────────


def test_engine_budget_sits_under_middleware_tier():
    from backend.app.config.resilience import (
        HTTP_TIMEOUT_TRACE_SECS,
        TRACE_ENGINE_HEADROOM_SECS,
        TRACE_TIMEOUT_SECS,
    )
    from backend.app.services.context_engine import ContextEngine

    assert ContextEngine.TRACE_TIMEOUT_MS == int(
        max(5.0, TRACE_TIMEOUT_SECS - TRACE_ENGINE_HEADROOM_SECS) * 1000
    )
    assert ContextEngine.TRACE_TIMEOUT_MS < HTTP_TIMEOUT_TRACE_SECS * 1000


def test_trace_request_depth_defaults_and_cap():
    from backend.common.models.graph import TraceRequest

    req = TraceRequest(urn="urn:x")
    assert req.upstream_depth == 25 and req.downstream_depth == 25
    with pytest.raises(Exception):
        TraceRequest(urn="urn:x", upstreamDepth=500)


# ── ancestor chains: bucket-gathered, no membership round-trips ─────


class _Result:
    def __init__(self, rows=None):
        self.result_set = rows or []


def _provider_with_recorder(labels, children):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    p.set_containment_edge_types(["HAS"], from_ontology=True)
    p.recorded = []
    parent = {}
    for par, kids in children.items():
        for k in kids:
            parent[k] = par

    async def _ro(cypher, params=None, timeout=None, op=None):
        p.recorded.append((op, cypher))
        assert "RETURN n.urn" not in cypher, (
            "membership query issued — buckets come from the urn→label cache"
        )
        rows = []
        for u in (params or {}).get("urns", []):
            chain, cur = [], parent.get(u)
            while cur is not None:
                chain.append(cur)
                cur = parent.get(cur)
            rows.append([u, chain])
        return _Result(rows)

    p._ro_query = _ro

    async def _buckets(urns):
        by = {}
        for u in dict.fromkeys(u for u in urns if u):
            by.setdefault(labels.get(u) or "", []).append(u)
        return sorted(by.items())

    p._label_buckets = _buckets
    return p


def test_chain_computation_gathers_one_query_per_bucket():
    labels = {"urn:a": "Node", "urn:b": "Node", "urn:c": "Roots"}
    children = {"urn:c": {"urn:a", "urn:b"}}
    p = _provider_with_recorder(labels, children)
    chains = _run(p._compute_ancestor_chains_bulk_cypher(["urn:a", "urn:b", "urn:c"]))
    assert chains["urn:a"] == ["urn:c"]
    assert chains["urn:c"] == []
    # exactly one chain query per label bucket (Node, Roots) — no 2·L
    # membership+chain sequential ladder.
    assert len(p.recorded) == 2
    assert all(op == "trace.chains" for op, _ in p.recorded)


def test_fetch_containment_edges_reuses_provided_chains():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    p.set_containment_edge_types(["HAS"], from_ontology=True)
    recompute = {"n": 0}

    async def _bulk(urns):
        recompute["n"] += 1
        return {}

    async def _ro(cypher, params=None, timeout=None, op=None):
        return _Result([["urn:p", "urn:c", "HAS", 1]])

    p._compute_and_store_ancestors_bulk = _bulk
    p._ro_query = _ro
    chains = {"urn:c": ["urn:p"], "urn:p": []}
    edges = _run(p._fetch_containment_edges(
        ["urn:p", "urn:c"], ["HAS"], chains=chains,
    ))
    assert recompute["n"] == 0, "must not recompute chains handed in by the caller"
    assert [(e.source_urn, e.target_urn) for e in edges] == [("urn:p", "urn:c")]


# ── retry-at-focus budget floor ──────────────────────────────────────


def _trace_provider(expand_delay_s):
    from backend.common.models.graph import GraphNode

    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    p._entity_type_levels = {"table": 2, "domain": 0}
    p.expand_calls = {"n": 0}

    async def _noop():
        return None

    async def _get_node(urn):
        return GraphNode(urn=urn, displayName=urn, entityType="table")

    async def _anchor(urn, level, ctypes):
        return urn

    async def _root_anchor(urn, ctypes):
        return urn, 0

    async def _has_agg(*a, **kw):
        return True

    async def _expand(*a, **kw):
        p.expand_calls["n"] += 1
        await asyncio.sleep(expand_delay_s)
        return []

    p._ensure_connected = _noop
    p.get_node = _get_node
    p._resolve_anchor_at_level = _anchor
    p._resolve_root_anchor = _root_anchor
    p._has_aggregated_at_level = _has_agg
    p._expand_aggregated_set = _expand
    return p


def test_retry_at_focus_skipped_when_budget_nearly_gone():
    """Level-0 BFS finds nothing and the focus level differs — the retry
    condition is armed. With <40% budget left it must SKIP the second BFS
    and return truncated instead of racing the deadline."""
    p = _trace_provider(expand_delay_s=0.08)
    result = _run(p.trace_at_level(
        "urn:x", level=0, upstream_depth=1, downstream_depth=1,
        lineage_edge_types=["FLOWS_TO"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=100,
    ))
    # First BFS = 2 expands (up+down); the retry (2 more) must be skipped.
    assert p.expand_calls["n"] == 2
    assert result.truncated is True


def test_retry_at_focus_runs_with_ample_budget():
    p = _trace_provider(expand_delay_s=0.0)
    result = _run(p.trace_at_level(
        "urn:x", level=0, upstream_depth=1, downstream_depth=1,
        lineage_edge_types=["FLOWS_TO"], containment_edge_types=["HAS"],
        max_nodes=100, timeout_ms=60_000,
    ))
    assert p.expand_calls["n"] == 4  # first BFS + focus-level retry
    assert result.effective_level == 2  # retried at the focus's own level

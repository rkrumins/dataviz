"""The focus-lineage-closure WIRE CONTRACT — model layer only.

Pins TraceClosureRequest / TraceFrontierNode / TraceClosureResult: the
three pydantic models backing the new focus-lineage-closure endpoint.

TraceClosureRequest is deliberately a NEW model, not an extension of
TraceRequest — it must not accept the re-anchoring-era skeleton/expand
concepts (level, includeInheritedLineage, includeAncestorChain). It is
used both for the initial focus walk and to continue a walk from a set
of seed leaves (seed_urns) — e.g. the visible leaves under a rolled-up
container card, so the walk stays scoped to the focus's lineage rather
than re-walking the whole container.

TraceClosureResult adds a frontier (nodes at the closure boundary, for
"+N more" / hub-paging affordances) on top of TraceResult's existing
nodes/edges/containment/truncation shape.

Model layer: pins field names, aliases, bounds and defaults (below).
Engine layer: pins ContextEngine.trace_closure's forwarding contract —
direction-to-depth zeroing, max_nodes clamping, verbatim seed/exclude/
cursor forwarding, and the deliberate ABSENCE of level resolution —
mirroring test_expand_wire_contract.py's engine-layer pattern (a
capturing fake provider + a bare ContextEngine with _resolve_ontology
monkey-patched).
"""
import asyncio

import pytest
from pydantic import ValidationError

from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import (
    TraceClosureRequest,
    TraceClosureResult,
    TraceFocus,
    TraceFrontierNode,
    TraceResult,
)


# ── TraceClosureRequest: defaults ───────────────────────────────────────


def test_trace_closure_request_defaults():
    req = TraceClosureRequest(urn="u")
    assert req.direction == "both"
    assert req.upstream_depth == 1
    assert req.downstream_depth == 1
    assert req.lineage_edge_types is None
    assert req.max_nodes is None
    assert req.seed_urns is None
    assert req.exclude_urns is None
    assert req.after_cursor is None


# ── TraceClosureRequest: bounds ─────────────────────────────────────────


def test_upstream_depth_rejects_over_25():
    TraceClosureRequest.model_validate({"urn": "u", "upstreamDepth": 25})  # boundary itself is valid
    with pytest.raises(ValidationError):
        TraceClosureRequest.model_validate({"urn": "u", "upstreamDepth": 26})


def test_downstream_depth_rejects_negative():
    TraceClosureRequest.model_validate({"urn": "u", "downstreamDepth": 0})  # boundary itself is valid
    with pytest.raises(ValidationError):
        TraceClosureRequest.model_validate({"urn": "u", "downstreamDepth": -1})


def test_max_nodes_rejects_zero():
    TraceClosureRequest.model_validate({"urn": "u", "maxNodes": 1})  # boundary itself is valid
    with pytest.raises(ValidationError):
        TraceClosureRequest.model_validate({"urn": "u", "maxNodes": 0})


def test_seed_urns_rejects_over_500():
    TraceClosureRequest.model_validate({"urn": "u", "seedUrns": [f"u{i}" for i in range(500)]})  # boundary
    with pytest.raises(ValidationError):
        TraceClosureRequest.model_validate({"urn": "u", "seedUrns": [f"u{i}" for i in range(501)]})


def test_exclude_urns_rejects_over_2000():
    TraceClosureRequest.model_validate({"urn": "u", "excludeUrns": [f"u{i}" for i in range(2000)]})  # boundary
    with pytest.raises(ValidationError):
        TraceClosureRequest.model_validate({"urn": "u", "excludeUrns": [f"u{i}" for i in range(2001)]})


# ── TraceClosureRequest: alias round-trip ───────────────────────────────


def test_trace_closure_request_alias_round_trip():
    alias_payload = {
        "urn": "u1",
        "direction": "upstream",
        "upstreamDepth": 3,
        "downstreamDepth": 4,
        "lineageEdgeTypes": ["FLOWS"],
        "maxNodes": 500,
        "seedUrns": ["s1", "s2"],
        "excludeUrns": ["x1"],
        "afterCursor": "e:123",
    }
    from_alias = TraceClosureRequest.model_validate(alias_payload)

    snake_payload = {
        "urn": "u1",
        "direction": "upstream",
        "upstream_depth": 3,
        "downstream_depth": 4,
        "lineage_edge_types": ["FLOWS"],
        "max_nodes": 500,
        "seed_urns": ["s1", "s2"],
        "exclude_urns": ["x1"],
        "after_cursor": "e:123",
    }
    from_snake = TraceClosureRequest.model_validate(snake_payload)

    assert from_alias == from_snake
    assert from_alias.model_dump(by_alias=True) == alias_payload


# ── TraceFrontierNode ────────────────────────────────────────────────────


def test_trace_frontier_node_minimal_defaults():
    node = TraceFrontierNode.model_validate({"urn": "u1"})
    assert node.total_count is None
    assert node.next_cursor is None


def test_trace_frontier_node_accepts_explicit_null_total_count():
    node = TraceFrontierNode.model_validate({"urn": "u1", "totalCount": None})
    assert node.total_count is None


def test_trace_frontier_node_alias_round_trip():
    alias_payload = {"urn": "u1", "totalCount": 42, "nextCursor": "e:9"}
    from_alias = TraceFrontierNode.model_validate(alias_payload)

    snake_payload = {"urn": "u1", "total_count": 42, "next_cursor": "e:9"}
    from_snake = TraceFrontierNode.model_validate(snake_payload)

    assert from_alias == from_snake
    assert from_alias.model_dump(by_alias=True) == alias_payload


# ── TraceClosureResult ───────────────────────────────────────────────────


def test_trace_closure_result_inherits_trace_result_shape_with_frontier_defaults():
    result = TraceClosureResult(
        nodes=[],
        edges=[],
        focus=TraceFocus(urn="u1", level=0, entityType="dataset"),
        effectiveLevel=0,
    )
    assert isinstance(result, TraceResult)

    dumped = result.model_dump(by_alias=True)
    # Inherited TraceResult shape is present...
    assert dumped["nodes"] == []
    assert dumped["edges"] == []
    assert dumped["containmentEdges"] == []
    assert dumped["upstreamUrns"] == set()
    assert dumped["downstreamUrns"] == set()
    assert dumped["truncated"] is False
    assert dumped["truncationReason"] is None
    # ...plus the closure-specific frontier, correctly defaulted.
    assert dumped["frontierUp"] == []
    assert dumped["frontierDown"] == []
    assert dumped["seedTruncated"] is False


def test_trace_closure_result_alias_round_trip():
    alias_payload = {
        "nodes": [],
        "edges": [],
        "containmentEdges": [],
        "focus": {"urn": "u1", "level": 0, "entityType": "dataset"},
        "effectiveLevel": 0,
        "truncated": True,
        "truncationReason": "max_nodes",
        "frontierUp": [{"urn": "up1", "totalCount": 5, "nextCursor": None}],
        "frontierDown": [{"urn": "down1", "totalCount": None, "nextCursor": "e:1"}],
        "seedTruncated": True,
    }
    from_alias = TraceClosureResult.model_validate(alias_payload)

    snake_payload = {
        "nodes": [],
        "edges": [],
        "containment_edges": [],
        "focus": {"urn": "u1", "level": 0, "entity_type": "dataset"},
        "effective_level": 0,
        "truncated": True,
        "truncation_reason": "max_nodes",
        "frontier_up": [{"urn": "up1", "total_count": 5, "next_cursor": None}],
        "frontier_down": [{"urn": "down1", "total_count": None, "next_cursor": "e:1"}],
        "seed_truncated": True,
    }
    from_snake = TraceClosureResult.model_validate(snake_payload)

    assert from_alias == from_snake

    dumped = from_alias.model_dump(by_alias=True)
    assert dumped["frontierUp"] == [{"urn": "up1", "totalCount": 5, "nextCursor": None}]
    assert dumped["frontierDown"] == [{"urn": "down1", "totalCount": None, "nextCursor": "e:1"}]
    assert dumped["seedTruncated"] is True


# ── Engine layer: ContextEngine.trace_closure ───────────────────────────
#
# The engine is a thin forwarder: resolve ontology defaults, clamp
# max_nodes, and forward to provider.trace_closure — deliberately with NO
# level resolution (the closure is level-free by design, unlike `trace`).


def _run(coro):
    return asyncio.run(coro)


class _CapturingClosureProvider:
    def __init__(self):
        self.calls = []

    async def trace_closure(self, **kwargs):
        self.calls.append(kwargs)
        return TraceClosureResult(
            nodes=[], edges=[], containmentEdges=[],
            upstreamUrns=set(), downstreamUrns=set(),
            focus=TraceFocus(urn=kwargs["urn"], level=0, entityType="x"),
            effectiveLevel=0, isInherited=False, inheritedFromUrn=None,
            truncated=False, truncationReason=None,
        )


class _NotImplementedClosureProvider:
    async def trace_closure(self, **kwargs):
        raise NotImplementedError("nope")


class _Ontology:
    # No hierarchy/level concept anywhere — the closure must not need one.
    lineage_edge_types = ["FLOWS"]
    containment_edge_types = ["HAS"]
    entity_type_definitions: dict = {}


def _make_engine(provider):
    # The real class, minus its constructor: trace_closure only touches
    # `provider`, `_resolve_ontology`, and the semaphore (which
    # getattr-degrades on a bare instance).
    eng = object.__new__(ContextEngine)
    eng.provider = provider

    async def _resolve_ontology():
        return _Ontology()

    eng._resolve_ontology = _resolve_ontology
    return eng


def test_direction_upstream_zeroes_downstream_depth():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate(
        {"urn": "u1", "direction": "upstream", "upstreamDepth": 3, "downstreamDepth": 5}
    )
    _run(ContextEngine.trace_closure(eng, req))
    call = provider.calls[0]
    assert call["upstream_depth"] == 3
    assert call["downstream_depth"] == 0


def test_direction_downstream_zeroes_upstream_depth():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate(
        {"urn": "u1", "direction": "downstream", "upstreamDepth": 3, "downstreamDepth": 5}
    )
    _run(ContextEngine.trace_closure(eng, req))
    call = provider.calls[0]
    assert call["upstream_depth"] == 0
    assert call["downstream_depth"] == 5


def test_direction_both_keeps_both_depths():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate(
        {"urn": "u1", "direction": "both", "upstreamDepth": 3, "downstreamDepth": 5}
    )
    _run(ContextEngine.trace_closure(eng, req))
    call = provider.calls[0]
    assert call["upstream_depth"] == 3
    assert call["downstream_depth"] == 5


def test_max_nodes_none_uses_trace_max_nodes():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1"})
    _run(ContextEngine.trace_closure(eng, req))
    assert provider.calls[0]["max_nodes"] == ContextEngine.TRACE_MAX_NODES


def test_max_nodes_over_cap_clamps_to_trace_max_nodes():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1", "maxNodes": 99999})
    _run(ContextEngine.trace_closure(eng, req))
    assert provider.calls[0]["max_nodes"] == ContextEngine.TRACE_MAX_NODES


def test_max_nodes_under_cap_passes_through():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1", "maxNodes": 50})
    _run(ContextEngine.trace_closure(eng, req))
    assert provider.calls[0]["max_nodes"] == 50


def test_seed_exclude_cursor_forwarded_verbatim():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({
        "urn": "u1", "direction": "upstream", "upstreamDepth": 1,
        "seedUrns": ["s2", "s1"], "excludeUrns": ["x1"], "afterCursor": "e:5",
    })
    _run(ContextEngine.trace_closure(eng, req))
    call = provider.calls[0]
    assert call["seed_urns"] == ["s2", "s1"]
    assert call["exclude_urns"] == ["x1"]
    assert call["after_cursor"] == "e:5"


def test_timeout_ms_uses_trace_timeout_ms():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1"})
    _run(ContextEngine.trace_closure(eng, req))
    assert provider.calls[0]["timeout_ms"] == ContextEngine.TRACE_TIMEOUT_MS


def test_no_level_kwarg_sent_to_provider():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1"})
    _run(ContextEngine.trace_closure(eng, req))
    assert "level" not in provider.calls[0]


def test_works_when_resolved_ontology_has_no_levels():
    # _Ontology above already carries zero level info anywhere (no
    # entity_type_definitions) — a smoke test that the call chain never
    # reaches for one.
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1"})
    result = _run(ContextEngine.trace_closure(eng, req))
    assert isinstance(result, TraceClosureResult)


def test_provider_without_attr_raises_not_implemented():
    eng = _make_engine(object())
    req = TraceClosureRequest.model_validate({"urn": "u1"})
    with pytest.raises(NotImplementedError):
        _run(ContextEngine.trace_closure(eng, req))


def test_provider_raising_not_implemented_propagates():
    eng = _make_engine(_NotImplementedClosureProvider())
    req = TraceClosureRequest.model_validate({"urn": "u1"})
    with pytest.raises(NotImplementedError):
        _run(ContextEngine.trace_closure(eng, req))

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
import json
from pathlib import Path

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


def test_direction_rejects_anything_but_the_three_it_means():
    """A misspelt direction used to be a 200 with the WRONG lineage in it.
    Nothing validated the string, and everything that reads it treats
    "not upstream" as downstream: the endpoint's cursor guard picks the
    active depth that way, and the engine zeroes the depths that way. So
    `"upstrem"` paged a hub's consumers while the client asked for its
    producers, and no error was raised anywhere in between."""
    for good in ("upstream", "downstream", "both"):
        assert TraceClosureRequest.model_validate({"urn": "u", "direction": good}).direction == good
    for bad in ("upstrem", "UPSTREAM", "up", "", "in"):
        with pytest.raises(ValidationError):
            TraceClosureRequest.model_validate({"urn": "u", "direction": bad})


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
        "seedCursor": None,
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
        "seed_cursor": None,
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
    assert from_alias.model_dump(by_alias=True) == {**alias_payload, "reason": None}


def test_trace_frontier_node_reason_is_additive_and_bounded():
    """`reason` says WHY a node is on the frontier: `cut` = the budget or the
    deadline stopped the walk there (a one-hop client completes it hands-free
    by re-rooting), `depth` = the requested depth ended there (the next hop —
    a pill). Old payloads without it still validate."""
    assert TraceFrontierNode.model_validate({"urn": "u1"}).reason is None
    assert TraceFrontierNode.model_validate({"urn": "u1", "reason": "cut"}).reason == "cut"
    assert TraceFrontierNode(urn="u1", reason="depth").model_dump(by_alias=True)["reason"] == "depth"
    with pytest.raises(ValidationError):
        TraceFrontierNode.model_validate({"urn": "u1", "reason": "because"})


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
        "frontierUp": [{"urn": "up1", "totalCount": 5, "nextCursor": None, "reason": "depth"}],
        "frontierDown": [{"urn": "down1", "totalCount": None, "nextCursor": "e:1", "reason": "cut"}],
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
        "frontier_up": [{"urn": "up1", "total_count": 5, "next_cursor": None, "reason": "depth"}],
        "frontier_down": [{"urn": "down1", "total_count": None, "next_cursor": "e:1", "reason": "cut"}],
        "seed_truncated": True,
    }
    from_snake = TraceClosureResult.model_validate(snake_payload)

    assert from_alias == from_snake

    dumped = from_alias.model_dump(by_alias=True)
    assert dumped["frontierUp"] == [{"urn": "up1", "totalCount": 5, "nextCursor": None, "reason": "depth"}]
    assert dumped["frontierDown"] == [{"urn": "down1", "totalCount": None, "nextCursor": "e:1", "reason": "cut"}]
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


def test_max_nodes_over_cap_clamps_to_the_hard_ceiling():
    # 2026-08-19: an explicit maxNodes may ESCALATE past the default page
    # size (the full-walk driver's big-page lane — one 6000-node BFS beats
    # thousands of frontier round trips), clamped by the hard ceiling.
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1", "maxNodes": 99999})
    _run(ContextEngine.trace_closure(eng, req))
    assert provider.calls[0]["max_nodes"] == ContextEngine.TRACE_MAX_NODES_HARD


def test_max_nodes_escalation_between_default_and_hard_cap_passes_through():
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    req = TraceClosureRequest.model_validate({"urn": "u1", "maxNodes": 6000})
    _run(ContextEngine.trace_closure(eng, req))
    assert provider.calls[0]["max_nodes"] == 6000


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


# ── Shared fixture: the frontend/backend drift tripwire ─────────────────
#
# trace_closure_walk_fixture.json is a hand-written, realistic three-hop
# walk (initial focus closure, an upstream extension with a seam edge, a
# downstream hub page) consumed by BOTH suites: this test validates each
# document against the wire model below; the frontend's
# closure-adapter.test.ts loads the SAME file and feeds each document
# through toLensClosure/mergeClosures. If the wire model ever drifts from
# this shape, this test fails first.


def _assert_subset_equal(expected, actual, path):
    """`actual` (the round-tripped dump) may carry extra keys the fixture
    omitted (defaulted fields, e.g. GraphNode.properties/tags) — this
    checks only that every key/value the fixture DID specify survived the
    round trip, recursively through nested dicts/lists."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected a dict, got {type(actual).__name__}"
        for key, value in expected.items():
            assert key in actual, f"{path}.{key}: missing from the round-tripped dump"
            _assert_subset_equal(value, actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list), f"{path}: expected a list, got {type(actual).__name__}"
        assert len(expected) == len(actual), f"{path}: length {len(expected)} != {len(actual)}"
        for i, (e, a) in enumerate(zip(expected, actual)):
            _assert_subset_equal(e, a, f"{path}[{i}]")
    else:
        assert expected == actual, f"{path}: {expected!r} != {actual!r}"


def test_shared_walk_fixture_round_trips_by_alias():
    fixture_path = Path(__file__).parent / "fixtures" / "trace_closure_walk_fixture.json"
    fixture = json.loads(fixture_path.read_text())

    assert set(fixture.keys()) == {"initial", "extension", "hubPage"}

    for name, doc in fixture.items():
        result = TraceClosureResult.model_validate(doc)
        dumped = result.model_dump(by_alias=True)
        for key, expected in doc.items():
            # upstreamUrns/downstreamUrns round-trip through a Python `set`
            # (Set[str] fields) — order is not preserved, so compare as sets.
            if key in ("upstreamUrns", "downstreamUrns"):
                assert set(dumped[key]) == set(expected), f"{name}.{key}"
                continue
            _assert_subset_equal(expected, dumped[key], f"{name}.{key}")


# --------------------------------------------------------------------- #
# Synthetic edges are not lineage                                        #
#                                                                        #
# REPORTED LIVE (2026-08-14): a column's peek read "5 in / 4 out" over    #
# two real neighbours. The estate's resolved ontology lists AGGREGATED    #
# among its lineage types — verified on the live source:                  #
# ['FLOWS_TO','CONSUMES','PRODUCES','DERIVED_FROM','DEPENDS_ON',          #
#  'AGGREGATED','TRANSFORMS'] — and :AGGREGATED edges are the aggregation #
# worker's own rollups of a real flow onto every coarser grain above it.  #
# Walking them counts one flow once per containment level, and it         #
# contradicts this closure's own design: it is regime-independent         #
# BECAUSE it depends on no :AGGREGATED cells.                             #
# --------------------------------------------------------------------- #


class _OntologyWithSyntheticTypes(_Ontology):
    # Exactly what the live source resolves to.
    lineage_edge_types = [
        "FLOWS_TO", "CONSUMES", "PRODUCES", "DERIVED_FROM",
        "DEPENDS_ON", "AGGREGATED", "TRANSFORMS",
    ]


def _engine_with_ontology(provider, ontology):
    eng = _make_engine(provider)

    async def _resolve_ontology():
        return ontology

    eng._resolve_ontology = _resolve_ontology
    return eng


def test_resolved_ontology_synthetic_type_never_reaches_the_provider():
    provider = _CapturingClosureProvider()
    eng = _engine_with_ontology(provider, _OntologyWithSyntheticTypes())
    _run(ContextEngine.trace_closure(eng, TraceClosureRequest.model_validate({"urn": "u1"})))
    sent = provider.calls[0]["lineage_edge_types"]
    assert "AGGREGATED" not in sent
    # ...and nothing REAL is lost with it, in the order it was declared.
    assert sent == [
        "FLOWS_TO", "CONSUMES", "PRODUCES", "DERIVED_FROM", "DEPENDS_ON", "TRANSFORMS",
    ]


def test_caller_supplied_synthetic_type_is_filtered_too():
    # A client asking for it explicitly is still asking for a rollup.
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    _run(ContextEngine.trace_closure(eng, TraceClosureRequest.model_validate(
        {"urn": "u1", "lineageEdgeTypes": ["FLOWS_TO", "AGGREGATED"]},
    )))
    assert provider.calls[0]["lineage_edge_types"] == ["FLOWS_TO"]


def test_synthetic_type_is_matched_however_the_graph_spells_it():
    # Per-source graphs carry their own casing (see _alias_rel_types), so
    # the comparison is case-insensitive and the filter cannot be dodged.
    provider = _CapturingClosureProvider()
    eng = _make_engine(provider)
    _run(ContextEngine.trace_closure(eng, TraceClosureRequest.model_validate(
        {"urn": "u1", "lineageEdgeTypes": ["Aggregated", "flows_to", "aggregated"]},
    )))
    assert provider.calls[0]["lineage_edge_types"] == ["flows_to"]


class _OntologyWithOnlySyntheticType(_Ontology):
    # The manual/blank-model shape REPORTED LIVE (2026-08-19): the canvas
    # editor's non-drawable guard was case-broken, so authored flow edges
    # were written as :AGGREGATED — leaving graphs (e.g. manual_lineage)
    # whose ONLY physical lineage vocabulary IS the synthetic type. The
    # filter then handed the provider an EMPTY list, and the walk was
    # guaranteed to find nothing: the canvas showed the flow, the lens
    # showed a bare focus card.
    lineage_edge_types = ["AGGREGATED"]


def test_a_source_whose_only_lineage_vocabulary_is_synthetic_walks_it():
    # When filtering the synthetic type would leave NOTHING to walk, the
    # rollup grain is the only lineage truth this source has — walk it.
    # The double-count the filter exists to prevent needs a real flow
    # UNDER the rollup, and this source has none.
    provider = _CapturingClosureProvider()
    eng = _engine_with_ontology(provider, _OntologyWithOnlySyntheticType())
    _run(ContextEngine.trace_closure(eng, TraceClosureRequest.model_validate({"urn": "u1"})))
    assert provider.calls[0]["lineage_edge_types"] == ["AGGREGATED"]


def test_a_source_with_any_real_type_still_filters_the_synthetic_one():
    # The rescue is ONLY for the nothing-left case — one real type present
    # and the filter behaves exactly as before.
    provider = _CapturingClosureProvider()
    eng = _engine_with_ontology(provider, _OntologyWithSyntheticTypes())
    _run(ContextEngine.trace_closure(eng, TraceClosureRequest.model_validate({"urn": "u1"})))
    assert "AGGREGATED" not in provider.calls[0]["lineage_edge_types"]

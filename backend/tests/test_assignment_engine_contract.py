"""``AssignmentEngine.compute_assignments(..., contract=True)``: the placement contract over the
nodes and edges the compute already reads (``placementContractEnabled``).

The response keeps its shape: contract members become ``EntityAssignment`` rows, fallback and
none go to ``unassignedEntityIds``. ``contract=False`` (the default) is today's engine, unchanged.
"""
import asyncio

import pytest
from fastapi import Response

from backend.app.api.v1.endpoints import assignments as assignments_ep
from backend.app.models.assignment import LayerAssignmentRequest
from backend.app.models.graph import GraphEdge, GraphNode
from backend.app.services.assignment_engine import AssignmentEngine, _request_config
from backend.common.models.graph import OntologyMetadata


class _FakeEngine:
    """The three reads compute_assignments makes (the shape of test_assignment_engine_scope's)."""

    def __init__(self, nodes, edges=(), containment=("CONTAINS",), directions=None):
        self._nodes = list(nodes)
        self._edges = list(edges)
        self._containment = list(containment)
        self._directions = directions or {}

    async def get_ontology_metadata(self):
        return OntologyMetadata(
            containmentEdgeTypes=self._containment, lineageEdgeTypes=[],
            edgeTypeMetadata={t: {"isContainment": True, "direction": d} for t, d in self._directions.items()},
            entityTypeHierarchy={}, rootEntityTypes=[],
        )

    async def get_nodes_query(self, query):
        return [n for n in self._nodes if n.urn in set(query.urns or ())]

    async def get_edges(self, query):
        return list(self._edges)


def _node(urn, entity_type="table", **kw):
    return GraphNode(urn=urn, displayName=urn, entityType=entity_type, **kw)


def _edge(src, tgt, edge_type="CONTAINS"):
    return GraphEdge(id=f"{src}->{tgt}", sourceUrn=src, targetUrn=tgt, edgeType=edge_type)


def _layer(layer_id, order, **kw):
    return {"id": layer_id, "name": layer_id.upper(), "color": "#888888", "order": order, **kw}


def _entry(layer_id, **kw):
    return {"entityId": "", "layerId": layer_id, "priority": 1000, "assignedBy": "user",
            "assignedAt": "2026-10-04T00:00:00Z", **kw}


def _request(layers, *, urns, assignments=None, scope="all"):
    return LayerAssignmentRequest.model_validate({
        "layers": layers, "urns": urns, "assignments": assignments or {}, "entityScope": scope})


def _compute(request, fake, **kw):
    return asyncio.run(AssignmentEngine().compute_assignments(request, engine=fake, **kw))


def _placed(result):
    return {urn: (a.layer_id, a.rule_id, a.is_inherited, a.inherited_from_id)
            for urn, a in result.assignments.items()}


def _no_clock(result):
    dumped = result.model_dump(by_alias=True)
    dumped["stats"].pop("computeTimeMs")
    return dumped


# ── contract=False is today's engine ────────────────────────────────────

def test_without_the_contract_the_legacy_engine_answers():
    """The keyword defaults off, and off is the legacy answer: here the child inherits its
    rule-placed parent's layer (the contract would give the child its own rule)."""
    layers = [_layer("a", 0, entityTypes=["schema"]), _layer("b", 1, entityTypes=["table"])]
    fake = _FakeEngine([_node("p", "schema"), _node("c", "table")], [_edge("p", "c")])
    request = _request(layers, urns=["p", "c"])

    default = _compute(request, fake)
    off = _compute(request, fake, contract=False)
    on = _compute(request, fake, contract=True)

    assert _no_clock(default) == _no_clock(off)
    assert _placed(off)["c"] == ("a", None, True, "p")
    assert _placed(on)["c"] == ("b", "_type_b_table", False, None)


# ── contract=True ───────────────────────────────────────────────────────

def test_hand_placement_cascades_with_its_logical_node():
    layers = [_layer("a", 0), _layer("b", 1, entityTypes=["table"])]
    fake = _FakeEngine([_node("p", "schema"), _node("c", "table")], [_edge("p", "c")])
    result = _compute(_request(layers, urns=["p", "c"], assignments={
        "p": _entry("a", logicalNodeId="ln1")}), fake, contract=True)

    assert _placed(result) == {"p": ("a", None, False, None), "c": ("a", None, True, "p")}
    assert result.assignments["p"].logical_node_id == "ln1"
    assert result.assignments["c"].logical_node_id == "ln1"
    assert result.parent_map == {"c": "p"}


def test_a_stale_entry_falls_through_to_the_rule():
    layers = [_layer("a", 0, entityTypes=["table"])]
    fake = _FakeEngine([_node("x")])
    result = _compute(_request(layers, urns=["x"], assignments={"x": _entry("gone")}), fake, contract=True)
    assert _placed(result) == {"x": ("a", "_type_a_table", False, None)}


def test_containment_direction_comes_from_the_ontology():
    """A BELONGS_TO edge points child -> parent (the system ontology writes target-to-source), and an
    ontology may declare any type that way: the term inherits its glossary's hand placement."""
    layers = [_layer("a", 0), _layer("b", 1)]
    fake = _FakeEngine(
        [_node("g", "glossary"), _node("t", "term"), _node("k", "column")],
        [_edge("t", "g", "BELONGS_TO"), _edge("k", "t", "PART_OF")],
        containment=["BELONGS_TO", "PART_OF"], directions={"PART_OF": "child-to-parent"})
    result = _compute(_request(layers, urns=["g", "t", "k"], assignments={"g": _entry("b")}),
                      fake, contract=True)
    assert _placed(result) == {
        "g": ("b", None, False, None), "t": ("b", None, True, "g"), "k": ("b", None, True, "t")}


def test_several_parents_give_the_same_answer_in_any_edge_order():
    """A hand-placed parent wins before a rule-placed one whatever their URNs, and the answer does
    not depend on the order the provider returns edges in (the legacy engine kept the last)."""
    layers = [_layer("a", 0, entityTypes=["schema"]), _layer("b", 1)]
    nodes = [_node("p1", "schema"), _node("p2", "folder"), _node("x", "file")]
    edges = [_edge("p1", "x"), _edge("p2", "x")]
    request = _request(layers, urns=["p1", "p2", "x"], assignments={"p2": _entry("b")})

    forward = _compute(request, _FakeEngine(nodes, edges), contract=True)
    backward = _compute(request, _FakeEngine(nodes[::-1], edges[::-1]), contract=True)

    assert _placed(forward)["x"] == ("b", None, True, "p2")
    assert forward.assignments == backward.assignments
    assert forward.parent_map == backward.parent_map == {"x": "p2"}
    assert forward.unassigned_entity_ids == backward.unassigned_entity_ids


def test_property_rules_place_and_criteria_combine_with_and():
    """propertyMatch now survives the request model; every criterion of a rule must hold."""
    layers = [_layer("a", 0, rules=[{
        "id": "fin", "priority": 5, "entityTypes": ["table"],
        "propertyMatch": {"field": "owner", "operator": "equals", "value": "finance"}}])]
    fake = _FakeEngine([
        _node("x", properties={"owner": "Finance"}),
        _node("y", properties={"owner": "ops"}),
        _node("z", "view", properties={"owner": "finance"}),
    ])
    result = _compute(_request(layers, urns=["x", "y", "z"]), fake, contract=True)
    assert _placed(result) == {"x": ("a", "fin", False, None)}
    assert sorted(result.unassigned_entity_ids) == ["y", "z"]


def test_inherits_from_parent_false_is_honoured():
    layers = [_layer("a", 0, rules=[
        {"id": "r", "priority": 1, "entityTypes": ["schema"], "inheritsFromParent": False}])]
    fake = _FakeEngine([_node("p", "schema"), _node("c", "file")], [_edge("p", "c")])
    result = _compute(_request(layers, urns=["p", "c"]), fake, contract=True)
    assert _placed(result) == {"p": ("a", "r", False, None)}
    assert result.unassigned_entity_ids == ["c"]
    assert result.parent_map == {"c": "p"}  # still its parent, just not its layer


def test_curated_scope_places_only_by_hand():
    layers = [_layer("a", 0, entityTypes=["table"])]
    fake = _FakeEngine([_node("x"), _node("y", layerAssignment="a")])
    result = _compute(_request(layers, urns=["x", "y"], scope="curated"), fake, contract=True)
    assert result.assignments == {}
    assert sorted(result.unassigned_entity_ids) == ["x", "y"]


def test_the_rest_of_the_response_keeps_its_shape():
    layers = [_layer("a", 0, entityTypes=["table"])]
    fake = _FakeEngine([_node("p", "schema"), _node("x")], [_edge("p", "x")])
    result = _compute(_request(layers, urns=["p", "x"]), fake, contract=True)
    assert [e.id for e in result.edges] == ["p->x"]  # includeEdges defaults on
    assert result.unassigned_entity_ids == ["p"]
    assert result.stats.total_nodes == 2
    assert result.stats.assigned_nodes == 1
    assert result.stats.truncated is False


def test_the_request_reads_as_a_full_view_config():
    request = _request([_layer("a", 0, rules=[{"id": "r", "priority": 2, "tags": ["pii"],
                                               "inheritsFromParent": False}])],
                       urns=["x"], assignments={"x": _entry("a")}, scope="curated")
    config = _request_config(request)
    assert config["content"] == {"entityScope": "curated"}
    layout = config["layout"]["referenceLayout"]
    assert layout["layers"][0]["rules"] == [
        {"id": "r", "priority": 2, "tags": ["pii"], "inheritsFromParent": False}]
    assert layout["assignments"]["x"]["layerId"] == "a"
    assert layout["assignments"]["x"]["inheritsChildren"] is True


# ── the compute route ───────────────────────────────────────────────────

class _RecordingCache:
    def __init__(self):
        self.params = []

    async def get_or_compute(self, *, params, compute, **_kw):
        self.params.append(params)
        return await compute()


@pytest.mark.parametrize("on", [False, True])
async def test_the_compute_route_reads_the_flag_once(monkeypatch, on):
    """One flag read per request decides both the placement and the cache key."""
    reads = []

    async def _flag():
        reads.append(on)
        return on

    cache = _RecordingCache()
    monkeypatch.setattr(assignments_ep, "contract_enabled", _flag)
    monkeypatch.setattr(assignments_ep, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(assignments_ep, "_cache_scope", lambda engine: "scope")
    layers = [_layer("a", 0, entityTypes=["schema"]), _layer("b", 1, entityTypes=["table"])]
    fake = _FakeEngine([_node("p", "schema"), _node("c", "table")], [_edge("p", "c")])

    result = await assignments_ep.compute_assignments(Response(), _request(layers, urns=["p", "c"]), fake)

    assert reads == [on]
    assert ("placementContract" in cache.params[0]) is on
    assert result.assignments["c"].layer_id == ("b" if on else "a")

"""``/graph/changes`` aims an edge update or delete at the edge its id names.

Nodes and edges share one id space, so an edge copied in whose id was also a node's urn is
``edge:<id>`` in history, while the customer's graph — which the canvas reads while the projection
is fresh — still calls it ``<id>``. Sent on as it came, a delete of ``<id>`` tombstoned the NODE.
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import graph
from backend.app.services.versioning import service

_EDGE = {"sourceEntityId": "urn:a", "targetEntityId": "urn:b", "edgeType": "FLOWS"}


class _Svc:
    named: dict = {}
    calls: list = []

    async def get_graph_by_data_source(self, ds):
        return {"graph_id": "g1", "workspace_id": "ws1", "kind": "manual"}

    async def resolve_edges(self, *, graph_id, edge_ids, branch_id=None):
        _Svc.calls.append(("resolve_edges", list(edge_ids), branch_id))
        return {i: _Svc.named[i] for i in edge_ids if i in _Svc.named}

    async def apply_ops_detailed(self, **kw):
        _Svc.calls.append(("apply", kw["ops"]))
        return service.ApplyResult("cmt_1", {}, {})


class _Cache:
    async def bump_generation(self, scope):
        return None


@pytest.fixture
def send(monkeypatch):
    _Svc.calls = []
    monkeypatch.setattr(service, "GraphVersioningService", _Svc)
    monkeypatch.setattr(graph, "get_graph_cache", lambda: _Cache())

    async def no_types(engine):
        return []

    async def no_rules(engine, *, fail_closed=False):
        return None

    monkeypatch.setattr(graph, "_resolve_containment_types", no_types)
    monkeypatch.setattr(graph, "_resolve_ontology_rules", no_rules)

    async def call(named, *ops):
        _Svc.named = named
        request = graph.GraphChangesRequest(ops=[graph.GraphChangeOp(**o) for o in ops])
        return await graph.apply_graph_changes(
            "ws1", request, dataSourceId="ds1", branchId="br1", idempotency_key=None,
            user=SimpleNamespace(id="u1"), engine=None)
    return call


def _applied():
    return [(o["op"], o["entity_kind"], o["entity_id"])
            for name, *rest in _Svc.calls if name == "apply" for o in rest[0]]


async def test_an_edge_named_by_a_node_id_is_the_re_keyed_edge(send):
    await send({"X": ("edge:X", _EDGE)},
               {"op": "delete", "kind": "edge", "id": "X"},
               {"op": "update", "kind": "edge", "id": "X", "payload": {"properties": {"w": 2}}})
    assert ("resolve_edges", ["X", "X"], "br1") in _Svc.calls
    assert _applied() == [("delete", "edge", "edge:X"), ("update", "edge", "edge:X")]


async def test_an_edge_op_on_an_id_that_names_only_a_node_is_refused(send):
    with pytest.raises(HTTPException) as err:
        await send({"X": None}, {"op": "delete", "kind": "edge", "id": "X"})
    assert err.value.status_code == 422 and err.value.detail["type"] == "invalid_patch"
    assert "X" in err.value.detail["message"]
    assert _applied() == [], "the node is never deleted as if it were the edge"


async def test_edge_ops_that_name_an_edge_or_nothing_go_as_sent(send):
    await send({"e1": ("e1", _EDGE)},
               {"op": "delete", "kind": "edge", "id": "e1"},
               {"op": "delete", "kind": "edge", "id": "gone"},
               {"op": "delete", "kind": "node", "id": "X"})
    assert _applied() == [("delete", "edge", "e1"), ("delete", "edge", "gone"),
                          ("delete", "node", "X")]


async def test_a_batch_without_edge_updates_or_deletes_looks_nothing_up(send):
    await send({}, {"op": "create", "kind": "node", "ref": "n1",
                    "payload": {"entityType": "Table", "displayName": "T"}})
    assert [c for c in _Svc.calls if c[0] == "resolve_edges"] == []

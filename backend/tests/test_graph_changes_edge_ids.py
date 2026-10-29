"""``/graph/changes`` has the service aim each edge update or delete at the edge its id names.

Nodes and edges share one id space, so an edge copied in whose id was also a node's urn is
``edge:<id>`` in history, while the customer's graph — which the canvas reads while the projection
is fresh — still calls it ``<id>``. Sent on as it came, a delete of ``<id>`` tombstoned the NODE.
The route used to aim the ops itself, before the service had found the draft writable by this
person or answered a retry: so the aim read drafts the caller couldn't, a retry of a delete that had
landed was refused, and ``main`` failed with a 500. The service aims them after those checks
(``aim_edges``); its behaviour is pinned over HTTP in ``integration/test_api_graph_draft_journey``.
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import graph
from backend.app.services.versioning import service
from backend.app.services.versioning.errors import NotAnEdge


class _Svc:
    calls: list = []
    refuse = None

    async def get_graph_by_data_source(self, ds):
        return {"graph_id": "g1", "workspace_id": "ws1", "kind": "manual"}

    async def resolve_edges(self, **_kw):
        raise AssertionError("the route looked up the draft before the service checked it")

    async def apply_ops_detailed(self, **kw):
        _Svc.calls.append(kw)
        if _Svc.refuse is not None:
            raise _Svc.refuse
        return service.ApplyResult("cmt_1", {}, {})


class _Cache:
    async def bump_generation(self, scope):
        return None


@pytest.fixture
def send(monkeypatch):
    _Svc.calls, _Svc.refuse = [], None
    monkeypatch.setattr(service, "GraphVersioningService", _Svc)
    monkeypatch.setattr(graph, "get_graph_cache", lambda: _Cache())

    async def no_types(engine):
        return []

    async def no_rules(engine, *, fail_closed=False):
        return None

    async def no_identity(engine):
        return None

    monkeypatch.setattr(graph, "_resolve_containment_types", no_types)
    monkeypatch.setattr(graph, "_resolve_ontology_rules", no_rules)
    monkeypatch.setattr(graph, "_node_identity_for_write", no_identity)

    async def call(*ops):
        request = graph.GraphChangesRequest(ops=[graph.GraphChangeOp(**o) for o in ops])
        return await graph.apply_graph_changes(
            "ws1", request, dataSourceId="ds1", branchId="br1", idempotency_key=None,
            user=SimpleNamespace(id="u1"), engine=None)
    return call


async def test_the_service_aims_edge_ops_once_it_has_checked_the_draft(send):
    await send({"op": "delete", "kind": "edge", "id": "X"},
               {"op": "update", "kind": "edge", "id": "X", "payload": {"properties": {"w": 2}}})
    (kw,) = _Svc.calls
    assert kw["aim_edges"] is True
    assert [(o["op"], o["entity_id"]) for o in kw["ops"]] == [("delete", "X"), ("update", "X")]


async def test_an_edge_op_on_an_id_that_names_only_a_node_is_refused(send):
    _Svc.refuse = NotAnEdge(["X"])
    with pytest.raises(HTTPException) as err:
        await send({"op": "delete", "kind": "edge", "id": "X"})
    assert err.value.status_code == 422 and err.value.detail["type"] == "invalid_patch"
    assert "X" in err.value.detail["message"]

"""The write-through writes a versioned graph's main to Postgres only; the projector is the
only FalkorDB writer.

* No write reaches the wrapped FalkorDB provider: it was a second writer, outside the
  projector's ordering, that the watermark could not see.
* An edge endpoint is backfilled from FalkorDB only when main has never recorded it. Re-sending
  FalkorDB's copy of a recorded node overwrote what main committed with cache-shaped values, and
  brought back a node main had deleted.
* ``update_edge`` answers with the edge as Postgres committed it; an edge Postgres does not hold
  is not found (``None`` / ``False``).
* A write that commits nudges the projector; a no-op does not.
* The admin flag is checked before any service call.

No services: a fake versioning service and a FalkorDB-shaped inner provider. The real
``entity_recorded`` runs in ``tests/integration/test_versioning_single_writer.py``.
"""
from typing import Dict, List, Optional

import pytest

from backend.app.providers import versioned_write_provider as vwp
from backend.app.services.feature_flags import FeatureDisabledError
from backend.app.services.versioning.service import ApplyResult
from backend.common.models.graph import GraphEdge, GraphNode


class _Svc:
    """Main holds ``values`` (``None`` = deleted); ``recorded`` is every id main ever saw."""

    def __init__(self, values: Optional[Dict[str, Optional[dict]]] = None, *,
                 commit_id: Optional[str] = "c1", written: Optional[dict] = None):
        self.values = dict(values or {})
        self.commit_id = commit_id
        self.written = dict(written or {})
        self.applied: List[dict] = []
        self.calls: List[str] = []

    async def resolve_graph(self, **kw):
        self.calls.append("resolve_graph")
        return {"graph_id": "g"}

    async def entity_recorded(self, *, graph_id, entity_id):
        self.calls.append("entity_recorded")
        return entity_id in self.values

    async def entity_value(self, *, graph_id, entity_id, branch_id=None):
        self.calls.append("entity_value")
        return self.values.get(entity_id)

    async def apply_ops_detailed(self, **kw):
        self.calls.append("apply_ops_detailed")
        self.applied.extend(kw["ops"])
        written = {o["entity_id"]: (o["entity_kind"], o["payload"]) for o in kw["ops"]}
        written.update(self.written)
        return ApplyResult(self.commit_id, written, {})

    async def apply_ops(self, **kw):                      # the dual-writer path
        self.calls.append("apply_ops")
        self.applied.extend(kw["ops"])
        return self.commit_id


class _Falkor:
    """FalkorDB-shaped: its node copies carry cache fields; every write is recorded."""

    def __init__(self, *urns):
        self.nodes = {u: GraphNode(urn=u, entityType="Dataset", displayName=u, description="",
                                   sourceSystem="", lastSyncedAt="", layerAssignment="",
                                   childCount=3) for u in urns}
        self.calls: List[tuple] = []

    async def get_node(self, urn):
        return self.nodes.get(urn)

    async def create_node(self, node, containment_edge=None):
        self.calls.append(("create_node", node.urn))
        return True

    async def create_edge(self, edge):
        self.calls.append(("create_edge", edge.id))
        return True

    async def update_edge(self, edge_id, properties):
        self.calls.append(("update_edge", edge_id))
        return GraphEdge(id=edge_id, sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO",
                         properties={"from": "falkor"})

    async def delete_edge(self, edge_id):
        self.calls.append(("delete_edge", edge_id))
        return True

    async def save_custom_graph(self, nodes, edges):
        self.calls.append(("save", len(nodes), len(edges)))
        return True


@pytest.fixture
def nudges(monkeypatch):
    sent: List[str] = []

    async def _flag_on():
        return None

    async def _nudge(graph_id):
        sent.append(graph_id)
    monkeypatch.setattr(vwp, "_require_versioning_flag", _flag_on)
    monkeypatch.setattr(vwp, "nudge_projection", _nudge, raising=False)
    return sent


def _provider(inner, svc):
    return vwp.VersionedWriteProvider(inner, workspace_id="ws", data_source_id="ds",
                                      actor="u", svc=svc)


_A = {"urn": "a", "entityType": "Dataset", "displayName": "a"}
_B = {"urn": "b", "entityType": "Dataset", "displayName": "b"}
_E = {"sourceEntityId": "a", "targetEntityId": "b", "edgeType": "FLOWS_TO",
      "properties": {"w": 1}}


@pytest.mark.asyncio
async def test_an_edge_between_recorded_nodes_records_only_the_edge(nudges):
    inner, svc = _Falkor("a", "b"), _Svc({"a": _A, "b": _B})
    edge = GraphEdge(id="e1", sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO")
    assert await _provider(inner, svc).create_edge(edge) is True
    assert [o["entity_id"] for o in svc.applied] == ["e1"]
    assert inner.calls == []


@pytest.mark.asyncio
async def test_a_node_main_deleted_is_not_brought_back_from_falkordb(nudges):
    inner, svc = _Falkor("a", "b"), _Svc({"a": _A, "b": None})
    edge = GraphEdge(id="e1", sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO")
    await _provider(inner, svc).create_edge(edge)
    assert [o["entity_id"] for o in svc.applied] == ["e1"]    # apply_ops then refuses the dangle
    assert inner.calls == []


@pytest.mark.asyncio
async def test_an_endpoint_main_never_recorded_is_backfilled_from_falkordb(nudges):
    # Legacy graphs whose FalkorDB holds nodes the bootstrap missed still get a referentially
    # whole edge; the recorded endpoint is not re-sent.
    inner, svc = _Falkor("a", "b"), _Svc({"a": _A})
    edge = GraphEdge(id="e1", sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO")
    await _provider(inner, svc).create_edge(edge)
    backfill = [o for o in svc.applied if o["entity_kind"] == "node"]
    assert [(o["op"], o["entity_id"]) for o in backfill] == [("create", "b")]
    assert backfill[0]["payload"]["displayName"] == "b"


@pytest.mark.asyncio
async def test_update_of_an_edge_postgres_does_not_hold_is_not_found(nudges):
    inner, svc = _Falkor(), _Svc()
    assert await _provider(inner, svc).update_edge("e1", {"w": 2}) is None
    assert svc.applied == [] and inner.calls == []


@pytest.mark.asyncio
async def test_update_answers_with_the_edge_postgres_committed(nudges):
    # A concurrent writer's field is in the committed value but not in patch-onto-cur, so the
    # answer can only have come from Postgres.
    committed = {**_E, "confidence": 0.7, "properties": {"w": 2, "other": "x"}}
    inner, svc = _Falkor(), _Svc({"e1": _E}, written={"e1": ("edge", committed)})
    edge = await _provider(inner, svc).update_edge("e1", {"w": 2})
    assert svc.applied == [{"op": "update", "entity_kind": "edge", "entity_id": "e1",
                            "payload": {"properties": {"w": 2}}}]
    assert (edge.id, edge.source_urn, edge.target_urn, edge.edge_type) == ("e1", "a", "b", "FLOWS_TO")
    assert edge.confidence == 0.7 and edge.properties == {"w": 2, "other": "x"}
    assert inner.calls == []


@pytest.mark.asyncio
async def test_delete_records_in_postgres_only(nudges):
    inner = _Falkor()
    assert await _provider(inner, _Svc()).delete_edge("e1") is False
    svc = _Svc({"e1": _E})
    assert await _provider(inner, svc).delete_edge("e1") is True
    assert svc.applied == [{"op": "delete", "entity_kind": "edge", "entity_id": "e1",
                            "payload": None}]
    assert inner.calls == []


@pytest.mark.asyncio
async def test_node_and_save_writes_skip_falkordb(nudges):
    inner, svc = _Falkor(), _Svc()
    prov = _provider(inner, svc)
    node = GraphNode(urn="n", entityType="Dataset", displayName="n")
    assert await prov.create_node(node) is True
    assert await prov.save_custom_graph([node], []) is True
    assert [o["entity_id"] for o in svc.applied] == ["n", "n"]
    assert inner.calls == []


@pytest.mark.asyncio
async def test_a_write_that_commits_nudges_the_projector_once(nudges):
    node = GraphNode(urn="n", entityType="Dataset", displayName="n")
    await _provider(_Falkor(), _Svc()).create_node(node)
    assert nudges == ["g"]
    await _provider(_Falkor(), _Svc(commit_id=None)).create_node(node)    # a no-op commits nothing
    assert nudges == ["g"]


def _edge():
    return GraphEdge(id="e1", sourceUrn="a", targetUrn="b", edgeType="CONTAINS")


@pytest.mark.asyncio
@pytest.mark.parametrize("write", [
    lambda p: p.create_edge(_edge()),
    lambda p: p.create_node(GraphNode(urn="b", entityType="Dataset", displayName="b"), _edge()),
    lambda p: p.update_edge("e1", {"w": 2}),
    lambda p: p.delete_edge("e1"),
], ids=["create_edge", "create_node_contained", "update_edge", "delete_edge"])
async def test_the_flag_is_checked_before_any_service_call(monkeypatch, write):
    async def _flag_off():
        raise FeatureDisabledError("versioningEnabled")
    monkeypatch.setattr(vwp, "_require_versioning_flag", _flag_off)
    inner, svc = _Falkor("a", "b"), _Svc({"a": _A, "b": _B, "e1": _E})
    with pytest.raises(FeatureDisabledError):
        await write(_provider(inner, svc))
    assert svc.calls == [] and inner.calls == []

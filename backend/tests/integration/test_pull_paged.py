"""A draft past ``SQUASH_PAGED_ABOVE`` changes pulls main reading only what main changed too —
needs Postgres.

Pins: the paged pull (``_pull_paged``) leaves the draft as the pull that reads the whole draft
does, on the same history run into two graphs, one pulled each way:
- a field main changed merges with the draft's change of another field of the same node;
- an edge the draft made onto a node main deleted is deleted with it (the cascade);
- an edge the draft made onto a node of its own, which main changed nothing of, is kept, and an
  edge main changed that ends at a node of the draft's own passes the integrity check;
- what main made or changed that the draft never touched comes from main;
and a field both changed differently is the same conflict either way, writing nothing.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _node(eid, **payload):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid, **payload}}


def _edge(eid, a, b):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"sourceEntityId": a, "targetEntityId": b, "edgeType": "LINEAGE"}}


def _update(eid, kind="node", **payload):
    return {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}


async def _history(svc, *, conflict=False):
    """A graph, and a draft of it main moved past. Returns the graph and the draft."""
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    seed = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=seed, actor="alice", message="seed", ops=[
        *[_node(f"n{i}") for i in range(1, 7)], _edge("e12", "n1", "n2"), _edge("e34", "n3", "n4"),
        _edge("e56", "n5", "n6")])
    await svc.publish(graph_id=gid, branch_id=seed, actor="alice", message="seed")
    mine = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=mine, actor="bob", message="mine", ops=[
        _update("n1", description="bob's"),
        _node("n7"), _edge("e75", "n7", "n5"),           # onto a node main changes
        _edge("e23", "n2", "n3"),                        # onto a node main deletes
        _update("n6", displayName="bob's six"),
        _edge("e67", "n6", "n7")])                       # onto a node of the draft's own
    theirs = await svc.open_draft(graph_id=gid, owner="carol")
    await svc.apply_ops(graph_id=gid, branch_id=theirs, actor="carol", message="theirs", ops=[
        _update("n1", displayName="carol's one"),
        {"op": "delete", "entity_kind": "node", "entity_id": "n3"},
        _update("n5", displayName="carol's five"), _node("n8"),
        _update("e56", kind="edge", properties={"w": 2}),
        *([_update("n6", displayName="carol's six")] if conflict else [])])
    await svc.publish(graph_id=gid, branch_id=theirs, actor="carol", message="theirs")
    return gid, mine


async def _pulled(svc, monkeypatch, paged, *, conflict=False):
    gid, mine = await _history(svc, conflict=conflict)
    monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 1 if paged else 10 ** 9)
    pulled = await svc.rebase_draft(graph_id=gid, branch_id=mine, actor="bob")
    state = await svc.materialize_state(graph_id=gid, branch_id=mine)
    return pulled, state


async def _run(monkeypatch):
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    whole, whole_state = await _pulled(svc, monkeypatch, paged=False)
    paged, paged_state = await _pulled(svc, monkeypatch, paged=True)
    assert whole["clean"] and paged["clean"], (whole, paged)
    assert paged["changes"] == whole["changes"]
    assert paged_state == whole_state
    nodes, edges = paged_state["nodes"], paged_state["edges"]
    assert (nodes["n1"]["displayName"], nodes["n1"]["description"]) == ("carol's one", "bob's")
    assert "n3" not in nodes and "e23" not in edges and "e34" not in edges
    assert {"e75", "e67", "e12", "e56"} <= set(edges)
    assert nodes["n5"]["displayName"] == "carol's five" and "n8" in nodes

    whole, _ = await _pulled(svc, monkeypatch, paged=False, conflict=True)
    paged, _ = await _pulled(svc, monkeypatch, paged=True, conflict=True)
    assert not whole["clean"] and not paged["clean"]
    assert [(c["entity_id"], c["path"]) for c in paged["conflicts"]] == [
        (c["entity_id"], c["path"]) for c in whole["conflicts"]] == [("n6", ["displayName"])]


def test_a_large_draft_pulls_main_as_a_whole_draft_does(monkeypatch):
    async def run():
        try:
            await _run(monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())

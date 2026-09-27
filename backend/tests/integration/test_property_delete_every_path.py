"""Removing a property persists on EVERY write path (needs Postgres).

Reported 2026-09-27: deleting a node property in the drawer and saving said "Saved", and the
property came back on reload. The drawer sent the whole bag; the server merges ``properties`` key
by key, so a key left out was simply kept. Around it, the other paths each got removal wrong
differently: the stage→checkpoint fold replaced the bag (a partial edit wiped the siblings), two
updates in one save dropped the first's removal, a create could store the marker, and an edge
PATCH replaced the bag in the provider.

Removal is now explicit — ``unsetProperties`` → the one internal marker — and each path below
applies it the same way, and never stores the marker.
"""
import asyncio
import json
import os

import pytest

from backend.app.api.v1.endpoints.graph import _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.versioning import db, models
from backend.app.services.versioning.ids import prefixed_id
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.property_patch import PROP_DELETE


class _Op:
    """A /graph/changes op as the route parses it."""

    def __init__(self, op, kind, id=None, ref=None, payload=None, unset=None, base_version=None):
        self.op, self.kind, self.id, self.ref, self.payload = op, kind, id, ref, payload
        self.unset_properties, self.base_version = unset, base_version


async def _save(svc, gid, bid, *ops):
    """The /graph/changes save: resolve the wire ops, apply them as one commit."""
    resolved, _ = _resolve_change_ops(list(ops), prefixed_id, make_urn)
    return await svc.apply_ops(graph_id=gid, branch_id=bid, ops=resolved, actor="alice", message="save")


def _node(urn, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": "dataset", "displayName": urn, "properties": props}}


def _edge(eid, s, t, **props):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": s, "targetEntityId": t,
                        "properties": props}}


async def _props(svc, gid, bid, eid):
    value = await svc.entity_value(graph_id=gid, entity_id=eid, branch_id=bid)
    assert value is not None, eid
    assert PROP_DELETE not in json.dumps(value), value       # the marker never reaches storage
    return value.get("properties") or {}


async def _head_hash(svc, gid, bid, eid):
    async with db.graphver_session() as s:
        return await svc._effective_head_hash(s, gid, bid, eid)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws_del", actor="alice")
    gid = g["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[
        _node("A", gone="x", kept="k"), _node("B", gone="x", kept="k"), _node("C", gone="x", kept="k"),
        _node("S", gone="x", kept="k"), _node("T", gone="x", kept="k"),
        _edge("E1", "A", "B", gone="x", kept="k"), _edge("E2", "A", "C", gone="x", kept="k")])
    d = await svc.open_draft(graph_id=gid, owner="alice")

    # 1 · /graph/changes, no OCC token: unset removes, the rest is kept.
    await _save(svc, gid, d, _Op("update", "node", id="A", payload={"properties": {"new": 1}}, unset=["gone"]))
    assert await _props(svc, gid, d, "A") == {"kept": "k", "new": 1}

    # 2 · with an OCC token: the 3-way merge carries the removal.
    tok = await _head_hash(svc, gid, d, "B")
    assert tok
    await _save(svc, gid, d, _Op("update", "node", id="B", payload={}, unset=["gone"], base_version=tok))
    assert await _props(svc, gid, d, "B") == {"kept": "k"}

    # 3 · a rename + a removal of ONE node in ONE save keep both.
    await _save(svc, gid, d,
                _Op("update", "node", id="C", unset=["gone"]),
                _Op("update", "node", id="C", payload={"displayName": "C renamed"}))
    c = await svc.entity_value(graph_id=gid, entity_id="C", branch_id=d)
    assert c["displayName"] == "C renamed" and c["properties"] == {"kept": "k"}, c

    # 4 · an edge through /graph/changes.
    await _save(svc, gid, d, _Op("update", "edge", id="E1", unset=["gone"]))
    assert await _props(svc, gid, d, "E1") == {"kept": "k"}

    # 5 · an edge PATCH through the branch provider (PATCH /edges on a draft).
    prov = VersionedBranchProvider(svc, graph_id=gid, branch_id=d, actor="alice")
    edge = await prov.update_edge("E2", {"gone": PROP_DELETE, "added": 2})
    assert edge.properties == {"kept": "k", "added": 2}
    assert await _props(svc, gid, d, "E2") == {"kept": "k", "added": 2}

    # 6 · a create carrying a marker never stores it.
    await _save(svc, gid, d, _Op("create", "node", ref="t1",
                                 payload={"urn": "N", "entityType": "dataset", "displayName": "N",
                                          "properties": {"x": PROP_DELETE, "y": 1}}))
    assert await _props(svc, gid, d, "N") == {"y": 1}

    # 7 · stage → checkpoint (the API-only stage path): a partial properties patch keeps its
    #     siblings, and a removal survives a later staged edit of another property.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "S",
         "payload": {"properties": {"gone": PROP_DELETE}}}])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "S", "payload": {"properties": {"more": 1}}}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    assert await _props(svc, gid, d, "S") == {"kept": "k", "more": 1}

    # 8 · the shared-draft fold: the same through a collaborative draft.
    shared = await svc.open_draft(graph_id=gid, owner="alice", shared=True)
    await svc.stage_changes(graph_id=gid, branch_id=shared, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "T",
         "payload": {"properties": {"gone": PROP_DELETE}}}])
    await svc.checkpoint(graph_id=gid, branch_id=shared, actor="alice")
    assert await _props(svc, gid, shared, "T") == {"kept": "k"}

    # 9 · publish: every removal above reaches main.
    await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="publish removals")
    main = g["main_branch_id"]
    assert await _props(svc, gid, main, "A") == {"kept": "k", "new": 1}
    assert await _props(svc, gid, main, "B") == {"kept": "k"}
    assert await _props(svc, gid, main, "E1") == {"kept": "k"}
    assert await _props(svc, gid, main, "S") == {"kept": "k", "more": 1}
    assert await _props(svc, gid, main, "N") == {"y": 1}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_property_delete_every_path_e2e():
    asyncio.run(_run())

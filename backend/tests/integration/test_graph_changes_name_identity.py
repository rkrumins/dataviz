"""A versioned write keeps each node's own name and identity properties in step (needs Postgres).

A node the platform wrote itself — created or renamed in the editor, staged through the API — used
to carry ``urn`` and ``displayName`` and never the ``name``/``title``/``id`` its source names and
keys nodes by, and publishing projected exactly that. Here every such write goes through the real
service: what is stored, what a save answers with, and what a concurrent edit conflicts on.
"""
import asyncio
import os

import pytest

from backend.app.api.v1.endpoints.graph import _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.node_identity import ResolvedNodeIdentity
from backend.app.services.versioning import db, models
from backend.app.services.versioning.entity_audit import entity_views
from backend.app.services.versioning.ids import prefixed_id
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict

MAPPED = ResolvedNodeIdentity(identity_property="id", name_property="title")


class _Op:
    def __init__(self, op, kind, id=None, ref=None, payload=None, base_version=None):
        self.op, self.kind, self.id, self.ref, self.payload = op, kind, id, ref, payload
        self.base_version, self.unset_properties = base_version, None


def _create(ref, name, **extra):
    return _Op("create", "node", ref=ref, payload={"entityType": "dataset", "displayName": name, **extra})


async def _save(svc, gid, bid, *ops, identity=MAPPED, actor="ana"):
    resolved, assigned = _resolve_change_ops(list(ops), prefixed_id, make_urn)
    res = await svc.apply_ops_detailed(graph_id=gid, branch_id=bid, ops=resolved, actor=actor,
                                       message="save", node_identity=identity)
    return res, assigned


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws_ni", actor="ana")
    gid = g["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="ana")

    async def value(eid):
        return await svc.entity_value(graph_id=gid, entity_id=eid, branch_id=d)

    # 1 · a new node is stored — and answered — with its own name and identity properties
    res, assigned = await _save(svc, gid, d, _create("t1", "Orders"))
    orders = assigned["t1"]
    assert (await value(orders))["properties"] == {"title": "Orders", "id": orders}
    views, _ = entity_views(res.written, res.urns)
    assert views[orders]["node"]["properties"] == {"title": "Orders", "id": orders}

    # 2 · created, then renamed before its first save: named by its last name
    _, assigned = await _save(svc, gid, d, _create("t2", "Draft"),
                              _Op("update", "node", id="t2", payload={"displayName": "Sales"}))
    assert (await value(assigned["t2"]))["properties"]["title"] == "Sales"

    # 3 · a set of entities in one save: each named, each its own identity
    _, assigned = await _save(svc, gid, d, *[_create(f"b{i}", f"T{i}") for i in range(300)])
    for i in (0, 150, 299):
        assert (await value(assigned[f"b{i}"]))["properties"] == {"title": f"T{i}", "id": assigned[f"b{i}"]}

    # 4 · a duplicate's copied bag keeps neither its original's identity nor its name
    _, assigned = await _save(svc, gid, d, _create(
        "dup", "Orders (Copy)", properties={"title": "Orders", "id": orders, "duplicatedFrom": orders}))
    copy_urn = assigned["dup"]
    assert (await value(copy_urn))["properties"] == {
        "title": "Orders (Copy)", "id": copy_urn, "duplicatedFrom": orders}

    # 5 · a restored snapshot (its own urn) is kept exactly
    snapshot = {"urn": "urn:restored", "entityType": "dataset", "displayName": "Kept",
                "properties": {"title": "kept_title", "id": "native-7"}}
    await _save(svc, gid, d, _Op("create", "node", ref="r", payload=snapshot))
    assert (await value("urn:restored"))["properties"] == {"title": "kept_title", "id": "native-7"}

    # 6 · a rename carries the name while the two agree; once set apart, the name stays
    await _save(svc, gid, d, _Op("update", "node", id=orders, payload={"displayName": "All orders"}))
    assert (await value(orders))["properties"]["title"] == "All orders"
    await _save(svc, gid, d, _Op("update", "node", id=orders, payload={
        "displayName": "Every order", "properties": {"title": "orders_v1"}}))
    await _save(svc, gid, d, _Op("update", "node", id=orders, payload={"displayName": "Each order"}))
    stored = await value(orders)
    assert (stored["displayName"], stored["properties"]["title"]) == ("Each order", "orders_v1")

    # 7 · a concurrent rename conflicts on the display name alone, never on a mirrored value
    res, assigned = await _save(svc, gid, d, _create("c", "Base"))
    concurrent = assigned["c"]
    token = entity_views(res.written, res.urns)[0][concurrent]["version"]
    await _save(svc, gid, d, _Op("update", "node", id=concurrent, payload={"displayName": "Theirs"},
                                 base_version=token), actor="bo")
    with pytest.raises(MergeConflict) as conflict:
        await _save(svc, gid, d, _Op("update", "node", id=concurrent, payload={"displayName": "Ours"},
                                     base_version=token))
    assert [c["path"] for c in conflict.value.conflicts] == [["displayName"]]

    # 8 · without a mapping nothing is bound; a node that never had the properties gets them on
    #     its next save, whatever that save changes
    legacy = {"urn": "urn:legacy", "entityType": "dataset", "displayName": "Legacy"}
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="ana", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "urn:legacy", "payload": legacy}])
    assert await value("urn:legacy") == legacy
    await _save(svc, gid, d, _Op("update", "node", id="urn:legacy", payload={"description": "old"}))
    assert (await value("urn:legacy"))["properties"] == {"title": "Legacy", "id": "urn:legacy"}

    # 9 · edits staged through the API are bound when the draft checkpoints
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "urn:staged",
         "payload": {"urn": "urn:staged", "entityType": "dataset", "displayName": "Staged"}}])
    assert await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", node_identity=MAPPED)
    assert (await value("urn:staged"))["properties"] == {"title": "Staged", "id": "urn:staged"}

    # 10 · the platform's own default names a node under `name`
    _, assigned = await _save(svc, gid, d, _create("plain", "Plain"), identity=ResolvedNodeIdentity())
    assert (await value(assigned["plain"]))["properties"] == {"name": "Plain"}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioned_writes_bind_name_and_identity_e2e():
    asyncio.run(_run())

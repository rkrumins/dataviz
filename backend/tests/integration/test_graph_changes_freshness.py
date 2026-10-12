"""A save answers with what it wrote, so the next edit is never a conflict with the last save
(needs Postgres).

After a save the canvas kept the node as it was READ, token included, so a second edit of the same
field three-way-merged against a base the draft had already moved past — and conflicted with the
user's own save. A real conflict failed the whole save without saying what it conflicted with.
"""
import asyncio
import os

import pytest

from backend.app.api.v1.endpoints.graph import _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.versioning import db, models
from backend.app.services.versioning.entity_audit import entity_views
from backend.app.services.versioning.ids import prefixed_id
from backend.app.services.versioning.merkle import content_hash
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict


class _Op:
    def __init__(self, op, kind, id=None, payload=None, base_version=None, unset=None):
        self.op, self.kind, self.id, self.ref, self.payload = op, kind, id, None, payload
        self.base_version, self.unset_properties = base_version, unset


async def _save(svc, gid, bid, *ops, actor="ana"):
    resolved, _ = _resolve_change_ops(list(ops), prefixed_id, make_urn)
    return await svc.apply_ops_detailed(graph_id=gid, branch_id=bid, ops=resolved, actor=actor, message="save")


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws_fresh", actor="ana")
    gid = g["graph_id"]
    seed = {"urn": "N", "entityType": "dataset", "displayName": "N", "properties": {"owner": "ana"}}
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N", "payload": seed},
        {"op": "create", "entity_kind": "node", "entity_id": "M",
         "payload": {"urn": "M", "entityType": "dataset", "displayName": "M"}},
        {"op": "create", "entity_kind": "edge", "entity_id": "E",
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "N", "targetEntityId": "M", "properties": {}}}])
    d = await svc.open_draft(graph_id=gid, owner="ana")
    token = content_hash(seed)

    # 1 · the save answers with the value and token it wrote
    res = await _save(svc, gid, d, _Op("update", "node", id="N", payload={"properties": {"owner": "bo"}},
                                       base_version=token))
    views, truncated = entity_views(res.written, res.urns)
    assert not truncated and res.commit_id
    assert views["N"]["node"]["properties"] == {"owner": "bo"}
    fresh = views["N"]["version"]
    assert fresh != token

    # 2 · the next edit of the same field, from the returned token, is not a conflict
    res = await _save(svc, gid, d, _Op("update", "node", id="N", payload={"properties": {"owner": "cy"}},
                                       base_version=fresh))
    assert res.commit_id
    # …whereas from the stale token it is one (the user's own save moved the field)
    with pytest.raises(MergeConflict):
        await _save(svc, gid, d, _Op("update", "node", id="N", payload={"properties": {"owner": "dee"}},
                                     base_version=fresh))

    # 3 · a real conflict says what it conflicts with: the kind, and the current value
    current = (await svc.entity_value(graph_id=gid, entity_id="N", branch_id=d))
    try:
        await _save(svc, gid, d, _Op("update", "node", id="N", payload={"properties": {"owner": "eve"}},
                                     base_version=token), actor="eve")
        raise AssertionError("expected a conflict")
    except MergeConflict as exc:
        assert {c["entity_kind"] for c in exc.conflicts} == {"node"}
        assert [c["path"] for c in exc.conflicts] == [["properties", "owner"]]
        views, _ = entity_views(exc.current)
        assert views["N"]["node"]["properties"] == current["properties"]
        assert views["N"]["version"] == content_hash(current)

    # 4 · disjoint edits from the same stale token still merge
    res = await _save(svc, gid, d, _Op("update", "node", id="N", payload={"properties": {"tier": "gold"}},
                                       base_version=token))
    assert res.commit_id
    assert (await svc.entity_value(graph_id=gid, entity_id="N", branch_id=d))["properties"] == {
        "owner": "cy", "tier": "gold"}

    # 5 · an edge save answers with its endpoints' urns; a delete says it is gone
    res = await _save(svc, gid, d, _Op("update", "edge", id="E", payload={"properties": {"sla": "1h"}}))
    views, _ = entity_views(res.written, res.urns)
    assert views["E"]["edge"]["sourceUrn"] == "N" and views["E"]["edge"]["properties"] == {"sla": "1h"}
    res = await _save(svc, gid, d, _Op("delete", "edge", id="E"))
    assert entity_views(res.written, res.urns)[0]["E"] == {"kind": "edge", "version": None, "deleted": True}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_graph_changes_freshness_e2e():
    asyncio.run(_run())

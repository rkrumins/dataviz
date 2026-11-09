"""Restoring a published deletion into a draft — needs Postgres.

A deletion's cascade read with ``into`` says what the restore would meet in the draft: what it
hangs from there, the links it can't take, and whether the draft can take it at all — not when
the draft branched off before the deletion (it still has what was deleted), when the draft has
one of its entities again, or when its old parent is gone. The journey stages the restore as the
canvas would, through ``POST /graph/changes``, and publishes it: the same entities are back as
they were, under the same ids, an imported node (whose id is not its urn) included.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning import service as service_mod
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.service import GraphVersioningService

from .test_api_graph_draft_journey import _build_app, _StubCache, _StubManager
from .test_entity_summary_and_history import CONT, _gone, _link, _named, _published_deletion

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


async def _run_refusals() -> None:
    await models.create_schema_and_partitions()
    service_mod._CHANGE_INDEXES.clear()
    svc = GraphVersioningService()
    gid, main, d = await _published_deletion(svc)
    old = await svc.open_draft(graph_id=gid, owner="ana")          # branched before it is published
    await svc.publish(graph_id=gid, branch_id=d, actor="cy", message="publish the drop")
    n = (await svc.get_graph(gid))["main_head_commit_seq"]
    window = ChangeOrigin(from_seq=n - 1, to_seq=n)

    async def draft(*ops):
        b = await svc.open_draft(graph_id=gid, owner="ana")
        if ops:
            await svc.apply_ops(graph_id=gid, branch_id=b, actor="ana", message="edit",
                                containment_edge_types=CONT, ops=list(ops))
        return b

    async def into(target, root="T"):
        return await svc.deletion_cascade(graph_id=gid, origin=window, entity_id=root,
                                          containment_edge_types=CONT, into=target)

    # A draft opened since: everything it hangs from is there.
    fresh = await draft()
    ok = await into(fresh)
    assert (ok["restorable"], ok.get("reason")) == (True, None)
    assert ok["live"] == ["SCH", "OUT", "urn:x"] and ok["skippedLinks"] == []
    assert len(ok["removed"]) == 8 and all(e["before"] for e in ok["removed"])

    # A link whose other end the draft no longer has is skipped; the rest is restored.
    part = await into(await draft(_gone("OUT")))
    assert (part["restorable"], part["skippedLinks"], part["live"]) == (True, ["lin"], ["SCH", "urn:x"])

    # Refused: the draft still has it ...
    late = await into(old)
    assert (late["restorable"], late["reason"]) == (False, "draft_predates")
    # ... has one of its nodes again, by id or under another id with its urn ...
    for again in (_named("C1", "amount", "Column"), _named("C2b", "currency", "Column", urn="C2")):
        made = await into(await draft(again))
        assert (made["restorable"], made["reason"]) == (False, "recreated"), again
    # ... or no longer has where it hung: its parent deleted in the draft, or deleted with it.
    gone = await into(await draft(_gone("SCH")))
    assert (gone["restorable"], gone["reason"]) == (False, "parent_gone")
    assert gone["detail"] == {"parentId": "SCH", "parentName": "crm"}
    assert gone["live"] == [] and set(gone["skippedLinks"]) == {"sch_t", "lin", "lin_x"}
    child = await into(fresh, "C1")
    assert (child["restorable"], child["reason"]) == (False, "parent_gone")
    assert child["detail"] == {"parentId": "T", "parentName": "orders"}
    assert child["live"] == ["urn:x"] and child["skippedLinks"] == ["t_c1"]

    # Restored into a draft, never into main.
    with pytest.raises(ValueError):
        await into(main)

    service_mod._CHANGE_INDEXES.clear()
    await db.dispose_engine()


def test_a_restore_into_a_draft_is_refused_when_the_draft_cannot_take_it():
    asyncio.run(_run_refusals())


def _written(eid, name, etype, urn=None, **props):
    """A node as a canvas save or an import writes it: its name property in step with its
    displayName. A save fills an empty one, a restore's create included
    (``node_identity.bind_node_write``), so a node written without it comes back with it."""
    op = _named(eid, name, etype, urn=urn, **props)
    op["payload"]["properties"]["name"] = name
    return op


async def _run_journey(monkeypatch) -> None:
    """Deleted in a draft and published; restored in a new draft as the canvas stages it, and
    published again: the same entities, as they were, under the same ids."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import versioning as V

    await models.create_schema_and_partitions()
    service_mod._CHANGE_INDEXES.clear()
    app, G = _build_app()

    async def containment(*_a):
        return CONT
    monkeypatch.setattr(G, "_resolve_containment_types", containment)
    monkeypatch.setattr(V, "_live_containment_types", containment)
    monkeypatch.setattr(G, "provider_manager", _StubManager())
    monkeypatch.setattr(G, "get_graph_cache", lambda: _StubCache())
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})
            assert r.status_code == 201, r.text
            gid, main = r.json()["graphId"], r.json()["mainBranchId"]
            # crm ⊃ {orders ⊃ {amount, currency (imported: its id is not its urn)}, report}, and
            # lineage from currency to report.
            await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT, ops=[
                _written("SCH", "crm", "Schema"), _written("T", "orders", "Table", rows=12),
                _written("C1", "amount", "Column"), _written("ent_C2", "currency", "Column", urn="urn:c2"),
                _written("OUT", "report", "Table"),
                _link("sch_t", "SCH", "T"), _link("t_c1", "T", "C1"), _link("t_c2", "T", "ent_C2"),
                _link("sch_out", "SCH", "OUT"), _link("lin", "ent_C2", "OUT", "LINEAGE")])
            removed_ids = {"T", "C1", "ent_C2", "sch_t", "t_c1", "t_c2", "lin"}

            async def draft():
                r = await c.post(f"{V1}/graphs/{gid}/branches", json={})
                assert r.status_code in (200, 201), r.text
                return r.json()["branchId"]

            async def save(branch, ops):
                return await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": branch},
                                    json={"ops": ops, "message": "restore orders"})

            async def publish(branch):
                r = await c.post(f"{V1}/graphs/{gid}/branches/{branch}/publish", json={"message": "go"})
                assert r.status_code == 200, r.text
                return (await svc.get_graph(gid))["main_head_commit_seq"]

            # Deleted in a draft — its columns and their links go with it — and published.
            first = await draft()
            r = await save(first, [{"op": "delete", "kind": "node", "id": "T"}])
            assert r.status_code == 200, r.text
            n = await publish(first)

            # The tombstone says who deleted it, and what its deletion took.
            r = await c.get(f"{V1}/graphs/{gid}/entities/T/deletion")
            assert r.status_code == 200, r.text
            gone = r.json()
            assert gone["deleted"]["seq"] == n and gone["deleted"]["deletedBy"] == "u_test"
            assert gone["deleted"]["commitKind"] == "squash_publish" and "mergedBy" not in gone["deleted"]
            assert gone["deleted"]["mergedAt"] and gone["lastValue"]["properties"]["rows"] == 12
            assert gone["ancestors"] == [{"urn": "SCH", "displayName": "crm", "entityType": "Schema"}]

            restore = await draft()
            r = await c.get(f"{V1}/graphs/{gid}/entities/T/deletion/cascade",
                            params={"fromSeq": n - 1, "toSeq": n, "into": restore})
            assert r.status_code == 200, r.text
            cascade = r.json()
            assert cascade["restorable"] is True and cascade["reason"] is None, cascade
            assert cascade["live"] == ["SCH", "OUT"] and cascade["skippedLinks"] == []
            assert {e["entityId"] for e in cascade["removed"]} == removed_ids
            assert cascade["removed"][0]["entityId"] == "T"                    # parent first

            # Staged as the canvas stages it: each node created under its urn, each link under
            # its id, its ends named by urn.
            ops = [{"op": "create", "kind": "node", "ref": f"restore-{e['entityId']}",
                    "payload": {**e["before"], "urn": e["urn"]}} if e["kind"] == "node" else
                   {"op": "create", "kind": "edge", "id": e["entityId"],
                    "payload": {**e["before"], "sourceEntityId": e["sourceUrn"],
                                "targetEntityId": e["targetUrn"]}}
                   for e in cascade["removed"]]

            # Another draft that has one of them again by the time it saves is refused.
            clash = await draft()
            assert (await save(clash, [{"op": "create", "kind": "node", "payload": {
                **next(e["before"] for e in cascade["removed"] if e["entityId"] == "C1")}}])).status_code == 200
            r = await save(clash, ops)
            assert r.status_code == 409 and r.json()["detail"]["type"] == "entity_exists", r.text
            r = await c.get(f"{V1}/graphs/{gid}/entities/T/deletion/cascade",
                            params={"fromSeq": n - 1, "toSeq": n, "into": clash})
            assert r.json()["reason"] == "recreated", r.text

            r = await save(restore, ops)
            assert r.status_code == 200, r.text
            # The draft brings each back as it was before the deletion, nothing changed in it.
            r = await c.post(f"{V1}/graphs/{gid}/diff/entries/batch",
                             json={"branchId": restore, "ids": sorted(removed_ids)})
            assert r.status_code == 200, r.text
            back = {e["entityId"]: e for e in r.json()["entries"]}
            assert set(back) == removed_ids
            for e in cascade["removed"]:
                assert (back[e["entityId"]]["status"], back[e["entityId"]]["after"]) == ("added", e["before"])

            h = await publish(restore)
            # Across the deletion and the restore, main changed none of them.
            r = await c.post(f"{V1}/graphs/{gid}/diff/entries/batch",
                             json={"fromSeq": n - 1, "toSeq": h, "ids": sorted(removed_ids)})
            assert r.status_code == 200 and r.json() == {"entries": []}, r.text
            async with db.graphver_session() as s:
                now = await svc._current_values(s, gid, main, sorted(removed_ids))
                holders = await svc._urns_to_eids(s, gid, main, ["urn:c2"])
            assert set(now) == removed_ids and all(now.values())
            assert now["ent_C2"]["urn"] == "urn:c2" and holders == {"urn:c2": "ent_C2"}
            r = await c.get(f"{V1}/graphs/{gid}/entities/ent_C2/deletion")
            assert r.status_code == 200 and r.json()["deleted"] is None, r.text
    finally:
        service_mod._CHANGE_INDEXES.clear()
        await db.dispose_engine()


def test_a_published_deletion_is_restored_through_a_draft(data_sources, monkeypatch):
    asyncio.run(_run_journey(monkeypatch))

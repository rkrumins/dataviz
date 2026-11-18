"""Change lists built once and kept (``change_sets.py``) — needs Postgres.

* **Composed, not read again:** every pair of revisions compared from the revisions' own kept
  changes lists exactly what reading the window's version rows directly does — counts, types,
  names (a removed entity's as it was), the order — with an entity changed and changed back, a
  delete and a relationship among them; the canvas's rewind to an old revision is the same too;
  and composing reads no window of version rows.
* **Kept for every process:** a list asked for again after this process forgot it is read back,
  not built.
* **A draft's newer version replaces its older** in the store.
* **Built once:** callers asking for the same list at the same moment wait for one build.
* **Built ahead:** an import into a draft leaves its change list and tree kept; a write that
  advances ``main`` leaves its newest revisions kept.
"""
import asyncio
import os
from itertools import combinations

import pytest
from sqlalchemy import select

from backend.app.services.versioning import change_sets, config, db, models
from backend.app.services.versioning import service as service_mod
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.models import ChangeSetORM
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, name, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name}}


def _u(eid, name, etype="Table"):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name}}


def _e(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "CONTAINS", "sourceEntityId": s, "targetEntityId": t}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _publish(svc, gid, ops):
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    await svc.publish(graph_id=gid, branch_id=d, actor="ana", message="m")


async def _listing(svc, gid, origin):
    summary = await svc.change_summary(graph_id=gid, origin=origin, containment_edge_types=CONT)
    page = await svc.change_entries(graph_id=gid, origin=origin, containment_edge_types=CONT, limit=500)
    summary = {k: v for k, v in summary.items() if k != "window"}
    return summary, page["entries"]


async def _run(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="ana")
    gid = G["graph_id"]
    await _publish(svc, gid, [_n("S", "sales", "Schema"), *[_n(f"T{i}", f"t{i}") for i in range(1, 5)],
                              *[_e(f"c{i}", "S", f"T{i}") for i in range(1, 5)]])
    await _publish(svc, gid, [_u("T1", "renamed"), _del("T2"), _del("c2", "edge")])
    await _publish(svc, gid, [_u("T1", "t1"), _n("T5", "t5"), _e("c5", "S", "T5")])      # T1 back as it was
    await _publish(svc, gid, [_u("T3", "orders"), _del("c4", "edge"), _u("T5", "t5 again")])
    head = (await svc.get_graph(gid))["main_head_commit_seq"]
    pairs = list(combinations(range(1, head + 1), 2))

    async def forget():
        await change_sets.settled()
        service_mod._CHANGE_INDEXES.clear()
        async with db.graphver_session() as s:
            await s.execute(ChangeSetORM.__table__.delete().where(
                ChangeSetORM.graph_id == gid, ChangeSetORM.origin != "revision"))

    # Read directly: nothing kept, and nothing built ahead.
    monkeypatch.setattr(config, "REVISION_SETS_INLINE_FACTOR", -1.0)
    monkeypatch.setattr(service_mod.GraphVersioningService, "_keep_revisions_later", lambda *a, **k: None)
    direct, rewound = {}, {}
    for lo, hi in pairs:
        await forget()
        direct[(lo, hi)] = await _listing(svc, gid, ChangeOrigin(from_seq=lo, to_seq=hi))
        rewound[(lo, hi)] = await svc.revision_overlay_delta(graph_id=gid, as_of_seq=lo, head_seq=hi)
    # Revision 1 made the graph; 2 the seed, 3 renamed T1 and removed T2, 4 put T1 back.
    assert "T1" not in {e["entityId"] for e in direct[(2, 4)][1]}      # changed and changed back
    assert {e["entityId"]: e["status"] for e in direct[(2, 3)][1]}["T2"] == "removed"

    # Composed from each revision's own changes, kept once built.
    async with db.graphver_session() as s:
        main_id = await svc._main_branch_id(s, gid)
    for k in range(2, head + 1):
        await svc._revision_changes(gid, main_id, k)
    read_window = []
    real = service_mod.GraphVersioningService._changed_in_window

    async def spy(self, s, graph_id, branch_id, lo, hi):
        if (lo, hi) != (hi - 1, hi):                    # a revision of its own is how one is kept
            read_window.append((lo, hi))
        return await real(self, s, graph_id, branch_id, lo, hi)
    monkeypatch.setattr(service_mod.GraphVersioningService, "_changed_in_window", spy)
    for lo, hi in pairs:
        await forget()
        assert await _listing(svc, gid, ChangeOrigin(from_seq=lo, to_seq=hi)) == direct[(lo, hi)], (lo, hi)
        # The canvas opening revision lo with main at hi: the same rewind, composed.
        assert await svc.revision_overlay_delta(graph_id=gid, as_of_seq=lo, head_seq=hi) == rewound[(lo, hi)], (lo, hi)
    assert read_window == []                            # no window's version rows read again

    # Kept for every process: forgotten here, read back — not built.
    await _listing(svc, gid, ChangeOrigin(from_seq=1, to_seq=head))
    await change_sets.settled()
    service_mod._CHANGE_INDEXES.clear()
    built = []
    real_build = service_mod.GraphVersioningService._build_window_change_index

    async def counted(self, *a, **k):
        built.append(a)
        return await real_build(self, *a, **k)
    monkeypatch.setattr(service_mod.GraphVersioningService, "_build_window_change_index", counted)
    assert await _listing(svc, gid, ChangeOrigin(from_seq=1, to_seq=head)) == direct[(1, head)]
    assert built == []

    # A draft's newer version replaces its older.
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_u("T3", "draft 1")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    draft = ChangeOrigin(branch_id=d)
    await svc.change_entries(graph_id=gid, origin=draft, containment_edge_types=CONT, paths=True)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_u("T5", "draft 2")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    rows = await svc.change_entries(graph_id=gid, origin=draft, containment_edge_types=CONT, paths=True)
    assert {e["entityId"] for e in rows["entries"]} == {"T3", "T5"}
    await change_sets.settled()
    async with db.graphver_session() as s:
        kept = (await s.execute(select(ChangeSetORM.key).where(
            ChangeSetORM.graph_id == gid, ChangeSetORM.origin == f"draft:{d}"))).scalars().all()
    assert len(kept) == 2 and {k.endswith(".tree") for k in kept} == {True, False}, kept

    # Built once: two callers at the same moment wait for one build.
    calls = []

    async def slow():
        calls.append(1)
        await asyncio.sleep(0.5)
        return {"v": 1}
    key = change_sets.key_of("test", os.urandom(4).hex())
    got = await asyncio.gather(*[change_sets.shared(
        change_sets.STORE, gid, key, "window", build=slow, dump=lambda x: change_sets._pack(
            {**x, "v": change_sets.FORMAT}), load=lambda b: {"v": change_sets._unpack(b)["v"]},
        size_of=lambda _x: 1) for _ in range(2)])
    assert len(calls) == 1 and all(g["v"] for g in got), (calls, got)
    await change_sets.settled()

    # Built ahead: main's newest revisions, after a write advanced it.
    async with db.graphver_session() as s:
        await s.execute(ChangeSetORM.__table__.delete().where(ChangeSetORM.graph_id == gid))
    await _publish(svc, gid, [_u("T1", "after")])
    head = (await svc.get_graph(gid))["main_head_commit_seq"]
    await svc.keep_recent_revisions(gid, n=3)
    await change_sets.settled()
    kept = await change_sets.STORE.get_many(gid, [svc._revision_key(gid, main_id, k) for k in range(head - 2, head + 1)])
    assert len(kept) == 3

    # Built ahead: an import into a draft leaves its change list and tree kept.
    import json
    import shutil
    import tempfile
    from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
    from backend.app.services.versioning.import_export.import_worker import ImportWorker
    from backend.app.services.versioning.import_export.service import ImportExportService
    root = tempfile.mkdtemp(prefix="change-sets-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")
        lines = [{"kind": "node", "urn": "T3", "entityType": "Table", "displayName": "imported"}]

        async def body():
            yield ("\n".join(json.dumps(x) for x in lines) + "\n").encode()
        await store.put_stream(key, body())
        job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="ana",
                                         import_format="ndjson", source_uri=key, reconcile_mode="upsert")
        await ImportWorker(svc, store, ontology={"containment": CONT}).run(job["job_id"])
        await change_sets.settled()
        async with db.graphver_session() as s:
            kept = (await s.execute(select(ChangeSetORM.key).where(
                ChangeSetORM.graph_id == gid, ChangeSetORM.origin == f"draft:{job['branch_id']}"))).scalars().all()
        assert len(kept) == 2, kept                     # its list and its tree
        built.clear()
        service_mod._CHANGE_INDEXES.clear()
        real_draft = service_mod.GraphVersioningService._build_draft_change_index

        async def draft_built(self, *a, **k):
            built.append(a)
            return await real_draft(self, *a, **k)
        monkeypatch.setattr(service_mod.GraphVersioningService, "_build_draft_change_index", draft_built)
        page = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(branch_id=job["branch_id"]),
                                        containment_edge_types=CONT, paths=True)
        assert [e["entityId"] for e in page["entries"]] == ["T3"] and built == []   # read back, not built
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_change_lists_are_built_once_kept_and_composed(monkeypatch):
    try:
        asyncio.run(_run(monkeypatch))
    finally:
        asyncio.run(db.dispose_engine())

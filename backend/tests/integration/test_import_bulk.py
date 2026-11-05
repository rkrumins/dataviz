"""A bulk import, on live Postgres: a file straight into the published graph, with no draft.

The import opens ``main``'s next commit at head+1, writes its windows into it and lands it whole
(``ImportWorker``; ``GraphVersioningService.open_import_commit`` / ``land_import_commit``). Proven:

* it leaves ``main`` as a draft import and its publish would, tallies included; into an empty
  graph one ``import`` commit holds every row, and into a populated one only what changed gets a
  version;
* while it loads, readers see ``main`` as it was (its state, history, freshness, diffs, a commit
  read by id), drafts take edits, and every ``main`` writer — a second bulk import too — is refused;
* it resumes after a crash with nothing written twice, and a discard puts ``main`` back;
* a refused row lands the rest, a delete refuses the file before anything is written, and a strict
  ontology's parent rule is asked of the whole load at its end.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest
from sqlalchemy import func, select

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import BulkImportLoading
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import ImportWorker, lease_job
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import (BranchORM, CommitORM, EdgeVersionORM, GraphORM,
                                                    JobORM, NodeVersionORM, ProjectionStateORM)
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.service import GraphVersioningService, Viewer


def _n(i, name=None, etype="Table"):
    return {"kind": "node", "urn": f"urn:b:{i}", "entityType": etype, "displayName": name or f"t{i}"}


def _e(i, j, etype="LINEAGE"):
    return {"kind": "edge", "edgeType": etype, "sourceUrn": f"urn:b:{i}", "targetUrn": f"urn:b:{j}"}


# Six nodes and five edges: with a window of two rows, three node windows and three edge windows.
_FILE = [*(_n(i) for i in range(6)), *(_e(i, i + 1) for i in range(5))]
# What main holds before the file in the populated case: t0 and t1 as the file has them, t2 and t3
# named otherwise.
_SEED = [{"op": "create", "entity_kind": "node", "entity_id": f"E{i}",
          "payload": {"urn": f"urn:b:{i}", "entityType": "Table", "displayName": name}}
         for i, name in ((0, "t0"), (1, "t1"), (2, "old2"), (3, "old3"))]


class _Crash(Exception):
    """The worker stops here, as far as its job can tell."""


def _crash_on(fn, call):
    calls = 0

    async def crashing(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == call:
            raise _Crash(f"call {call}")
        return await fn(*args, **kwargs)
    return crashing


async def _graph(svc, ops=()):
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    if ops:
        await svc.apply_ops(graph_id=G["graph_id"], actor="u", message="seed", ops=list(ops))
    return G["graph_id"], G["main_branch_id"]


async def _job(ie, store, gid, lines, *, bulk=True):
    key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")

    async def body():
        yield ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    await store.put_stream(key, body())
    return await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                      import_format="ndjson", source_uri=key, bulk=bulk)


async def _main(svc, gid, main):
    """``main``'s live nodes (name -> type) and edges ((source name, target name, type)): by name, as
    the ids an import derives belong to the graph's data source."""
    state = await svc.materialize_state(graph_id=gid, branch_id=main)
    name = {eid: p.get("displayName") for eid, p in state["nodes"].items()}
    return ({p.get("displayName"): p.get("entityType") for p in state["nodes"].values()},
            {(name.get(p["sourceEntityId"]), name.get(p["targetEntityId"]), p["edgeType"])
             for p in state["edges"].values()})


async def _get(model, *key):
    async with db.graphver_session() as s:
        return await s.get(model, key if len(key) > 1 else key[0])


async def _count(model, *where):
    async with db.graphver_session() as s:
        return (await s.execute(select(func.count()).select_from(model).where(*where))).scalar_one()


async def _rows_of(gid, commit_id):
    return (await _count(NodeVersionORM, NodeVersionORM.graph_id == gid, NodeVersionORM.commit_id == commit_id)
            + await _count(EdgeVersionORM, EdgeVersionORM.graph_id == gid, EdgeVersionORM.commit_id == commit_id))


async def _equivalent(svc, ie, store) -> None:
    """The file into a draft and published, and in bulk, from the same main: the same main and
    tallies. Into the populated main only what changed gets a version; into an empty one, one
    ``import`` commit holds every row, main's heads point at them, and no draft was opened."""
    ref, ref_main = await _graph(svc, _SEED)
    job = await _job(ie, store, ref, _FILE, bulk=False)
    want_tallies = await ImportWorker(svc, store).run(job["job_id"])
    await svc.publish(graph_id=ref, branch_id=job["branch_id"], actor="u", message="draft")
    want = await _main(svc, ref, ref_main)

    gid, main = await _graph(svc, _SEED)
    head = (await _get(GraphORM, gid)).main_head_commit_seq
    job = await _job(ie, store, gid, _FILE)
    assert job["branch_id"] is None, "a bulk import opens no draft"
    assert await ImportWorker(svc, store).run(job["job_id"]) == want_tallies == {
        "new": 7, "updated": 2, "unchanged": 2, "deleted": 0, "invalid": 0}
    assert await _main(svc, gid, main) == want
    row = await _get(JobORM, job["job_id"])
    landed = row.summary["landed"]
    assert (row.status, row.target_commit_id, landed["state"]) == ("completed", None, "landed"), row.summary
    commit = await _get(CommitORM, gid, landed["commitId"])
    assert (commit.kind, commit.commit_seq) == ("import", head + 1)
    assert (await _get(GraphORM, gid)).main_head_commit_seq == head + 1
    assert await _rows_of(gid, commit.id) == 9, "t2, t3, t4, t5 and five edges: t0 and t1 are as they were"
    assert commit.stats == {"create": 7, "update": 2, "delete": 0}, commit.stats

    gid, main = await _graph(svc)
    job = await _job(ie, store, gid, _FILE)
    await ImportWorker(svc, store).run(job["job_id"])
    commit_id = (await _get(JobORM, job["job_id"])).summary["landed"]["commitId"]
    assert await _rows_of(gid, commit_id) == 11
    assert await _count(models.EntityHeadORM, models.EntityHeadORM.graph_id == gid,
                        models.EntityHeadORM.branch_id == main) == 11
    assert await _count(BranchORM, BranchORM.graph_id == gid, BranchORM.kind != "main") == 0
    ps = await _get(ProjectionStateORM, gid)
    assert ps is None or ps.target_commit_seq == (await _get(CommitORM, gid, commit_id)).commit_seq

    # Sent again, it changes nothing: its commit is dropped, and the head stays.
    head = (await _get(GraphORM, gid)).main_head_commit_seq
    job = await _job(ie, store, gid, _FILE)
    assert (await ImportWorker(svc, store).run(job["job_id"]))["unchanged"] == 11
    assert (await _get(JobORM, job["job_id"])).summary["landed"] == {"state": "unchanged"}
    assert (await _get(GraphORM, gid)).main_head_commit_seq == head
    assert await _count(CommitORM, CommitORM.graph_id == gid, CommitORM.commit_seq > head) == 0


async def _while_loading(svc, ie, store) -> None:
    """Stopped after two windows: main reads as it was, drafts take edits, main writers are
    refused; resumed, it lands what an uninterrupted load lands, nothing twice."""
    gid, main = await _graph(svc, _SEED)
    before = await _main(svc, gid, main)
    head = (await _get(GraphORM, gid)).main_head_commit_seq
    draft = await svc.open_draft(graph_id=gid, owner="u")
    job = await _job(ie, store, gid, _FILE)
    worker = ImportWorker(svc, store)
    worker._next_window = _crash_on(worker._next_window, 3)
    with pytest.raises(_Crash):
        await worker.run(job["job_id"])
    row = await _get(JobORM, job["job_id"])
    cid = row.target_commit_id
    assert cid is not None and await _rows_of(gid, cid) > 0, "two windows are in the commit"

    assert await _main(svc, gid, main) == before
    assert (await _get(GraphORM, gid)).main_head_commit_seq == head
    assert cid not in {c["commit_id"] for c in await svc.commit_log(graph_id=gid)}
    fresh = await svc.branch_freshness(graph_id=gid, branch_id=main, since_seq=head)
    assert (fresh["head_commit_seq"], fresh["saved_since"]["commits"]) == (head, 0), fresh
    assert await svc.diff_commits(graph_id=gid, branch_id=main, from_seq=head, to_seq=head + 1) == {
        "added": [], "removed": [], "modified": {}}
    with pytest.raises(ValueError, match="unknown commit"):
        await svc.state_at_commit(graph_id=gid, commit_id=cid)

    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="draft edit", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "D1",
         "payload": {"urn": "urn:d:1", "entityType": "Table", "displayName": "d1"}}])
    edit = [{"op": "update", "entity_kind": "node", "entity_id": "E0", "payload": {"displayName": "x"}}]
    with pytest.raises(BulkImportLoading):
        await svc.apply_ops(graph_id=gid, actor="u", message="main edit", ops=edit)
    with pytest.raises(BulkImportLoading):
        await svc.publish(graph_id=gid, branch_id=draft, actor="u", message="draft")
    with pytest.raises(BulkImportLoading):
        await ie.create_publish_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                    branch_id=draft, actor="u", message="draft")
    with pytest.raises(BulkImportLoading):
        await _job(ie, store, gid, _FILE)

    assert await ImportWorker(svc, store).run(job["job_id"]) == {
        "new": 7, "updated": 2, "unchanged": 2, "deleted": 0, "invalid": 0}
    assert await _rows_of(gid, cid) == 9, "nothing written twice"
    after, _edges = await _main(svc, gid, main)
    assert set(after) == {f"t{i}" for i in range(6)}, after
    await svc.apply_ops(graph_id=gid, actor="u", message="main edit", ops=edit)   # the gate is open


async def _discarded(svc, ie, store) -> None:
    """Discarded mid-load: what it wrote goes, its commit with it, and main is as it was."""
    gid, main = await _graph(svc, _SEED)
    before = await _main(svc, gid, main)
    head = (await _get(GraphORM, gid)).main_head_commit_seq
    job = await _job(ie, store, gid, _FILE)
    worker = ImportWorker(svc, store)
    worker._next_window = _crash_on(worker._next_window, 3)
    with pytest.raises(_Crash):
        await worker.run(job["job_id"])
    cid = (await _get(JobORM, job["job_id"])).target_commit_id
    with pytest.raises(Exception, match="person who started"):
        await ie.discard_import(job["job_id"], viewer=Viewer(actor="v", can_manage=False, can_read=True))
    assert (await ie.discard_import(job["job_id"], viewer=Viewer(actor="u", can_manage=False, can_read=True))
            ) == {"jobId": job["job_id"], "status": "pending", "discarding": True}
    assert await ImportWorker(svc, store).run(job["job_id"]) == {}
    row = await _get(JobORM, job["job_id"])
    assert (row.status, row.target_commit_id, row.last_cursor) == ("cancelled", None, "bulk:discard")
    assert await _get(CommitORM, gid, cid) is None and await _rows_of(gid, cid) == 0
    assert await _main(svc, gid, main) == before
    assert (await _get(GraphORM, gid)).main_head_commit_seq == head
    await svc.apply_ops(graph_id=gid, actor="u", message="main edit", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "E0", "payload": {"displayName": "y"}}])

    # One that never opened its commit is cancelled there and then.
    job = await _job(ie, store, gid, _FILE)
    assert (await ie.discard_import(job["job_id"], viewer=Viewer(actor="w", can_manage=True, can_read=True))
            )["status"] == "cancelled"


async def _refusals(svc, ie, store, rooted) -> None:
    """A refused row lands the rest; a delete refuses the file before anything is written; a strict
    ontology's parent rule is asked of the whole load, which a node left outside every parent
    discards."""
    gid, main = await _graph(svc)
    job = await _job(ie, store, gid, [*_FILE, {"kind": "node", "urn": "urn:b:x", "displayName": "untyped"}])
    tallies = await ImportWorker(svc, store).run(job["job_id"])
    assert (tallies["new"], tallies["invalid"]) == (11, 1), tallies
    assert len((await _main(svc, gid, main))[0]) == 6

    job = await _job(ie, store, gid, [_n(9), {"kind": "node", "urn": "urn:b:0", "entityType": "Table",
                                              "_op": "delete"}])
    with pytest.raises(ValueError, match="only adds and updates"):
        await ImportWorker(svc, store).run(job["job_id"])
    assert (await _get(JobORM, job["job_id"])).target_commit_id is None
    assert await _count(CommitORM, CommitORM.graph_id == gid,
                        CommitORM.idempotency_key == f"bulk:{job['job_id']}") == 0

    async def resolver(*_args):
        return ["CONTAINS"], rooted

    strict = ImportExportService(versioning=svc, store=store, bulk_resolver=resolver)
    gid, main = await _graph(svc)
    async with db.graphver_session() as s:
        (await s.get(GraphORM, gid)).ontology_enforcement = "strict"
    schema = _n("s", "s", "Schema")
    job = await _job(strict, store, gid, [schema, _n(1), _n(2), _e("s", 1, "CONTAINS")])
    await strict.run_import_safe(job["job_id"], await lease_job(job["job_id"]))   # as the lane runs it
    row = await _get(JobORM, job["job_id"])
    assert (row.status, row.target_commit_id) == ("failed", None), (row.status, row.error_message)
    assert "outside every parent" in row.error_message
    assert await _main(svc, gid, main) == ({}, set())
    assert await _count(CommitORM, CommitORM.graph_id == gid, CommitORM.kind == "import") == 0
    job = await _job(strict, store, gid, [schema, _n(1), _n(2), _e("s", 1, "CONTAINS"), _e("s", 2, "CONTAINS")])
    await strict.run_import(job["job_id"])
    assert (await _main(svc, gid, main))[0] == {"s": "Schema", "t1": "Table", "t2": "Table"}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    rooted = OntologyRules(entity_types={"Schema": EntityRule(), "Table": EntityRule()},
                           edge_types={"CONTAINS": EdgeRule(is_containment=True), "LINEAGE": EdgeRule()},
                           containment_edge_types=frozenset({"CONTAINS"}),
                           root_entity_types=frozenset({"Schema"}))
    root = tempfile.mkdtemp(prefix="import-bulk-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        await _equivalent(svc, ie, store)
        await _while_loading(svc, ie, store)
        await _discarded(svc, ie, store)
        await _refusals(svc, ie, store, rooted)
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_import_bulk_e2e(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 2)
    monkeypatch.setattr(import_worker, "_PARSE_BATCH", 2)
    asyncio.run(_run())

"""An import worked a window at a time (live Postgres), with windows of two rows.

The importer resolves and builds every node window, then every edge window, each against the draft
as the windows before it left it, and looks up only what the window's rows name. Proven here on
files that span several windows:

* an edge finds a node a LATER row creates, by urn and by qualifiedName, and an existing edge is
  matched, not duplicated; the tally is what the rows did;
* replace deletes every entity no row matched (edges first) and nothing else;
* a view-scoped replace deletes only the view's own entities;
* a finished import's staged rows are swept once they are old enough;
* a file uploaded in parts imports as the one file it is;
* an import stopped after any unit of work — mid-parse, after a node or an edge window, inside a
  window's transaction — and run again by the next worker ends exactly as one that never stopped:
  the same entities, no duplicates, the same tallies and quarantine, and no Merkle rows on the
  draft; so does one that failed and a person retried, queued again with its cursor;
* a window still running when its job is taken over rolls back whole at its checkpoint — what
  ``apply_ops(on_commit=...)`` gives it: the hook runs inside the batch's transaction, whether the
  batch commits a change or turns out to change nothing, and what it raises rolls the batch back.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from sqlalchemy import func, select, update

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, job_lease, models
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import ImportWorker, lease_job
from backend.app.services.versioning.import_export.runner import INSPECT_TYPES, JOB_TYPES
from backend.app.services.versioning.job_lease import Superseded
from backend.app.services.versioning.models import CommitORM, ImportRowORM, JobORM, MerkleNodeORM
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService


def _node(eid, urn, qname, name="n"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": "Table", "displayName": name, "qualifiedName": qname}}


def _edge(eid, src, tgt, etype="LINEAGE"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


async def _graph(svc, ops):
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    await svc.apply_ops(graph_id=G["graph_id"], actor="u", message="seed", ops=ops)
    return G["graph_id"]


async def _import_job(ie, store, gid, lines, *, mode="upsert", branch_id=None):
    """A queued-to-be import job of ``lines``, its file stored."""
    key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")

    async def body():
        yield ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    await store.put_stream(key, body())
    return await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                      import_format="ndjson", source_uri=key, reconcile_mode=mode,
                                      branch_id=branch_id)


async def _import(ie, store, gid, lines, *, mode="upsert", scope=None, branch_id=None):
    job = await _import_job(ie, store, gid, lines, mode=mode, branch_id=branch_id)
    summary = await ImportWorker(ie._svc, store, scope=scope).run(job["job_id"])
    return job["branch_id"], summary


async def _state(svc, gid, branch_id):
    """Live nodes (urn -> displayName) and edges ((source urn, target urn, type)) of the draft."""
    state = await svc.materialize_state(graph_id=gid, branch_id=branch_id)
    urn = {eid: p.get("urn") for eid, p in state["nodes"].items()}
    nodes = {p.get("urn"): p.get("displayName") for p in state["nodes"].values()}
    edges = {(urn.get(p["sourceEntityId"]), urn.get(p["targetEntityId"]), p["edgeType"])
             for p in state["edges"].values()}
    return nodes, edges


async def _windows(svc, ie, store) -> None:
    gid = await _graph(svc, [_node("ent_A", "urn:A", "a", "A"), _node("ent_B", "urn:B", "b", "B"),
                             _edge("edg_AB", "ent_A", "ent_B")])
    lines = [
        {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "d", "targetUrn": "urn:E"},
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A2", "qualifiedName": "a"},
        {"kind": "node", "urn": "urn:D", "entityType": "Table", "displayName": "D", "qualifiedName": "d"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:A", "targetUrn": "urn:B"},
        {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "B", "qualifiedName": "b"},
        {"kind": "node", "urn": "urn:E", "entityType": "Table", "displayName": "E", "qualifiedName": "e"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "a", "targetQualifiedName": "d"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:X", "targetUrn": "urn:A"},
    ]
    branch_id, summary = await _import(ie, store, gid, lines)
    # new: D, E, d->E (both its ends made by later rows), a->d; updated: A; unchanged: B, A->B;
    # invalid: the edge from a node nowhere to be found.
    assert summary == {"new": 4, "updated": 1, "unchanged": 2, "deleted": 0, "invalid": 1}, summary
    nodes, edges = await _state(svc, gid, branch_id)
    assert nodes == {"urn:A": "A2", "urn:B": "B", "urn:D": "D", "urn:E": "E"}, nodes
    assert edges == {("urn:A", "urn:B", "LINEAGE"), ("urn:D", "urn:E", "LINEAGE"),
                     ("urn:A", "urn:D", "LINEAGE")}, edges

    # The same file again, onto the same draft: every row is now unchanged, nothing is duplicated.
    _, again = await _import(ie, store, gid, lines, branch_id=branch_id)
    assert again == {"new": 0, "updated": 0, "unchanged": 7, "deleted": 0, "invalid": 1}, again
    assert await _state(svc, gid, branch_id) == (nodes, edges)


async def _replace(svc, ie, store) -> None:
    gid = await _graph(svc, [
        _node("ent_A", "urn:A", "a"), _node("ent_B", "urn:B", "b"), _node("ent_C", "urn:C", "c"),
        _edge("edg_AB", "ent_A", "ent_B"), _edge("edg_BC", "ent_B", "ent_C")])
    branch_id, summary = await _import(ie, store, gid, [
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "n", "qualifiedName": "a"},
        {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "n", "qualifiedName": "b"},
        {"kind": "node", "urn": "urn:D", "entityType": "Table", "displayName": "n", "qualifiedName": "d"},
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:A", "targetUrn": "urn:B"},
    ], mode="replace")
    # C and B->C were in the graph and in no row: deleted. D is new; the rest unchanged.
    assert summary == {"new": 1, "updated": 0, "unchanged": 3, "deleted": 2, "invalid": 0}, summary
    nodes, edges = await _state(svc, gid, branch_id)
    assert set(nodes) == {"urn:A", "urn:B", "urn:D"}, nodes
    assert edges == {("urn:A", "urn:B", "LINEAGE")}, edges


async def _view_replace(svc, ie, store) -> None:
    gid = await _graph(svc, [
        _node("ent_A", "urn:A", "a"), _node("ent_B", "urn:B", "b"), _node("ent_C", "urn:C", "c"),
        _node("ent_X", "urn:X", "x"),
        _edge("edg_AB", "ent_A", "ent_B", "CONTAINS"), _edge("edg_BC", "ent_B", "ent_C", "CONTAINS"),
        _edge("edg_XA", "ent_X", "ent_A")])
    scope = {"assigned_urns": ["urn:A"], "inherit_urns": ["urn:A"], "containment_types": ["CONTAINS"]}
    branch_id, summary = await _import(ie, store, gid, [
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "n", "qualifiedName": "a"},
        {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "n", "qualifiedName": "b"},
        {"kind": "edge", "edgeType": "CONTAINS", "sourceUrn": "urn:A", "targetUrn": "urn:B"},
    ], mode="replace", scope=scope)
    # The view holds A, B and C (A's containment subtree): C and B->C go; X and X->A are not the view's.
    assert summary["deleted"] == 2, summary
    nodes, edges = await _state(svc, gid, branch_id)
    assert set(nodes) == {"urn:A", "urn:B", "urn:X"}, nodes
    assert edges == {("urn:A", "urn:B", "CONTAINS"), ("urn:X", "urn:A", "LINEAGE")}, edges


async def _sweep(svc, ie, store) -> None:
    """A finished import's staged rows are swept once it is STAGING_GC_DAYS old, a batch at a time;
    a recent one's and a running one's stay."""
    from sqlalchemy import func, select, update

    from backend.app.services.versioning import db
    from backend.app.services.versioning.import_export.import_worker import sweep_staged_rows
    from backend.app.services.versioning.models import ImportRowORM, JobORM

    gid = await _graph(svc, [_node("ent_A", "urn:A", "a")])
    lines = [{"kind": "node", "urn": f"urn:s{i}", "entityType": "Table", "displayName": "s"} for i in range(5)]
    jobs = []
    for _ in range(3):
        await _import(ie, store, gid, lines)
        jobs.append((await ie.list_jobs(graph_id=gid, job_type="ingest", limit=1))[0]["jobId"])
    old, recent, running = jobs

    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id.in_([old, running]))
                        .values(completed_at="2000-01-01T00:00:00+00:00"))
        await s.execute(update(JobORM).where(JobORM.id == running).values(status="running"))

    async def staged(job_id):
        async with db.graphver_session() as s:
            return (await s.execute(select(func.count()).where(ImportRowORM.job_id == job_id))).scalar_one()

    assert [await staged(j) for j in jobs] == [5, 5, 5]
    assert await sweep_staged_rows(older_than_days=7, batch=2) >= 5
    assert [await staged(j) for j in jobs] == [0, 5, 5]


async def _parts(svc, ie, store) -> None:
    """A file uploaded in parts (resumable upload) is imported as the one file it is, even with
    rows split across parts."""
    from backend.app.services.versioning.import_export import uploads

    gid = await _graph(svc, [_node("ent_A", "urn:A", "a")])
    data = ("\n".join(json.dumps({"kind": "node", "urn": f"urn:p{i}", "entityType": "Table",
                                   "displayName": f"p{i}"}) for i in range(9)) + "\n").encode()
    record = await uploads.create(store, workspace_id="ws1", data_source_id=gid, graph_id=gid, owner="u",
                                  file_name="parts.ndjson", size=len(data), fmt="ndjson")
    step = record["partBytes"]
    for n in reversed(range(record["parts"])):
        async def body(n=n):
            yield data[n * step:(n + 1) * step]
        await uploads.put_part(store, record, n, body())
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                     import_format="ndjson", source_uri=uploads.record_key(record))
    summary = await ImportWorker(ie._svc, store).run(job["job_id"])
    assert record["parts"] > 3 and summary["new"] == 9 and summary["invalid"] == 0, (record["parts"], summary)


class _Crash(Exception):
    """The worker stops here, as far as its job can tell: dies, mid-job."""


def _crash_on(fn, call):
    """``fn``, except that its ``call``-th call (1-based) is where the worker dies."""
    calls = 0

    async def crashing(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == call:
            raise _Crash(f"{fn.__name__} call {call}")
        return await fn(*args, **kwargs)
    return crashing


async def _row(job_id):
    async with db.graphver_session() as s:
        return await s.get(JobORM, job_id)


async def _count(model, *where):
    async with db.graphver_session() as s:
        return (await s.execute(select(func.count()).select_from(model).where(*where))).scalar_one()


async def _quarantine(job_id):
    async with db.graphver_session() as s:
        return [(r.raw.get("urn") or r.raw.get("sourceUrn"), r.reasons) for r in (await s.execute(
            select(ImportRowORM).where(ImportRowORM.job_id == job_id, ImportRowORM.status == "invalid")
            .order_by(ImportRowORM.row_index))).scalars()]


# 8 node rows and 6 edge rows, interleaved: node windows of two rows, then edge windows of two. One
# node row updates a node of main, an edge row names its source by a later row's qualifiedName, and
# two rows are quarantined (a node with no type, an edge whose source is nowhere).
_RESUME_LINES = [
    {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A2", "qualifiedName": "a"},
    {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "n5", "targetUrn": "urn:A"},
    *({"kind": "node", "urn": f"urn:N{i}", "entityType": "Table", "displayName": f"N{i}",
       "qualifiedName": f"n{i}"} for i in range(3)),
    {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:A", "targetUrn": "urn:N0"},
    {"kind": "node", "urn": "urn:Z", "displayName": "no type"},
    *({"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": f"urn:N{i}", "targetUrn": f"urn:N{i + 1}"}
      for i in range(3)),
    *({"kind": "node", "urn": f"urn:N{i}", "entityType": "Table", "displayName": f"N{i}",
       "qualifiedName": f"n{i}"} for i in range(3, 6)),
    {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:X", "targetUrn": "urn:A"},
]


async def _resume(svc, ie, store) -> None:
    gid = await _graph(svc, [_node("ent_A", "urn:A", "a", "A")])
    ref_branch, ref = await _import(ie, store, gid, _RESUME_LINES)
    assert ref == {"new": 11, "updated": 1, "unchanged": 0, "deleted": 0, "invalid": 2}, ref
    ref_job = (await ie.list_jobs(graph_id=gid, job_type="ingest", limit=1))[0]["jobId"]
    want = await _state(svc, gid, ref_branch)
    want_counts = {k: len(v) for k, v in (await svc.materialize_state(graph_id=gid, branch_id=ref_branch)).items()}

    async def resumed(job, check_stopped):
        """The job after a second worker ran it: as the reference, through and through."""
        await check_stopped(await _row(job["job_id"]))
        summary = await ImportWorker(svc, store).run(job["job_id"])        # the next worker
        assert summary == ref, summary
        assert await _state(svc, gid, job["branch_id"]) == want
        state = await svc.materialize_state(graph_id=gid, branch_id=job["branch_id"])
        assert {k: len(v) for k, v in state.items()} == want_counts, "no entity twice"
        assert await _quarantine(job["job_id"]) == await _quarantine(ref_job)
        assert await _count(MerkleNodeORM, MerkleNodeORM.graph_id == gid,
                            MerkleNodeORM.branch_id == job["branch_id"]) == 0
        row = await _row(job["job_id"])
        assert (row.status, row.retry_count, row.progress, row.processed, row.total) == \
            ("completed", 2, 100, len(_RESUME_LINES), len(_RESUME_LINES)), row.__dict__

    # Mid-parse: two rows staged (one batch), the rest of the file not yet read.
    job = await _import_job(ie, store, gid, _RESUME_LINES)
    worker = ImportWorker(svc, store)
    worker._flush = _crash_on(worker._flush, 2)
    with pytest.raises(_Crash):
        await worker.run(job["job_id"])

    async def mid_parse(row):
        assert (row.status, row.last_cursor, row.total) == ("running", "parse:2", 2), row.__dict__
        assert await _count(ImportRowORM, ImportRowORM.job_id == row.id) == 2
    await resumed(job, mid_parse)

    # After windows: two node windows; then every node window and one edge window.
    for windows, cursor in ((2, "node:4"), (5, "edge:5")):
        job = await _import_job(ie, store, gid, _RESUME_LINES)
        worker = ImportWorker(svc, store)
        worker._next_window = _crash_on(worker._next_window, windows + 1)
        with pytest.raises(_Crash):
            await worker.run(job["job_id"])

        async def after_windows(row, windows=windows, cursor=cursor):
            assert (row.status, row.last_cursor) == ("running", cursor), row.__dict__
            # a window is one commit onto the draft (an all-unchanged window none)
            assert await _count(CommitORM, CommitORM.graph_id == gid,
                                CommitORM.branch_id == row.branch_id) == windows
        await resumed(job, after_windows)

    # Inside a window's transaction, at its checkpoint: the window's ops roll back with it.
    job = await _import_job(ie, store, gid, _RESUME_LINES)
    lease = await lease_job(job["job_id"])
    checkpoint = lease.checkpoint
    windows = []

    async def dies_in_the_second_window(s, **values):
        if str(values.get("last_cursor")).startswith("node:") and values["last_cursor"] != "node:-1":
            windows.append(values["last_cursor"])
            if len(windows) == 2:
                raise _Crash("at the second window's checkpoint")
        await checkpoint(s, **values)
    lease.checkpoint = dies_in_the_second_window
    with pytest.raises(_Crash):
        await ImportWorker(svc, store).run(job["job_id"], lease=lease)

    async def mid_window(row):
        assert (row.status, row.last_cursor) == ("running", windows[0]), row.__dict__
        assert await _count(CommitORM, CommitORM.graph_id == gid, CommitORM.branch_id == row.branch_id) == 1
        assert await _count(ImportRowORM, ImportRowORM.job_id == row.id,
                            ImportRowORM.resolved_op.is_not(None)) == 2, "window 2's resolutions rolled back"
    await resumed(job, mid_window)

    # Failed after two windows, then retried by a person: queued again with its cursor, claimed by
    # the transfer lane (not failed as a pre-lease job), resumed from where it stopped.
    job = await _import_job(ie, store, gid, _RESUME_LINES)
    lease = await lease_job(job["job_id"])
    worker = ImportWorker(svc, store)
    worker._next_window = _crash_on(worker._next_window, 3)
    with pytest.raises(_Crash):
        await worker.run(job["job_id"], lease=lease)
    assert await lease.fail("the third window broke")
    async with db.graphver_session() as s:          # what earlier runs left queued would come first
        await s.execute(update(JobORM).where(JobORM.job_type.in_(JOB_TYPES + INSPECT_TYPES),
                                             JobORM.status.in_(("pending", "running")))
                        .values(status="failed", error_message="cleared by test_import_windows"))
    assert await ie.requeue_failed(job["job_id"])
    claimed = await job_lease.claim(db.graphver_session, JOB_TYPES, phase_pred=job_lease.TRANSFER_READY)
    assert (claimed.job_id, claimed.epoch) == (job["job_id"], 2)
    assert (await _row(job["job_id"])).last_cursor == "node:4", "it resumes from its cursor"
    assert await ImportWorker(svc, store).run(job["job_id"], lease=claimed) == ref
    assert await _state(svc, gid, job["branch_id"]) == want


async def _on_commit(svc, ie) -> None:
    gid = await _graph(svc, [_node("ent_A", "urn:A", "a")])
    draft = await svc.open_draft(graph_id=gid, owner="u")
    job_id = (await ie.create_export_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                         actor="u"))["job_id"]

    def hook(fail=False):
        async def on_commit(s):
            await s.execute(update(JobORM).where(JobORM.id == job_id).values(processed=JobORM.processed + 1))
            if fail:
                raise _Crash("in the hook")
        return on_commit

    create = [_node("ent_B", "urn:B", "b")]
    assert await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=create, on_commit=hook())
    assert (await _row(job_id)).processed == 1, "ran with the commit"
    assert await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=create, on_commit=hook()) is None
    assert (await _row(job_id)).processed == 2, "ran though the batch changed nothing"
    with pytest.raises(_Crash):
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=[_node("ent_C", "urn:C", "c")],
                            on_commit=hook(fail=True))
    assert (await _row(job_id)).processed == 2
    assert "urn:C" not in (await _state(svc, gid, draft))[0], "the batch rolled back with its hook"


class _TakenOverMidWindow:
    """The versioning service, for a worker whose job the next worker takes over while it is still
    building a window: the window runs to its end, then must roll back at its checkpoint."""

    def __init__(self, svc, job_id):
        self._svc, self._job_id, self.successor = svc, job_id, None

    def __getattr__(self, name):
        return getattr(self._svc, name)

    async def apply_ops(self, **kwargs):
        if self.successor is None:
            self.successor = await lease_job(self._job_id)
        return await self._svc.apply_ops(**kwargs)


async def _zombie(svc, ie, store) -> None:
    gid = await _graph(svc, [_node("ent_A", "urn:A", "a", "A")])
    ref_branch, ref = await _import(ie, store, gid, _RESUME_LINES)
    job = await _import_job(ie, store, gid, _RESUME_LINES)
    zombie = _TakenOverMidWindow(svc, job["job_id"])
    with pytest.raises(Superseded):
        await ImportWorker(zombie, store).run(job["job_id"])
    assert await _count(CommitORM, CommitORM.graph_id == gid, CommitORM.branch_id == job["branch_id"]) == 0, \
        "the zombie's window rolled back"
    row = await _row(job["job_id"])
    assert (row.status, row.retry_count, row.last_cursor) == ("running", 2, "node:-1"), row.__dict__
    assert await ImportWorker(svc, store).run(job["job_id"], lease=zombie.successor) == ref
    assert await _state(svc, gid, job["branch_id"]) == await _state(svc, gid, ref_branch)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    root = tempfile.mkdtemp(prefix="import-windows-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        await _windows(svc, ie, store)
        await _replace(svc, ie, store)
        await _view_replace(svc, ie, store)
        await _sweep(svc, ie, store)
        await _parts(svc, ie, store)
        await _on_commit(svc, ie)
        await _resume(svc, ie, store)
        await _zombie(svc, ie, store)
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_import_windows_e2e(monkeypatch):
    from backend.app.services.versioning.import_export import uploads

    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 2)
    monkeypatch.setattr(import_worker, "_PARSE_BATCH", 2)    # a parse commit every two rows
    monkeypatch.setattr(uploads, "PART_BYTES", 100)          # rows straddle the parts
    asyncio.run(_run())

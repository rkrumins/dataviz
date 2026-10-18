"""A frozen, trashed or purging graph refuses every content write, and reads go on — needs Postgres.

* Each write entry point (open/stage/checkpoint/pull/save/publish/merge a draft, a main save,
  revert, restore, bulk, sync and resync, a fork of it, a fork PR merged into it, an import or a
  publish job) raises :class:`GraphNotWritable` ``frozen`` and leaves nothing behind: no commit,
  staged change, branch or job, and main where it was. A resync refuses before it pages its
  provider.
* Reads, exports, a projection rebuild, abandoning a draft, the review of a PR (approve, edit,
  close), a draft's members and visibility, moving its data source, trashing and restoring a fork,
  and a fork PR from a frozen fork into a live parent all still work.
* ``set_frozen`` is a compare-and-set on ``lifecycle_rev``; freezing a frozen graph changes nothing
  (no new rev), a stale rev is :class:`VersionConflict`, a trashed graph is unknown. Unfreezing
  restores every write.
* A freeze waits for a draft save in flight, and every later save sees it; past
  ``GRAPH_LOCK_TIMEOUT_MS`` it is :class:`LockBusy`.
* A queued publish that meets a freeze fails with the 409 and hands its draft back; an import
  fails after the windows it committed and, once unfrozen and retried, lands every row once.
* A trashed graph reports ``trashed``, one with a purge job ``purging``; a frozen graph trashed and
  restored comes back frozen.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest
from sqlalchemy import delete, func, select

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import GraphNotWritable, LockBusy, VersionConflict
from backend.app.services.versioning.import_export.import_worker import lease_job
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import BranchORM, CommitORM, GraphORM, JobORM, WorkingChangeORM
from backend.app.services.versioning.purge_worker import (PURGE_JOB_TYPE, restore_graphs_for_data_source,
                                                          tombstone_graphs_for_data_source)
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid}}


def _upd(eid, name):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": {"displayName": name}}


def _e2e(coro_fn, *args):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService(), *args)
        finally:
            await db.dispose_engine()
    asyncio.run(run())


async def _live(svc):
    """A graph with a published node, a draft with a saved and a staged edit and a review, and a
    fork with a commit and a PR into it."""
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("A"), _node("B")])
    main = await svc.main_branch_id(gid)
    seed = (await svc.commit_log(graph_id=gid, branch_id=main))[0]["commit_id"]
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=[_upd("A", "a")])
    await svc.stage_changes(graph_id=gid, branch_id=draft, actor="u", ops=[_node("C")])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="u")
    fork = (await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="v"))["graph_id"]
    await svc.apply_ops(graph_id=fork, actor="v", ops=[_node("F")])
    pr = await svc.open_pr(source_graph_id=fork, actor="v")
    return {"ds": ds, "gid": gid, "main": main, "seed": seed, "draft": draft, "mr": mr,
            "fork": fork, "pr": pr}


async def _footprint(gid):
    """What a write would change: main's head and every row a write adds to the graph."""
    async with db.graphver_session() as s:
        count = lambda m: s.scalar(select(func.count()).select_from(m).where(m.graph_id == gid))  # noqa: E731
        return {
            "head": await s.scalar(select(GraphORM.main_head_commit_seq).where(GraphORM.id == gid)),
            "commits": await count(CommitORM), "staged": await count(WorkingChangeORM),
            "jobs": await count(JobORM),
            "branches": sorted((await s.execute(select(BranchORM.id, BranchORM.status).where(
                BranchORM.graph_id == gid))).all()),
            "forks": await s.scalar(select(func.count()).select_from(GraphORM).where(
                GraphORM.fork_parent_graph_id == gid)),
        }


class _NoPaging:
    """A provider a refused resync must never page."""

    def __getattr__(self, name):
        raise AssertionError(f"the provider was paged ({name}) before the refusal")


def _ie(svc):
    return ImportExportService(versioning=svc, store=object())


_WRITES = {
    "open_draft": lambda svc, g: svc.open_draft(graph_id=g["gid"], owner="u"),
    "stage": lambda svc, g: svc.stage_changes(graph_id=g["gid"], branch_id=g["draft"], actor="u",
                                              ops=[_node("D")]),
    "checkpoint": lambda svc, g: svc.checkpoint(graph_id=g["gid"], branch_id=g["draft"], actor="u"),
    "rebase": lambda svc, g: svc.rebase_draft(graph_id=g["gid"], branch_id=g["draft"], actor="u"),
    "save_draft": lambda svc, g: svc.apply_ops(graph_id=g["gid"], branch_id=g["draft"], actor="u",
                                               ops=[_upd("A", "x")]),
    "save_main": lambda svc, g: svc.apply_ops(graph_id=g["gid"], branch_id=g["main"], actor="u",
                                              ops=[_upd("A", "x")], allow_main=True),
    "publish": lambda svc, g: svc.publish(graph_id=g["gid"], branch_id=g["draft"], actor="u",
                                          message="ship"),
    "merge_mr": lambda svc, g: svc.merge_mr(mr_id=g["mr"], actor="u", message="ship"),
    "revert": lambda svc, g: svc.revert_commit(graph_id=g["gid"], commit_id=g["seed"], actor="u"),
    "restore": lambda svc, g: svc.restore_to_commit(graph_id=g["gid"], commit_id=g["seed"], actor="u"),
    "bulk": lambda svc, g: svc.bulk_ingest(graph_id=g["gid"], actor="u", rows=[
        {"kind": "node", "entity_id": "E", "urn": "urn:E", "entityType": "Table", "displayName": "E"}]),
    "sync": lambda svc, g: svc.sync_ingest(graph_id=g["gid"], actor="u", rows=[]),
    "resync": lambda svc, g: svc.resync_from_provider(graph_id=g["gid"], provider=_NoPaging(), actor="u"),
    "fork": lambda svc, g: svc.fork_graph(parent_graph_id=g["gid"], workspace_id="ws1", actor="u"),
    "merge_pr": lambda svc, g: svc.merge_pr(pr_id=g["pr"], actor="u", message="take it"),
    "import_new_draft": lambda svc, g: _ie(svc).create_import_job(
        workspace_id="ws1", data_source_id=g["ds"], graph_id=g["gid"], actor="u", import_format="ndjson"),
    "import_onto_draft": lambda svc, g: _ie(svc).create_import_job(
        workspace_id="ws1", data_source_id=g["ds"], graph_id=g["gid"], actor="u", import_format="ndjson",
        branch_id=g["draft"]),
    "publish_job": lambda svc, g: _ie(svc).create_publish_job(
        workspace_id="ws1", data_source_id=g["ds"], graph_id=g["gid"], branch_id=g["draft"], actor="u",
        message="ship"),
}


async def _refuses(svc, write):
    g = await _live(svc)
    assert (await svc.set_frozen(graph_id=g["gid"], frozen=True, expected_rev=0))["state"] == "frozen"
    before = await _footprint(g["gid"])
    with pytest.raises(GraphNotWritable) as refused:
        await _WRITES[write](svc, g)
    assert refused.value.state == "frozen" and refused.value.detail["type"] == "graph_not_writable"
    assert await _footprint(g["gid"]) == before


@pytest.mark.parametrize("write", sorted(_WRITES))
def test_a_frozen_graph_refuses_every_write_entry_point(write):
    _e2e(_refuses, write)


async def _reads(svc):
    g = await _live(svc)
    gid, main, draft = g["gid"], g["main"], g["draft"]
    other = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=other, actor="u", ops=[_upd("B", "o")])
    await svc.checkpoint(graph_id=gid, branch_id=draft, actor="u")
    await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0)

    async with db.graphver_session() as s:
        row = await s.get(GraphORM, gid)
        assert (row.lifecycle_state, row.lifecycle_rev) == ("frozen", 1)
        assert row.lifecycle_changed_at is not None
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert {p["displayName"] for p in nodes.values()} == {"A", "B"}
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=draft))["nodes"]
    assert {p["displayName"] for p in nodes.values()} == {"a", "B", "C"}
    assert await svc.commit_log(graph_id=gid, branch_id=main)
    assert await svc.commit_log(graph_id=gid, branch_id=draft)
    assert await svc.diff_branch_vs_base(graph_id=gid, branch_id=draft)
    assert await svc.entity_history(graph_id=gid, entity_id="A")
    assert await svc.projection_watermark(gid)
    assert await svc.get_graph(gid)
    await svc.request_projection_rebuild(gid)
    root = tempfile.mkdtemp()
    try:
        ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root))
        assert (await ie.create_export_job(workspace_id="ws1", data_source_id=g["ds"], graph_id=gid,
                                           actor="u"))["job_id"]
        async with db.graphver_session() as s:      # nothing runs it here; nothing else may
            await s.execute(delete(JobORM).where(JobORM.graph_id == gid))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # A review is metadata: approved, edited, closed.
    await svc.approve_pr(pr_id=g["mr"], actor="w")
    await svc.update_pr(pr_id=g["mr"], title="paused", reviewers=["w"])
    assert (await svc.close_pr(pr_id=g["mr"], actor="u"))["status"] == "closed"
    # So are a draft's members and visibility; abandoning it is a way out.
    await svc.add_branch_member(graph_id=gid, branch_id=other, subject_type="user", subject_id="w",
                                role="editor", actor="u")
    await svc.remove_branch_member(graph_id=gid, branch_id=other, subject_type="user", subject_id="w",
                                   actor="u")
    await svc.update_branch(graph_id=gid, branch_id=other, actor="u", name="kept", is_shared=False)
    assert (await svc.abandon_draft(graph_id=gid, branch_id=other, actor="u"))["status"] == "abandoned"
    # Moving its data source moves no content.
    assert await svc.move_graph_workspace(g["ds"], "ws2", from_workspace_id="ws1")
    assert await svc.move_graph_workspace(g["ds"], "ws1", from_workspace_id="ws2")

    # A frozen fork is trashed and restored like any other; its PR writes only the parent.
    await svc.close_pr(pr_id=g["pr"], actor="v")
    fork = g["fork"]
    await svc.set_frozen(graph_id=fork, frozen=True, expected_rev=0)
    assert await svc.delete_fork(graph_id=fork, workspace_id="ws1", actor="v") == gid
    assert await svc.restore_fork(graph_id=fork, workspace_id="ws1") == gid
    await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=1)
    pr = await svc.open_pr(source_graph_id=fork, actor="v")
    assert await svc.merge_pr(pr_id=pr, actor="u", message="from a frozen fork")


def test_reads_and_metadata_still_work_on_a_frozen_graph():
    _e2e(_reads)


async def _unfreeze(svc):
    g = await _live(svc)
    gid, draft = g["gid"], g["draft"]
    await svc.close_pr(pr_id=g["mr"], actor="u")
    assert await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0) == {
        "graph_id": gid, "state": "frozen", "rev": 1, "changed": True}
    assert await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=1) == {
        "graph_id": gid, "state": "live", "rev": 2, "changed": True}
    head = (await _footprint(gid))["head"]
    await svc.stage_changes(graph_id=gid, branch_id=draft, actor="u", ops=[_node("D")])
    assert await svc.checkpoint(graph_id=gid, branch_id=draft, actor="u")
    assert await svc.publish(graph_id=gid, branch_id=draft, actor="u", message="ship")
    assert (await _footprint(gid))["head"] == head + 1
    job = await _ie(svc).create_import_job(workspace_id="ws1", data_source_id=g["ds"], graph_id=gid,
                                           actor="u", import_format="ndjson")
    async with db.graphver_session() as s:          # nothing runs it here; nothing else may
        await s.execute(delete(JobORM).where(JobORM.id == job["job_id"]))


def test_unfreeze_restores_writes():
    _e2e(_unfreeze)


async def _cas(svc):
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    assert (await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0))["rev"] == 1
    assert await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0) == {
        "graph_id": gid, "state": "frozen", "rev": 1, "changed": False}, "a retried freeze is a no-op"
    with pytest.raises(VersionConflict) as stale:
        await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=0)
    assert (stale.value.resource, stale.value.current) == ("lifecycle", 1)
    await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=1)
    with pytest.raises(VersionConflict) as stale:
        await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=1)
    assert stale.value.current == 2
    async with db.graphver_session() as s:
        assert (await s.get(GraphORM, gid)).lifecycle_state == "live"
    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id="ws1", actor="u")
    with pytest.raises(ValueError, match="unknown graph"):
        await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=2)
    with pytest.raises(ValueError, match="unknown graph"):
        await svc.set_frozen(graph_id="g_" + os.urandom(4).hex(), frozen=True, expected_rev=0)


def test_freeze_is_compare_and_set_and_idempotent():
    _e2e(_cas)


async def _in_flight(svc, monkeypatch):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u"))["graph_id"]
    draft = await svc.open_draft(graph_id=gid, owner="u")
    entered, release = asyncio.Event(), asyncio.Event()

    async def held(_s):
        entered.set()
        await release.wait()

    save = asyncio.create_task(svc.apply_ops(graph_id=gid, branch_id=draft, actor="u",
                                             ops=[_node("A")], on_commit=held))
    await entered.wait()
    freeze = asyncio.create_task(svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0))
    await asyncio.sleep(0.5)
    assert not freeze.done(), "the freeze waits for the save in flight"
    release.set()
    assert await save
    assert (await freeze)["state"] == "frozen"
    with pytest.raises(GraphNotWritable):
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=[_node("B")])
    async with db.graphver_session() as s:
        assert await s.scalar(select(func.count()).select_from(CommitORM).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == draft)) == 1

    # A save that holds the row past the bounded wait: the freeze is busy, not stuck.
    await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=1)
    monkeypatch.setattr(config, "GRAPH_LOCK_TIMEOUT_MS", 200)
    entered.clear()
    release.clear()
    save = asyncio.create_task(svc.apply_ops(graph_id=gid, branch_id=draft, actor="u",
                                             ops=[_node("C")], on_commit=held))
    await entered.wait()
    try:
        with pytest.raises(LockBusy):
            await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=2)
    finally:
        release.set()
        await save


def test_freeze_waits_for_an_in_flight_draft_save_and_later_saves_see_it(monkeypatch):
    _e2e(_in_flight, monkeypatch)


async def _queued_publish(svc):
    from backend.app.api.v1.endpoints.versioning import get_import_export_service

    ie = get_import_export_service()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", ops=[_node("A")])
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=[_upd("A", "a")])
    job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                      branch_id=draft, actor="u", message="ship")
    await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0)
    head = (await _footprint(gid))["head"]
    result = await ie.run_publish(job["job_id"])
    assert result["error"]["status"] == 409, result
    assert result["error"]["detail"]["type"] == "graph_not_writable", result
    assert (await ie.get_job(job["job_id"]))["status"] == "failed"
    assert (await svc.branch_statuses([draft]))[draft] == "open", "a refused job hands the draft back"
    assert (await _footprint(gid))["head"] == head
    await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=1)
    assert await svc.publish(graph_id=gid, branch_id=draft, actor="u", message="ship")


def test_a_queued_publish_meets_a_freeze():
    _e2e(_queued_publish)


async def _import(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u"))["graph_id"]
    root = tempfile.mkdtemp()
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")
        urns = [f"urn:I{i}" for i in range(5)]          # three windows of two

        async def body():
            yield "".join(json.dumps({"kind": "node", "urn": u, "entityType": "Table", "displayName": u,
                                      "qualifiedName": u}) + "\n" for u in urns).encode()
        await store.put_stream(key, body())
        job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                         actor="u", import_format="ndjson", source_uri=key)
        draft, windows = job["branch_id"], []
        apply_ops = svc.apply_ops

        async def freezes_before_the_second_window(**kwargs):
            if kwargs.get("message") == "import":
                windows.append(1)
                if len(windows) == 2:
                    await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0)
            return await apply_ops(**kwargs)
        svc.apply_ops = freezes_before_the_second_window
        try:
            await ie.run_import_safe(job["job_id"], await lease_job(job["job_id"]))
        finally:
            del svc.apply_ops
        failed = await ie.get_job(job["job_id"])
        assert failed["status"] == "failed" and "Editing is paused" in failed["errorMessage"], failed
        async with db.graphver_session() as s:
            assert await s.scalar(select(func.count()).select_from(CommitORM).where(
                CommitORM.graph_id == gid, CommitORM.branch_id == draft)) == 1, "the first window landed"

        await svc.set_frozen(graph_id=gid, frozen=False, expected_rev=1)
        assert await ie.requeue_failed(job["job_id"])
        await ie.run_import_safe(job["job_id"], await lease_job(job["job_id"]))
        assert (await ie.get_job(job["job_id"]))["status"] == "completed"
        nodes = (await svc.materialize_state(graph_id=gid, branch_id=draft))["nodes"]
        assert sorted(p["urn"] for p in nodes.values()) == urns, "every row landed once"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_an_import_running_into_a_freeze_fails_and_resumes(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 2)
    _e2e(_import)


async def _trash(svc):
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    draft = await svc.open_draft(graph_id=gid, owner="u")

    async def refused_as():
        with pytest.raises(GraphNotWritable) as refused:
            await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", ops=[_node("A")])
        return refused.value.state

    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id="ws1", actor="u")
    assert await refused_as() == "trashed"
    async with db.graphver_session() as s:          # completed: no worker picks it up
        s.add(JobORM(job_type=PURGE_JOB_TYPE, graph_id=gid, workspace_id="ws1", status="completed"))
    try:
        assert await refused_as() == "purging"
    finally:
        async with db.graphver_session() as s:
            await s.execute(delete(JobORM).where(JobORM.graph_id == gid))

    # Frozen, trashed and restored: frozen still.
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.set_frozen(graph_id=gid, frozen=True, expected_rev=0)
    await tombstone_graphs_for_data_source(data_source_id=ds, workspace_id="ws1", actor="u")
    assert await refused_as() == "trashed"
    assert not (await restore_graphs_for_data_source(data_source_id=ds, workspace_id="ws1")).final
    async with db.graphver_session() as s:
        assert (await s.get(GraphORM, gid)).lifecycle_state == "frozen"
    assert await refused_as() == "frozen"


def test_trash_and_purge_report_their_state_and_restore_keeps_frozen():
    _e2e(_trash)

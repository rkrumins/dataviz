"""Update from parent over HTTP, inside the request and as a job — needs Postgres (management and
graphver).

``POST …/graphs/{fork}/update-from-parent`` answers the update (200 ``{commitId, parentSeq, wrote,
upToDate}``), its conflicts (409 ``fork_update_conflicts``), or 409 ``not_a_fork`` for a graph with
no parent, and records ``workspace.versioning.fork_updated``. Past ``SYNC_PUBLISH_MAX_CHANGES`` —
what it would merge and the edges its cascades may delete, counted in SQL first — it queues a
``fork_update`` job on the transfer lane instead (202 ``{jobId}``), one per fork at a time (409
``job_active``), pinned to the parent's head when it was asked for. Run, the job lands as the
route's update would, says why when it cannot (its conflicts), and run again after it landed
writes nothing more; ``GET …/update-jobs/{jobId}`` says where it is.
"""
import os

import pytest

from backend.tests.integration.test_fork_data_sources import WS, _client, _fork, _parent, _run
from backend.tests.integration.test_fork_overlay_delta import _n, _u

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

#: Update from parent writes the fork's main, so it takes publish, as sync and publish do.
PERMS = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:datasource:publish")


def _url(gid):
    return f"/api/v1/{WS}/versioning/graphs/{gid}/update-from-parent"


def _recorder(monkeypatch):
    from backend.app.services.activity import recorder

    recorded = []

    async def _record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    monkeypatch.setattr(recorder, "record_for_request", _record)
    return lambda: [(f["target_id"], f["details"]) for e, f in recorded
                    if e == "workspace.versioning.fork_updated"]


async def _forked(svc, c, seed):
    """A parent data source with ``seed`` on its graph, and a fork of it made through the API."""
    _ds, gid = await _parent(svc, label="Sales")
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=seed)
    r = await _fork(c, gid, {"name": "Q3"})
    assert r.status_code == 201, r.text
    return gid, r.json()["graphId"]


def test_update_from_parent_answers_its_commit_and_is_recorded(monkeypatch):
    updates = _recorder(monkeypatch)

    async def case(svc):
        async with _client(PERMS) as c:
            gid, fgid = await _forked(svc, c, [_n("A"), _n("B")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_n("C")])
            head = (await svc.get_graph(gid))["main_head_commit_seq"]
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 200, r.text
            body = r.json()
            assert (body["parentSeq"], body["wrote"], body["upToDate"]) == (head, 0, False)
            (entry,) = await svc.commit_log(graph_id=fgid, limit=1)
            assert (entry["commit_id"], entry["kind"], entry["message"]) == (
                body["commitId"], "sync_parent", f"Update from Sales@{head}")
            assert updates() == [(fgid, {"forkParentGraphId": gid, "parentSeq": head, "wrote": 0})]

            r = await c.post(_url(fgid))                     # up to date: no commit, no record
            assert r.status_code == 200, r.text
            assert r.json() == {"commitId": None, "parentSeq": head, "wrote": 0, "upToDate": True}
            assert len(updates()) == 1
    _run(case)


def test_update_from_parent_needs_the_publish_permission():
    async def case(svc):
        async with _client(PERMS) as c:
            gid, fgid = await _forked(svc, c, [_n("A")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_n("C")])
        async with _client(PERMS[:2]) as c:                     # read and manage, no publish
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 403, r.text
            assert r.json()["detail"]["permission"] == "workspace:datasource:publish"
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="x"))["wrote"] == 0
    _run(case)


def test_the_inline_update_takes_the_parent_head_it_was_sized_at(monkeypatch):
    """The route sizes an update at the parent's head, then runs it there: a parent publish in
    between is the next update's, never this one's — which was judged small at that size."""
    from backend.app.services.versioning.service import GraphVersioningService

    sized = GraphVersioningService.fork_update_size

    async def case(svc):
        async with _client(PERMS) as c:
            gid, fgid = await _forked(svc, c, [_n("A")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_n("C")])
            asked = (await svc.get_graph(gid))["main_head_commit_seq"]

            async def size_then_the_parent_moves(self, **kwargs):
                out = await sized(self, **kwargs)
                await svc.apply_ops(graph_id=gid, actor="alice", message="between", ops=[_n("Z")])
                return out
            monkeypatch.setattr(GraphVersioningService, "fork_update_size", size_then_the_parent_moves)
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 200, r.text
            assert r.json()["parentSeq"] == asked
            main = await svc.main_branch_id(fgid)
            assert "Z" not in (await svc.materialize_state(graph_id=fgid, branch_id=main))["nodes"]
    _run(case)


def test_update_from_parent_answers_conflicts_and_refuses_a_graph_with_no_parent():
    async def case(svc):
        async with _client(PERMS) as c:
            gid, fgid = await _forked(svc, c, [_n("A")])
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_u("A", "A parent")])
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 409, r.text
            detail = r.json()["detail"]
            assert detail["type"] == "fork_update_conflicts"
            assert [(x["entity_id"], x["path"], x["ours"], x["theirs"]) for x in detail["conflicts"]] == [
                ("A", ["displayName"], "A fork", "A parent")]
            seed = detail["seeds"]["A"]
            r = await c.post(_url(fgid), json={"resolutions": {"A": {**seed, "displayName": "A both"}}})
            assert r.status_code == 200 and r.json()["wrote"] == 1, r.text
            main = await svc.main_branch_id(fgid)
            nodes = (await svc.materialize_state(graph_id=fgid, branch_id=main))["nodes"]
            assert nodes["A"]["displayName"] == "A both"

            r = await c.post(_url(gid), json={})
            assert r.status_code == 409 and r.json()["detail"]["type"] == "not_a_fork", r.text
    _run(case)


def test_a_large_update_runs_as_a_job_one_at_a_time_pinned_to_the_parent_it_was_asked_of(monkeypatch):
    """Here every update that merges anything is large."""
    from backend.app.api.v1.endpoints import versioning as ep
    from backend.app.services.versioning import config as vconfig

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)
    updates = _recorder(monkeypatch)
    set_off = []
    followed = ep._fork_updated

    async def follow(graph_id, actor):
        set_off.append(graph_id)
        await followed(graph_id, actor)
    monkeypatch.setattr(ep, "_fork_updated", follow)

    async def case(svc):
        from backend.app.api.v1.endpoints.versioning import get_import_export_service
        from backend.app.services.versioning.import_export.import_worker import lease_job

        ie = get_import_export_service()
        async with _client(PERMS) as c:
            gid, fgid = await _forked(svc, c, [_n("A"), _n("B")])
            main = await svc.main_branch_id(fgid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_u("A", "A", w=1)])
            asked = (await svc.get_graph(gid))["main_head_commit_seq"]
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 202, r.text
            job_id = r.json()["jobId"]
            assert r.json()["graphId"] == fgid
            assert updates() == [(fgid, {"forkParentGraphId": gid, "parentSeq": asked, "jobId": job_id})]

            r = await c.post(_url(fgid), json={})            # one at a time
            assert r.status_code == 409, r.text
            assert (r.json()["detail"]["type"], r.json()["detail"]["jobId"]) == ("job_active", job_id)

            # The parent moves on after it was asked: the job takes what it was asked of.
            await svc.apply_ops(graph_id=gid, actor="alice", message="later", ops=[_n("Z")])
            result = await ie.run_fork_job(job_id)
            assert (result["parentSeq"], result["wrote"], result["upToDate"]) == (asked, 1, False)
            assert (await ie.get_job(job_id))["status"] == "completed"
            r = await c.get(f"/api/v1/{WS}/versioning/graphs/{fgid}/update-jobs/{job_id}")
            assert r.status_code == 200, r.text
            assert {k: r.json()[k] for k in ("status", "commitId", "parentSeq", "wrote", "upToDate")} == {
                "status": "completed", "commitId": result["commitId"], "parentSeq": asked, "wrote": 1,
                "upToDate": False}
            nodes = (await svc.materialize_state(graph_id=fgid, branch_id=main))["nodes"]
            assert sorted(nodes) == ["A", "B"] and nodes["A"]["displayName"] == "A fork"
            assert nodes["A"]["properties"] == {"w": 1}

            assert set_off == [fgid]
            # Run again after its update landed (its worker died before it could say so): the next
            # attempt writes nothing more, and completes — what an update sets off runs again.
            await svc.apply_ops(graph_id=gid, actor="alice", message="again", ops=[_u("A", "A", w=2)])
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 202, r.text
            again = r.json()["jobId"]
            await lease_job(again)                           # the first attempt's worker...
            landed = await svc.update_fork_from_parent(
                fork_graph_id=fgid, actor="u_forker",
                parent_seq=(await svc.get_graph(gid))["main_head_commit_seq"])
            result = await ie.run_fork_job(again)            # ...died here; the next attempt runs
            got = await ie.get_job(again)
            assert (got["status"], got["attempt"], result["upToDate"]) == ("completed", 2, True), got
            assert set_off == [fgid, fgid]
            syncs = [e for e in await svc.commit_log(graph_id=fgid) if e["kind"] == "sync_parent"]
            assert [e["commit_id"] for e in syncs][:1] == [landed["commit_id"]] and len(syncs) == 2
    _run(case)


def test_an_update_job_that_finds_conflicts_fails_with_them(monkeypatch):
    from backend.app.services.versioning import config as vconfig

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        from backend.app.api.v1.endpoints.versioning import get_import_export_service

        ie = get_import_export_service()
        async with _client(PERMS) as c:
            gid, fgid = await _forked(svc, c, [_n("A")])
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_u("A", "A parent")])
            head = (await svc.get_graph(fgid))["main_head_commit_seq"]
            r = await c.post(_url(fgid), json={})
            assert r.status_code == 202, r.text
            job_id = r.json()["jobId"]
            result = await ie.run_fork_job(job_id)
            assert result["error"]["status"] == 409, result
            assert result["error"]["detail"]["type"] == "fork_update_conflicts"
            assert [x["entity_id"] for x in result["error"]["detail"]["conflicts"]] == ["A"]
            assert (await ie.get_job(job_id))["status"] == "failed"
            r = await c.get(f"/api/v1/{WS}/versioning/graphs/{fgid}/update-jobs/{job_id}")
            assert (r.json()["status"], r.json()["error"]["detail"]["type"]) == (
                "failed", "fork_update_conflicts"), r.text
            assert (await svc.get_graph(fgid))["main_head_commit_seq"] == head
            # Resolved, it is asked again: the failed job holds nothing up.
            seed = result["error"]["detail"]["seeds"]["A"]
            r = await c.post(_url(fgid), json={"resolutions": {"A": {**seed, "displayName": "A both"}}})
            assert r.status_code == 202, r.text
            assert (await ie.run_fork_job(r.json()["jobId"]))["wrote"] == 1
    _run(case)

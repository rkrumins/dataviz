"""Bulk property jobs against Postgres: one property operation over many entities of a draft,
written by the transfer lane a window at a time — each window one commit, recorded with the job's
checkpoint — and never on main.

* A window is one commit, named by the operation and its place; a worker superseded mid-job leaves
  no window half-written, and the job resumes from its cursor without writing one twice.
* The same Idempotency-Key is the same job; a second job on the draft, and its publish, wait for
  the first; a cancel stops it after its window, keeping what it wrote.
* A rename skips an entity that holds the new key, unless it overwrites; what a job could not write
  — not in the draft, deleted there, a conflict, refused by the write gate — is counted and listed.
* A search target is resolved by the job itself (a stub here: the search engine needs FalkorDB),
  and one that matches too much is refused; a draft closed under a job stops it, saying why.
* The routes: preview, create, follow, cancel, the refused rows as CSV.
"""
import asyncio
import os

import pytest
from sqlalchemy import select, update

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import JobActive
from backend.app.services.versioning.import_export.import_worker import lease_job
from backend.app.services.versioning.import_export.runner import TransferRunner
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Superseded
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.property_patch import PROP_DELETE

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

RENAME = {"kind": "rename", "key": "owner", "to": "steward", "onConflict": "skip"}


def _node(i, etype="Dataset", **props):
    return {"op": "create", "entity_kind": "node", "entity_id": f"N{i}",
            "payload": {"urn": f"urn:n{i}", "entityType": etype, "displayName": f"N{i}",
                        "properties": props}}


async def _draft(owner="alice", nodes=None, n=8):
    """A graph seeded on main — ``n`` nodes holding ``owner``, unless ``nodes`` says — and a draft."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor=owner))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor=owner, message="seed",
                        ops=nodes or [_node(i, owner=f"o{i}") for i in range(n)])
    return svc, ds, gid, await svc.open_draft(graph_id=gid, owner=owner)


async def _create(ie, ds, gid, draft, op, target, key="key-property-0001", actor="alice"):
    return (await ie.create_property_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                         branch_id=draft, actor=actor, op=op, target=target,
                                         message=None, key=key))["job_id"]


async def _props(svc, gid, bid, eid):
    return ((await svc.entity_value(graph_id=gid, entity_id=eid, branch_id=bid)) or {}).get("properties")


async def _messages(gid, bid):
    async with db.graphver_session() as s:
        return list((await s.execute(select(models.CommitORM.message).where(
            models.CommitORM.graph_id == gid, models.CommitORM.branch_id == bid)
            .order_by(models.CommitORM.commit_seq))).scalars())


def _on_window(svc, n, hook):
    """Run ``hook()`` as the ``n``-th window starts to write (before its commit)."""
    real, calls = svc.apply_ops, []

    async def apply_ops(**kw):
        calls.append(kw["message"])
        if len(calls) == n:
            await hook()
        return await real(**kw)
    svc.apply_ops = apply_ops
    return calls


async def _csv(ie, job_id):
    return b"".join([c async for c in await ie.property_refused_rows(job_id)]).decode().splitlines()


# ── windows, commits, resume ──────────────────────────────────────────────────
async def _windows_and_resume(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(8)] + ["urn:nope"]
    job_id = await _create(ie, ds, gid, draft, RENAME, {"ids": ids})
    seeded = await _messages(gid, draft)

    # Another worker takes the job over while the second window writes: that window rolls back
    # with its checkpoint, and the superseded run stops.
    lease = await lease_job(job_id)
    _on_window(svc, 2, lambda: lease_job(job_id))
    with pytest.raises(Superseded):
        await ie.run_property(job_id, lease=lease)
    assert await _messages(gid, draft) == seeded + ["Bulk property: Rename owner → steward (1/3)"]
    assert await _props(svc, gid, draft, "N3") == {"owner": "o3"}

    # Resumed from its cursor: the windows after the first, each once.
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    summary = await ie.run_property(job_id)
    assert await _messages(gid, draft) == seeded + [
        f"Bulk property: Rename owner → steward ({i}/3)" for i in (1, 2, 3)]
    for i in range(8):
        assert await _props(svc, gid, draft, f"N{i}") == {"steward": f"o{i}"}
        assert await _props(svc, gid, None, f"N{i}") == {"owner": f"o{i}"}       # main untouched
    assert (summary["changed"], summary["missing"], summary["commits"]) == (8, 1, 3)
    assert summary["refused"]["byReason"] == {"missing": 1}
    job = await ie.get_property_job(job_id)
    assert (job["status"], job["progress"], job["processed"], job["total"]) == ("completed", 1.0, 9, 9)
    assert job["target"] == {"kind": "ids", "count": 9} and job["op"] == RENAME
    log = await svc.commit_log(graph_id=gid, branch_id=draft)
    by_message = {c["message"]: c["commit_id"] for c in log}
    assert job["summary"]["firstCommitId"] == by_message["Bulk property: Rename owner → steward (1/3)"]
    assert job["summary"]["lastCommitId"] == by_message["Bulk property: Rename owner → steward (3/3)"]
    assert await _csv(ie, job_id) == ["urn,entityId,reason,detail", "urn:nope,,missing,Not in this draft."]
    await db.dispose_engine()


def test_each_window_is_one_commit_and_a_superseded_job_resumes_without_repeating_one(monkeypatch):
    asyncio.run(_windows_and_resume(monkeypatch))


# ── one at a time, idempotent, publish waits, cancel keeps what landed ─────────
async def _one_at_a_time(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(8)]
    first = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-first-0001")
    assert await _create(ie, ds, gid, draft, RENAME, {"ids": ids[:1]}, key="key-first-0001") == first
    with pytest.raises(JobActive) as busy:
        await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-second-001")
    assert busy.value.job_id == first
    with pytest.raises(JobActive, match="bulk property edit"):
        await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="too soon")
    assert await ie.active_draft_job(draft) == first

    # Cancelled as its second window writes: that window rolls back, the first stays.
    lease = await lease_job(first)
    _on_window(svc, 2, lambda: ie.cancel_property_job(first, actor="alice"))
    await ie.run_property_safe(first, lease)
    job = await ie.get_property_job(first)
    assert job["status"] == "cancelled" and job["summary"]["cancelled"] is True
    assert (job["summary"]["changed"], job["summary"]["commits"]) == (3, 1)
    assert [await _props(svc, gid, draft, f"N{i}") for i in (2, 3)] == [{"steward": "o2"}, {"owner": "o3"}]
    assert not await ie.cancel_property_job(first, actor="alice")                # ended already

    # The draft is free again: the next job runs, and the draft publishes once it is done.
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    second = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-second-001")
    await ie.run_property(second)
    assert (await ie.get_property_job(second))["summary"]["changed"] == 5
    assert await ie.active_draft_job(draft) is None
    await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="steward")
    assert await _props(svc, gid, None, "N7") == {"steward": "o7"}
    await db.dispose_engine()


def test_one_job_a_draft_its_key_once_publish_waits_and_cancel_keeps_written_windows(monkeypatch):
    asyncio.run(_one_at_a_time(monkeypatch))


# ── rename conflicts, deleted entities, the write gate ───────────────────────
async def _skips_and_refusals() -> None:
    svc, ds, gid, draft = await _draft(nodes=[
        _node(0, owner="a"), _node(1, owner="b", steward="x"), _node(2, other=1),
        _node(3, owner="d"), _node(4, "Legacy", owner="e"), _node(5, "Legacy", owner="f")])
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(4)]
    skip = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-skip-00001")
    summary = await ie.run_property(skip)
    assert (summary["changed"], summary["unchanged"], summary["conflicts"]) == (2, 1, 1)
    assert await _props(svc, gid, draft, "N1") == {"owner": "b", "steward": "x"}
    assert await _csv(ie, skip) == ["urn,entityId,reason,detail",
                                    "urn:n1,N1,conflict,It already has steward."]
    over = await _create(ie, ds, gid, draft, {**RENAME, "onConflict": "overwrite"}, {"ids": ids},
                         key="key-over-00001")
    assert (await ie.run_property(over))["changed"] == 1
    assert await _props(svc, gid, draft, "N1") == {"steward": "b"}

    # Deleted in the draft; refused by a strict ontology that no longer declares Legacy.
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="drop N3",
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "N3"}])
    async with db.graphver_session() as s:
        await s.execute(update(models.GraphORM).where(models.GraphORM.id == gid).values(
            ontology_spec={"entityTypes": ["Dataset"]}, ontology_enforcement="strict"))
    before = len(await _messages(gid, draft))
    tier = await _create(ie, ds, gid, draft, {"kind": "set", "key": "tier", "value": "gold",
                                              "onConflict": "skip"},
                         {"ids": ["urn:n0", "gv:N0", "urn:n3", "urn:n4", "urn:n5"]}, key="key-tier-00001")
    summary = await ie.run_property(tier)
    assert (summary["changed"], summary["unchanged"], summary["deletedInDraft"], summary["commits"]) == (1, 1, 1, 1)
    assert summary["refused"]["byReason"] == {"deleted_in_draft": 1, "write_refused": 2}
    assert len(await _messages(gid, draft)) == before + 1
    assert (await _props(svc, gid, draft, "N0"))["tier"] == "gold"
    assert "tier" not in await _props(svc, gid, draft, "N4")
    rows = await _csv(ie, tier)
    assert {r.split(",")[0] for r in rows[1:]} == {"urn:n3", "urn:n4", "urn:n5"}
    assert sum(",write_refused," in r for r in rows) == 2 and "urn:n3,N3,deleted_in_draft" in rows[1]
    assert PROP_DELETE not in str(await svc.entity_value(graph_id=gid, entity_id="N1", branch_id=draft))
    await db.dispose_engine()


def test_rename_skips_or_overwrites_and_every_entity_not_written_is_counted_and_listed():
    asyncio.run(_skips_and_refusals())


# ── a search target; too many matches; a draft closed under the job ──────────
async def _search_target(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)
    asked = []

    async def targets(job):
        asked.append(job["target"])
        for urn in ("urn:n0", "urn:n1", "urn:n2", "urn:gone"):
            yield urn

    svc, ds, gid, draft = await _draft(n=4)
    ie = ImportExportService(versioning=svc, property_targets=targets)
    search = {"viewId": "v1", "predicate": {"kind": "hasProperty", "key": "owner"}, "scopeMode": "view"}
    job_id = await _create(ie, ds, gid, draft, {"kind": "remove", "key": "owner", "onConflict": "skip"}, search)
    assert (await ie.get_property_job(job_id))["target"] == {"kind": "predicate", **search}
    await TransferRunner(lambda: ie).run_job(await lease_job(job_id))            # as the lane runs it
    summary = (await ie.get_property_job(job_id))["summary"]
    assert asked == [{"kind": "predicate", **search}]
    assert (summary["changed"], summary["missing"], summary["commits"]) == (3, 1, 2)          # 2 windows
    assert await _props(svc, gid, draft, "N2") == {} and await _props(svc, gid, draft, "N3") == {"owner": "o3"}
    assert (await ie.get_property_job(job_id))["total"] == 4

    monkeypatch.setattr(config, "PROPERTY_JOB_MAX_TARGETS", 3)
    too_many = await _create(ie, ds, gid, draft, {"kind": "remove", "key": "x", "onConflict": "skip"},
                             search, key="key-too-many-1")
    await ie.run_property_safe(too_many, await lease_job(too_many))
    job = await ie.get_property_job(too_many)
    assert job["status"] == "failed" and job["error"]["code"] == "too_many_targets", job
    await db.dispose_engine()


def test_a_search_target_is_resolved_by_the_job_and_one_matching_too_much_is_refused(monkeypatch):
    asyncio.run(_search_target(monkeypatch))


async def _draft_closed(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    job_id = await _create(ie, ds, gid, draft, RENAME, {"ids": [f"urn:n{i}" for i in range(8)]})
    _on_window(svc, 2, lambda: svc.abandon_draft(graph_id=gid, branch_id=draft, actor="alice"))
    await ie.run_property_safe(job_id, await lease_job(job_id))
    job = await ie.get_property_job(job_id)
    assert job["status"] == "failed" and job["error"]["code"] == "draft_closed", job
    assert "abandoned" in job["error"]["message"] and job["summary"]["commits"] == 1
    await db.dispose_engine()


def test_a_draft_closed_under_a_job_stops_it_saying_why(monkeypatch):
    asyncio.run(_draft_closed(monkeypatch))


# ── the routes ────────────────────────────────────────────────────────────────
async def _routes() -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints.versioning import get_import_export_service
    from .test_versioning_main_write_publish import MIA, PAT, V1, _app

    svc, ds, gid, draft = await _draft(owner="pat", n=2)
    main = await svc.main_branch_id(gid)
    app, _G = _app()
    ie = get_import_export_service()
    ids = ["urn:n0", "urn:n1", "urn:nope"]
    body = {"op": RENAME, "target": {"ids": ids}}
    jobs = f"{V1}/graphs/{gid}/branches/{draft}/property-jobs"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"{jobs}/preview", json=body, headers=PAT)
        assert r.status_code == 200, r.text
        preview = r.json()
        assert preview["refusal"] is None and preview["activeJobId"] is None
        assert preview["counts"] == {"matched": 2, "haveKey": 2, "haveTo": 0, "missing": 1}
        assert preview["nameBudget"]["verdict"] == "ok" and preview["nameBudget"]["ceiling"] == 65_534
        reserved = {"op": {"kind": "set", "key": "displayName", "value": "x"}, "target": {"ids": ids}}
        r = await c.post(f"{jobs}/preview", json=reserved, headers=PAT)
        assert r.json()["refusal"]["code"] == "reserved_key", r.text
        r = await c.post(f"{V1}/graphs/{gid}/branches/{main}/property-jobs/preview", json=body, headers=PAT)
        assert r.json()["refusal"]["code"] == "main_write_forbidden", r.text
        unseen = {"op": RENAME, "target": {"viewId": "v_nope", "predicate": {"kind": "hasProperty", "key": "owner"}}}
        r = await c.post(f"{jobs}/preview", json=unseen, headers=PAT)
        assert r.json()["refusal"]["code"] == "view_not_found", r.text

        key = {**PAT, "Idempotency-Key": "key-route-0001"}
        assert (await c.post(jobs, json=body, headers=PAT)).status_code == 422          # no key
        r = await c.post(jobs, json=reserved, headers=key)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "reserved_key", r.text
        r = await c.post(jobs, json=unseen, headers=key)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "view_not_found", r.text
        r = await c.post(f"{V1}/graphs/{gid}/branches/{main}/property-jobs", json=body, headers=key)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "main_write_forbidden", r.text
        r = await c.post(jobs, json=body, headers=key)
        assert r.status_code == 202, r.text
        job = r.json()
        assert (job["status"], job["phase"], job["target"], job["progress"]) == (
            "pending", "queued", {"kind": "ids", "count": 3}, 0.0)
        again = await c.post(jobs, json=body, headers=key)
        assert again.status_code == 202 and again.json()["jobId"] == job["jobId"]
        r = await c.post(jobs, json=body, headers={**PAT, "Idempotency-Key": "key-route-0002"})
        assert r.status_code == 409, r.text
        assert (r.json()["detail"]["code"], r.json()["detail"]["jobId"]) == ("job_active", job["jobId"])
        assert (await c.post(f"{jobs}/preview", json=body, headers=PAT)).json()["activeJobId"] == job["jobId"]

        await ie.run_property(job["jobId"])
        url = f"{V1}/graphs/{gid}/property-jobs/{job['jobId']}"
        r = await c.get(url, headers=PAT)
        assert r.status_code == 200, r.text
        done = r.json()
        assert (done["status"], done["progress"], done["error"]) == ("completed", 1.0, None)
        assert {k: done["summary"][k] for k in ("changed", "missing", "commits")} == {
            "changed": 2, "missing": 1, "commits": 1}
        r = await c.get(f"{url}/refused", params={"format": "csv"}, headers=PAT)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv"), r.text
        assert r.text.splitlines()[1] == "urn:nope,,missing,Not in this draft."
        r = await c.post(f"{url}/cancel", headers=PAT)
        assert r.status_code == 200 and r.json()["status"] == "completed"
        # Someone who can't read pat's private draft doesn't see its jobs.
        assert (await c.get(url, headers=MIA)).status_code == 404
        other = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                        actor="pat"))["graph_id"]
        assert (await c.get(f"{V1}/graphs/{other}/property-jobs/{job['jobId']}", headers=PAT)).status_code == 404
    await db.dispose_engine()


def test_the_routes_preview_create_follow_cancel_and_list_refused_rows():
    asyncio.run(_routes())

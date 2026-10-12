"""A publish run as a job lands exactly as one run inside the request — and says why when it can't.

The job goes through the same hook the API wires into the import/export service (the target's
live ontology, the route's refusals, then what a publish sets off), so this runs it end to end
against Postgres: the draft's changes reach main and the job carries the commit; a draft that fell
behind main is refused with the route's own answer, for the client to raise the same error; the
merge of a draft's review goes the same way, waiting on its reviewer's approval. And a job run again
after its draft merged — its worker died after the squash, or a superseded attempt's squash landed
under it — completes with that merge, publishing nothing twice, and what a publish sets off runs.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models


async def _run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints import versioning as ep
    from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
    from backend.app.services.versioning.import_export.import_worker import lease_job

    await models.create_schema_and_partitions()
    svc, ie = get_versioning_service(), get_import_export_service()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice"))["graph_id"]
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "entity_id": k, "urn": f"urn:{k}", "entityType": "Dataset", "displayName": k}
        for k in ("A", "B")])

    def upd(eid, **payload):
        return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": payload}

    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[upd("A", properties={"reviewed": True})])
    job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                      branch_id=draft, actor="alice", message="publish by job")
    result = await ie.run_publish(job["job_id"])
    got = await ie.get_job(job["job_id"])
    assert got["status"] == "completed" and got["summary"] == result and result.get("commitId"), got
    main = await svc.main_branch_id(gid)
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert nodes["A"]["properties"] == {"reviewed": True}
    log = await svc.commit_log(graph_id=gid, branch_id=main)
    assert log[0]["commit_id"] == result["commitId"] and log[0]["message"] == "publish by job", log[0]

    # A draft that fell behind main: refused with the route's own answer.
    behind = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=behind, actor="alice", ops=[upd("B", displayName="b")])
    other = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=other, actor="bob", ops=[upd("A", displayName="a")])
    await svc.publish(graph_id=gid, branch_id=other, actor="bob", message="first")
    job2 = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                       branch_id=behind, actor="alice", message="too late")
    result2 = await ie.run_publish(job2["job_id"])
    assert result2["error"]["status"] == 409, result2
    assert result2["error"]["detail"]["type"] == "not_up_to_date", result2
    assert (await ie.get_job(job2["job_id"]))["status"] == "failed"

    # The merge of a draft's review, as a job: refused until the reviewer approves, then merged.
    reviewed = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=reviewed, actor="alice", ops=[upd("B", displayName="reviewed")])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=reviewed, actor="alice", reviewers=["carol"])

    async def merge_by_job():
        job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=reviewed,
                                          actor="alice", message="ship it", merge_request_id=mr)
        return await ie.run_publish(job["job_id"])

    unapproved = await merge_by_job()
    assert unapproved["error"] == {"status": 409, "detail": {"type": "approval_required", "pending": ["carol"]}}
    await svc.approve_pr(pr_id=mr, actor="carol")
    merged = await merge_by_job()
    pr = await svc.get_pr(mr)
    assert pr["status"] == "merged" and pr["resulting_commit_id"] == merged["commitId"], (pr, merged)
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert nodes["B"]["displayName"] == "reviewed"

    # What a publish sets off, as it runs.
    set_off = []

    async def promote(branch_id, actor):
        set_off.append(("promote", branch_id))

    async def nudge(graph_id):
        set_off.append(("nudge", graph_id))

    monkeypatch.setattr(ep, "_promote_view_layout_overlay", promote)
    monkeypatch.setattr(ep, "nudge_projection", nudge)

    async def squashes_of(branch_id):
        return [c for c in await svc.commit_log(graph_id=gid, branch_id=main)
                if c["kind"] == "squash_publish" and c.get("source_branch_id") == branch_id]

    # The worker died after its squash committed, before it finished the job: the next attempt
    # publishes nothing again, completes with the merge, and what a publish sets off runs.
    crashed = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=crashed, actor="alice", ops=[upd("A", displayName="crashed")])
    job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                      branch_id=crashed, actor="alice", message="crashed")
    await lease_job(job["job_id"])                      # the first attempt's worker...
    landed = await svc.publish(graph_id=gid, branch_id=crashed, actor="alice", message="crashed")
    result = await ie.run_publish(job["job_id"])       # ...died here; the next attempt runs it
    got = await ie.get_job(job["job_id"])
    assert (got["status"], got["attempt"], result) == ("completed", 2, {"commitId": landed}), got
    assert [c["commit_id"] for c in await squashes_of(crashed)] == [landed], "published once"
    assert set_off == [("promote", crashed), ("nudge", gid)]

    # A superseded attempt's squash lands between this attempt's look and its publish: the publish
    # is refused (the draft merged), and the job completes with that merge all the same.
    raced = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=raced, actor="alice", ops=[upd("B", displayName="raced")])
    job = await ie.create_publish_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                      branch_id=raced, actor="alice", message="raced")
    looked = svc.merged_commit_id
    zombie = []

    async def looks_then_the_zombie_lands(**kwargs):
        merged = await looked(**kwargs)
        if not zombie:
            zombie.append(await svc.publish(graph_id=gid, branch_id=raced, actor="alice", message="zombie"))
        return merged
    monkeypatch.setattr(svc, "merged_commit_id", looks_then_the_zombie_lands)
    set_off.clear()
    result = await ie.run_publish(job["job_id"])
    assert result == {"commitId": zombie[0]} and (await ie.get_job(job["job_id"]))["status"] == "completed"
    assert [c["commit_id"] for c in await squashes_of(raced)] == zombie
    assert set_off == [("promote", raced), ("nudge", gid)]
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_publish_job_lands_like_a_publish_and_says_why_when_it_cannot(monkeypatch):
    asyncio.run(_run(monkeypatch))

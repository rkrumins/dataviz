"""A publish run as a job lands exactly as one run inside the request — and says why when it can't.

The job goes through the same hook the API wires into the import/export service (the target's
live ontology, the route's refusals, then what a publish sets off), so this runs it end to end
against Postgres: the draft's changes reach main and the job carries the commit; a draft that fell
behind main is refused with the route's own answer, for the client to raise the same error.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models


async def _run() -> None:
    from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service

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
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_publish_job_lands_like_a_publish_and_says_why_when_it_cannot():
    asyncio.run(_run())

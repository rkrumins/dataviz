"""A draft that changes more entities than one Postgres statement can name still publishes.

asyncpg caps a statement at 32,767 bind parameters. Reading the draft's own payloads for the
publish merge named every changed version id in ONE ``IN (...)``, so a draft that changed more
than ~32k entities — a large import, a bulk property change — could no longer publish, merge or
pull latest: the statement itself was refused. Every other large read in the service is chunked.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService, NotUpToDate

N = 40_000                      # past the 32,767-parameter cap of a single statement
WINDOW = 10_000


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "entity_id": f"N{i}", "urn": f"urn:n:{i}", "entityType": "Dataset",
         "displayName": f"n{i}", "properties": {"rank": i}}
        for i in range(N)])

    draft = await svc.open_draft(graph_id=gid, owner="alice")
    for start in range(0, N, WINDOW):
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[
            {"op": "update", "entity_kind": "node", "entity_id": f"N{i}",
             "payload": {"properties": {"reviewed": True}}}
            for i in range(start, start + WINDOW)])

    # Someone publishes first, so the big draft must pull latest before it can publish.
    other = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=other, actor="bob", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "N0", "payload": {"displayName": "zero"}}])
    await svc.publish(graph_id=gid, branch_id=other, actor="bob", message="rename n0")
    with pytest.raises(NotUpToDate):
        await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="review everything")
    pulled = await svc.rebase_draft(graph_id=gid, branch_id=draft, actor="alice")
    assert pulled["clean"], pulled

    await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="review everything")

    main = await svc.main_branch_id(gid)
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert len(nodes) == N
    assert all(n["properties"] == {"rank": i, "reviewed": True}
               for i, n in ((int(k[1:]), v) for k, v in nodes.items())), "every change is published"
    assert nodes["N0"]["displayName"] == "zero", "the change pulled in survives"
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_draft_changing_more_entities_than_one_statement_can_name_publishes():
    asyncio.run(_run())

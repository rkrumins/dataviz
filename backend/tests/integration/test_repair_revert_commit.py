"""Repair flow: reverting a commit that truncated a node restores it — against Postgres.

Exercises exactly what backend/scripts/repair_revert_commit.py orchestrates: locate the offending
commit (commit_log), preview what it touched (diff_commits — the script's --dry-run), then
revert_commit to rewrite the affected entities back to their pre-commit state. Projection (FalkorDB)
is out of scope here (no socket); the script defers that to project_now/the worker.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.scripts.repair_revert_commit import _find_commit


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid = G["graph_id"]
    mid = await svc.main_branch_id(gid)

    # commit 1 — the node lands with a full, correct payload.
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "id": "urn:li:dataset:ds_a", "urn": "urn:li:dataset:ds_a",
         "entityType": "Dataset", "displayName": "Accounts", "qualifiedName": "db.accounts",
         "properties": {"owner": "finance"}},
    ])
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    assert st["nodes"]["urn:li:dataset:ds_a"]["displayName"] == "Accounts"

    # commit 2 — the corruption: a commit rewrites the node with a TRUNCATED payload (the pre-fix
    # partial-update bug). displayName/qualifiedName/properties are gone.
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "id": "urn:li:dataset:ds_a", "urn": "urn:li:dataset:ds_a",
         "entityType": "Dataset", "description": "ds_a v2"},
    ])
    bad = (await svc.commit_log(graph_id=gid, limit=1))[0]          # the corrupting commit is head
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    assert st["nodes"]["urn:li:dataset:ds_a"].get("displayName") is None     # corrupted: name lost
    assert st["nodes"]["urn:li:dataset:ds_a"].get("properties") is None

    # the script locates the commit (commit_log) and previews it (diff_commits = --dry-run).
    found = await _find_commit(svc, gid, bad["commit_id"])
    assert found is not None and found["commit_seq"] == bad["commit_seq"]
    diff = await svc.diff_commits(graph_id=gid, branch_id=mid,
                                  from_seq=bad["commit_seq"] - 1, to_seq=bad["commit_seq"])
    assert diff["modified"], "the corrupting commit should show as a modification of ds_a"

    # the repair: revert restores the node to its pre-corruption (commit 1) state.
    revert_id = await svc.revert_commit(graph_id=gid, commit_id=bad["commit_id"], actor="repair",
                                        message="repair: revert truncation")
    assert revert_id
    restored = (await svc.materialize_state(graph_id=gid, branch_id=mid))["nodes"]["urn:li:dataset:ds_a"]
    assert restored["displayName"] == "Accounts"
    assert restored["qualifiedName"] == "db.accounts"
    assert restored["properties"] == {"owner": "finance"}

    # a revert commit is recorded on main (audit trail; not a silent rewrite).
    head = (await svc.commit_log(graph_id=gid, limit=1))[0]
    assert head["commit_id"] == revert_id and head["kind"] == "revert"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_repair_revert_commit_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("repair revert-commit e2e: OK")

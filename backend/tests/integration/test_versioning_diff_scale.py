"""O(changed) diff/history (P3) — needs Postgres.

A graph with a large baseline plus a few tiny commits: diffing two commits must
return ONLY the entities those commits changed (not the baseline), and must equal
the full-reconstruction diff it replaces. Also checked across a fork (CoW
'before' value resolves through the parent).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.changeset import diff_states
from backend.app.services.versioning.service import GraphVersioningService

N = 60  # baseline size


def _node(name, etype="Dataset"):
    return {"displayName": name, "entityType": etype}


async def _publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


async def _brute_diff(svc, gid, branch, frm, to):
    """The full-reconstruction diff this replaces — ground truth."""
    async with db.graphver_session() as s:
        a = await svc._state_as_of(s, gid, branch, frm)
        b = await svc._state_as_of(s, gid, branch, to)
    return diff_states(a, b)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a"))["graph_id"]
    mid = await svc.main_branch_id(gid)

    # commit 2: 60-node baseline (one bulk commit)
    await _publish(svc, gid, "a", [
        {"op": "create", "entity_kind": "node", "entity_id": f"N{i}", "payload": _node(f"n{i}")}
        for i in range(N)
    ], "baseline")
    # commit 3: update N0, add N60
    await _publish(svc, gid, "a", [
        {"op": "update", "entity_kind": "node", "entity_id": "N0", "payload": _node("n0-v2")},
        {"op": "create", "entity_kind": "node", "entity_id": "N60", "payload": _node("n60")},
    ], "c3")
    # commit 4: update N1, delete N60
    await _publish(svc, gid, "a", [
        {"op": "update", "entity_kind": "node", "entity_id": "N1", "payload": _node("n1-v2")},
        {"op": "delete", "entity_kind": "node", "entity_id": "N60", "payload": None},
    ], "c4")

    # ── adjacent diff touches ONLY the 2 changed entities (not the 60 baseline) ──
    d34 = await svc.diff_commits(graph_id=gid, branch_id=mid, from_seq=3, to_seq=4)
    assert d34["added"] == [] and d34["removed"] == ["N60"] and set(d34["modified"]) == {"N1"}, d34
    assert len(d34["added"]) + len(d34["removed"]) + len(d34["modified"]) == 2   # not 60+

    # ── equals the full-reconstruction diff it replaces, across ranges ──
    for frm, to in [(3, 4), (2, 4), (1, 4), (2, 3)]:
        new = await svc.diff_commits(graph_id=gid, branch_id=mid, from_seq=frm, to_seq=to)
        brute = await _brute_diff(svc, gid, mid, frm, to)
        assert new == brute, (frm, to, new, brute)

    # create+delete across a window nets out (N60 absent from diff(2,4))
    d24 = await svc.diff_commits(graph_id=gid, branch_id=mid, from_seq=2, to_seq=4)
    assert set(d24["modified"]) == {"N0", "N1"} and d24["added"] == [] and d24["removed"] == []

    # ── fork: CoW 'before' value resolves through the parent ──
    fgid = (await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="b"))["graph_id"]
    fmid = await svc.main_branch_id(fgid)
    fbase = (await svc.get_graph(fgid))["fork_base_commit_seq"]
    await _publish(svc, fgid, "b", [
        {"op": "update", "entity_kind": "node", "entity_id": "N2", "payload": _node("n2-fork")},
    ], "fork edit")
    fhead = (await svc.get_graph(fgid))["main_head_commit_seq"]
    fdiff = await svc.diff_commits(graph_id=fgid, branch_id=fmid, from_seq=fbase, to_seq=fhead)
    fbrute = await _brute_diff(svc, fgid, fmid, fbase, fhead)
    assert fdiff == fbrute, (fdiff, fbrute)
    assert set(fdiff["modified"]) == {"N2"} and fdiff["added"] == [] and fdiff["removed"] == []
    # N2's 'before' value (inherited from parent) is present → it's a modify, not an add
    assert fdiff["modified"]["N2"]["displayName"][0] == "n2"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_diff_scale_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning O(changed) diff e2e: OK")

"""Pull-latest (rebase_draft) + require-up-to-date-before-merge gate — needs Postgres.

Multiple named drafts run in parallel off the same main. Merging one advances main, so the others
go out of date and are HARD-blocked from publish/merge (NotUpToDate) until they pull the latest
changes. rebase_draft re-bases a draft's edits onto current main with the same 3-way merge as
publish — surfacing same-field conflicts for resolution — and on a clean rebase the draft becomes
up-to-date and mergeable, its composed state reflecting both main's advance and its own edits.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService, NotUpToDate


def _node(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


def _upd(eid, **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, "entityType": "Dataset", **kw}}


async def _draft(svc, gid, owner, name, ops):
    d = await svc.open_draft(graph_id=gid, owner=owner, name=name)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=owner, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=owner)
    return d


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    seed = await _draft(svc, gid, "alice", "seed", [_node("A", f=1), _node("B", f=1)])
    await svc.publish(graph_id=gid, branch_id=seed, actor="alice", message="seed")

    # ── parallel NAMED drafts off the same main ──
    d1 = await _draft(svc, gid, "alice", "feature-x", [_upd("A", f=2)])     # edits A
    d2 = await _draft(svc, gid, "bob", "feature-y", [_upd("B", f=2)])       # edits B (non-overlapping)
    d3 = await _draft(svc, gid, "carol", "feature-z", [_upd("A", f=99)])    # edits A (will clash with d1)
    metas = {b["branch_id"]: b for b in await svc.list_branches(graph_id=gid)}
    assert metas[d1]["name"] == "feature-x" and metas[d2]["name"] == "feature-y"   # names round-trip

    # ── merge one (main advances: A.f -> 2) ──
    mr1 = await svc.open_draft_mr(graph_id=gid, branch_id=d1, actor="alice")
    assert await svc.merge_mr(mr_id=mr1, actor="alice", message="merge x")
    head = (await svc.get_graph(gid))["main_head_commit_seq"]

    # ── the others are now behind → HARD-blocked at merge AND publish ──
    mr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="bob")
    pr2 = await svc.get_pr(mr2)
    assert pr2["behind"] is True and pr2["behind_by"] >= 1     # meta surfaces staleness for the FE gate
    with pytest.raises(NotUpToDate):
        await svc.merge_mr(mr_id=mr2, actor="bob", message="merge y")
    with pytest.raises(NotUpToDate):
        await svc.publish(graph_id=gid, branch_id=d2, actor="bob", message="pub y")

    # ── pull latest into d2: non-overlapping → clean, becomes up-to-date, then merges ──
    r = await svc.rebase_draft(graph_id=gid, branch_id=d2, actor="bob")
    assert r["clean"] is True and r["base_commit_seq"] == head
    assert (await svc.get_pr(mr2))["behind"] is False          # rebase cleared the merge gate
    st2 = await svc.materialize_state(graph_id=gid, branch_id=d2)             # pulled main's A.f=2 + own B.f=2
    assert st2["nodes"]["A"]["f"] == 2 and st2["nodes"]["B"]["f"] == 2
    assert await svc.merge_mr(mr_id=mr2, actor="bob", message="merge y")
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]["B"]["f"] == 2

    # ── d3 also edited A → rebase surfaces a same-field conflict, resolvable in the draft ──
    rc = await svc.rebase_draft(graph_id=gid, branch_id=d3, actor="carol")
    assert rc["clean"] is False and rc["conflicts"][0]["entity_id"] == "A"
    rc2 = await svc.rebase_draft(graph_id=gid, branch_id=d3, actor="carol",
                                 resolutions={"A": {"displayName": "A", "entityType": "Dataset", "f": 99}})
    assert rc2["clean"] is True
    mr3 = await svc.open_draft_mr(graph_id=gid, branch_id=d3, actor="carol")
    assert await svc.merge_mr(mr_id=mr3, actor="carol", message="merge z")
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]["A"]["f"] == 99

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_rebase_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning rebase + up-to-date gate e2e: OK")

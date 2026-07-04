"""View attribution rides every write path (needs Postgres).

The per-view "Changes & Reviews" filter is only as good as write-time attribution:
- ``resolve_graph`` with a view id opens an ATTRIBUTED draft, and ``apply_ops``
  (the interactive canvas save) stamps its ``kind="edit"`` commits with the
  draft's ``originating_view_id``;
- ``publish`` carries the attribution onto the squash commit on main, so the
  view-scoped ``commit_log`` sees merged work;
- claim-if-null: a draft opened without a view (legacy / non-view paths) adopts
  the caller's view on the next editing resolve — but an already-attributed
  draft is never re-assigned, and a resolve without a view id never mutates;
- a draft MR from an attributed draft is listed by
  ``list_pulls(originating_view_id=...)``.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM
from backend.app.services.versioning.service import GraphVersioningService


def _n(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Dataset", "displayName": eid}}


async def _branch_view(bid: str):
    async with db.graphver_session() as s:
        return (await s.get(BranchORM, bid)).originating_view_id


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds_id = "ds_" + os.urandom(4).hex()

    G = await svc.create_graph(data_source_id=ds_id, workspace_id="ws1", actor="alice")
    gid = G["graph_id"]

    # ── An editing resolve opens an attributed draft ──────────────────────
    r = await svc.resolve_graph(data_source_id=ds_id, actor="alice",
                                originating_view_id="view_A")
    d = r["my_draft"]
    assert d["originating_view_id"] == "view_A"
    bid = d["branch_id"]

    # apply_ops (interactive canvas save) → the "edit" commit carries the view
    await svc.apply_ops(graph_id=gid, branch_id=bid, actor="alice",
                        message="canvas save", ops=[_n("A"), _n("B")])
    view_log = await svc.commit_log(graph_id=gid, originating_view_id="view_A")
    assert [c["kind"] for c in view_log] == ["edit"]

    # publish → the squash commit on main keeps the attribution
    await svc.publish(graph_id=gid, branch_id=bid, actor="alice", message="ship")
    view_log = await svc.commit_log(graph_id=gid, originating_view_id="view_A")
    kinds = {c["kind"] for c in view_log}
    assert "squash_publish" in kinds and "edit" in kinds
    # ... and the whole-graph main log still shows it (sanity)
    main_log = await svc.commit_log(graph_id=gid)
    assert any(c["kind"] == "squash_publish" for c in main_log)

    # ── "This view" published_only == whole-graph for a single-view source ──
    published = await svc.commit_log(graph_id=gid, originating_view_id="view_A",
                                     published_only=True)
    assert [c["commit_id"] for c in published] == [c["commit_id"] for c in main_log], \
        "single-view published history must equal the whole-graph main log"
    # every published row is a main-branch commit (squash/genesis), never a raw draft edit
    assert all(c["kind"] in ("squash_publish", "genesis") for c in published)

    # ── the squash drills down to the raw draft commits it squashed ──
    squash = next(c for c in published if c["kind"] == "squash_publish")
    assert squash["source_commit_count"] >= 1
    children = await svc.squashed_commits(graph_id=gid, commit_id=squash["commit_id"])
    assert len(children) == squash["source_commit_count"]
    assert all(c["originating_view_id"] == "view_A" for c in children)
    # a non-squash commit has no drill-down
    genesis = next(c for c in published if c["kind"] == "genesis")
    assert await svc.squashed_commits(graph_id=gid, commit_id=genesis["commit_id"]) == []

    # ── Claim-if-null on resume ────────────────────────────────────────────
    legacy = await svc.open_draft(graph_id=gid, owner="bob")        # no view (legacy path)
    assert await _branch_view(legacy) is None
    r = await svc.resolve_graph(data_source_id=ds_id, actor="bob",
                                originating_view_id="view_B")
    assert r["my_draft"]["branch_id"] == legacy                     # resumed, not duplicated
    assert r["my_draft"]["originating_view_id"] == "view_B"
    assert await _branch_view(legacy) == "view_B"

    # an attributed draft is never re-assigned ...
    r = await svc.resolve_graph(data_source_id=ds_id, actor="bob",
                                originating_view_id="view_C")
    assert r["my_draft"]["originating_view_id"] == "view_B"
    # ... and a read resolve (no view id) never mutates
    r = await svc.resolve_graph(data_source_id=ds_id, actor="bob",
                                open_draft_if_absent=False)
    assert r["my_draft"]["originating_view_id"] == "view_B"

    # ── A draft MR from an attributed draft is view-listable ──────────────
    await svc.stage_changes(graph_id=gid, branch_id=legacy, actor="bob", ops=[_n("C")])
    await svc.checkpoint(graph_id=gid, branch_id=legacy, actor="bob")
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=legacy, actor="bob")
    by_view = await svc.list_pulls(originating_view_id="view_B")
    assert any(p["pr_id"] == mr for p in by_view)
    assert not any(p["pr_id"] == mr for p in await svc.list_pulls(originating_view_id="view_A"))

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_view_attribution_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning view attribution e2e: OK")

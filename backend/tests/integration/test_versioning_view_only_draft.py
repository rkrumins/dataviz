"""A draft that changes only views (an import staged in it) — needs Postgres.

Such a draft has no graph changes, yet publishing it is real: its views go live with it. So
publishing it directly still resolves the review raised from it (a live review on a merged
branch would be a zombie: unmergeable, yet shown as actionable), and ``branch_statuses`` tells
the views' settling pass which drafts are merged or abandoned. ``claim_draft`` lets a view
imported with a package's data go into the draft that data opened, and only its owner's.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import AccessDenied, GraphVersioningService


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    graph = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                   actor="alice")
    gid = graph["graph_id"]

    views_only = await svc.open_draft(graph_id=gid, owner="alice", name="Import: Finance lineage")
    review = await svc.open_draft_mr(graph_id=gid, branch_id=views_only, actor="alice", title="Finance lineage")
    head_before = (await svc.get_graph(gid))["main_head_commit_seq"]
    await svc.publish(graph_id=gid, branch_id=views_only, actor="alice", message="Publish")

    assert (await svc.get_graph(gid))["main_head_commit_seq"] == head_before, "nothing reached main"
    settled = await svc.get_pr(review)
    assert settled["status"] == "merged" and settled["merged_via"] == "direct_publish"
    assert settled["resulting_commit_id"] is None, "no commit landed it"

    abandoned = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.abandon_draft(graph_id=gid, branch_id=abandoned, actor="alice")
    still_open = await svc.open_draft(graph_id=gid, owner="bob")
    assert await svc.branch_statuses([views_only, abandoned, still_open, "br_missing"]) == {
        views_only: "merged", abandoned: "abandoned", still_open: "open",
    }

    # A package's data opened a draft for no view yet; the new view imported with it claims it.
    for_data = await svc.open_draft(graph_id=gid, owner="alice", name="Import: Finance lineage")
    claimed = await svc.claim_draft(graph_id=gid, branch_id=for_data, actor="alice", view_id="view_new")
    assert claimed["originating_view_id"] == "view_new"
    again = await svc.claim_draft(graph_id=gid, branch_id=for_data, actor="alice", view_id="view_other")
    assert again["originating_view_id"] == "view_new", "a draft already for a view stays that view's"
    with pytest.raises(AccessDenied):
        await svc.claim_draft(graph_id=gid, branch_id=for_data, actor="bob")
    with pytest.raises(ValueError):
        await svc.claim_draft(graph_id=gid, branch_id=abandoned, actor="alice")

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_draft_of_views_only_publishes_and_settles():
    asyncio.run(_run())

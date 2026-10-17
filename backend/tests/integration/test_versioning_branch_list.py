"""The branch list (2B-3): who sees what, which statuses, and paging — needs Postgres.

The read filter runs in SQL before LIMIT, so a non-manager's first page holds their own drafts
even when a graph has hundreds of branches they cannot read. A non-manager sees ``main``, their
own drafts, shared drafts they are a member of, and drafts with a PR they raised or review — the
``_branch_readable`` rule. ``status`` defaults to open + publishing. Order is ``main`` first, then
drafts newest first, paged by a keyset cursor (the HTTP route returns it as ``X-Next-Cursor``).
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchMemberORM, BranchORM, MergeRequestORM
from backend.app.services.versioning.service import GraphVersioningService, Viewer


_T0 = datetime.now(timezone.utc) - timedelta(hours=1)     # recent: the idle-draft sweep leaves them be


def _ts(i: int) -> str:
    return (_T0 + timedelta(seconds=i)).isoformat()


async def _seed():
    """main + 150 of alice's drafts, with bob's readable drafts at both ends and in the middle.

    Alice's drafts come in pairs with the same ``created_at``, so the cursor's id tie-break counts.
    """
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    tag = os.urandom(3).hex()

    def br(i, owner, *, status="open", shared=False, ts=None):
        return BranchORM(id=f"br_{tag}_{i:03d}", graph_id=gid, kind="draft", owner=owner,
                         is_shared=shared, status=status, base_commit_seq=1,
                         created_at=ts or _ts(i), updated_at=ts or _ts(i))

    bob = {
        "oldest": br(0, "bob"),
        "shared": br(50, "alice", shared=True),
        "reviewing": br(80, "alice"),
        "publishing": br(120, "bob", status="publishing"),
        "newest": br(199, "bob"),
        "merged": br(198, "bob", status="merged"),
        "abandoned": br(197, "bob", status="abandoned"),
    }
    hidden = {
        "unshared_member": br(60, "alice"),            # a member row, but the draft is not shared
        "closed_pr": br(70, "alice"),                   # a PR bob neither raised nor reviews
    }
    used = {int(b.id[-3:]) for b in [*bob.values(), *hidden.values()]}
    others = [br(i, "alice", ts=_ts(i - i % 2)) for i in range(1, 200) if i not in used][:150]
    async with db.graphver_session() as s:
        s.add_all([*bob.values(), *hidden.values(), *others])
        await s.flush()
        s.add_all([
            BranchMemberORM(branch_id=bob["shared"].id, subject_type="user", subject_id="bob", role="editor"),
            BranchMemberORM(branch_id=hidden["unshared_member"].id, subject_type="user", subject_id="bob",
                            role="editor"),
            MergeRequestORM(graph_id=gid, source_graph_id=gid, source_branch_id=bob["reviewing"].id,
                            target_graph_id=gid, actor="alice", reviewers=["bob"]),
            MergeRequestORM(graph_id=gid, source_graph_id=gid, source_branch_id=hidden["closed_pr"].id,
                            target_graph_id=gid, actor="alice", reviewers=["carol"]),
        ])
        await s.commit()
    ids = lambda d: {k: b.id for k, b in d.items()}  # noqa: E731
    return svc, gid, main, ids(bob), ids(hidden), len(others)


async def _run() -> None:
    svc, gid, main, bob, hidden, n_others = await _seed()
    viewer_bob, mgr = Viewer("bob", False), Viewer("mgr", True)

    # ── bob's FIRST page (default limit 100) holds every draft he may read, and only those ──
    page, cursor = await svc.list_branches(graph_id=gid, viewer=viewer_bob)
    got = [b["branch_id"] for b in page]
    assert got == [main, bob["newest"], bob["publishing"], bob["reviewing"], bob["shared"], bob["oldest"]], got
    assert cursor is None
    assert not set(hidden.values()) & set(got)

    # ── status filter: default is open + publishing; any other set by name; "all" lifts it ──
    page, _ = await svc.list_branches(graph_id=gid, viewer=viewer_bob, status=["merged", "abandoned"])
    assert [b["branch_id"] for b in page] == [bob["merged"], bob["abandoned"]]
    page, _ = await svc.list_branches(graph_id=gid, viewer=viewer_bob, status=["publishing"])
    assert [b["branch_id"] for b in page] == [bob["publishing"]]
    page, _ = await svc.list_branches(graph_id=gid, viewer=viewer_bob, status=["all"])
    assert len(page) == 8                                        # main + 7 drafts of bob's, all statuses

    # ── cursor paging: bob, two at a time, walks the same list ──
    walked, cursor = [], None
    while True:
        page, cursor = await svc.list_branches(graph_id=gid, viewer=viewer_bob, limit=2, cursor=cursor)
        walked += [b["branch_id"] for b in page]
        if cursor is None:
            break
    assert walked == [main, bob["newest"], bob["publishing"], bob["reviewing"], bob["shared"], bob["oldest"]]

    # ── a manager pages through all of them: no row twice, none missed, newest first ──
    walked, cursor, rows = [], None, []
    while True:
        page, cursor = await svc.list_branches(graph_id=gid, viewer=mgr, limit=40, cursor=cursor,
                                               status=["all"])
        rows += page
        if cursor is None:
            break
    walked = [b["branch_id"] for b in rows]
    assert len(walked) == len(set(walked)) == 1 + len(bob) + len(hidden) + n_others
    assert walked[0] == main
    keys = [(b["created_at"], b["branch_id"]) for b in rows[1:]]
    assert keys == sorted(keys, reverse=True)

    await db.dispose_engine()


async def _run_http() -> None:
    from httpx import ASGITransport, AsyncClient

    from backend.tests.integration.test_versioning_branch_per_view import _build_app

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ws1 = "/api/v1/ws1/versioning"
    async with AsyncClient(transport=ASGITransport(app=_build_app()), base_url="http://test") as c:
        ds = "ds_" + os.urandom(4).hex()
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})).json()["graphId"]
        drafts = [await svc.open_draft(graph_id=gid, owner="u_test") for _ in range(3)]
        await svc.abandon_draft(graph_id=gid, branch_id=drafts[0], actor="u_test")

        r = await c.get(f"{ws1}/graphs/{gid}/branches", params={"limit": 2})
        assert r.status_code == 200 and len(r.json()) == 2
        nxt = r.headers["X-Next-Cursor"]
        r = await c.get(f"{ws1}/graphs/{gid}/branches", params={"limit": 2, "cursor": nxt})
        assert [b["branchId"] for b in r.json()] == [drafts[1]] and "X-Next-Cursor" not in r.headers

        r = await c.get(f"{ws1}/graphs/{gid}/branches", params=[("status", "merged"), ("status", "abandoned")])
        assert [b["branchId"] for b in r.json()] == [drafts[0]]
        assert (await c.get(f"{ws1}/graphs/{gid}/branches", params={"status": "closed"})).status_code == 422
        assert (await c.get(f"{ws1}/graphs/{gid}/branches", params={"cursor": "junk"})).status_code == 422

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_branch_list_e2e():
    asyncio.run(_run())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_branch_list_http_e2e(data_sources):
    asyncio.run(_run_http())

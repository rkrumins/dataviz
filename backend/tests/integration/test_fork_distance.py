"""A fork says how far it is from its parent — needs Postgres.

Each live fork in a graph's fork list says how many entities it changed since its last merged
review, or since its fork point (``ahead``), how many its parent changed that it has not taken in
(``behind``: the parent's window since the base the fork reads), whether an update from its parent
is recommended (the parent's changes past ``GRAPHVER_FORK_REWIND_WARN``, or its reads past
``GRAPHVER_FORK_REWIND_MAX``) and how it is read (``readsFrom``: ``overlay`` or ``postgres``).
Each count stops at the ceiling (``countsCapped``).
"""
import os

import pytest

from backend.app.services.versioning import config, db
from backend.app.services.versioning.models import MergeRequestORM
from backend.tests.integration.test_fork_data_sources import WS, _client, _fork, _parent
from backend.tests.integration.test_fork_overlay_delta import _n, _run, _u

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

FIELDS = ("ahead", "behind", "updateRecommended", "readsFrom", "countsCapped")


def test_a_fork_says_how_far_it_is_from_its_parent(monkeypatch, forks_on):
    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
            fgid = fork["graphId"]

            async def item():
                r = await c.get(f"/api/v1/{WS}/versioning/graphs/{gid}/forks")
                assert r.status_code == 200, r.text
                got = next(f for f in r.json() if f["graphId"] == fgid)
                return {k: got[k] for k in FIELDS}

            assert await item() == {"ahead": 0, "behind": 0, "updateRecommended": False,
                                    "readsFrom": "overlay", "countsCapped": False}
            await svc.apply_ops(graph_id=fgid, actor="u_forker", message="own", ops=[
                _n("N"), _u("A", "A fork")])
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent's", ops=[
                _n("P"), _u("B", "B two"), _n("Q")])
            assert await item() == {"ahead": 2, "behind": 3, "updateRecommended": False,
                                    "readsFrom": "overlay", "countsCapped": False}

            # Ahead of its last merged review, not of its fork point.
            async with db.graphver_session() as s:
                s.add(MergeRequestORM(
                    graph_id=fgid, source_branch_id=fork["mainBranchId"], target_graph_id=gid,
                    status="merged", merged_source_seq=(await svc.get_graph(fgid))[
                        "main_head_commit_seq"]))
            await svc.apply_ops(graph_id=fgid, actor="u_forker", message="more", ops=[_n("M")])
            assert (await item())["ahead"] == 1

            # Past the warning, an update is recommended; past the ceiling it reads Postgres, and
            # the counts stop at the ceiling.
            monkeypatch.setattr(config, "FORK_REWIND_WARN", 3)
            assert await item() == {"ahead": 1, "behind": 3, "updateRecommended": True,
                                    "readsFrom": "overlay", "countsCapped": False}
            monkeypatch.setattr(config, "FORK_REWIND_WARN", 50_000)
            monkeypatch.setattr(config, "FORK_REWIND_MAX", 2)
            # Past the ceiling on its own 3 changes: taking in the parent's would not bring it
            # back under, so no update is recommended for it.
            assert await item() == {"ahead": 1, "behind": 2, "updateRecommended": False,
                                    "readsFrom": "postgres", "countsCapped": True}

            # A fork in the trash says none of it.
            deleted = await c.delete(f"/api/v1/{WS}/versioning/graphs/{fgid}")
            assert deleted.status_code == 204
            assert await item() == {k: None for k in FIELDS}
    _run(case)


def test_a_forks_ceiling_count_is_kept_per_version(monkeypatch, forks_on):
    """Each engine a request builds for a fork asks ``fork_reads_from`` whether the fork is past
    the ceiling, which counts its candidates (70 ms at 145,000). The count is kept per version of
    the fork (its head, the base each layer reads, its root's head) and ceiling: a request at an
    unchanged version counts nothing, a commit on either side counts anew."""
    from backend.app.services.versioning.service import GraphVersioningService

    counted = []
    real = GraphVersioningService._own_change_count

    async def spy(s, graph_id, branch_id, lo, hi, cap):
        counted.append(graph_id)
        return await real(s, graph_id, branch_id, lo, hi, cap)

    monkeypatch.setattr(GraphVersioningService, "_own_change_count", staticmethod(spy))

    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
        async with _client() as c:
            fgid = (await _fork(c, gid)).json()["graphId"]
        await svc.apply_ops(graph_id=fgid, actor="u_forker", message="own", ops=[_n("N")])
        monkeypatch.setattr(config, "FORK_REWIND_MAX", 2)

        async def reads():
            counted.clear()
            return await svc.fork_reads_from(fgid), len(counted)

        assert await reads() == ("overlay", 1)          # its own 1, the root's window 0
        assert await reads() == ("overlay", 0)          # the same version: nothing counted
        await svc.apply_ops(graph_id=gid, actor="alice", message="root", ops=[_n("P"), _n("Q")])
        assert await reads() == ("postgres", 1)         # the root moved: 3, past the ceiling
        assert await reads() == ("postgres", 0)
        await svc.apply_ops(graph_id=fgid, actor="u_forker", message="own", ops=[_n("M")])
        assert await reads() == ("postgres", 1)         # the fork moved
        monkeypatch.setattr(config, "FORK_REWIND_MAX", 50)
        assert await reads() == ("overlay", 1)          # another ceiling, another count
    _run(case)


def test_an_update_is_recommended_only_where_it_would_help(monkeypatch, forks_on):
    """``updateRecommended`` is what Update from parent can fix. A fork past the ceiling recommended
    one whatever put it there, and a fork of a busy fork, whose reads count its parent's own
    history up to its base, recommended one for good: taking in its parent's newer work only adds
    to that. Past the ceiling, one is recommended where taking in the parent's changes would bring
    the fork back under it (a fork of the root that changed no more than the ceiling itself); and
    always once ``behind`` reaches the warning. Either way the fork says it reads Postgres."""
    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A")])
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
            fgid = fork["graphId"]
            await svc.apply_ops(graph_id=fgid, actor="u_forker", message="own",
                                ops=[_n("F1"), _n("F2"), _n("F3")])
            leaf = (await _fork(c, fgid)).json()
            await svc.apply_ops(graph_id=gid, actor="alice", message="root", ops=[_n("R1"), _n("R2")])

            async def item(of, graph):
                r = await c.get(f"/api/v1/{WS}/versioning/graphs/{of}/forks")
                got = next(f for f in r.json() if f["graphId"] == graph)
                return got["readsFrom"], got["updateRecommended"], got["behind"]

            # The fork of the root: its own 3, the root's 2 it has not taken in.
            monkeypatch.setattr(config, "FORK_REWIND_MAX", 4)
            assert await item(gid, fgid) == ("postgres", True, 2)     # the update leaves 3
            monkeypatch.setattr(config, "FORK_REWIND_MAX", 2)
            assert await item(gid, fgid) == ("postgres", False, 2)    # its own 3 stay
            # The fork of the fork: past the ceiling on its parent's own 3, behind on nothing.
            assert await item(fgid, leaf["graphId"]) == ("postgres", False, 0)
    _run(case)

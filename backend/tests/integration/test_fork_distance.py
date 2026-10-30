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


def test_a_fork_says_how_far_it_is_from_its_parent(monkeypatch):
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
            assert await item() == {"ahead": 1, "behind": 2, "updateRecommended": True,
                                    "readsFrom": "postgres", "countsCapped": True}

            # A fork in the trash says none of it.
            assert (await c.delete(f"/api/v1/{WS}/versioning/graphs/{fgid}")).status_code == 204
            assert await item() == {k: None for k in FIELDS}
    _run(case)

"""An edge changed since a draft's or fork's base reads as it was there — needs Postgres.

A draft reads main as it was at its branch point, and a fork its parent as it was at its base;
the overlay rewinds what main (or the parent) changed since. A change to an edge's properties
alone was not rewound — restored as an upsert, the edge counted twice in the rollups — so a draft
showed main's later edits of an edge. The overlay now serves the value at the base and counts the
edge as main counts it: its rollup, its source's child count, the children total. A draft's own
property edit of an edge, and a fork's, read and count the same way.
"""
import os

import pytest

from backend.common.models.graph import EdgeQuery
from backend.tests.integration.test_fork_overlay_delta import _e, _n, _run, _ue

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]


def _reader(svc, gid, bid):
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    p = VersionedBranchProvider(svc, graph_id=gid, branch_id=bid)
    p.set_containment_edge_types(CONT)
    return p


def _overlay(svc, base, gid, bid, fork=False):
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    p = DraftOverlayProvider(base, svc=svc, graph_id=gid, branch_id=bid, fork=fork)
    p.set_containment_edge_types(CONT)
    return p


async def _props(p):
    return {e.id: e.properties for e in await p.get_edges(EdgeQuery(limit=100))
            if e.id in ("lin", "cA")}


async def _counts(p):
    """Every count the overlay adjusts for the edges' ends."""
    agg = await p.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, CONT, ["FLOWS"])
    kids = await p.get_children_with_edges("A", edge_types=CONT)
    return ({(e.source_urn, e.target_urn): e.edge_count for e in agg.aggregated_edges},
            kids.total_children, (await p.get_node("A")).child_count,
            [(e.id, e.properties) for e in kids.containment_edges])


def test_an_edge_main_changed_after_the_base_reads_as_it_was():
    async def case(svc):
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws1", actor="alice"))["graph_id"]
        main = await svc.main_branch_id(gid)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                            ops=[_n("A"), _n("B"), _n("A.c"), _n("B.c"), _e("cA", "A", "A.c", "CONTAINS", p=0),
                                 _e("cB", "B", "B.c", "CONTAINS"), _e("lin", "A.c", "B.c", w=0)])
        draft = await svc.open_draft(graph_id=gid, owner="alice")
        fork = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
        fgid, fmain = fork["graph_id"], fork["main_branch_id"]
        at_base = await _counts(_reader(svc, gid, main))
        await svc.apply_ops(graph_id=gid, actor="alice", message="edges", containment_edge_types=CONT,
                            ops=[_ue("lin", "A.c", "B.c", w=1), _ue("cA", "A", "A.c", "CONTAINS", p=1)])
        now = await _counts(_reader(svc, gid, main))
        assert now[:3] == at_base[:3] and now[3] == [("cA", {"p": 1})]

        # The draft and the fork read the edges as they were at their base, counted as main is.
        for p in (_overlay(svc, _reader(svc, gid, main), gid, draft),
                  _overlay(svc, _reader(svc, gid, main), fgid, fmain, fork=True)):
            assert await _props(p) == {"lin": {"w": 0}, "cA": {"p": 0}}
            assert await _counts(p) == at_base

        # Their own property edits read as theirs, and count as main does too.
        own = await svc.open_draft(graph_id=gid, owner="alice")
        await svc.apply_ops(graph_id=gid, branch_id=own, actor="alice", message="own",
                            containment_edge_types=CONT, ops=[_ue("lin", "A.c", "B.c", w=5)])
        await svc.apply_ops(graph_id=fgid, actor="bob", message="own", containment_edge_types=CONT,
                            ops=[_ue("cA", "A", "A.c", "CONTAINS", p=7)])
        p = _overlay(svc, _reader(svc, gid, main), gid, own)
        assert await _props(p) == {"lin": {"w": 5}, "cA": {"p": 1}}
        assert (await _counts(p))[:3] == now[:3]
        p = _overlay(svc, _reader(svc, gid, main), fgid, fmain, fork=True)
        assert await _props(p) == {"lin": {"w": 0}, "cA": {"p": 7}}
        assert await _counts(p) == (*at_base[:3], [("cA", {"p": 7})])
    _run(case)

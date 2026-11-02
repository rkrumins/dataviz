"""A rollup read through a draft's or fork's overlay — needs Postgres.

The overlay adjusts its store's rollups by the flows its patch set added and removed. For a fork
that list holds every flow its root added, deleted or re-pointed since the fork point, and each
read paid a urn lookup, a containment climb and a value read for each of them: thousands of
queries a read for a fork whose root took in a few thousand flows. The chains of their ends are
now looked up once per patch set, in one batched walk, and kept with it; each read places its
flows in Python. A flow the overlay removed comes off where its store counted it (the store's
chains), one it added goes on where it runs (the overlay's own).
"""
import os

import pytest
from sqlalchemy import event

from backend.tests.integration.test_fork_overlay_delta import _d, _e, _n, _run, _ue
from backend.tests.integration.test_overlay_edge_rewind import CONT, _overlay, _reader

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


async def _queries(read, provider) -> int:
    """How many statements ``read(provider)`` sends to Postgres."""
    from backend.app.services.versioning import db

    sent = []

    def record(conn, cursor, statement, params, context, executemany):
        sent.append(statement)

    engine = db.get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        await read(provider)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    return len(sent)


def test_a_forks_rollup_read_runs_no_queries_per_flow_its_root_took_in():
    tables = [f"T{i}" for i in range(10)]

    async def rollups(p):
        return await p.get_aggregated_edges_between(tables, tables, None, CONT, ["FLOWS"])

    async def case(svc):
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws1", actor="alice"))["graph_id"]
        main = await svc.main_branch_id(gid)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                            ops=[*(_n(t) for t in tables), *(_n(f"c{j}") for j in range(50)),
                                 *(_e(f"k{j}", f"T{j % 10}", f"c{j}", "CONTAINS") for j in range(50))])
        fork = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
        fgid, fmain = fork["graph_id"], fork["main_branch_id"]
        store = _reader(svc, gid, main)

        async def overlay_cost():
            """The queries a rollup read adds to its store's own: the first read of a patch set,
            and the next request's."""
            p = _overlay(svc, store, fgid, fmain, fork=True)
            await p._delta_()                                  # built, and cached, beforehand
            own = await _queries(rollups, store)
            first = await _queries(rollups, p)
            again = await _queries(rollups, _overlay(svc, store, fgid, fmain, fork=True))
            return first - own, again - own

        flows = [_e(f"f{j}", f"c{j}", f"c{(j + 13) % 50}") for j in range(40)]
        await svc.apply_ops(graph_id=gid, actor="alice", message="4 flows", ops=flows[:4],
                            containment_edge_types=CONT)
        few = await overlay_cost()
        await svc.apply_ops(graph_id=gid, actor="alice", message="36 more", ops=flows[4:],
                            containment_edge_types=CONT)
        many = await overlay_cost()
        assert many == few, (few, many)
        assert many[1] < many[0], many                         # the chains are kept
    _run(case)


def test_a_flow_the_overlay_removed_comes_off_where_its_store_counted_it():
    """A draft (or fork) that deletes a flow and moves one of its ends to another container took
    the flow off its rollups under the container it moved the end to, where its store never
    counted it: the store's cell stayed. It comes off where the store counts it."""
    async def cells(p):
        agg = await p.get_aggregated_edges_between(["A", "B", "C"], ["A", "B", "C"], None, CONT,
                                                   ["FLOWS"])
        return {(e.source_urn, e.target_urn): e.edge_count for e in agg.aggregated_edges}

    async def case(svc):
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws1", actor="alice"))["graph_id"]
        main = await svc.main_branch_id(gid)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                            ops=[_n("A"), _n("B"), _n("C"), _n("A.c"), _n("B.c"),
                                 _e("cA", "A", "A.c", "CONTAINS"), _e("cB", "B", "B.c", "CONTAINS"),
                                 _e("lin", "A.c", "B.c")])
        draft = await svc.open_draft(graph_id=gid, owner="alice")
        fork = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
        fgid, fmain = fork["graph_id"], fork["main_branch_id"]
        ops = [_d("lin", "edge"), _ue("cA", "C", "A.c", "CONTAINS")]
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="own", ops=ops,
                            containment_edge_types=CONT)
        await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=ops,
                            containment_edge_types=CONT)
        store = _reader(svc, gid, main)
        assert await cells(store) == {("A", "B"): 1}
        for p in (_overlay(svc, store, gid, draft),
                  _overlay(svc, store, fgid, fmain, fork=True)):
            assert await cells(p) == {}
    _run(case)


def test_a_forks_chains_find_a_node_it_inherited_whose_id_is_not_its_urn():
    """The rollups place a flow by its ends' chains on the overlay's own state. A fork composes
    its parent's rows, so a node it inherited has its version rows in the parent: one whose id
    is not its urn was found by urn only among the fork's own rows, and had no chain."""
    async def case(svc):
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws1", actor="alice"))["graph_id"]
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                            ops=[_n("T"), {"op": "create", "entity_kind": "node", "entity_id": "e_x",
                                           "payload": {"urn": "urn:x", "entityType": "Column",
                                                       "displayName": "x"}},
                                 _e("k", "T", "e_x", "CONTAINS")])
        main = await svc.main_branch_id(gid)
        fork = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
        assert await _reader(svc, gid, main).get_ancestor_chains(["urn:x"]) == {"urn:x": ["T"]}
        p = _overlay(svc, _reader(svc, gid, main), fork["graph_id"], fork["main_branch_id"], fork=True)
        assert await p.get_ancestor_chains(["urn:x"]) == {"urn:x": ["T"]}
    _run(case)

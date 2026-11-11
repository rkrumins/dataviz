"""``Snapshot.edges_between`` — the edges an import's window looks up by their ends — needs Postgres.

An edge row with no id is matched by its ends and type, so each window asks for the live edges from
its rows' sources to their targets. The lookup used to read every edge version leaving each source
and keep those to a wanted target, so a hub's millions of edges were read again by every window
that named it. Up to ``_BOTH_ENDS_MAX`` targets (any window's), both ends are now sought in SQL, and
only the wanted edges are read; past it (a view's every node, for a replace scoped to it), the
sources alone, as before. Both answer the same.
"""
import contextlib
import os

import pytest

from backend.app.services.versioning.import_export import snapshot as snapshots
from backend.tests.integration.test_fork_overlay_delta import _d, _run

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid}}


def _edge(eid, src, tgt, etype="FLOWS_TO"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _counting(monkeypatch) -> list:
    """The rows each statement returns, in order: ``edges_between``'s own by their ends, then the
    lookup of which of those are live."""
    read, opened = [], snapshots._session

    @contextlib.asynccontextmanager
    async def session():
        async with opened() as s:
            execute = s.execute

            async def counted(*args, **kwargs):
                result = await execute(*args, **kwargs)
                rows = result.all()
                read.append(len(rows))
                return type("R", (), {"all": staticmethod(lambda: rows)})()
            s.execute = counted
            yield s
    monkeypatch.setattr(snapshots, "_session", session)
    return read


def test_a_hubs_other_edges_are_never_read_and_both_ways_answer_alike(monkeypatch):
    async def case(svc):
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws1", actor="alice"))["graph_id"]
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[
            _node("hub"), _node("a"), *(_node(f"t{i}") for i in range(60)),
            *(_edge(f"e{i}", "hub", f"t{i}") for i in range(60)),
            _edge("ea", "a", "t0"), _edge("eb", "a", "t5", "CONTAINS"), _edge("gone", "a", "t7")])
        await svc.apply_ops(graph_id=gid, actor="alice", message="drop", ops=[_d("gone", kind="edge")])
        snap = await snapshots.open_snapshot(graph_id=gid)
        want = {**{("hub", f"t{i}", "FLOWS_TO"): f"e{i}" for i in (0, 3, 5, 7)},
                ("a", "t0", "FLOWS_TO"): "ea", ("a", "t5", "CONTAINS"): "eb"}

        read = _counting(monkeypatch)
        assert await snap.edges_between({"hub", "a"}, {"t3", "t0", "t5", "t7"}) == want
        assert read[0] == 7, read            # those six and the deleted one: never hub's 56 others

        monkeypatch.setattr(snapshots, "_BOTH_ENDS_MAX", 1)                     # a view's every node
        read.clear()
        assert await snap.edges_between({"hub", "a"}, {"t3", "t0", "t5", "t7"}) == want
        assert read[0] == 63, read                                              # every edge they leave
    _run(case)

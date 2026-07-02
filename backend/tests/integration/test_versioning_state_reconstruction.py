"""Equivalence + perf proof for the two-phase _state_as_of rewrite — needs Postgres.

The old implementation replayed EVERY version row of the branch (O(history) rows,
full payloads, into Python). The new one picks each entity's winning version via a
narrow DISTINCT ON, then fetches payloads for live winners only. This test:

  * builds a main-branch history with creates / updates / deletes / re-creates
    (multi-entity batches, nodes AND edges);
  * asserts the new ``_state_as_of`` equals the old replay (kept here verbatim as
    the reference oracle) at EVERY commit seq 0..head, on main and on a draft;
  * times both on the same history and prints the ratio (informational).

Run inside the dev backend container:
  PYTHONPATH=/app GRAPHVER_E2E=1 python backend/tests/integration/test_versioning_state_reconstruction.py
"""
import asyncio
import os
import time

try:
    import pytest
except ModuleNotFoundError:  # the dev container has no pytest — direct-run path still works
    class _PytestStub:
        class mark:
            @staticmethod
            def skipif(*_a, **_k):
                return lambda fn: fn
    pytest = _PytestStub()  # type: ignore

from sqlalchemy import select

from backend.app.services.versioning.models import (
    EdgeVersionORM, GraphORM, NodeVersionORM,
)
from backend.app.services.versioning.service import GraphVersioningService


async def _state_as_of_reference(svc, s, graph_id, branch_id, seq):
    """The OLD implementation, verbatim (minus fork recursion, not exercised here):
    full-history replay, last write wins."""
    state = {}
    for model in (NodeVersionORM, EdgeVersionORM):
        rows = (await s.execute(
            select(model).where(
                model.graph_id == graph_id, model.branch_id == branch_id,
                model.commit_seq <= seq,
            ).order_by(model.commit_seq, model.created_at)
        )).scalars().all()
        for r in rows:
            state[r.entity_id] = None if r.op == "delete" else r.payload
    return state


def _node(i, rev=0):
    urn = f"urn:li:dataset:sr_{i}"
    return {"op": "create" if rev == 0 else "update", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": "dataset", "displayName": f"n{i}r{rev}",
                        "properties": {"rev": rev, "pad": "x" * 64}}}


def _edge(i, j, rev=0):
    eid = f"e_sr_{i}_{j}"
    return {"op": "create" if rev == 0 else "update", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": f"urn:li:dataset:sr_{i}",
                        "targetEntityId": f"urn:li:dataset:sr_{j}", "properties": {"rev": rev}}}


def _del(eid, kind):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _run() -> None:
    svc = GraphVersioningService()
    sfx = os.urandom(3).hex()
    g = await svc.create_graph(data_source_id="ds_sr_" + sfx, workspace_id="ws_sr", actor="bot")
    gid = g["graph_id"]

    N = 60
    # History on MAIN: creates, then waves of updates, deletes, and a re-create.
    await svc.apply_ops(graph_id=gid, actor="bot",
                        ops=[_node(i) for i in range(N)] + [_edge(i, i + 1) for i in range(0, N - 1, 2)])
    for rev in (1, 2, 3):
        await svc.apply_ops(graph_id=gid, actor="bot",
                            ops=[_node(i, rev) for i in range(0, N, 2)])
    await svc.apply_ops(graph_id=gid, actor="bot",
                        ops=[_del(f"urn:li:dataset:sr_{i}", "node") for i in (3, 5, 7)]
                        + [_del("e_sr_0_1", "edge")])
    await svc.apply_ops(graph_id=gid, actor="bot", ops=[_node(3)])          # re-create a deleted node
    await svc.apply_ops(graph_id=gid, actor="bot",
                        ops=[_node(i, 4) for i in range(1, N, 3) if i not in (5, 7)])

    # A DRAFT with its own history (sparse overlay rows on the draft branch).
    d = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot",
                        ops=[_node(i, 9) for i in range(0, 10)])
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot",
                        ops=[_del("urn:li:dataset:sr_2", "node"), _node(N + 1)])

    async with svc._session() as s:
        graph = await s.get(GraphORM, gid)
        head = graph.main_head_commit_seq
        main_id = await svc._main_branch_id(s, gid)

        # Equivalence at EVERY seq on main (incl. 0 = genesis and head).
        for seq in range(0, head + 1):
            ref = await _state_as_of_reference(svc, s, gid, main_id, seq)
            new = await svc._state_as_of(s, gid, main_id, seq)
            assert new == ref, f"mismatch on main at seq={seq}: " \
                f"only_ref={set(ref) - set(new)} only_new={set(new) - set(ref)} " \
                f"diff={[k for k in ref if k in new and ref[k] != new[k]][:5]}"

        # Equivalence on the draft branch's own rows at every draft seq.
        for seq in (0, 1, 2, 10 ** 9):
            ref = await _state_as_of_reference(svc, s, gid, d, seq)
            new = await svc._state_as_of(s, gid, d, seq)
            assert new == ref, f"mismatch on draft at seq={seq}"

        # Sanity of the semantics themselves (not just parity).
        cur = await svc._state_as_of(s, gid, main_id, head)
        assert cur["urn:li:dataset:sr_3"] is not None, "re-created node must be live"
        assert cur["urn:li:dataset:sr_5"] is None, "deleted node must be an explicit tombstone"
        assert cur["e_sr_0_1"] is None, "deleted edge must be an explicit tombstone"
        assert cur["urn:li:dataset:sr_0"]["properties"]["rev"] == 3, "latest update must win"

        # Perf (informational): the new path should not be slower; the payoff grows with
        # history depth (here ~6 versions/entity — production drafts see far more).
        t0 = time.perf_counter()
        for _ in range(5):
            await _state_as_of_reference(svc, s, gid, main_id, head)
        t_ref = time.perf_counter() - t0
        t0 = time.perf_counter()
        for _ in range(5):
            await svc._state_as_of(s, gid, main_id, head)
        t_new = time.perf_counter() - t0
        print(f"STATE-RECONSTRUCTION OK  head={head}  ref={t_ref * 200:.1f}ms/call  "
              f"new={t_new * 200:.1f}ms/call  speedup=x{t_ref / max(t_new, 1e-9):.1f}")


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs Postgres (set GRAPHVER_E2E=1)")
def test_state_reconstruction_equivalence():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())

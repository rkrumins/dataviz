"""Incremental :AGGREGATED rollup maintenance in the versioning projector — needs
Postgres + FalkorDB.

Proves that committed lineage-edge changes reach the FalkorDB rollup layer WITHOUT a
full aggregation run: a created lineage edge materialises weight-1 AGGREGATED pairs over
the ancestor-pair product (self-inclusive chains, self-loops excluded — the aggregation
worker's exact semantics); a retried window doesn't double-count (gvSeq guard); deleting
the edge removes the rollups; a containment MOVE re-points them.

Run inside the dev backend container:
  PYTHONPATH=/app GRAPHVER_E2E=1 python backend/tests/integration/test_versioning_rollup_projection.py
"""
import asyncio
import os

try:
    import pytest
except ModuleNotFoundError:  # the dev container has no pytest — direct-run path still works
    class _PytestStub:
        class mark:
            @staticmethod
            def skipif(*_a, **_k):
                return lambda fn: fn
    pytest = _PytestStub()  # type: ignore

from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning import db as gvdb
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
from backend.app.services.versioning.service import GraphVersioningService

CONT, LIN = ["CONTAINS"], ["FLOWS_TO"]


async def _edge_types_stub(_svc, _graph_id):
    return (CONT, LIN)


def _node(urn, etype):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn.split(":")[-1]}}


def _edge(eid, src, tgt, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _del(eid):
    return {"op": "delete", "entity_kind": "edge", "entity_id": eid, "payload": None}


async def _rollups(client) -> dict:
    res = await client.query(
        "MATCH (a)-[r:AGGREGATED]->(b) RETURN a.urn, b.urn, r.weight, r.sourceEdgeTypes")
    return {(s, t): (int(w), sorted(types or [])) for s, t, w, types in (res.result_set or [])}


async def _run() -> None:
    svc = GraphVersioningService()
    sfx = os.urandom(3).hex()
    name = f"gvt_agg_{sfx}"                              # gvt_ prefix → session cleanup covers it
    gid = (await svc.create_graph(data_source_id="ds_agg_" + sfx, workspace_id="ws_agg",
                                  actor="bot", falkor_graph_name=name))["graph_id"]
    stale_calls: list = []

    async def _stale_stub(g):
        stale_calls.append(g)

    proj = FalkorProjector(make_falkor_graph_factory(), edge_types_resolver=_edge_types_stub,
                           on_rollups_stale=_stale_stub)
    client = make_falkor_graph_factory()(name)

    A, B, C = "urn:t:aggA_" + sfx, "urn:t:aggB_" + sfx, "urn:t:aggC_" + sfx
    Ac, Bc = A + ".c", B + ".c"
    try:
        # seed containers + columns on main, full-seed projection (no rollups yet)
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
            _node(A, "Table"), _node(B, "Table"), _node(Ac, "Column"), _node(Bc, "Column"),
            _edge("cA_" + sfx, A, Ac, "CONTAINS"), _edge("cB_" + sfx, B, Bc, "CONTAINS")])
        await proj.project_graph(gid)
        assert await _rollups(client) == {}, "full seed must not invent rollups"
        assert stale_calls == [gid], "a full seed wipes rollups → must queue a rebuild"
        stale_calls.clear()

        # (1) a committed lineage edge rolls up over the ancestor-pair product
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT,
                            ops=[_edge("lin_" + sfx, Ac, Bc, "FLOWS_TO")])
        await proj.project_graph(gid)
        got = await _rollups(client)
        expect = {(Ac, Bc), (Ac, B), (A, Bc), (A, B)}
        assert set(got) == expect, got
        assert all(v == (1, ["FLOWS_TO"]) for v in got.values()), got

        # (2) idempotency: re-projecting the SAME window can't double-count (gvSeq guard)
        async with gvdb.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            ps.projected_commit_seq -= 1                 # simulate a crash before the watermark advanced
        await proj.project_graph(gid)
        got = await _rollups(client)
        assert all(v[0] == 1 for v in got.values()), f"double-counted on retry: {got}"

        # (3) a containment MOVE re-points the rollups: B.c moves from B to new table C
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
            _node(C, "Table"), _del("cB_" + sfx), _edge("cC_" + sfx, C, Bc, "CONTAINS")])
        await proj.project_graph(gid)
        got = await _rollups(client)
        expect = {(Ac, Bc), (Ac, C), (A, Bc), (A, C)}
        assert set(got) == expect, got

        # (4) deleting the lineage edge removes every rollup it fed
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT,
                            ops=[_del("lin_" + sfx)])
        await proj.project_graph(gid)
        assert await _rollups(client) == {}, "rollups must decrement away with their raw edge"
        assert stale_calls == [], f"clean incremental paths must not queue rebuilds: {stale_calls}"

        # (5) MULTI-COMMIT window: create + property-update batched into ONE projection window.
        #     Op-label netting would see only the trailing 'update' and lose the +1; the
        #     before/after netting must still count the edge exactly once.
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT,
                            ops=[_edge("lin2_" + sfx, Ac, Bc, "FLOWS_TO")])
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
            {"op": "update", "entity_kind": "edge", "entity_id": "lin2_" + sfx,
             "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": Ac, "targetEntityId": Bc,
                         "properties": {"confidence_note": "edited"}}}])
        await proj.project_graph(gid)                    # one window spanning both commits
        got = await _rollups(client)
        assert set(got) == {(Ac, Bc), (Ac, C), (A, Bc), (A, C)}, got
        assert all(v[0] == 1 for v in got.values()), f"create+update window miscounted: {got}"

        # (6) delete + re-create (same id, same endpoints) across two commits, ONE window:
        #     the edge never stopped being live — weights must not move.
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT,
                            ops=[_del("lin2_" + sfx)])
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT,
                            ops=[_edge("lin2_" + sfx, Ac, Bc, "FLOWS_TO")])
        await proj.project_graph(gid)
        got = await _rollups(client)
        assert all(v[0] == 1 for v in got.values()), f"delete+recreate window drifted: {got}"
        assert stale_calls == [], stale_calls

        # (7) BULK window over the cap hands off to the rebuild hook instead of inline math.
        proj._MOVE_EDGE_CAP = 1                          # instance override for the test
        X1, X2 = A + ".x1", A + ".x2"
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=[
            _node(X1, "Column"), _node(X2, "Column"),
            _edge("bulk1_" + sfx, X1, Bc, "FLOWS_TO"), _edge("bulk2_" + sfx, X2, Bc, "FLOWS_TO")])
        await proj.project_graph(gid)
        assert stale_calls == [gid], f"over-cap window must queue exactly one rebuild: {stale_calls}"
        got = await _rollups(client)
        assert all(v[0] == 1 for v in got.values()), f"over-cap window must not half-apply: {got}"
        del proj._MOVE_EDGE_CAP                          # restore class default

        # (8) GROWN retry window overlapping prior applications (crash-retry where new commits
        #     landed, or a concurrent projector): the graph-level marker detects that part of
        #     the window was already applied → hand off to rebuild, never guess weights.
        async with gvdb.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            ps.projected_commit_seq = 2                  # rewind before EVERY applied rollup window
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT,
                            ops=[_del("bulk2_" + sfx)])  # grow the window past the marker
        stale_calls.clear()
        await proj.project_graph(gid)
        assert stale_calls == [gid], f"overlap must hand off to rebuild: {stale_calls}"
        got = await _rollups(client)
        assert all(v[0] == 1 for v in got.values()), f"overlap must not half-apply: {got}"

        print("ROLLUP-PROJECTION OK")
    finally:
        try:
            await client.delete()
        except Exception:
            pass
        async with gvdb.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            if ps is not None:
                ps.falkor_graph_name = None              # unpin → worker never re-projects it


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs Postgres+FalkorDB (set GRAPHVER_E2E=1)")
def test_rollup_projection():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())

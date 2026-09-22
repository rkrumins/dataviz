"""The read layer is only ever changed by differences — LIVE, on Postgres + a real FalkorDB.

Pins, end to end, what a versioned graph's FalkorDB projection must do:

1. Lineage between columns rolls up to their tables and domains; removing one column
   edge lowers the table-level weight and removes the cell only when no other column
   pair still links those tables.
2. Thousands of raw lineage edges in one commit are maintained inline, by delta.
3. The incident of 2026-09-22: FalkorDB loses a published write, the next publish's
   verify heals — IN PLACE. The graph is never dropped, so label ids, indexes and
   rollups survive; a reader that cached the label table before the heal still decodes
   a Domain as a Domain; the lost entity comes back and its rollups with it.
4. Stub rollups (weightless rows replayed from an old import) are not trusted: the
   rebuild hands the rollups to the aggregation batch job.
5. A rebuild of an up-to-date graph writes nothing.

Run inside the dev backend container:
  GRAPHVER_E2E=1 python -m pytest backend/tests/integration/test_projection_reconcile_live.py
"""
import asyncio
import os
import time

import pytest

from backend.app.services.versioning import db as gvdb
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
from backend.app.services.versioning.service import GraphVersioningService

CONT, LIN = ["CONTAINS"], ["TRANSFORMS"]


async def _edge_types(_svc, _graph_id):
    return (CONT, LIN)


def _node(urn, etype):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn.rsplit(":", 1)[-1]}}


def _edge(eid, src, tgt, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _del(eid):
    return {"op": "delete", "entity_kind": "edge", "entity_id": eid, "payload": None}


async def _rows(client, cypher, params=None):
    res = await client.query(cypher, params or {})
    return res.result_set or []


async def _rollups(client) -> dict:
    return {(s, t): int(w) for s, t, w in await _rows(
        client, "MATCH (a)-[r:AGGREGATED]->(b) RETURN a.urn, b.urn, r.weight")}


async def _run() -> None:
    svc = GraphVersioningService()
    sfx = os.urandom(3).hex()
    name = f"gvt_rec_{sfx}"                              # gvt_ prefix → session cleanup covers it
    gid = (await svc.create_graph(data_source_id="ds_rec_" + sfx, workspace_id="ws_rec",
                                  actor="bot", falkor_graph_name=name))["graph_id"]
    handoffs: list = []

    async def _on_stale(g):
        handoffs.append(g)

    factory = make_falkor_graph_factory()
    proj = FalkorProjector(factory, edge_types_resolver=_edge_types, on_rollups_stale=_on_stale)
    client = factory(name)
    if asyncio.iscoroutine(client):
        client = await client

    D1, D2 = f"urn:t:dom1_{sfx}", f"urn:t:dom2_{sfx}"
    TA, TB = f"urn:t:tabA_{sfx}", f"urn:t:tabB_{sfx}"
    a1, a2, b1, b2 = TA + ":c1", TA + ":c2", TB + ":c1", TB + ":c2"

    async def publish(ops):
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=ops)
        return await proj.project_graph(gid)

    try:
        # ── 1. column lineage rolls up; a delete lowers, the last one removes ──────────
        await publish([
            _node(D1, "domain"), _node(D2, "domain"), _node(TA, "table"), _node(TB, "table"),
            _node(a1, "column"), _node(a2, "column"), _node(b1, "column"), _node(b2, "column"),
            _edge("d1ta", D1, TA, "CONTAINS"), _edge("d2tb", D2, TB, "CONTAINS"),
            _edge("taa1", TA, a1, "CONTAINS"), _edge("taa2", TA, a2, "CONTAINS"),
            _edge("tbb1", TB, b1, "CONTAINS"), _edge("tbb2", TB, b2, "CONTAINS"),
        ])
        await publish([_edge("l1", a1, b1, "TRANSFORMS"), _edge("l2", a2, b2, "TRANSFORMS")])
        got = await _rollups(client)
        assert got[(TA, TB)] == 2 and got[(D1, D2)] == 2, got
        await publish([_del("l1")])
        got = await _rollups(client)
        assert got[(TA, TB)] == 1 and got[(D1, D2)] == 1, \
            f"a2→b2 still links the tables — the cells must stay at weight 1: {got}"
        await publish([_del("l2")])
        assert await _rollups(client) == {}, "the last column edge gone → the cells go"
        assert handoffs == [], handoffs

        # ── 2. 10,000 raw lineage edges in ONE commit, maintained inline ──────────────
        n = 100
        cols_a = [f"{TA}:x{i}" for i in range(n)]
        cols_b = [f"{TB}:y{i}" for i in range(n)]
        await publish([_node(c, "column") for c in cols_a + cols_b]
                      + [_edge(f"ca{i}", TA, c, "CONTAINS") for i, c in enumerate(cols_a)]
                      + [_edge(f"cb{i}", TB, c, "CONTAINS") for i, c in enumerate(cols_b)])
        bulk = [_edge(f"x{i}y{j}", cols_a[i], cols_b[j], "TRANSFORMS")
                for i in range(n) for j in range(n)]
        await svc.apply_ops(graph_id=gid, actor="bot", containment_edge_types=CONT, ops=bulk)
        t0 = time.monotonic()
        await proj.project_graph(gid)
        took = time.monotonic() - t0
        got = await _rollups(client)
        assert got[(TA, TB)] == n * n and got[(D1, D2)] == n * n, got
        assert handoffs == [], f"10,000 edges must stay inline: {handoffs}"
        print(f"10,000-edge window projected + rolled up in {took:.2f}s")
        await publish([_del(f"x{i}y{j}") for i in range(n) for j in range(n // 2)])
        got = await _rollups(client)
        assert got[(TA, TB)] == n * n // 2, got

        # ── 3. the incident: a published write lost from FalkorDB, healed in place ────
        lost = f"{TA}:lost"
        await publish([_node(lost, "column"), _edge("tal", TA, lost, "CONTAINS"),
                       _edge("lost_b1", lost, b1, "TRANSFORMS")])
        before = await _rollups(client)
        labels_before = [r[0] for r in await _rows(client, "CALL db.labels()")]
        await client.query("CREATE INDEX FOR (n:column) ON (n.displayName)")
        # A long-lived reader: its label table is filled now, before the heal.
        reader = factory(name)
        if asyncio.iscoroutine(reader):
            reader = await reader
        assert (await _rows(reader, "MATCH (n {urn: $u}) RETURN n", {"u": D1}))[0][0].labels == ["domain"]

        # FalkorDB loses that publish, consistently (an AOF rollback takes the rollups too).
        await client.query("MATCH (n:column {urn: $u}) DETACH DELETE n", {"u": lost})
        for (s_, t_), w in before.items():
            if (s_, t_) in ((TA, TB), (D1, D2)):
                await client.query(
                    "MATCH (a {urn: $s})-[r:AGGREGATED]->(b {urn: $t}) SET r.weight = $w",
                    {"s": s_, "t": t_, "w": w - 1})

        # The next, unrelated publish verifies, finds FalkorDB short, and heals.
        r = await publish([_node(f"urn:t:other_{sfx}", "domain")])
        assert r["verify_error"] is None, r
        assert await _rows(client, "MATCH (n:column {urn: $u}) RETURN count(n)", {"u": lost}) == [[1]]
        assert await _rollups(client) == before, "the heal must restore the rollups by delta"
        assert [r[0] for r in await _rows(client, "CALL db.labels()")][:len(labels_before)] \
            == labels_before, "label ids must never be renumbered"
        idx = await _rows(client, "CALL db.indexes() YIELD label, properties RETURN label, properties")
        assert ["column", ["displayName"]] in [[r[0], list(r[1])] for r in idx], idx
        dom = (await _rows(reader, "MATCH (n {urn: $u}) RETURN n", {"u": D1}))[0][0]
        assert dom.labels == ["domain"], f"a Domain must still decode as a Domain: {dom.labels}"
        assert handoffs == [], handoffs

        # ── 5. a rebuild of an up-to-date graph writes nothing ────────────────────────
        assert await svc.request_projection_rebuild(gid) is True
        r = await proj.project_graph(gid)
        assert r["applied"] == 0 and r["verify_error"] is None, r
        assert await _rollups(client) == before
        assert handoffs == []

        # ── 4. stub rollups are not trusted → the batch job takes the rollups ─────────
        await client.query(
            "MATCH (a {urn: $s}), (b {urn: $t}) CREATE (a)-[:AGGREGATED]->(b)",
            {"s": D2, "t": D1})                          # a stub: no weight, no aggKey
        assert await svc.request_projection_rebuild(gid) is True
        await client.query("MATCH (n:column {urn: $u}) DETACH DELETE n", {"u": b2})
        await proj.project_graph(gid)
        assert handoffs == [gid], f"untrusted rollups must go to the batch job: {handoffs}"
        assert await _rows(client, "MATCH (n:column {urn: $u}) RETURN count(n)", {"u": b2}) == [[1]]
        print("RECONCILE-LIVE OK")
    finally:
        try:
            await client.delete()
        except Exception:
            pass
        async with gvdb.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            if ps is not None:
                ps.falkor_graph_name = None              # unpin → the worker never re-projects it


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs Postgres+FalkorDB (set GRAPHVER_E2E=1)")
def test_projection_reconcile_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())

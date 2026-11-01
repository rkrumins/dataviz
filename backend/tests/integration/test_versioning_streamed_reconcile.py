"""A full reconcile of a graph too large to hold goes a page at a time, and lands what one pass
would — needs Postgres and a live FalkorDB.

A first seed, a rebuild and a heal reconcile FalkorDB against committed main. Past
``PROJECTION_RECONCILE_STREAMED_ABOVE`` live entities that compares the two a page of each at a time
(``_reconcile_streamed``) instead of holding both. Here twin keys drift the same way — a node and a
relationship lost, a stray node, a node with no urn, a node's content stale, a node held twice, a
relationship held twice, an extra relationship — while main moves on (a retype, a node added, one
deleted); one key is rebuilt in one pass, the other a page at a time, and both must end holding the
same nodes and relationships. On a key the platform does not own, nothing it holds is deleted,
either way.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
from backend.app.services.versioning.service import GraphVersioningService


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not (os.getenv("GRAPHVER_E2E") and _falkordb_available()),
    reason="set GRAPHVER_E2E=1 + live Postgres + a real FalkorDB (FALKORDB_HOST/PORT) to run")]


def _node(eid, etype="Dataset", op="create"):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:t:{eid}", "displayName": f"{eid} name", "entityType": etype}}


def _edge(eid, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": src, "targetEntityId": tgt}}


BASE = [_node(f"N{i}") for i in range(8)] + [_edge(f"E{i}", f"N{i}", f"N{i + 1}") for i in range(7)]
MOVED_ON = [_node("N4", "Table", op="update"), _node("Z"),
            {"op": "delete", "entity_kind": "node", "entity_id": "N7", "payload": None}]
DRIFT = [
    "MATCH (n:Dataset {urn: 'urn:t:N3'}) DETACH DELETE n",
    "CREATE (:Dataset {urn: 'urn:t:STRAY', entityId: 'STRAY'})",
    "CREATE (:Dataset {displayName: 'no urn'})",
    "MATCH (n:Dataset {urn: 'urn:t:N1'}) SET n.gvHash = 'stale', n.displayName = 'wrong'",
    "CREATE (:Dataset {urn: 'urn:t:N2', entityId: 'N2'})",
    "MATCH (a:Dataset {urn: 'urn:t:N5'}), (b:Dataset {urn: 'urn:t:N6'}) "
    "CREATE (a)-[:FLOWS_TO {id: 'E5'}]->(b)",
    "MATCH ()-[r:FLOWS_TO {id: 'E0'}]->() DELETE r",
    "MATCH (a:Dataset {urn: 'urn:t:N0'}), (b:Dataset {urn: 'urn:t:N6'}) "
    "CREATE (a)-[:FLOWS_TO {id: 'EX'}]->(b)",
]


async def _publish(svc, gid, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=ops)
    await svc.publish(graph_id=gid, branch_id=d, actor="u", message=msg)


async def _held(graph):
    nodes = (await graph.query(
        "MATCH (n) WHERE NOT n:_GVProjMeta AND NOT n:_GVRollupMeta RETURN labels(n), n.urn, "
        "n.entityId, n.displayName, n.gvHash")).result_set or []
    edges = (await graph.query(
        "MATCH (a)-[r]->(b) RETURN a.urn, type(r), b.urn, r.id, r.gvHash")).result_set or []
    return sorted(tuple(map(str, n)) for n in nodes), sorted(tuple(map(str, e)) for e in edges)


async def _rebuilt(svc, factory, *, streamed, owned):
    name = f"gvt_recon_{os.getpid()}_{os.urandom(3).hex()}"
    graph = await factory(name)
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u", falkor_graph_name=name))["graph_id"]
    proj = FalkorProjector(graph_client_factory=factory)
    try:
        await _publish(svc, gid, BASE, "baseline")
        assert not (await proj.project_graph(gid)).get("verify_error")
        await _publish(svc, gid, MOVED_ON, "moved on")
        for q in DRIFT:
            await graph.query(q)
        async with db.graphver_session() as s, s.begin():
            ps = await s.get(ProjectionStateORM, gid)
            ps.projected_commit_seq, ps.owns_falkor_graph = 0, owned
        saved = (config.PROJECTION_RECONCILE_STREAMED_ABOVE, config.PROJECTION_PAGE)
        if streamed:
            config.PROJECTION_RECONCILE_STREAMED_ABOVE, config.PROJECTION_PAGE = 0, 2
            proj._SCAN_PAGE = 3
        else:
            config.PROJECTION_RECONCILE_STREAMED_ABOVE = 10 ** 9
        try:
            out = await proj.project_graph(gid)
        finally:
            config.PROJECTION_RECONCILE_STREAMED_ABOVE, config.PROJECTION_PAGE = saved
        return out, await _held(graph)
    finally:
        try:
            await graph.delete()
        except Exception:
            pass


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    factory = make_falkor_graph_factory()

    one_out, one = await _rebuilt(svc, factory, streamed=False, owned=True)
    streamed_out, streamed = await _rebuilt(svc, factory, streamed=True, owned=True)
    assert streamed == one, (streamed, one)
    assert not one_out.get("verify_error") and not streamed_out.get("verify_error"), (
        one_out, streamed_out)
    nodes, edges = one
    urns = {n[1] for n in nodes}
    assert urns == {f"urn:t:N{i}" for i in range(7)} | {"urn:t:Z"}, urns    # N7 and strays gone
    assert any(n[1] == "urn:t:N4" and "Table" in n[0] for n in nodes), nodes  # relabelled
    assert sorted(e[3] for e in edges) == ["E0", "E1", "E2", "E3", "E4", "E5"], edges

    # A customer's key: what the log does not hold stays, either way.
    _, one = await _rebuilt(svc, factory, streamed=False, owned=False)
    _, streamed = await _rebuilt(svc, factory, streamed=True, owned=False)
    assert streamed == one, (streamed, one)
    assert "urn:t:STRAY" in {n[1] for n in one[0]}, one
    await db.dispose_engine()


def test_a_streamed_reconcile_lands_what_one_pass_would():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning streamed reconcile e2e: OK")

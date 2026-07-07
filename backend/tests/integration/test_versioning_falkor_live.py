"""LIVE FalkorDB validation of P1 (projection) + P2 (reads) — needs Postgres + a
real FalkorDB.

Everything else mocks the FalkorDB socket; this proves the real Cypher dialect
and the reader round-trip: the projector's writes land in a real graph with the
exact reader schema (urn-keyed, labelled by entityType, edgeType rels), the
neighbors read traverses it, deletes apply, and a rewound watermark re-converges.

Run:  docker run -d -p 6379:6379 falkordb/falkordb
      GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
      MANAGEMENT_DB_URL=postgresql+asyncpg://... \
      pytest backend/tests/integration/test_versioning_falkor_live.py
"""
import asyncio
import os

import pytest

from backend.app.api.v1.endpoints.versioning import _falkor_neighbors
from backend.app.services.versioning import db, models
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


async def _node_rows(graph):
    res = await graph.query("MATCH (n) RETURN n.urn, n.entityId, n.displayName, labels(n) ORDER BY n.urn")
    return res.result_set or []


async def _edge_rows(graph):
    res = await graph.query("MATCH (a)-[r]->(b) RETURN a.urn, type(r), b.urn, r.id ORDER BY a.urn")
    return res.result_set or []


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    factory = make_falkor_graph_factory()
    name = f"gv_live_{os.getpid()}_{os.urandom(3).hex()}"
    graph = factory(name)
    proj = FalkorProjector(graph_client_factory=factory)

    try:
        gid = (await svc.create_graph(
            data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
            actor="a", falkor_graph_name=name,
        ))["graph_id"]
        d = await svc.open_draft(graph_id=gid, owner="a")
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
            {"op": "create", "entity_kind": "node", "entity_id": "A",
             "payload": {"urn": "urn:test:A", "displayName": "Alpha", "entityType": "Dataset",
                         "properties": {"owner": "team-a", "meta": {"k": 1}}}},
            {"op": "create", "entity_kind": "node", "entity_id": "B",
             "payload": {"displayName": "Beta", "entityType": "Dataset"}},   # no urn → gv:B
            {"op": "create", "entity_kind": "edge", "entity_id": "E1",
             "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
        ])
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
        await svc.publish(graph_id=gid, branch_id=d, actor="a", message="seed")

        # ── P1: project to the REAL graph; verify reader-compatible schema ──
        await proj.project_graph(gid)
        nodes = await _node_rows(graph)
        by_urn = {r[0]: r for r in nodes}
        assert set(by_urn) == {"urn:test:A", "gv:B"}, by_urn          # real urn + synthesized fallback
        assert by_urn["urn:test:A"][1] == "A" and by_urn["urn:test:A"][2] == "Alpha"   # entityId + displayName
        assert "Dataset" in by_urn["urn:test:A"][3]                    # label = entityType
        assert by_urn["gv:B"][1] == "B"
        edges = await _edge_rows(graph)
        assert edges and edges[0][0] == "urn:test:A" and edges[0][1] == "FLOWS_TO" and edges[0][2] == "gv:B"
        assert edges[0][3] == "E1"                                     # edge id = entity_id

        # ── P2: neighbors read traverses the real graph ──
        nb = await _falkor_neighbors(graph, urn="urn:test:A", depth=1, direction="both", edge_types=None, limit=100)
        assert {n["urn"] for n in nb["nodes"]} == {"urn:test:A", "gv:B"}
        assert [e["id"] for e in nb["edges"]] == ["E1"]
        # native vs residual user props survived the round-trip
        a = next(n for n in nb["nodes"] if n["urn"] == "urn:test:A")
        assert a["properties"].get("owner") == "team-a" and a["properties"].get("meta") == {"k": 1}

        # ── incremental: update A, delete B + E1, reproject ──
        d2 = await svc.open_draft(graph_id=gid, owner="a")
        await svc.stage_changes(graph_id=gid, branch_id=d2, actor="a", ops=[
            {"op": "update", "entity_kind": "node", "entity_id": "A",
             "payload": {"urn": "urn:test:A", "displayName": "Alpha2", "entityType": "Dataset"}},
            {"op": "delete", "entity_kind": "edge", "entity_id": "E1", "payload": None},
            {"op": "delete", "entity_kind": "node", "entity_id": "B", "payload": None},
        ])
        await svc.checkpoint(graph_id=gid, branch_id=d2, actor="a")
        await svc.publish(graph_id=gid, branch_id=d2, actor="a", message="prune")
        await proj.project_graph(gid)
        nodes = {r[0]: r for r in await _node_rows(graph)}
        assert set(nodes) == {"urn:test:A"} and nodes["urn:test:A"][2] == "Alpha2"   # B gone, A updated
        assert await _edge_rows(graph) == []                            # E1 gone

        # ── crash recovery: rewind watermark, reproject → converges ──
        from backend.app.services.versioning.models import ProjectionStateORM
        async with db.graphver_session() as s:
            (await s.get(ProjectionStateORM, gid)).projected_commit_seq = 2
        await proj.project_graph(gid)
        nodes = {r[0]: r for r in await _node_rows(graph)}
        assert set(nodes) == {"urn:test:A"} and await _edge_rows(graph) == []   # idempotent, no dup/loss
    finally:
        try:
            await graph.delete()
        except Exception:
            pass
        await db.dispose_engine()


@pytest.mark.integration
@pytest.mark.skipif(
    not (os.getenv("GRAPHVER_E2E") and _falkordb_available()),
    reason="set GRAPHVER_E2E=1 + live Postgres + a real FalkorDB (FALKORDB_HOST/PORT) to run",
)
def test_versioning_falkor_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning LIVE FalkorDB projection + reads: OK")

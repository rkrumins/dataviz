"""A projection window too large to hold is written a page at a time, and lands what one pass would
— needs Postgres and a live FalkorDB.

A publish of millions is one window for the projector. Past ``PROJECTION_PAGED_ABOVE`` version rows
it is computed and written ``PROJECTION_PAGE`` rows at a time (``_apply_paged``): all its nodes,
then all its edges. Here the same window — creates, updates, a retype, a property dropped, deletes
with the edges on them, an edge re-pointed, an edge onto a node made in the same window — is
projected into twin keys, once in one pass and once in pages of two, and both keys must hold the
same nodes and edges, and both passes publish.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
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


def _node(eid, etype="Dataset", op="create", **props):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:t:{eid}", "displayName": f"{eid} name", "entityType": etype,
                        **({"properties": props} if props else {})}}


def _edge(eid, src, tgt, etype="FLOWS_TO", op="create", **props):
    return {"op": op, "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt,
                        **({"properties": props} if props else {})}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


BASE = ([_node(f"N{i}", owner=f"team{i}") for i in range(8)]
        + [_edge(f"E{i}", f"N{i}", f"N{i + 1}") for i in range(7)])
WINDOW = [
    _node("A"), _node("B", "Table"), _edge("EA", "A", "N1"), _edge("EB", "N2", "B"),
    _node("N0", op="update", owner="team0", tier="gold"),       # a property added
    _node("N1", op="update"),                                     # a property dropped
    _node("N2", "Table", op="update", owner="team2"),             # retyped
    _del("N4"), _del("E6", "edge"),                               # N4 takes E3 and E4 with it
    _edge("E0", "N0", "N7", op="update", weight=2),               # re-pointed
]


async def _publish(svc, gid, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=ops)
    await svc.publish(graph_id=gid, branch_id=d, actor="u", message=msg)


async def _held(graph):
    nodes = (await graph.query(
        "MATCH (n) WHERE NOT n:_GVProjMeta RETURN labels(n), n.urn, n.entityId, n.displayName, "
        "n.owner, n.tier, n.gvHash")).result_set or []
    edges = (await graph.query(
        "MATCH (a)-[r]->(b) RETURN a.urn, type(r), b.urn, r.id, r.gvHash")).result_set or []
    return sorted(tuple(map(str, n)) for n in nodes), sorted(tuple(map(str, e)) for e in edges)


async def _projected(svc, factory, *, paged):
    name = f"gvt_paged_{os.getpid()}_{os.urandom(3).hex()}"
    graph = await factory(name)
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u", falkor_graph_name=name))["graph_id"]
    proj = FalkorProjector(graph_client_factory=factory)
    try:
        await _publish(svc, gid, BASE, "baseline")
        await proj.project_graph(gid)
        await _publish(svc, gid, WINDOW, "window")
        saved = (config.PROJECTION_PAGED_ABOVE, config.PROJECTION_PAGE)
        config.PROJECTION_PAGED_ABOVE, config.PROJECTION_PAGE = (0, 2) if paged else (10 ** 9, 10 ** 9)
        try:
            out = await proj.project_graph(gid)
        finally:
            config.PROJECTION_PAGED_ABOVE, config.PROJECTION_PAGE = saved
        head = (await svc.get_graph(gid))["main_head_commit_seq"]
        assert out.get("projected") == head and not out.get("verify_error"), out
        return await _held(graph)
    finally:
        try:
            await graph.delete()
        except Exception:
            pass


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    factory = make_falkor_graph_factory()
    one = await _projected(svc, factory, paged=False)
    paged = await _projected(svc, factory, paged=True)
    assert paged == one, (paged, one)
    nodes, edges = one
    urns = {n[1] for n in nodes}
    assert "urn:t:N4" not in urns and {"urn:t:A", "urn:t:B"} <= urns, urns
    assert any(n[1] == "urn:t:N2" and "Table" in n[0] for n in nodes), nodes
    assert {e[3] for e in edges} == {"E0", "E1", "E2", "E5", "EA", "EB"}, edges
    await db.dispose_engine()


def test_a_paged_projection_lands_what_one_pass_would():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning paged projection e2e: OK")

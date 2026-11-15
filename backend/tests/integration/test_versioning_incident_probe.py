"""A few of a node's edges, through the index on one side, one LIMIT per node
(``GraphVersioningService._some_incident_edge_ids``) — needs Postgres.

A window's lineage summaries ask whether a node holds a live containment child. A container of
500,000 children answered that by reading every one of them, twice a window. Now it reads at most
a few of each node's edge rows, and reads the rest only when none of those is live. Pinned here:
- a node with more rows than the limit gets exactly the limit;
- one with fewer gets every edge it ever had: what the full read finds;
- an edge with several versions counts once a version, so a node cut off at the limit is known
  to be;
- only the asked side and types count, and a node with no edges is absent.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 with a live Postgres to run")]


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:p:{eid}", "displayName": eid, "entityType": "Dataset"}}


def _edge(eid, src, tgt, etype="CONTAINS", op="create", note=None):
    payload = {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}
    if note:
        payload["properties"] = {"note": note}
    return {"op": op, "entity_kind": "edge", "entity_id": eid, "payload": payload}


async def _publish(svc, gid, ops):
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=ops)
    await svc.publish(graph_id=gid, branch_id=d, actor="u", message="probe")


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u"))["graph_id"]
    kids = [f"k{i}" for i in range(5)]
    await _publish(svc, gid, [_node("box"), _node("small"), _node("lone"), *map(_node, kids),
                              *(_edge(f"c{i}", "box", k) for i, k in enumerate(kids)),
                              _edge("c_small", "small", "k0"),
                              _edge("f_box", "box", "k1", etype="FLOWS")])
    # A second version of one of small's edges: two rows, one edge.
    await _publish(svc, gid, [_edge("c_small", "small", "k0", op="update", note="again")])
    main = await svc.main_branch_id(gid)
    ask = {"box", "small", "lone", "k0"}
    async with db.graphver_session() as s:
        some = await svc._some_incident_edge_ids(s, gid, main, ask, side="source",
                                                 edge_types={"CONTAINS"}, per_node=3)
        assert len(some["box"]) == 3, some                       # five children: cut at three
        assert set(some["box"]) <= {f"c{i}" for i in range(5)}, some
        assert sorted(some["small"]) == ["c_small", "c_small"], some   # one edge, two versions
        assert "lone" not in some and "k0" not in some, some     # no edge out of either
        whole = await svc._some_incident_edge_ids(s, gid, main, ask, side="source",
                                                  edge_types={"CONTAINS"}, per_node=50)
        full = await svc._incident_edge_ids(s, gid, main, {"box"}, sides=("source",),
                                            edge_types={"CONTAINS"})
        assert set(whole["box"]) == full == {f"c{i}" for i in range(5)}, (whole, full)
        into = await svc._some_incident_edge_ids(s, gid, main, {"k1"}, side="target",
                                                 edge_types=None, per_node=50)
        assert set(into["k1"]) == {"c1", "f_box"}, into           # any type, into k1
    await db.dispose_engine()


def test_a_few_of_a_nodes_edges_one_limit_a_node():
    asyncio.run(_run())

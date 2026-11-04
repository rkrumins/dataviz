"""Every way a graph is seeded gives a node one identity — needs Postgres.

A node's id is its urn, the way a bootstrap names every node it copies: a bulk-ingest row that
brings a urn and no id is named by it, and one with neither is given a ``urn:uuid:`` that is its
urn too, so no node is left for the projection to name ``gv:<id>``. Two rows naming one node are
refused, not stored as two. A sync names a new node by its urn as well, and keeps the id of one
an earlier sync named ``sync:<urn>``.
"""
import asyncio
import os
import uuid

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ids import uuid_urn
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _node(**kw):
    return {"kind": "node", "entityType": "Dataset", **kw}


def _v7(eid):
    return uuid_urn(eid) == eid and uuid.UUID(eid[len("urn:uuid:"):]).version == 7


async def _graph(svc):
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="ext", falkor_graph_name="gvt_" + os.urandom(3).hex())
    return G["graph_id"], G["main_branch_id"]


async def _bulk(svc):
    gid, main = await _graph(svc)
    res = await svc.bulk_ingest(graph_id=gid, actor="ext", rows=[
        _node(urn="urn:li:dataset:orders", displayName="orders"),
        _node(id="n-2", displayName="by id"),
        _node(displayName="bare"),
        _node(urn="urn:li:dataset:orders", displayName="again"),          # a second "orders"
        {"kind": "edge", "edgeType": "FLOWS_TO", "source": "urn:li:dataset:orders",
         "target": "n-2"},
    ])
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert set(nodes) >= {"urn:li:dataset:orders", "n-2"} and len(nodes) == 3, nodes
    assert nodes["urn:li:dataset:orders"]["displayName"] == "orders"
    assert nodes["n-2"]["urn"] == "n-2"
    bare = next(e for e in nodes if e not in ("urn:li:dataset:orders", "n-2"))
    assert _v7(bare) and nodes[bare]["urn"] == bare
    assert res["rejected"] == [{"row": 3, "reason": "another node in this file is "
                                                     "'urn:li:dataset:orders'"}], res
    assert res["edges"] == 1


async def _sync(svc):
    gid, main = await _graph(svc)
    # A node an earlier sync named sync:<urn>, as syncs did before nodes were named by their urn.
    await svc.bulk_ingest(graph_id=gid, actor="ext", rows=[
        _node(entity_id="sync:urn:old", urn="urn:old", displayName="old")])
    await svc.sync_ingest(graph_id=gid, actor="ext", strategy="merge", rows=[
        _node(urn="urn:old", displayName="old, renamed"),
        _node(urn="urn:new", displayName="new"),
        _node(displayName="bare"),
    ])
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]
    assert nodes["sync:urn:old"]["displayName"] == "old, renamed"            # kept, not doubled
    assert nodes["urn:new"]["urn"] == "urn:new"
    bare = next(e for e in nodes if e not in ("sync:urn:old", "urn:new"))
    assert _v7(bare) and nodes[bare]["urn"] == bare
    assert len(nodes) == 3, nodes


def _e2e(coro_fn):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())


def test_a_bulk_ingest_names_each_node_by_its_urn():
    _e2e(_bulk)


def test_a_sync_names_a_new_node_by_its_urn_and_keeps_an_earlier_one():
    _e2e(_sync)

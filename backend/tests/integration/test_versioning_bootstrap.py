"""Seed the versioned base from the provider (journey Phase F) — needs Postgres.

A freshly-created versioned graph is empty; bootstrap snapshots the provider's full graph
into one import commit so the versioned store is the COMPLETE graph. The critical
consequence: a draft then composes the full base + the user's overlay (not a sparse base).
Re-running is idempotent.
"""
import asyncio
import os

import pytest

from backend.common.models.graph import EdgeQuery, GraphEdge, GraphNode, NodeQuery
from backend.app.providers.versioned_bootstrap import bootstrap_versioned_graph
from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


class _FakeProvider:
    """In-memory provider holding pre-existing data, with paged get_nodes/get_edges."""

    def __init__(self, nodes, edges):
        self._nodes, self._edges = nodes, edges

    @property
    def name(self) -> str:
        return "fake"

    async def get_nodes(self, query: NodeQuery):
        return self._nodes[query.offset: query.offset + (query.limit or 100)]

    async def get_edges(self, query: EdgeQuery):
        return self._edges[query.offset: query.offset + (query.limit or 100)]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    nodes = [GraphNode(urn=f"u:{x}", entityType="Dataset", displayName=x, properties={"k": x})
             for x in ("A", "B", "C")]
    edges = [GraphEdge(id="e1", sourceUrn="u:A", targetUrn="u:B", edgeType="FLOWS"),
             GraphEdge(id="e2", sourceUrn="u:B", targetUrn="u:C", edgeType="FLOWS")]
    prov = _FakeProvider(nodes, edges)

    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="sys")
    gid, main = G["graph_id"], G["main_branch_id"]

    # a fresh versioned graph is empty (the bug: drafts would compose onto this)
    assert (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"] == {}

    # bootstrap → the versioned base equals the provider's full graph (paged via batch=2)
    rep = await bootstrap_versioned_graph(svc, prov, gid, actor="sys", batch=2)
    assert rep["commit_id"]
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert set(st["nodes"]) == {"u:A", "u:B", "u:C"} and set(st["edges"]) == {"e1", "e2"}
    assert st["nodes"]["u:A"]["properties"]["k"] == "A"

    # THE fix: a draft now composes the FULL base + the overlay edit (not a sparse base)
    d = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "u:A",
         "payload": {"urn": "u:A", "entityType": "Dataset", "displayName": "A2", "properties": {"k": "A"}}}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    dst = await svc.materialize_state(graph_id=gid, branch_id=d)
    assert set(dst["nodes"]) == {"u:A", "u:B", "u:C"}          # full base visible in the draft
    assert dst["nodes"]["u:A"]["displayName"] == "A2"          # plus the overlay edit

    # re-bootstrap is idempotent (replays the first import, no second commit)
    assert (await bootstrap_versioned_graph(svc, prov, gid, actor="sys", batch=2)).get("idempotent_replay") is True

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_bootstrap_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning bootstrap-from-provider e2e: OK")

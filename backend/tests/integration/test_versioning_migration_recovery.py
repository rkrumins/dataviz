"""S5 migration recovery GATE — needs Postgres.

Proves the operational recovery for graphs ALREADY corrupted by the pre-contract flatteners:
``resync_from_provider`` re-imports from the live source through the now-fixed serialization
contract, restoring each edge's confidence + nested properties (iff the source still holds them).
``edge_payload_health`` flags the graph before and clears it after.

The corruption is injected directly into the durable ``edge_versions`` payload (the pre-fix code
that would have produced it is gone), faithfully: the payload is flattened AND its ``content_hash``
recomputed, so the 3-way sync sees a real difference and applies the source's canonical value.
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.providers.versioned_bootstrap import bootstrap_versioned_graph
from backend.app.services.versioning import db, models
from backend.app.services.versioning.merkle import content_hash
from backend.app.services.versioning.models import EdgeVersionORM, EntityHeadORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.graph import GraphEdge, GraphNode


class _FakeSource:
    """A provider whose get_nodes/get_edges return the in-memory SOURCE graph (still authoritative)."""

    def __init__(self, nodes, edges):
        self._nodes, self._edges = nodes, edges

    async def get_nodes(self, q):
        off, lim = (q.offset or 0), (q.limit or 10000)
        return self._nodes[off:off + lim]

    async def get_edges(self, q):
        off, lim = (q.offset or 0), (q.limit or 10000)
        return self._edges[off:off + lim]


def _graph():
    nodes = [GraphNode(urn="urn:a", entityType="Attribute", displayName="email"),
             GraphNode(urn="urn:b", entityType="Attribute", displayName="name")]
    edges = [GraphEdge(id="l1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="DERIVES_FROM",
                       confidence=0.9, properties={"sql": "select email", "cols": ["a", "b"]})]
    return nodes, edges


async def _flatten_durable_edges(graph_id: str, main_id: str) -> None:
    """Rewrite each live ``main`` edge's head payload into the pre-fix FLATTENED shape — user props
    spread at the top level, ``confidence`` dropped — recomputing ``content_hash`` on BOTH the
    version row AND the ``entity_heads`` cache (the sync path compares against the head cache), so the
    graph is byte-for-byte what a pre-contract bootstrap left behind."""
    async with db.graphver_session() as s:
        heads = (await s.execute(
            select(EntityHeadORM).where(
                EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                EntityHeadORM.entity_kind == "edge", EntityHeadORM.is_tombstone.is_(False),
            ))).scalars().all()
        for head in heads:
            ev = await s.get(EdgeVersionORM, (graph_id, head.head_version_id))  # composite PK
            payload = ev.payload
            flat = {"edgeType": payload["edgeType"], "sourceEntityId": payload["sourceEntityId"],
                    "targetEntityId": payload["targetEntityId"], **(payload.get("properties") or {})}
            new_hash = content_hash(flat)
            ev.payload = flat
            ev.confidence = None
            ev.content_hash = new_hash
            head.content_hash = new_hash            # the cache the sync path actually reads
        await s.commit()


async def _head_edge(svc, graph_id: str, eid: str) -> dict:
    mid = await svc.main_branch_id(graph_id)
    st = await svc.materialize_state(graph_id=graph_id, branch_id=mid)
    return st["edges"][eid]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    nodes, edges = _graph()
    name = "gvm_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    src = _FakeSource(nodes, edges)

    # Bootstrap → canonical (the fixed contract). Then CORRUPT to the legacy flattened shape.
    await bootstrap_versioned_graph(svc, src, gid, "alice")
    mid = await svc.main_branch_id(gid)
    await _flatten_durable_edges(gid, mid)

    # Health flags the corruption; the durable edge has LOST its confidence + properties.
    h = await svc.edge_payload_health(gid)
    assert h["scanned"] == 1 and h["flattened"] == 1, h
    assert h["samples"] and h["samples"][0]["entityId"] == "l1", h
    pre = await _head_edge(svc, gid, "l1")
    assert pre.get("confidence") is None and not pre.get("properties"), pre

    # RESYNC from the still-authoritative source → recover through the fixed contract.
    await svc.resync_from_provider(graph_id=gid, provider=src, actor="alice",
                                   strategy="external_wins")

    # Health clears; confidence + nested properties are restored to the canonical shape.
    h2 = await svc.edge_payload_health(gid)
    assert h2["flattened"] == 0, h2
    post = await _head_edge(svc, gid, "l1")
    assert post["confidence"] == 0.9, post
    assert post["properties"] == {"sql": "select email", "cols": ["a", "b"]}, post

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_migration_recovers_flattened_edges_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning migration recovery: OK")

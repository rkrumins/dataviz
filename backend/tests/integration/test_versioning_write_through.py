"""Provider write-through versioning (unification Phase 5) — needs Postgres.

The VersionedWriteProvider wraps any provider so every write also lands as an audited
commit on the data source's versioned graph (auto-resolved/created), attributed to the
acting user, while still delegating to the underlying provider. Edge endpoints are
backfilled so the versioned graph stays referentially whole; updates/deletes are versioned
too. Reads delegate unchanged.
"""
import asyncio
import os

import pytest

from backend.common.models.graph import GraphEdge, GraphNode
from backend.app.providers.versioned_write_provider import VersionedWriteProvider
from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


class _FakeProvider:
    """Minimal in-memory inner provider that records the calls it received."""

    def __init__(self):
        self.nodes, self.edges, self.calls = {}, {}, []

    @property
    def name(self) -> str:
        return "fake"

    async def get_node(self, urn):
        return self.nodes.get(urn)

    async def create_node(self, node, containment_edge=None):
        self.nodes[node.urn] = node
        self.calls.append(("create_node", node.urn))
        return True

    async def create_edge(self, edge):
        self.edges[edge.id] = edge
        self.calls.append(("create_edge", edge.id))
        return True

    async def update_edge(self, edge_id, properties):
        self.calls.append(("update_edge", edge_id))
        return self.edges.get(edge_id)

    async def delete_edge(self, edge_id):
        self.edges.pop(edge_id, None)
        self.calls.append(("delete_edge", edge_id))
        return True

    async def save_custom_graph(self, nodes, edges):
        self.calls.append(("save", len(nodes), len(edges)))
        return True


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()

    inner = _FakeProvider()
    A = GraphNode(urn="u:A", entityType="Dataset", displayName="A", properties={"owner": "t1"})
    B = GraphNode(urn="u:B", entityType="Dataset", displayName="B")
    inner.nodes["u:A"], inner.nodes["u:B"] = A, B          # the live provider already has the nodes
    prov = VersionedWriteProvider(inner, workspace_id="ws1", data_source_id=ds, actor="u_alice", svc=svc)

    # reads delegate transparently
    assert (await prov.get_node("u:A")).display_name == "A"
    assert prov.name == "fake"

    # ── create node: delegated AND recorded; the versioned graph is auto-created ──
    assert await prov.create_node(A) is True
    assert ("create_node", "u:A") in inner.calls
    gid = (await svc.get_graph_by_data_source(ds))["graph_id"]
    main = await svc.main_branch_id(gid)
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert st["nodes"]["u:A"]["properties"]["owner"] == "t1"

    # ── create edge: backfills the endpoint node + records the edge ──
    E = GraphEdge(id="e1", sourceUrn="u:A", targetUrn="u:B", edgeType="FLOWS_TO")
    assert await prov.create_edge(E) is True
    assert ("create_edge", "e1") in inner.calls
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert "u:B" in st["nodes"] and st["edges"]["e1"]["edgeType"] == "FLOWS_TO"

    # ── audit trail: attributed "edit" commits + per-entity history ──
    log = await svc.commit_log(graph_id=gid, limit=50)
    assert any(c["kind"] == "edit" and c["actor"] == "u_alice" for c in log)
    hist = await svc.entity_history(graph_id=gid, entity_id="u:A")
    assert hist and hist[0]["actor"] == "u_alice" and hist[0]["op"] == "create"

    # ── update + delete are versioned too ──
    await prov.update_edge("e1", {"weight": 5})
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert st["edges"]["e1"]["properties"]["weight"] == 5

    await prov.delete_edge("e1")
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert "e1" not in st["edges"] and ("delete_edge", "e1") in inner.calls

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_write_through_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning provider write-through e2e: OK")

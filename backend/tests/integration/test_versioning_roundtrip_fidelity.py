"""Round-trip fidelity GATE — needs Postgres.

Proves the operational guarantee the user asked for: a FalkorDB → Postgres → FalkorDB round-trip
preserves EVERY non-:AGGREGATED edge with FULL attributes (type, direction, endpoints, confidence,
properties) across a complex multi-level containment hierarchy PLUS multiple/lineage edges
(multi-target, multi-type, mixed confidence, scalar/list/nested properties).

The graph originates as what the source FalkorDB holds (a fake source provider). Bootstrap streams it
into Postgres (`collect_provider_rows` → `bulk_ingest` — two of the paths that used to FLATTEN edge
payloads and drop confidence). The projector reseeds committed main back into FalkorDB (a FakeGraph
that interprets the projector's cypher). G2 must equal G1. Against the pre-fix code, confidence would
be None and properties "{}" — this test is the load-bearing gate for the canonical serialization
contract (`entity_serde`).
"""
import asyncio
import json
import os

import pytest

from backend.app.providers.falkordb_provider import _sanitize_label, _split_user_properties
from backend.app.providers.versioned_bootstrap import bootstrap_versioned_graph
from backend.app.services.versioning import db, models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.graph import GraphEdge, GraphNode
from backend.tests.integration.test_versioning_projection import FakeFalkor


class _FakeSource:
    """A provider whose get_nodes/get_edges return the in-memory SOURCE graph (what FalkorDB holds)."""

    def __init__(self, nodes, edges):
        self._nodes, self._edges = nodes, edges

    async def get_nodes(self, q):
        off, lim = (q.offset or 0), (q.limit or 10000)
        return self._nodes[off:off + lim]

    async def get_edges(self, q):
        off, lim = (q.offset or 0), (q.limit or 10000)
        return self._edges[off:off + lim]


def _complex_graph():
    """Layer ⊃ Object ⊃ Group ⊃ Attribute spine + lineage stressing every dropped dimension."""
    nodes = [
        GraphNode(urn="urn:layer:1", entityType="Layer", displayName="Sales", properties={"owner": "team-a"}),
        GraphNode(urn="urn:obj:1", entityType="Object", displayName="Orders", properties={"rows": 100}),
        GraphNode(urn="urn:grp:1", entityType="Group", displayName="PII", properties={}),
        GraphNode(urn="urn:attr:1", entityType="Attribute", displayName="email", properties={"pii": True}),
        GraphNode(urn="urn:attr:2", entityType="Attribute", displayName="name", properties={"meta": {"x": 1}}),
        GraphNode(urn="urn:attr:3", entityType="Attribute", displayName="id", properties={"cols": ["a", "b"]}),
    ]
    edges = [
        # 4-level containment spine (+ branches) — the complex hierarchy
        GraphEdge(id="c1", sourceUrn="urn:layer:1", targetUrn="urn:obj:1", edgeType="CONTAINS"),
        GraphEdge(id="c2", sourceUrn="urn:obj:1", targetUrn="urn:grp:1", edgeType="CONTAINS"),
        GraphEdge(id="c3", sourceUrn="urn:grp:1", targetUrn="urn:attr:1", edgeType="CONTAINS"),
        GraphEdge(id="c4", sourceUrn="urn:grp:1", targetUrn="urn:attr:2", edgeType="CONTAINS"),
        GraphEdge(id="c5", sourceUrn="urn:obj:1", targetUrn="urn:attr:3", edgeType="CONTAINS"),
        # lineage: multi-target from attr:1, multi-type, mixed confidence, varied property shapes
        GraphEdge(id="l1", sourceUrn="urn:attr:1", targetUrn="urn:attr:2", edgeType="DERIVES_FROM",
                  confidence=0.9, properties={"sql": "select email"}),
        GraphEdge(id="l2", sourceUrn="urn:attr:1", targetUrn="urn:attr:3", edgeType="PRODUCES",
                  confidence=0.42, properties={"cols": ["email", "id"]}),
        GraphEdge(id="l3", sourceUrn="urn:attr:2", targetUrn="urn:attr:3", edgeType="DERIVES_FROM",
                  confidence=None, properties={"meta": {"job": "etl-7"}}),
    ]
    return nodes, edges


def _reconstruct_props(node_item: dict) -> dict:
    """Rebuild a node's user properties from how the projector stored them (native scalars +
    a JSON `propertiesRaw` residual) — mirrors the reader `_node_from_props`."""
    native = node_item.get("nativeProps") or {}
    raw = node_item.get("propertiesRaw")
    residual = json.loads(raw) if isinstance(raw, str) and raw else {}
    return {**native, **residual}


async def _run_roundtrip() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake_falkor = FakeFalkor()
    nodes, edges = _complex_graph()

    name = "gvt_" + os.urandom(3).hex()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    proj = FalkorProjector(graph_client_factory=fake_falkor, batch_size=50)

    # FalkorDB → Postgres (bootstrap import) …
    await bootstrap_versioned_graph(svc, _FakeSource(nodes, edges), gid, "alice")
    # … Postgres → FalkorDB (full-seed reseed).
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)

    g2 = fake_falkor.graphs[name]

    # ---- Edges: type, direction, endpoints, CONFIDENCE, PROPERTIES all round-trip ----
    assert set(g2.edges) == {e.id for e in edges}, (set(g2.edges), {e.id for e in edges})
    for e in edges:
        ge = g2.edges[e.id]
        assert ge["type"] == _sanitize_label(e.edge_type), (e.id, ge["type"], e.edge_type)
        assert ge["src"] == e.source_urn and ge["tgt"] == e.target_urn, e.id
        assert ge["conf"] == e.confidence, (e.id, "confidence", ge["conf"], e.confidence)  # THE fix
        assert json.loads(ge["props"] or "{}") == e.properties, (e.id, "properties", ge["props"])  # THE fix

    # ---- Nodes: label (entityType), displayName, and user properties round-trip ----
    by_urn = {n["urn"]: n for n in g2.nodes.values()}
    assert set(by_urn) == {n.urn for n in nodes}
    for n in nodes:
        gn = by_urn[n.urn]
        assert gn["_label"] == _sanitize_label(n.entity_type), (n.urn, gn["_label"])
        assert gn["displayName"] == n.display_name, n.urn
        assert _reconstruct_props(gn) == n.properties, (n.urn, "properties")

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_roundtrip_fidelity_e2e():
    asyncio.run(_run_roundtrip())


if __name__ == "__main__":
    asyncio.run(_run_roundtrip())
    print("versioning round-trip fidelity: OK")

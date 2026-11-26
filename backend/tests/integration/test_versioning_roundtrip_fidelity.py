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


def _recursive_graph():
    """A SELF-NESTING type — ``Folder ⊃ Folder ⊃ … N deep`` — the exact recursive shape the
    containment tree reconstructs edge-by-edge: every node shares ONE entity type (and therefore one
    ontology level), so depth lives ENTIRELY in the edges, not in any per-node attribute. Proves the
    rebuild handles arbitrary nesting depth of a self-referential type, plus a cross-depth lineage
    edge (same type, different depths) carrying confidence + properties so attribute fidelity is
    exercised inside the recursion too."""
    DEPTH = 6
    nodes = [GraphNode(urn=f"urn:folder:{i}", entityType="Folder", displayName=f"F{i}",
                       properties={"depth_hint": i}) for i in range(1, DEPTH + 1)]
    # a chain of CONTAINS edges of the SAME type, one per level of nesting
    edges = [GraphEdge(id=f"c{i}", sourceUrn=f"urn:folder:{i}", targetUrn=f"urn:folder:{i + 1}",
                       edgeType="CONTAINS") for i in range(1, DEPTH)]
    # lineage between the deepest node and a shallow one — both `Folder`, different depths
    edges.append(GraphEdge(id="l1", sourceUrn=f"urn:folder:{DEPTH}", targetUrn="urn:folder:2",
                           edgeType="DERIVES_FROM", confidence=0.55, properties={"note": "deep-ref"}))
    return nodes, edges


def _reconstruct_props(node_item: dict) -> dict:
    """Rebuild a node's user properties from how the projector stored them (native scalars +
    a JSON `propertiesRaw` residual) — mirrors the reader `_node_from_props`."""
    native = node_item.get("nativeProps") or {}
    raw = node_item.get("propertiesRaw")
    residual = json.loads(raw) if isinstance(raw, str) and raw else {}
    return {**native, **residual}


async def _assert_roundtrip(nodes, edges) -> None:
    """Bootstrap the SOURCE graph into Postgres, reseed it back into FalkorDB, and assert G2 ≡ G1 on
    every edge (type/direction/endpoints/confidence/properties) and node (label/displayName/props)."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake_falkor = FakeFalkor()

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
        # Natively within the name budget, the rest in the bag: the edge holds them all.
        held = {**(ge.get("native") or {}), **json.loads(ge["props"] or "{}")}
        assert held == e.properties, (e.id, "properties", ge)  # THE fix

    # ---- Nodes: label (entityType), displayName, and user properties round-trip ----
    by_urn = {n["urn"]: n for n in g2.nodes.values()}
    assert set(by_urn) == {n.urn for n in nodes}
    for n in nodes:
        gn = by_urn[n.urn]
        assert gn["_label"] == _sanitize_label(n.entity_type), (n.urn, gn["_label"])
        assert gn["displayName"] == n.display_name, n.urn
        assert _reconstruct_props(gn) == n.properties, (n.urn, "properties")

    await db.dispose_engine()


async def _run_roundtrip() -> None:
    nodes, edges = _complex_graph()
    await _assert_roundtrip(nodes, edges)


async def _run_recursive_roundtrip() -> None:
    nodes, edges = _recursive_graph()
    await _assert_roundtrip(nodes, edges)


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_roundtrip_fidelity_e2e():
    asyncio.run(_run_roundtrip())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_recursive_roundtrip_fidelity_e2e():
    asyncio.run(_run_recursive_roundtrip())


if __name__ == "__main__":
    asyncio.run(_run_roundtrip())
    asyncio.run(_run_recursive_roundtrip())
    print("versioning round-trip fidelity: OK")


# --------------------------------------------------------------------------------------------- #
# A customer's graph, end to end: enable → Postgres → a key rebuilt from history → what is      #
# served → an export → an import into a fresh graph. Every property of every edge survives.     #
# --------------------------------------------------------------------------------------------- #
#: Ten properties a customer's relationship holds ON itself, some a flat file can't hold as a cell.
_NATIVE = {"my prop": "val1", "MyProp": " x ", "MySpecialProp": "", "MyLogicalProp": True,
           "weight": 3, "listy": "[1,2]", "token": "\\N", "naïve ü": "ü", "dotted.key": "y",
           "tags list": ["a", "b"]}


async def _run_customer_graph_end_to_end() -> None:
    import shutil
    import tempfile

    from backend.app.providers.falkordb_provider import _edge_from_row
    from backend.app.services.storage.object_store import LocalFsObjectStore
    from backend.app.services.versioning.bootstrap_worker import bootstrap_status
    from backend.app.services.versioning.import_export.service import ImportExportService
    from backend.app.services.versioning.models import ProjectionStateORM
    from backend.tests.integration.test_bootstrap_job import FakeGraph, _drive, _edge, _enable, _node, _runner

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()

    # ---- enable version control on the customer's graph ----
    source = FakeGraph([_node("urn:s", owner="ana", **{"my prop": "n1"}), _node("urn:t")],
                       [_edge(0, 1, etype="FEEDS", id="r1", **_NATIVE)])
    res = await _enable(ds)
    gid = res["graph_id"]
    out = await _drive(_runner(source), res["job_id"])
    assert out["status"] == "completed", out
    assert all(c["ok"] for c in (await bootstrap_status(data_source_id=ds))["report"]["checks"])
    state = await svc.materialize_state(graph_id=gid, branch_id=await _main_of(gid))
    assert state["edges"]["r1"]["properties"] == _NATIVE, "Postgres holds all ten"
    assert state["nodes"]["urn:s"]["properties"] == {"owner": "ana", "my prop": "n1"}

    # ---- rebuild the graph's key from history (a rehydration), and read it as it is served ----
    fake_falkor = FakeFalkor()
    proj = FalkorProjector(graph_client_factory=fake_falkor, batch_size=50)
    assert await svc.request_projection_rebuild(gid) is True
    await proj.project_graph(gid)
    async with db.graphver_session() as s:
        name = (await s.get(ProjectionStateORM, gid)).falkor_graph_name
    ge = fake_falkor.graphs[name].edges["r1"]
    assert {**(ge.get("native") or {}), **json.loads(ge["props"])} == _NATIVE, \
        "the rebuilt key holds all ten"
    # Each that FalkorDB can store natively is on the relationship itself, where every search
    # operator reaches it; the rest stay in the bag.
    assert ge["native"] and set(ge["native"]) | set(json.loads(ge["props"])) == set(_NATIVE)
    served = _edge_from_row(ge["src"], ge["tgt"], ge["type"],
                            {**ge["native"], "id": "r1", "confidence": ge["conf"],
                             "properties": ge["props"], "gvHash": ge.get("gvHash")})
    assert served.properties == _NATIVE, "and serves all ten"

    # ---- export it, and import the file into a fresh graph: all ten again ----
    root = tempfile.mkdtemp(prefix="customer-rt-")
    try:
        ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root))
        for fmt in ("ndjson", "csv"):
            exp = await ie.create_export_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                             actor="u", export_format=fmt)
            await ie.run_export(exp["job_id"])
            B = await svc.create_graph(data_source_id="ds_B_" + os.urandom(4).hex(),
                                       workspace_id="ws1", actor="u")
            imp = await ie.create_import_job(workspace_id="ws1", data_source_id=B["graph_id"],
                                             graph_id=B["graph_id"], actor="u", import_format=fmt,
                                             source_uri=exp["result_uri"])
            summary = await ie.run_import(imp["job_id"])
            assert summary["new"] == 3 and summary["invalid"] == 0, (fmt, summary)
            draft = await svc.materialize_state(graph_id=B["graph_id"], branch_id=imp["branch_id"])
            (edge,) = draft["edges"].values()
            got = edge["properties"]
            if fmt == "csv":                       # a CSV cell is text: numbers and booleans too
                want = {**_NATIVE, "MyLogicalProp": "True", "weight": "3"}
            else:
                want = _NATIVE
            assert got == want, (fmt, got)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    await db.dispose_engine()


async def _main_of(graph_id: str) -> str:
    from sqlalchemy import select
    async with db.graphver_session() as s:
        return (await s.execute(select(models.BranchORM.id).where(
            models.BranchORM.graph_id == graph_id, models.BranchORM.kind == "main"))).scalars().one()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_customers_edge_keeps_every_property_through_enable_rebuild_export_and_import_e2e():
    asyncio.run(_run_customer_graph_end_to_end())

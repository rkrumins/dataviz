"""End-to-end proof that a layered-lineage model converted under a CUSTOM ontology
(roots_node: Layer→Roots, everything else→Node, containment HAS, lineage
FLOWS_TO — physical-uppercase) ingests, enforces, and nests through the whole
versioned stack + a live FalkorDB projection with no source alias needed.

Needs Postgres (GRAPHVER_E2E=1) and a real FalkorDB. Run:
  docker exec -w /app -e GRAPHVER_E2E=1 -e RUN_FALKOR_LIVE=1 synodic-dev-viz-service-1 \
    python -m pytest backend/tests/integration/test_layered_lineage_schema_ingest.py -q
or standalone: `python backend/tests/integration/test_layered_lineage_schema_ingest.py`.
"""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from backend.app.services.versioning import db, models
from backend.scripts.layered_lineage_schema import load_schema

_GATE = os.getenv("GRAPHVER_E2E") != "1"


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


def _node(eid, urn, etype):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "displayName": eid, "entityType": etype}}


def _edge(eid, edt, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": edt, "sourceEntityId": src, "targetEntityId": tgt}}


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.versioning.projection import make_falkor_graph_factory
    from backend.app.services.versioning.service import OntologyViolation
    from backend.tests.integration.layered_lineage_helper import (
        provision_ingested_graph, seed_workspace_provider,
    )

    schema = load_schema("roots_node")
    await models.create_schema_and_partitions()
    ids = await seed_workspace_provider()
    h = await provision_ingested_graph(
        schema=schema, workspace_id=ids["workspace"],
        provider_id=ids["provider"], seed=42, layers=3, orphans=2)
    svc = h.svc

    try:
        # ── 1) Durable copy uses the declared UPPERCASE edge types natively ───
        # roots_node declares HAS/FLOWS_TO, so the physical graph is uppercase-clean with
        # no canonicalization needed (nothing to rewrite).
        assert h.canonicalized == 0
        state = await svc.materialize_state(graph_id=h.graph_id, branch_id=h.main_branch_id)
        node_types = {p["entityType"] for p in state["nodes"].values()}
        edge_types = {p["edgeType"] for p in state["edges"].values()}
        assert node_types <= {"Roots", "Node"}, node_types
        assert edge_types == {"HAS", "FLOWS_TO"}, edge_types

        # ── 2) Strict enforcement (write-through gate) ────────────────────────
        rules = h.rules
        # unknown entity type → rejected
        with pytest.raises(OntologyViolation) as e_unknown:
            await svc.apply_ops(
                graph_id=h.graph_id, actor="t", ontology_rules=rules,
                containment_edge_types=["HAS"],
                ops=[_node("BadX", "urn:sol:test:badx", "Widget")])
        assert any(v["rule"] == "unknown_entity_type" for v in e_unknown.value.violations)

        # containment_not_allowed: Node.can_contain == [Node], so Node -HAS-> Roots is illegal
        with pytest.raises(OntologyViolation) as e_contain:
            await svc.apply_ops(
                graph_id=h.graph_id, actor="t", ontology_rules=rules,
                containment_edge_types=["HAS"],
                ops=[_node("N1", "urn:sol:test:n1", "Node"),
                     _node("R1", "urn:sol:test:r1", "Roots"),
                     _edge("EBad", "HAS", "N1", "R1")])
        assert any(v["rule"] == "containment_not_allowed" for v in e_contain.value.violations)

        # a case variant `has` at the boundary is normalized to the declared `HAS` (never a violation)
        commit_id = await svc.apply_ops(
            graph_id=h.graph_id, actor="t", ontology_rules=rules,
            containment_edge_types=["HAS"],
            ops=[_node("R2", "urn:sol:test:r2", "Roots"),
                 _node("N2", "urn:sol:test:n2", "Node"),
                 _edge("EOk", "has", "R2", "N2")])
        assert commit_id
        state2 = await svc.materialize_state(graph_id=h.graph_id, branch_id=h.main_branch_id)
        assert state2["edges"]["EOk"]["edgeType"] == "HAS"

        # ── 3) Nesting in the live FalkorDB projection ────────────────────────
        # Physical edges are uppercase HAS, which the containment set (uppercased internally
        # to {"HAS"}) matches DIRECTLY — no source alias needed. That is the whole point of
        # keeping the data we author physical-uppercase.
        prov = FalkorDBProvider(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")), graph_name=h.graph_name)
        await prov._ensure_connected()
        prov.set_containment_edge_types(["HAS"])

        top = await prov.get_top_level_or_orphan_nodes(root_entity_types=["Roots"], limit=500)
        assert top.root_type_count == 3               # 3 layers → 3 Roots
        assert top.orphan_count == 2                  # 2 generated orphan Nodes (no parent)
        assert {n.entity_type for n in top.nodes} <= {"Roots", "Node"}

        a_root = next(n for n in top.nodes if n.entity_type == "Roots")
        children = await prov.get_children(a_root.urn, edge_types=["HAS"])
        assert children, "a Roots node must contain children via HAS"
        print("test_layered_lineage_schema_ingest: OK")
    finally:
        try:
            await make_falkor_graph_factory()(h.graph_name).delete()
        except Exception:
            pass
        await db.dispose_engine()


@pytest.mark.integration
@pytest.mark.skipif(_GATE, reason="needs Postgres (GRAPHVER_E2E=1)")
def test_layered_lineage_roots_node_end_to_end():
    if not _falkordb_available():
        pytest.skip("needs a live FalkorDB")
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())

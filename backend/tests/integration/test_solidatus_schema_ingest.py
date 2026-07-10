"""End-to-end proof that a Solidatus model converted under a CUSTOM ontology
(roots_node: Layer→Roots, everything else→Node, containment Has, lineage
Flows_To, emitting lowercase ``has``) ingests, canonicalizes, enforces, and
nests through the whole versioned stack + a live FalkorDB projection.

Needs Postgres (GRAPHVER_E2E=1) and a real FalkorDB. Run:
  docker exec -w /app -e GRAPHVER_E2E=1 -e RUN_FALKOR_LIVE=1 synodic-dev-viz-service-1 \
    python -m pytest backend/tests/integration/test_solidatus_schema_ingest.py -q
or standalone: `python backend/tests/integration/test_solidatus_schema_ingest.py`.
"""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from backend.app.services.versioning import db, models
from backend.scripts.solidatus_schema import load_schema

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
    from backend.tests.integration.solidatus_helper import (
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
        # ── 1) Canonicalization: the durable copy uses DECLARED casing ────────
        # (the preset emitted lowercase `has`; canonicalize_rows rewrote it to `Has`).
        assert h.canonicalized > 0
        state = await svc.materialize_state(graph_id=h.graph_id, branch_id=h.main_branch_id)
        node_types = {p["entityType"] for p in state["nodes"].values()}
        edge_types = {p["edgeType"] for p in state["edges"].values()}
        assert node_types <= {"Roots", "Node"}, node_types
        assert edge_types == {"Has", "Flows_To"}, edge_types

        # ── 2) Strict enforcement (write-through gate) ────────────────────────
        rules = h.rules
        # unknown entity type → rejected
        with pytest.raises(OntologyViolation) as e_unknown:
            await svc.apply_ops(
                graph_id=h.graph_id, actor="t", ontology_rules=rules,
                containment_edge_types=["Has"],
                ops=[_node("BadX", "urn:sol:test:badx", "Widget")])
        assert any(v["rule"] == "unknown_entity_type" for v in e_unknown.value.violations)

        # containment_not_allowed: Node.can_contain == [Node], so Node -Has-> Roots is illegal
        with pytest.raises(OntologyViolation) as e_contain:
            await svc.apply_ops(
                graph_id=h.graph_id, actor="t", ontology_rules=rules,
                containment_edge_types=["Has"],
                ops=[_node("N1", "urn:sol:test:n1", "Node"),
                     _node("R1", "urn:sol:test:r1", "Roots"),
                     _edge("EBad", "Has", "N1", "R1")])
        assert any(v["rule"] == "containment_not_allowed" for v in e_contain.value.violations)

        # legal create spelled `has` succeeds and lands as declared `Has`
        commit_id = await svc.apply_ops(
            graph_id=h.graph_id, actor="t", ontology_rules=rules,
            containment_edge_types=["Has"],
            ops=[_node("R2", "urn:sol:test:r2", "Roots"),
                 _node("N2", "urn:sol:test:n2", "Node"),
                 _edge("EOk", "has", "R2", "N2")])
        assert commit_id
        state2 = await svc.materialize_state(graph_id=h.graph_id, branch_id=h.main_branch_id)
        assert state2["edges"]["EOk"]["edgeType"] == "Has"

        # ── 3) Nesting in the live FalkorDB projection ────────────────────────
        # Wire the provider exactly as ContextEngine._apply_source_alignment does: the
        # containment set is uppercased internally ({"HAS"}), so alignment translates it
        # back to the graph's observed casing (:Has). Governed here means observed ==
        # declared, but the declared `Has`/`Roots` still differ from their UPPER() form,
        # so alignment is what makes the case-sensitive Cypher patterns match.
        from backend.app.ontology.source_alignment import derive_alignment
        declared_rel = schema.containment + schema.lineage
        declared_ent = list(dict.fromkeys(schema.entity_map.values()))
        align = derive_alignment(
            declared_relationship_types=declared_rel, declared_entity_types=declared_ent,
            observed_relationship_types=declared_rel, observed_entity_types=declared_ent)

        prov = FalkorDBProvider(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")), graph_name=h.graph_name)
        await prov._ensure_connected()
        prov.set_containment_edge_types(schema.containment)
        prov.set_source_type_aliases(align.rel_alias_map(), align.entity_alias_map())

        top = await prov.get_top_level_or_orphan_nodes(root_entity_types=["Roots"], limit=500)
        assert top.root_type_count == 3               # 3 layers → 3 Roots
        assert top.orphan_count == 2                  # 2 generated orphan Nodes (no parent)
        assert {n.entity_type for n in top.nodes} <= {"Roots", "Node"}

        a_root = next(n for n in top.nodes if n.entity_type == "Roots")
        children = await prov.get_children(a_root.urn, edge_types=["Has"])
        assert children, "a Roots node must contain children via Has"
        print("test_solidatus_schema_ingest: OK")
    finally:
        try:
            await make_falkor_graph_factory()(h.graph_name).delete()
        except Exception:
            pass
        await db.dispose_engine()


@pytest.mark.integration
@pytest.mark.skipif(_GATE, reason="needs Postgres (GRAPHVER_E2E=1)")
def test_solidatus_roots_node_end_to_end():
    if not _falkordb_available():
        pytest.skip("needs a live FalkorDB")
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())

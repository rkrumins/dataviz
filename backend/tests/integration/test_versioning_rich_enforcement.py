"""Rich ontology enforcement at the commit boundary — needs Postgres.

The injected ``OntologyRules`` gate (edge source/target compatibility, containment
``can_contain``, unknown types) must hold on every durable write path: ``apply_ops``
(the /graph/changes batch save), ``stage_changes``→``checkpoint`` (the draft loop),
and ``publish`` (merge-time re-gate against CURRENT rules — an ontology tightened
after the draft opened still wins). ``ontology_rules=None`` and ``permissive``
graphs keep today's behavior exactly.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation

CONT = ["CONTAINS"]

RULES = OntologyRules(
    entity_types={
        "System": EntityRule(can_contain=frozenset({"Dataset"})),
        "Dataset": EntityRule(can_contain=frozenset({"Column"})),
        "Column": EntityRule(),
    },
    edge_types={
        "CONTAINS": EdgeRule(is_containment=True),
        "FLOWS_TO": EdgeRule(source_types=frozenset({"Dataset"}),
                             target_types=frozenset({"Dataset"})),
    },
    containment_edge_types=frozenset({"CONTAINS"}),
)

# The same vocabulary with FLOWS_TO locked to System→System — the "tightened after
# the draft opened" ontology for the publish re-gate case.
TIGHTENED = OntologyRules(
    entity_types=RULES.entity_types,
    edge_types={
        "CONTAINS": EdgeRule(is_containment=True),
        "FLOWS_TO": EdgeRule(source_types=frozenset({"System"}),
                             target_types=frozenset({"System"})),
    },
    containment_edge_types=frozenset({"CONTAINS"}),
)


def _n(eid, etype="Dataset"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": eid}}


def _e(eid, s, t, etype="FLOWS_TO"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _seed(svc, *, enforcement="strict"):
    G = await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u",
        ontology_enforcement=enforcement)
    gid = G["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT,
                        ontology_rules=RULES, ops=[
                            _n("sys", "System"), _n("A"), _n("B"), _n("A.c", "Column"),
                            _e("c1", "sys", "A", "CONTAINS"), _e("c2", "A", "A.c", "CONTAINS")])
    return gid


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    # ── apply_ops: bad edge endpoints / bad containment / unknown type all 422-shaped ──
    gid = await _seed(svc)
    with pytest.raises(OntologyViolation) as ex:
        await svc.apply_ops(graph_id=gid, actor="u", message="bad", containment_edge_types=CONT,
                            ontology_rules=RULES, ops=[_e("bad1", "A.c", "B")])   # Column→Dataset
    assert any(v["rule"] == "invalid_source" for v in ex.value.violations)
    with pytest.raises(OntologyViolation) as ex:
        await svc.apply_ops(graph_id=gid, actor="u", message="bad", containment_edge_types=CONT,
                            ontology_rules=RULES,
                            ops=[_n("A.c2", "Column"),                            # fresh node (no parent yet)
                                 _e("bad2", "sys", "A.c2", "CONTAINS")])          # System can't contain Column
    assert any(v.get("rule") == "containment_not_allowed" for v in ex.value.violations), ex.value.violations
    with pytest.raises(OntologyViolation) as ex:
        await svc.apply_ops(graph_id=gid, actor="u", message="bad", ontology_rules=RULES,
                            ops=[_n("w1", "Widget")])
    assert any(v["rule"] == "unknown_entity_type" for v in ex.value.violations)
    # Legal writes still land; and an update to a legal edge's properties passes.
    ok = await svc.apply_ops(graph_id=gid, actor="u", message="ok", containment_edge_types=CONT,
                             ontology_rules=RULES, ops=[_e("f1", "A", "B")])
    assert ok is not None

    # ── stage → checkpoint: the checkpoint gate is authoritative for staged edges ──
    draft = await svc.open_draft(graph_id=gid, owner="u")
    # Staging an edge whose endpoints exist only in the SAME staged batch is validated
    # eagerly from the batch's own node payloads.
    with pytest.raises(OntologyViolation):
        await svc.stage_changes(graph_id=gid, branch_id=draft, actor="u", ontology_rules=RULES,
                                ops=[_n("N1"), _n("N1.c", "Column"),
                                     _e("badstage", "N1.c", "N1")])               # Column→Dataset
    # A clean batch stages, then checkpoint re-gates (and passes) with composed state.
    await svc.stage_changes(graph_id=gid, branch_id=draft, actor="u", ontology_rules=RULES,
                            ops=[_n("N2", "Column"), _e("cn2", "A", "N2", "CONTAINS")])
    cid = await svc.checkpoint(graph_id=gid, branch_id=draft, actor="u",
                               containment_edge_types=CONT, ontology_rules=RULES)
    assert cid is not None

    # ── publish re-gate: rules tightened after the draft opened block the merge ──
    d2 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.stage_changes(graph_id=gid, branch_id=d2, actor="u", ontology_rules=RULES,
                            ops=[_n("C"), _e("f2", "B", "C")])                    # legal under RULES
    await svc.checkpoint(graph_id=gid, branch_id=d2, actor="u",
                         containment_edge_types=CONT, ontology_rules=RULES)
    with pytest.raises(OntologyViolation) as ex:
        await svc.publish(graph_id=gid, branch_id=d2, actor="u", message="publish",
                          containment_edge_types=CONT, ontology_rules=TIGHTENED)
    assert any(v["rule"] in ("invalid_source", "invalid_target") for v in ex.value.violations)
    # …and merges cleanly under the rules it was authored against.
    assert await svc.publish(graph_id=gid, branch_id=d2, actor="u", message="publish",
                             containment_edge_types=CONT, ontology_rules=RULES)

    # ── rules=None and permissive graphs: exactly today's behavior ──
    gid2 = await _seed(svc, enforcement="permissive")
    assert await svc.apply_ops(graph_id=gid2, actor="u", message="legacy", containment_edge_types=CONT,
                               ops=[_e("any", "A.c", "B")])                       # no rules → allowed
    assert await svc.apply_ops(graph_id=gid2, actor="u", message="permissive", containment_edge_types=CONT,
                               ontology_rules=RULES, ops=[_e("any2", "A.c", "sys")])  # permissive → allowed

    # ── write-through upsert of an existing legacy endpoint is NOT re-litigated ──
    gid3 = await _seed(svc)
    # Seed a legacy node under no rules (predates the ontology)…
    await svc.apply_ops(graph_id=gid3, actor="u", message="legacy seed",
                        ops=[_n("legacy", "GhostType")])
    # …then a rules-gated batch re-records it (endpoint upsert) alongside a legal edge.
    assert await svc.apply_ops(
        graph_id=gid3, actor="u", message="edge to legacy", containment_edge_types=CONT,
        ontology_rules=RULES,
        ops=[_n("legacy", "GhostType"),                    # idempotent endpoint re-create
             _e("t1", "A", "B")])

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_rich_enforcement_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("rich ontology enforcement (apply_ops / stage+checkpoint / publish re-gate) e2e: OK")

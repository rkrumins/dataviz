"""Every write path judges the state it WRITES against the ontology — not the ops that expressed it.

Canvas save (``apply_ops``), checkpoint and publish share one gate: a creation, a retype, and a
re-pointed or re-typed relationship all face the full ontology (declared types, allowed ends,
``can_contain``); retyping a node re-judges its existing relationships against its NEW type; an
edit that leaves the type-defining fields alone stays exempt so legacy data remains editable.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation

RULES = OntologyRules(
    entity_types={"domain": EntityRule(can_contain=frozenset({"dataset"})),
                  "dataset": EntityRule(), "column": EntityRule()},
    edge_types={"CONTAINS": EdgeRule(is_containment=True),
                "FLOWS_TO": EdgeRule(source_types=frozenset({"dataset"}),
                                     target_types=frozenset({"dataset"}))},
    containment_edge_types=frozenset({"CONTAINS"}),
)
CSET = ["CONTAINS"]


def _n(eid, et, op="create"):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": et, "displayName": eid}}


def _e(eid, src, tgt, et, op="create"):
    return {"op": op, "entity_kind": "edge", "entity_id": eid,
            "payload": {"sourceEntityId": src, "targetEntityId": tgt, "edgeType": et}}


def _upd(eid, kind="node", **payload):
    return {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]

    async def write(ops, **kw):
        return await svc.apply_ops(graph_id=gid, actor="alice", ops=ops,
                                   containment_edge_types=CSET, ontology_rules=RULES, **kw)

    async def refused(ops, rule=None, **kw):
        with pytest.raises(OntologyViolation) as exc:
            await write(ops, **kw)
        if rule:
            assert any(v.get("rule") == rule for v in exc.value.violations), exc.value.violations

    await write([_n("D", "domain"), _n("A", "dataset"), _n("B", "dataset"), _n("C", "column"),
                 _e("DA", "D", "A", "CONTAINS"), _e("AB", "A", "B", "FLOWS_TO")])

    # A retype to a type the ontology does not declare is refused (it used to pass as an "update").
    await refused([_upd("A", entityType="notAType")], "unknown_entity_type")
    # A retype that would break the node's EXISTING relationships is refused: a column may not
    # sit under a domain, nor be the source of a dataset flow.
    await refused([_upd("A", entityType="column")])
    # A relationship re-pointed onto a node its type does not allow is refused.
    await refused([_upd("AB", kind="edge", targetEntityId="C")], "invalid_target")
    # A re-pointed edge still faces hierarchy integrity: no second parent.
    await write([_n("D2", "domain")])
    await refused([_e("D2A", "D2", "A", "CONTAINS")])
    # Edits that keep type and ends are exempt — property / name changes always go through.
    await write([_upd("A", displayName="Orders"), _upd("AB", kind="edge", properties={"k": 1})])
    # A valid retype goes through with its relationships intact.
    await write([_n("E", "dataset"), _e("EB", "E", "B", "FLOWS_TO")])
    await write([_upd("B", entityType="dataset", displayName="Still a dataset")])

    # The staged path is judged by the same gate at checkpoint.
    d = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice",
                            ops=[_upd("A", entityType="column")])
    with pytest.raises(OntologyViolation):
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice",
                             containment_edge_types=CSET, ontology_rules=RULES)
    d2 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.stage_changes(graph_id=gid, branch_id=d2, actor="alice",
                            ops=[_e("DUP", "A", "B", "FLOWS_TO")])
    with pytest.raises(OntologyViolation):                # a duplicate relationship
        await svc.checkpoint(graph_id=gid, branch_id=d2, actor="alice",
                             containment_edge_types=CSET, ontology_rules=RULES)

    # Publish re-judges against CURRENT main and the CURRENT ontology: an edit saved while the
    # rules were not in force (here: saved without them) cannot reach main.
    p1 = await svc.open_draft(graph_id=gid, owner="alice")
    p2 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=p1, actor="alice",
                        ops=[_n("X", "dataset"), _e("DX", "D", "X", "CONTAINS")],
                        containment_edge_types=CSET, ontology_rules=RULES)
    await svc.publish(graph_id=gid, branch_id=p1, actor="alice", message="p1",
                      containment_edge_types=CSET, ontology_rules=RULES)
    await svc.apply_ops(graph_id=gid, branch_id=p2, actor="alice",
                        ops=[_upd("A", entityType="column")], containment_edge_types=CSET)
    await svc.rebase_draft(graph_id=gid, branch_id=p2, actor="alice")
    with pytest.raises(OntologyViolation):                # p2's retype breaks main's D→A, A→B
        await svc.publish(graph_id=gid, branch_id=p2, actor="alice", message="p2",
                          containment_edge_types=CSET, ontology_rules=RULES)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_every_write_path_judges_the_written_state():
    asyncio.run(_run())

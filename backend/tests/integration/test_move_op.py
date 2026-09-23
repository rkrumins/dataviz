"""A move is one server-resolved instruction: the node ends up with exactly the parent asked for,
whatever containment it had — the client need not have loaded (or even know) the old link.

Reported 2026-09-23: moving a node on the canvas left it under BOTH parents when the canvas had
not loaded its old parent link (only a loaded link was deleted), and the node showed twice.
"""
import asyncio
import dataclasses
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation

CSET = ["HAS"]
RULES = OntologyRules(
    entity_types={"Roots": EntityRule(can_contain=frozenset({"Node"})),
                  "Node": EntityRule(can_contain=frozenset({"Node"}))},
    edge_types={"HAS": EdgeRule(is_containment=True)},
    containment_edge_types=frozenset({"HAS"}),
    root_entity_types=frozenset({"Roots"}),        # only Roots may be at the top level
)


def _n(eid, et="Node"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": et, "displayName": eid}}


def _has(eid, parent, child):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"sourceEntityId": parent, "targetEntityId": child, "edgeType": "HAS"}}


def _move(child, parent, edge_id):
    return {"op": "move", "entity_kind": "node", "entity_id": child,
            "payload": {"parentEntityId": parent, "edgeType": "HAS", "edgeId": edge_id}}


async def _parents(svc, gid, bid, child):
    st = await svc.materialize_state(graph_id=gid, branch_id=bid)
    return sorted(v["sourceEntityId"] for v in st["edges"].values()
                  if v and v.get("edgeType") == "HAS" and v.get("targetEntityId") == child)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)
    kw = dict(containment_edge_types=CSET, ontology_rules=RULES)
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[
        _n("R1", "Roots"), _n("R2", "Roots"), _n("X"), _n("Y"), _has("h1", "R1", "X"),
        _has("h2", "X", "Y")], **kw)

    d = await svc.open_draft(graph_id=gid, owner="alice")
    # The old link (h1) is on MAIN — never loaded by a "client" — and still goes.
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_move("X", "R2", "m1")], **kw)
    assert await _parents(svc, gid, d, "X") == ["R2"]
    assert await _parents(svc, gid, d, "Y") == ["X"]            # its subtree moves with it
    assert await _parents(svc, gid, main, "X") == ["R1"]        # main untouched until publish

    # To the top level: no parent at all (under an ontology that allows any type there — the
    # restriction to its top-level types is tested below).
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_move("X", None, "m2")],
                        containment_edge_types=CSET, ontology_rules=dataclasses.replace(RULES, root_entity_types=frozenset()))
    assert await _parents(svc, gid, d, "X") == []

    # Created and moved in the same save: one parent, the last one asked for.
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[
        _n("Z"), _has("hz", "R1", "Z"), _move("Z", "R2", "m3")], **kw)
    assert await _parents(svc, gid, d, "Z") == ["R2"]

    # Into its own subtree: refused (a loop), nothing written.
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_move("X", "R1", "m4")], **kw)
    with pytest.raises(OntologyViolation):
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_move("X", "Y", "m5")], **kw)
    assert await _parents(svc, gid, d, "X") == ["R1"]

    # Under a parent the ontology forbids (a Node cannot contain a Roots): refused.
    with pytest.raises(OntologyViolation):
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_move("R2", "X", "m6")], **kw)

    # The ontology's top-level types: a Node can't be left without a parent — not by a move to
    # the top level, not by un-nesting it, not by creating it there. A Roots can.
    with pytest.raises(OntologyViolation) as exc:
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_move("X", None, "m7")], **kw)
    assert exc.value.violations[0]["rule"] == "parent_required"
    link = next(eid for eid, v in (await svc.materialize_state(graph_id=gid, branch_id=d))["edges"].items()
                if v and v["targetEntityId"] == "X")
    with pytest.raises(OntologyViolation):
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice",
                            ops=[{"op": "delete", "entity_kind": "edge", "entity_id": link, "payload": None}], **kw)
    with pytest.raises(OntologyViolation):
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_n("LONE")], **kw)
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=[_n("R3", "Roots")], **kw)  # allowed
    assert await _parents(svc, gid, d, "X") == ["R1"]           # nothing refused above was written

    # Published, main holds exactly the moved hierarchy.
    await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="moves", **kw)
    assert await _parents(svc, gid, main, "X") == ["R1"]
    assert await _parents(svc, gid, main, "Z") == ["R2"]
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_move_replaces_whatever_containment_the_node_has():
    asyncio.run(_run())

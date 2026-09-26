"""One save = one batch of ops; several ops on ONE entity compose — they never replace each other.

Reported 2026-09-23: a node created on the canvas and renamed before Save was stored as
``{"displayName": ...}`` alone — no entityType, no urn, no parent — because the batch kept one
value per entity and the rename's partial payload replaced the create's. The ontology gate saw
the entity as an "update" (exempt) and let it through, and the untyped node then failed every
read of the draft ("Internal server error", the canvas stuck "refreshing").

So: ops compose in order; what is WRITTEN is what the ontology gate judges, as a create when the
entity does not exist yet; and an untyped node is never written at all.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.providers.draft_overlay_provider import _OverlayDelta
from backend.app.services.versioning.service import (
    GraphVersioningService, OntologyViolation, _graphnode_dict,
)


def _node(eid, **payload):
    return {"op": "create", "entity_kind": "node", "entity_id": eid, "payload": payload}


def _update(eid, **payload):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": payload}


async def _staged_rename_keeps_the_node(svc, gid, shared: bool) -> None:
    """The staged path (stage → checkpoint) folds the same way as one ``apply_ops`` batch."""
    d = await svc.open_draft(graph_id=gid, owner="alice", shared=shared)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[
        _node("S", urn="S", entityType="domain", displayName="Staged", properties={"k": 1})])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice",
                            ops=[_update("S", displayName="Staged Renamed")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    s = (await svc.materialize_state(graph_id=gid, branch_id=d))["nodes"]["S"]
    assert (s["entityType"], s["urn"], s["displayName"], s["properties"]) == \
        ("domain", "S", "Staged Renamed", {"k": 1}), (shared, s)

    # A staged "update" of nothing is judged at checkpoint as the creation it is.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice",
                            ops=[_update("GHOST2", displayName="x")])
    with pytest.raises(OntologyViolation):
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")


async def _state(svc, gid):
    main = await svc.main_branch_id(gid)
    return (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]

    # A create and a rename of the same new node, in one save.
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[
        _node("N", urn="N", entityType="domain", displayName="New Domain", properties={"owner": "a"}),
        _update("N", displayName="New Domain Yada"),
    ])
    n = (await _state(svc, gid))["N"]
    assert n["entityType"] == "domain" and n["urn"] == "N", n
    assert n["displayName"] == "New Domain Yada" and n["properties"] == {"owner": "a"}, n

    # Two edits of an existing node in one save compose too.
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[
        _update("N", displayName="Renamed"), _update("N", description="Described"),
    ])
    n = (await _state(svc, gid))["N"]
    assert (n["displayName"], n["description"], n["entityType"]) == ("Renamed", "Described", "domain"), n

    # An "update" of a node that does not exist creates it — so it is judged as a create:
    # with no type it is refused, and nothing is written.
    with pytest.raises(OntologyViolation) as exc:
        await svc.apply_ops(graph_id=gid, actor="alice", ops=[_update("GHOST", displayName="x")])
    assert "GHOST" not in await _state(svc, gid)
    # …and says so plainly: an edit of something that isn't here, named — not "needs a type".
    v = exc.value.violations[0]
    assert (v["rule"], v["entity_id"], v["name"]) == ("entity_not_found", "GHOST", "x"), v
    assert "isn't on this draft" in v["reason"], v

    # A create with no type is refused outright.
    with pytest.raises(OntologyViolation) as exc:
        await svc.apply_ops(graph_id=gid, actor="alice", ops=[_node("T", urn="T", displayName="t")])
    assert exc.value.violations[0]["rule"] == "missing_entity_type"
    assert exc.value.violations[0]["reason"] == "'t' has no entity type. Choose a type from the ontology."

    await _staged_rename_keeps_the_node(svc, gid, shared=False)
    await _staged_rename_keeps_the_node(svc, gid, shared=True)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_ops_on_one_entity_compose_and_untyped_nodes_are_refused():
    asyncio.run(_run())


def test_a_stored_untyped_node_still_reads():
    """Rows written before the rule (the reported draft holds one) read as "unknown" — visible and
    retypeable — instead of failing every read of the draft."""
    delta = _OverlayDelta({"nodesUpsert": [_graphnode_dict("e1", "u1", {"displayName": "Yada"})]}, [])
    assert delta.node_upsert["u1"].entity_type == "unknown"

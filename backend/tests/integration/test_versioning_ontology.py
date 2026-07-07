"""Ontology validation (P6) — needs Postgres.

Opt-in per graph: with an ontology_spec, strict enforcement rejects out-of-vocab
entity/edge types at stage time and at the publish (PR) gate; permissive allows
them; a graph with no spec is unconstrained.
"""
import asyncio
import os

import pytest
from sqlalchemy import text

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import GraphORM
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation

SPEC = {"entityTypes": ["Dataset", "Table"], "edgeTypes": ["CONTAINS", "PRODUCES"]}


def _n(name, et):
    return {"displayName": name, "entityType": et}


def _e(src, tgt, et):
    return {"edgeType": et, "sourceEntityId": src, "targetEntityId": tgt}


async def _run() -> None:
    await models.create_schema_and_partitions()
    async with db.graphver_session() as s:
        await s.execute(text('ALTER TABLE graphver.graphs ADD COLUMN IF NOT EXISTS ontology_spec jsonb'))
    svc = GraphVersioningService()

    # ── strict graph: valid ops stage + publish; invalid ops rejected ────
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="a", ontology_spec=SPEC, ontology_enforcement="strict"))["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="a")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _n("A", "Dataset")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _n("B", "Table")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E", "payload": _e("A", "B", "CONTAINS")},
    ])
    with pytest.raises(OntologyViolation):
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
            {"op": "create", "entity_kind": "node", "entity_id": "X", "payload": _n("X", "Foo")}])
    with pytest.raises(OntologyViolation):
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="a", ops=[
            {"op": "create", "entity_kind": "edge", "entity_id": "Y", "payload": _e("A", "B", "RELATES")}])
    # the valid ops survived (the rejected stages rolled back); publish passes the gate
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="a")
    await svc.publish(graph_id=gid, branch_id=d, actor="a", message="ok")
    assert set((await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid)))["nodes"]) == {"A", "B"}

    # ── no spec → unconstrained ──────────────────────────────────────────
    g2 = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a"))["graph_id"]
    d2 = await svc.open_draft(graph_id=g2, owner="a")
    await svc.stage_changes(graph_id=g2, branch_id=d2, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "Z", "payload": _n("Z", "Anything")},
    ])   # no raise

    # ── permissive: invalid allowed at stage; the publish gate (strict) rejects ─
    g3 = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                 actor="a", ontology_spec=SPEC, ontology_enforcement="permissive"))["graph_id"]
    d3 = await svc.open_draft(graph_id=g3, owner="a")
    await svc.stage_changes(graph_id=g3, branch_id=d3, actor="a", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N", "payload": _n("N", "Bad")},
    ])   # permissive → allowed
    await svc.checkpoint(graph_id=g3, branch_id=d3, actor="a")
    async with db.graphver_session() as s:                       # flip to strict → gate engages
        (await s.get(GraphORM, g3)).ontology_enforcement = "strict"
    with pytest.raises(OntologyViolation):
        await svc.publish(graph_id=g3, branch_id=d3, actor="a", message="should fail gate")

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_ontology_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning ontology validation e2e: OK")

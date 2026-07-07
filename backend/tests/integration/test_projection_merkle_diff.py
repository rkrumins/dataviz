"""Projection content-drift guard — the Merkle diff is the authoritative change set.

The incremental FalkorDB projection can rarely MISS a merge's field-level update (a property change
leaves the node COUNT unchanged, so the count-based verify/heal is blind to it). The strategic fix
unions the raw commit-row scan with ``MerkleStore.diff`` — which is authoritative (the tree hash
changes on ANY content change) and O(diff). This test proves the primitive the fix rests on: a
property-only change between two main commits shows up in the Merkle diff.
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM, GraphORM
from backend.app.services.versioning.service import GraphVersioningService


def _create(eid, urn, qname, dn):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": "Table", "displayName": dn, "qualifiedName": qname}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]

    # main commit 1: node A with NO user property
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_create("ent_A", "urn:A", "a", "A")])
    async with db.graphver_session() as s:
        main_id = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "main"))).scalar_one()
        seq_a = (await s.get(GraphORM, gid)).main_head_commit_seq

    # main commit 2: add a property to A (a FIELD-LEVEL change — node count is unchanged)
    await svc.apply_ops(graph_id=gid, actor="u", message="add prop",
                        ops=[{"op": "update", "entity_kind": "node", "entity_id": "ent_A",
                              "payload": {"properties": {"PII": "No", "Test Stuff": "B"}}}])
    async with db.graphver_session() as s:
        seq_b = (await s.get(GraphORM, gid)).main_head_commit_seq
        # THE PRIMITIVE: the authoritative Merkle diff between the two main commits must flag ent_A,
        # even though only a property changed (count-based heal would miss this).
        diff = await svc._merkle.diff(s, gid, main_id, seq_a, seq_b)

    assert seq_b > seq_a, (seq_a, seq_b)
    assert "ent_A" in diff, diff                                  # <-- the drift the old path could miss
    old_h, new_h = diff["ent_A"]
    assert new_h is not None and old_h != new_h, diff            # changed, not deleted
    # and NOTHING else changed → O(diff) is truly bounded to the one entity
    assert set(diff) == {"ent_A"}, diff

    # ---- the AUGMENTATION recovers a missed entity ----
    # Simulate the raw commit-row scan returning NOTHING for this window (last = {}), the exact
    # failure mode behind the bug, and verify the Merkle-diff augmentation recovers ent_A's upsert
    # WITH its properties — i.e. the projection would repair the content drift on its own.
    from backend.app.services.versioning.projection import FalkorProjector
    proj = FalkorProjector(graph_client_factory=lambda *a, **k: None, session_factory=db.graphver_session)
    node_upserts, edge_upserts, urn_of = [], [], {}
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, gid)
        await proj._merkle_augment_upserts(
            s, graph, main_id, seq_a, seq_b, last={}, urn_of=urn_of,
            node_upserts=node_upserts, edge_upserts=edge_upserts)
    recovered = {eid: p for eid, _urn, p in node_upserts}
    assert "ent_A" in recovered, node_upserts
    assert recovered["ent_A"].get("properties") == {"PII": "No", "Test Stuff": "B"}, recovered["ent_A"]

    # And when the scan ALREADY covered the entity, the augmentation is a no-op (union, never dupes).
    node_upserts2 = []
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, gid)
        await proj._merkle_augment_upserts(
            s, graph, main_id, seq_a, seq_b, last={("node", "ent_A"): ("node", "update", None)},
            urn_of={}, node_upserts=node_upserts2, edge_upserts=[])
    assert node_upserts2 == [], node_upserts2

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_projection_merkle_diff():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("projection merkle-diff primitive: OK")

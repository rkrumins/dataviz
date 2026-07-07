"""Write-path correctness (journey Phase H) — needs Postgres.

Write-through (apply_ops) now enforces the ontology gate under strict enforcement (parity
with stage/publish), and retries on the per-branch commit_seq unique-constraint collision
so concurrent writers to main all land instead of erroring.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation


def _n(eid, et="Dataset"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": et, "displayName": eid}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    # ── ontology gate on write-through ──
    G = await svc.create_graph(
        data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u",
        ontology_spec={"entityTypes": ["Dataset"]}, ontology_enforcement="strict")
    gid, main = G["graph_id"], G["main_branch_id"]
    assert await svc.apply_ops(graph_id=gid, actor="u", message="ok", ops=[_n("A", "Dataset")])
    with pytest.raises(OntologyViolation):
        await svc.apply_ops(graph_id=gid, actor="u", message="bad", ops=[_n("X", "Bad")])
    assert "X" not in (await svc.materialize_state(graph_id=gid, branch_id=main))["nodes"]

    # ── concurrent writers to main all land (commit_seq OCC retry) ──
    H = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    hgid, hmain = H["graph_id"], H["main_branch_id"]
    await asyncio.gather(*[
        svc.apply_ops(graph_id=hgid, actor="u", message=f"n{i}", ops=[_n(f"N{i}")]) for i in range(4)])
    st = await svc.materialize_state(graph_id=hgid, branch_id=hmain)
    assert set(st["nodes"]) == {f"N{i}" for i in range(4)}
    assert (await svc.get_graph(hgid))["main_head_commit_seq"] == 5   # genesis(1) + 4 writes

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_write_correctness_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning write-path correctness (ontology gate + commit-seq OCC) e2e: OK")

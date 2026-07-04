"""VersionedBranchProvider reports stats from the composed Postgres state (insights parity).

The insights collector polls a versioned data source through ContextEngine.for_workspace; when
main's FalkorDB projection is not fresh (blank/Postgres-only models: effectively always), the
engine's provider IS a VersionedBranchProvider. The collector then calls get_stats / get_schema_stats
on it. These assert the branch provider derives node/edge counts + per-type breakdowns + schema
summaries straight from the composed branch state, keyed exactly as the projector labels them.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider


def _n(eid, name=None, etype="Table", tags=None):
    payload = {"urn": eid, "entityType": etype, "displayName": name or eid}
    if tags is not None:
        payload["tags"] = tags
    return {"op": "create", "entity_kind": "node", "entity_id": eid, "payload": payload}


def _e(eid, s, t, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main: Domain DOM contains two Tables; one lineage edge. Tags on the tables.
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("DOM", "Domain", etype="Domain"),
        _n("T1", "T1name", tags=["pii", "gold"]),
        _n("T2", "T2name", tags=["pii"]),
        _e("e_d1", "DOM", "T1", "CONTAINS"), _e("e_d2", "DOM", "T2", "CONTAINS"),
        _e("e_12", "T1", "T2", "FLOWS")])

    main_reader = VersionedBranchProvider(svc, graph_id=gid, branch_id=main)

    stats = await main_reader.get_stats()
    assert stats["nodeCount"] == 3
    assert stats["edgeCount"] == 3
    assert stats["entityTypeCounts"] == {"Domain": 1, "Table": 2}
    assert stats["edgeTypeCounts"] == {"CONTAINS": 2, "FLOWS": 1}
    # bypass_cache accepted for FalkorDB parity, no effect (no cache to bypass)
    assert await main_reader.get_stats(bypass_cache=True) == stats

    schema = await main_reader.get_schema_stats()
    assert schema.total_nodes == 3 and schema.total_edges == 3
    assert {s.id: s.count for s in schema.entity_type_stats} == {"Domain": 1, "Table": 2}
    assert {s.id: s.count for s in schema.edge_type_stats} == {"CONTAINS": 2, "FLOWS": 1}
    tbl = next(s for s in schema.entity_type_stats if s.id == "Table")
    assert set(tbl.sample_names) <= {"T1name", "T2name"} and len(tbl.sample_names) == 2
    assert {t.tag: t.count for t in schema.tag_stats} == {"pii": 2, "gold": 1}

    # a draft's stats reflect the composed overlay: add T3, delete T2 (its edges cascade out)
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="draft", ops=[
        _n("T3", "T3name"), _e("e_d3", "DOM", "T3", "CONTAINS"),
        {"op": "delete", "entity_kind": "node", "entity_id": "T2", "payload": None}])

    draft_reader = VersionedBranchProvider(svc, graph_id=gid, branch_id=draft)
    dstats = await draft_reader.get_stats()
    assert dstats["nodeCount"] == 3                              # DOM, T1, T3 (T2 gone)
    assert dstats["edgeCount"] == 2                              # e_d1, e_d3 (e_d2/e_12 cascaded out)
    assert dstats["entityTypeCounts"] == {"Domain": 1, "Table": 2}
    assert dstats["edgeTypeCounts"] == {"CONTAINS": 2}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_branch_provider_stats_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning branch provider stats e2e: OK")

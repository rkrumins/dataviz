"""LIVE: a property operation found by a real FalkorDB search, written into a draft, published,
projected — and then found by the same search, its values exact.

The job's search runs on the published graph (the projection of main), its writes land in Postgres,
and a publish plus a projection bring them back to the graph the next search reads. Here every step
is real: the scan and the draft re-check (``deep_search_membership``) against FalkorDB, the windows
into the draft, the squash, the projector. A 64-bit integer must come back exactly, and a fill must
narrow on the published graph while deciding on the draft's values.

Run:  GRAPHVER_E2E=1 RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      MANAGEMENT_DB_URL=postgresql+asyncpg://... \\
      pytest backend/tests/integration/test_property_ops_live.py
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning import property_ops as ops_mod
from backend.app.services.versioning.property_ops import OpContext, PropertyOps
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.search import SearchQuery

INT64_MAX = 2 ** 63 - 1
N = 40


def _owner(i):
    return {0: {"owner": f"finance-{i}"}, 1: {"owner": ""}, 2: {}}[i % 3]


def _query(predicate):
    return SearchQuery.model_validate({"predicate": predicate,
                                       "scope": {"viewId": "v", "scopeMode": "data_source"}})


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.providers.falkordb_search.scan import scan_urns
    from backend.app.services.deep_search import SearchRunContext
    from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    factory = make_falkor_graph_factory()
    name = f"propop_live_{os.urandom(4).hex()}"
    projector = FalkorProjector(graph_client_factory=factory)
    provider = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "localhost"),
                                port=int(os.getenv("FALKORDB_PORT", "6379")),
                                graph_name=name, auth_enabled=False)
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    version = {"n": 0}

    def run_context():
        return SearchRunContext(data_version=f"v{version['n']}")

    async def context(job):
        async def on_written():
            return None
        return OpContext(provider=provider, run_context=run_context(), containment_edge_types=["CONTAINS"],
                         ontology_rules=None, on_written=on_written)

    async def publish(draft):
        await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="publish")
        await projector.project_graph(gid)
        version["n"] += 1

    async def found(predicate):
        return sorted((await scan_urns(provider, _query(predicate), context=run_context(), cap=10_000)).urns)

    ops = PropertyOps(svc, context)

    async def apply(draft, op, predicate):
        job_id = await ops.create(workspace_id="ws1", data_source_id="ds1", graph_id=gid, branch_id=draft,
                                  view_id="v", actor="alice", op=op, query=_query(predicate), scope_hash="h")
        summary = await ops.run(job_id)
        assert (await ops.get(job_id))["status"] == "completed", await ops.get(job_id)
        return summary

    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice", falkor_graph_name=name))["graph_id"]
    try:
        await svc.apply_ops(graph_id=gid, actor="alice", ops=[
            {"op": "create", "entity_kind": "node", "entity_id": f"N{i}",
             "payload": {"urn": f"urn:n:{i}", "entityType": "Dataset", "displayName": f"N{i}",
                         "properties": {"score": i / N, **_owner(i)}}} for i in range(N)])
        await projector.project_graph(gid)
        await provider._ensure_connected()
        finance = {"kind": "property", "key": "owner", "op": "contains", "value": "finance"}
        assert len(await found(finance)) == 14

        # ── A 64-bit integer, set across a search's matches a window at a time, then published ──
        draft = await svc.open_draft(graph_id=gid, owner="alice")
        summary = await apply(draft, {"kind": "set", "key": "gvId", "value": INT64_MAX}, finance)
        assert summary["matched"] == 14 and summary["applied"] == 14 and len(summary["commits"]) == 3, summary
        await publish(draft)
        exact = {"kind": "property", "key": "gvId", "op": "eq", "value": str(INT64_MAX), "valueType": "number"}
        assert await found(exact) == await found(finance), "the search finds what the operation wrote"
        res = await provider._graph.query("MATCH (n) WHERE n.gvId IS NOT NULL RETURN DISTINCT n.gvId")
        assert [row[0] for row in res.result_set] == [INT64_MAX], "stored exactly"

        # ── Fill empty: narrowed on the published graph, the draft's own edits re-checked ──
        draft = await svc.open_draft(graph_id=gid, owner="alice")
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[
            {"op": "update", "entity_kind": "node", "entity_id": "N1",           # "" published
             "payload": {"properties": {"owner": "set-in-draft"}}},
            {"op": "update", "entity_kind": "node", "entity_id": "N3",           # "finance-3" published
             "payload": {"properties": {"owner": "   "}}}])
        summary = await apply(draft, {"kind": "fillEmpty", "key": "owner", "value": "filled"}, {"kind": "all"})
        assert summary["applied"] == 26 and summary["unchanged"] == 1, summary
        await publish(draft)
        filled = await found({"kind": "property", "key": "owner", "op": "eq", "value": "filled"})
        assert "urn:n:3" in filled and "urn:n:1" not in filled and len(filled) == 26, filled
    finally:
        await provider._graph.delete()
        await db.dispose_engine()


@pytest.mark.skipif(not (os.getenv("GRAPHVER_E2E") and os.getenv("RUN_FALKOR_LIVE") == "1"),
                    reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with Postgres and FalkorDB running")
def test_a_property_operation_round_trips_through_the_published_graph(monkeypatch):
    monkeypatch.setattr(config, "PROPERTY_OP_WINDOW", 5)
    monkeypatch.setattr(ops_mod, "_WAIT_POLL_S", 0.01)
    asyncio.run(_run())

"""Branch-aware provider selection in ContextEngine.for_workspace (journey Phase G) — Postgres.

The graph endpoints gained an optional branchId; this asserts the selection rule that backs it.
A resolved draft on a versioned graph swaps in the VersionedBranchProvider; 'main' (and omission,
and the opaque main id) keep the live provider; an unknown branch on a versioned graph is a
KeyError (which the dependency maps to HTTP 404); and a branchId against a NON-versioned data
source is ignored (lenient). No FalkorDB — the live provider is a stub since only the *selection*
is under test, and ontology resolution is stubbed out so the test is independent of DB ontology.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.context_engine import ContextEngine


class _StubProvider:
    name = "stub-live-provider"


class _StubRegistry:
    async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
        return _StubProvider()


async def _for_workspace(ds, branch_id):
    async with db.graphver_session() as session:
        return await ContextEngine.for_workspace(
            "ws1", _StubRegistry(), session, data_source_id=ds, branch_id=branch_id)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N1",
         "payload": {"urn": "N1", "entityType": "Table", "displayName": "N1"}}])
    draft = await svc.open_draft(graph_id=gid, owner="u")

    # Isolate the selection rule: no write-through wrap, no ontology DB dependency.
    prev_writes = vconfig.VERSIONED_WRITES_ENABLED
    prev_resolve = ContextEngine._resolve_ontology
    vconfig.VERSIONED_WRITES_ENABLED = False

    async def _noop(self):
        return None
    ContextEngine._resolve_ontology = _noop
    try:
        # resolved draft on a versioned graph → the branch provider, bound to that branch
        eng = await _for_workspace(ds, draft)
        assert isinstance(eng.provider, VersionedBranchProvider)
        assert eng.provider._branch == draft and eng._branch_id == draft

        # 'main' (explicit alias), the opaque main id, and omission → live provider, never a reader
        for b in ("main", main, None):
            e = await _for_workspace(ds, b)
            assert isinstance(e.provider, _StubProvider)

        # unknown branch on a versioned graph → KeyError (the dependency maps this to HTTP 404)
        with pytest.raises(KeyError):
            await _for_workspace(ds, "br_does_not_exist")

        # branchId against a NON-versioned data source → ignored (lenient), live provider
        e_nv = await _for_workspace("ds_not_versioned_" + os.urandom(3).hex(), draft)
        assert isinstance(e_nv.provider, _StubProvider)
    finally:
        vconfig.VERSIONED_WRITES_ENABLED = prev_writes
        ContextEngine._resolve_ontology = prev_resolve

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_read_routing_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft read routing e2e: OK")

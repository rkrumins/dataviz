"""Branch-aware provider selection in ContextEngine.for_workspace (journey Phase G) — Postgres.

The graph endpoints gained an optional branchId; this asserts the selection rule that backs it.
A resolved draft on a versioned graph is served by the DraftOverlayProvider — main ⊕ the draft's
sparse delta — wrapping WHATEVER serves main (the live provider when the FalkorDB projection is fresh,
else the Postgres main reader), so a no-change draft reads identically to main. For 'main' (and
omission, and the opaque main id) the rule is read-your-writes: the live provider when the projection
is fresh (the hot path), but the Postgres reader when the projection lags the committed head (e.g.
just after a merge) so the change is visible immediately. An unknown branch on a versioned graph is a
KeyError (which the dependency maps to HTTP 404); and a branchId against a NON-versioned data source
is ignored (lenient). No FalkorDB — the live provider is a stub since only the *selection* is under
test; ontology resolution and the projection watermark are stubbed so the test is independent of DB
ontology and any running projector.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
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

    # Isolate the selection rule: no write-through wrap, no ontology DB dependency, and a
    # deterministic projection watermark (no FalkorDB / projector running here).
    prev_writes = vconfig.VERSIONED_WRITES_ENABLED
    prev_resolve = ContextEngine._resolve_ontology
    prev_wm = GraphVersioningService.projection_watermark
    vconfig.VERSIONED_WRITES_ENABLED = False

    async def _noop(self):
        return None
    ContextEngine._resolve_ontology = _noop
    try:
        # resolved draft on a versioned graph → the overlay provider, bound to that branch. The
        # real watermark here is NOT fresh (no projector ran), so the overlay's base is the Postgres
        # main reader — a draft still reads main ⊕ its delta, just with a Postgres base.
        eng = await _for_workspace(ds, draft)
        assert isinstance(eng.provider, DraftOverlayProvider)
        assert eng.provider._branch == draft and eng._branch_id == draft
        assert isinstance(eng.provider._base, VersionedBranchProvider) and eng.provider._base._branch == main

        # 'main' (explicit alias), the opaque main id, and omission, projection FRESH → live provider
        async def _fresh(self, graph_id):
            return {"fresh": True, "committed": 1, "projected": 1}
        GraphVersioningService.projection_watermark = _fresh
        for b in ("main", main, None):
            e = await _for_workspace(ds, b)
            assert isinstance(e.provider, _StubProvider)

        # a draft while main is FRESH → overlay wraps the LIVE main provider (reusing its
        # materialized aggregated lineage), not a Postgres reader. This is the scalable hot path.
        e_draft_fresh = await _for_workspace(ds, draft)
        assert isinstance(e_draft_fresh.provider, DraftOverlayProvider)
        assert isinstance(e_draft_fresh.provider._base, _StubProvider)

        # same reads, but the projection LAGS the committed head → read-your-writes serves main
        # from the Postgres reader so a just-merged change is visible before the projector catches up
        async def _stale(self, graph_id):
            return {"fresh": False, "committed": 2, "projected": 1}
        GraphVersioningService.projection_watermark = _stale
        for b in ("main", main, None):
            e = await _for_workspace(ds, b)
            assert isinstance(e.provider, VersionedBranchProvider)
            assert e.provider._branch == main

        # unknown branch on a versioned graph → KeyError (the dependency maps this to HTTP 404)
        with pytest.raises(KeyError):
            await _for_workspace(ds, "br_does_not_exist")

        # branchId against a NON-versioned data source → ignored (lenient), live provider
        e_nv = await _for_workspace("ds_not_versioned_" + os.urandom(3).hex(), draft)
        assert isinstance(e_nv.provider, _StubProvider)
    finally:
        vconfig.VERSIONED_WRITES_ENABLED = prev_writes
        ContextEngine._resolve_ontology = prev_resolve
        GraphVersioningService.projection_watermark = prev_wm

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_read_routing_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft read routing e2e: OK")

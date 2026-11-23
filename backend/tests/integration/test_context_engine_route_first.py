"""A read routed to Postgres needs no FalkorDB: its provider's failure no longer fails it — Postgres.

``ContextEngine.for_workspace`` resolves (and preflights) the data source's FalkorDB provider first.
When FalkorDB can't be reached, every read of the source used to fail (503), also a versioned
graph's whose main Postgres serves because FalkorDB holds no version of it. The error is now held
until the route is read: raised for a graph FalkorDB serves (as before: no Postgres load is added
while FalkorDB is overloaded) and for a source that isn't versioned, never for one Postgres serves.
That reader's reads are bounded (``db.bounded_read_sessions``), and the lookups that route it run on
their own pool (``db.graphver_route_session``).
"""
import asyncio
import os

import pytest

from backend.app.db.repositories import data_source_repo
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.context_engine import ContextEngine
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning import db, models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.adapters.circuit import ProviderUnavailable
from backend.tests.integration.test_versioning_draft_read_routing import _for_workspace
from backend.tests.integration.test_versioning_projection import FakeFalkor

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


class _Unreachable:
    """A registry whose FalkorDB failed its preflight."""

    async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
        raise ProviderUnavailable(provider_name="falkordb", reason="provider unreachable (preflight failed)")


async def _run(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u",
                               falkor_graph_name="gvt_" + os.urandom(3).hex())
    gid, main = G["graph_id"], G["main_branch_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N1",
         "payload": {"urn": "N1", "entityType": "Table", "displayName": "N1"}}])
    draft = await svc.open_draft(graph_id=gid, owner="u")

    async def _noop(self):
        return None

    async def _no_ds(session, ds_id):
        return None
    monkeypatch.setattr(vconfig, "VERSIONED_WRITES_ENABLED", False)
    monkeypatch.setattr(ContextEngine, "_resolve_ontology", _noop)
    monkeypatch.setattr(data_source_repo, "get_data_source_orm", _no_ds)
    try:
        # FalkorDB holds no version of main: Postgres serves it, so FalkorDB being out of reach
        # changes nothing. Main and a draft read on, through the bounded Postgres reader.
        eng = await _for_workspace(ds, "main", _Unreachable())
        assert isinstance(eng.provider, VersionedBranchProvider) and eng.provider._branch == main
        assert eng.provider._read is not eng.provider._svc, "its reads go through the bounded service"
        eng = await _for_workspace(ds, draft, _Unreachable())
        assert isinstance(eng.provider, DraftOverlayProvider)
        assert isinstance(eng.provider._base, VersionedBranchProvider)

        # Once FalkorDB holds a version of main, a read needs it: out of reach, it fails as before.
        await FalkorProjector(graph_client_factory=FakeFalkor()).project_graph(gid)
        assert (await svc.projection_watermark(gid))["served"] is not None
        for branch in ("main", draft):
            with pytest.raises(ProviderUnavailable):
                await _for_workspace(ds, branch, _Unreachable())

        # A source that isn't versioned has only FalkorDB to read: it fails as before.
        with pytest.raises(ProviderUnavailable):
            await _for_workspace("ds_" + os.urandom(4).hex(), "main", _Unreachable())
    finally:
        await db.dispose_engine()


def test_a_read_postgres_serves_goes_on_when_falkordb_is_out_of_reach(monkeypatch):
    asyncio.run(_run(monkeypatch))
